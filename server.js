import express from "express";
import cookieParser from "cookie-parser";
import bcrypt from "bcryptjs";
import crypto from "node:crypto";
import { db, REGIONS } from "./db.js";
import { runChat, HISTORY_LIMIT_ROWS } from "./ai.js";

try { process.loadEnvFile(".env"); } catch { /* no .env file; env vars may be set elsewhere */ }

const app = express();
const PORT = process.env.PORT || 3000;
const SESSION_DAYS = 7;

app.use((req, res, next) => {
  res.on("finish", () => console.log(`${new Date().toISOString()} ${req.method} ${req.path} -> ${res.statusCode}`));
  next();
});
app.use(express.json({ limit: "256kb" }));
app.use(cookieParser());
app.use(express.static("public", {
  setHeaders: (res, filePath) => {
    if (filePath.endsWith(".html")) res.setHeader("Cache-Control", "no-cache");
  },
}));

// ---------- auth helpers ----------

function createSession(userId) {
  const token = crypto.randomBytes(32).toString("hex");
  const expires = new Date(Date.now() + SESSION_DAYS * 864e5).toISOString();
  db.prepare("INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)").run(token, userId, expires);
  return token;
}

function requireAuth(req, res, next) {
  const token = req.cookies.session;
  if (!token) return res.status(401).json({ error: "Not signed in" });
  const row = db.prepare("SELECT user_id, expires_at FROM sessions WHERE token = ?").get(token);
  if (!row || new Date(row.expires_at) < new Date()) {
    if (row) db.prepare("DELETE FROM sessions WHERE token = ?").run(token);
    return res.status(401).json({ error: "Session expired" });
  }
  req.userId = row.user_id;
  next();
}

function setSessionCookie(res, token) {
  res.cookie("session", token, {
    httpOnly: true,
    sameSite: "lax",
    maxAge: SESSION_DAYS * 864e5,
  });
}

// ---------- auth routes ----------

app.post("/api/signup", async (req, res) => {
  const { email, password, company, industry, region, country, needs } = req.body ?? {};
  if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return res.status(400).json({ error: "Valid email required" });
  if (!password || password.length < 8) return res.status(400).json({ error: "Password must be at least 8 characters" });
  if (!company || !company.trim()) return res.status(400).json({ error: "Company name required" });
  if (region && !REGIONS.includes(region)) return res.status(400).json({ error: "Invalid region" });

  const existing = db.prepare("SELECT id FROM users WHERE email = ?").get(email.toLowerCase());
  if (existing) return res.status(409).json({ error: "An account with that email already exists" });

  const hash = await bcrypt.hash(password, 12);
  const info = db.prepare("INSERT INTO users (email, password_hash) VALUES (?, ?)").run(email.toLowerCase(), hash);
  const userId = Number(info.lastInsertRowid);
  db.prepare("INSERT INTO businesses (user_id, name, industry, region, country, needs) VALUES (?, ?, ?, ?, ?, ?)")
    .run(userId, company.trim(), industry ?? "", region ?? "North America", country ?? "", needs ?? "");

  setSessionCookie(res, createSession(userId));
  res.json({ ok: true });
});

app.post("/api/login", async (req, res) => {
  const { email, password } = req.body ?? {};
  const user = db.prepare("SELECT * FROM users WHERE email = ?").get(String(email ?? "").toLowerCase());
  if (!user || !(await bcrypt.compare(String(password ?? ""), user.password_hash))) {
    return res.status(401).json({ error: "Invalid email or password" });
  }
  setSessionCookie(res, createSession(user.id));
  res.json({ ok: true });
});

app.post("/api/logout", requireAuth, (req, res) => {
  db.prepare("DELETE FROM sessions WHERE token = ?").run(req.cookies.session);
  res.clearCookie("session");
  res.json({ ok: true });
});

// ---------- account / profile ----------

app.get("/api/me", requireAuth, (req, res) => {
  const user = db.prepare("SELECT id, email, created_at FROM users WHERE id = ?").get(req.userId);
  const business = db.prepare("SELECT name, industry, region, country, needs FROM businesses WHERE user_id = ?").get(req.userId);
  res.json({ user, business, regions: REGIONS });
});

app.put("/api/profile", requireAuth, (req, res) => {
  const { name, industry, region, country, needs } = req.body ?? {};
  if (!name || !name.trim()) return res.status(400).json({ error: "Company name required" });
  if (region && !REGIONS.includes(region)) return res.status(400).json({ error: "Invalid region" });
  db.prepare("UPDATE businesses SET name = ?, industry = ?, region = ?, country = ?, needs = ? WHERE user_id = ?")
    .run(name.trim(), industry ?? "", region ?? "North America", country ?? "", needs ?? "", req.userId);
  res.json({ ok: true });
});

// ---------- RFQs ----------

app.get("/api/rfqs", requireAuth, (req, res) => {
  const rows = db.prepare(`
    SELECT r.id, r.quantity, r.notes, r.status, r.created_at,
           m.name AS material, m.unit, m.price_per_unit,
           s.name AS supplier, s.country
    FROM rfqs r
    JOIN materials m ON m.id = r.material_id
    JOIN suppliers s ON s.id = r.supplier_id
    WHERE r.user_id = ?
    ORDER BY r.id DESC
  `).all(req.userId);
  res.json({ rfqs: rows });
});

// ---------- chat ----------

app.get("/api/chat", requireAuth, (req, res) => {
  const rows = db.prepare(
    "SELECT role, content_json FROM chat_messages WHERE user_id = ? ORDER BY id ASC"
  ).all(req.userId);
  // Only surface displayable turns: user text + assistant text blocks.
  const display = [];
  for (const row of rows) {
    const content = JSON.parse(row.content_json);
    if (row.role === "user" && typeof content === "string") {
      display.push({ role: "user", text: content });
    } else if (row.role === "assistant" && Array.isArray(content)) {
      const text = content.filter((b) => b.type === "text").map((b) => b.text).join("\n");
      if (text) display.push({ role: "assistant", text });
    }
  }
  res.json({ messages: display });
});

app.post("/api/chat", requireAuth, async (req, res) => {
  const message = String(req.body?.message ?? "").trim();
  if (!message) return res.status(400).json({ error: "Message required" });
  if (message.length > 4000) return res.status(400).json({ error: "Message too long" });

  const business = db.prepare("SELECT * FROM businesses WHERE user_id = ?").get(req.userId);

  // Rebuild API-shaped history from stored messages, trimmed to a safe window.
  // Trim on assistant boundaries so tool_use/tool_result pairs stay intact.
  const rows = db.prepare(
    "SELECT role, content_json FROM chat_messages WHERE user_id = ? ORDER BY id ASC"
  ).all(req.userId);
  let history = rows.map((r) => ({ role: r.role, content: JSON.parse(r.content_json) }));
  if (history.length > HISTORY_LIMIT_ROWS) {
    let start = history.length - HISTORY_LIMIT_ROWS;
    while (start < history.length && !(history[start].role === "user" && typeof history[start].content === "string")) start++;
    history = history.slice(start);
  }
  history.push({ role: "user", content: message });

  try {
    const { text, steps, newMessages } = await runChat(business, req.userId, history);

    const ins = db.prepare("INSERT INTO chat_messages (user_id, role, content_json) VALUES (?, ?, ?)");
    ins.run(req.userId, "user", JSON.stringify(message));
    for (const m of newMessages) ins.run(req.userId, m.role, JSON.stringify(m.content));

    res.json({ text, steps });
  } catch (err) {
    const detail = err?.message ?? String(err);
    if (err?.status === 401 || /api key|authentication|x-api-key/i.test(detail)) {
      return res.status(503).json({
        error: "The AI service isn't configured yet. Add ANTHROPIC_API_KEY to a .env file in the project root and restart the server.",
      });
    }
    console.error("Chat error:", err);
    res.status(502).json({ error: `AI request failed: ${detail}` });
  }
});

app.post("/api/chat/reset", requireAuth, (req, res) => {
  db.prepare("DELETE FROM chat_messages WHERE user_id = ?").run(req.userId);
  res.json({ ok: true });
});

app.listen(PORT, () => {
  console.log(`ForgeLink running at http://localhost:${PORT}`);
  if (!process.env.ANTHROPIC_API_KEY) {
    console.log("Note: ANTHROPIC_API_KEY not set. The chat assistant will be unavailable until you add it (e.g. in a .env file).");
  }
});

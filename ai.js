import Anthropic from "@anthropic-ai/sdk";
import { db, SHIPPING_DAYS, REGIONS, CATEGORIES } from "./db.js";

const MODEL = "claude-opus-4-8";
const MAX_TOOL_ITERATIONS = 8;
const HISTORY_LIMIT = 40; // message rows sent to the API per request

let client = null;
function getClient() {
  if (!client) client = new Anthropic(); // resolves ANTHROPIC_API_KEY / auth profile
  return client;
}

const tools = [
  {
    name: "search_materials",
    description:
      "Search the ForgeLink supplier catalog for materials and components. Call this whenever the user asks about sourcing, availability, pricing, or comparing options; do not answer catalog questions from memory. Results include the supplier, unit price, minimum order, supplier lead time, and estimated shipping days to the buyer's region.",
    input_schema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description:
            "Free-text keywords matched against material name and specification, e.g. 'aluminum plate 6061' or 'M12 bolt'. Leave empty to browse by category only.",
        },
        category: {
          type: "string",
          enum: CATEGORIES,
          description: "Optional category filter.",
        },
        region: {
          type: "string",
          enum: REGIONS,
          description: "Optional: only return suppliers located in this region.",
        },
        max_unit_price: {
          type: "number",
          description: "Optional: exclude items priced above this per unit (USD).",
        },
        max_total_days: {
          type: "number",
          description:
            "Optional: exclude items whose supplier lead time plus shipping to the buyer exceeds this many days.",
        },
      },
      required: [],
    },
  },
  {
    name: "get_supplier",
    description:
      "Get a supplier's full profile: location, rating, verification status, description, and complete material catalog with prices and lead times. Use before recommending a supplier or when the user asks about a specific one.",
    input_schema: {
      type: "object",
      properties: {
        supplier_id: { type: "integer", description: "The supplier's numeric ID from search results." },
      },
      required: ["supplier_id"],
    },
  },
  {
    name: "create_rfq",
    description:
      "Submit a request-for-quote to a supplier on the buyer's behalf. Only call this after the user has clearly confirmed they want to send an RFQ for a specific material and quantity; never file one speculatively. The quantity must meet the material's minimum order quantity.",
    input_schema: {
      type: "object",
      properties: {
        material_id: { type: "integer", description: "Material ID from search or supplier results." },
        quantity: { type: "integer", description: "Quantity requested, in the material's listed unit." },
        notes: { type: "string", description: "Optional message to the supplier (specs, delivery needs, target price)." },
      },
      required: ["material_id", "quantity"],
    },
  },
];

function searchMaterials(input, buyerRegion) {
  const clauses = [];
  const params = [];
  if (input.query) {
    for (const word of String(input.query).split(/\s+/).filter(Boolean).slice(0, 6)) {
      clauses.push("(m.name LIKE ? OR m.spec LIKE ? OR m.category LIKE ?)");
      const p = `%${word}%`;
      params.push(p, p, p);
    }
  }
  if (input.category) { clauses.push("m.category = ?"); params.push(input.category); }
  if (input.region) { clauses.push("s.region = ?"); params.push(input.region); }
  if (input.max_unit_price != null) { clauses.push("m.price_per_unit <= ?"); params.push(input.max_unit_price); }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";

  const rows = db.prepare(`
    SELECT m.id AS material_id, m.name, m.category, m.spec, m.unit,
           m.price_per_unit, m.min_order_qty, m.lead_time_days, m.stock_qty,
           s.id AS supplier_id, s.name AS supplier, s.country, s.region, s.rating, s.verified
    FROM materials m JOIN suppliers s ON s.id = m.supplier_id
    ${where}
    ORDER BY m.price_per_unit ASC
    LIMIT 30
  `).all(...params);

  let results = rows.map((r) => {
    const shipping = SHIPPING_DAYS[r.region]?.[buyerRegion] ?? 15;
    return { ...r, verified: !!r.verified, shipping_days_to_buyer: shipping, total_days_estimate: r.lead_time_days + shipping };
  });
  if (input.max_total_days != null) {
    results = results.filter((r) => r.total_days_estimate <= input.max_total_days);
  }
  return { buyer_region: buyerRegion, result_count: results.length, results };
}

function getSupplier(input, buyerRegion) {
  const s = db.prepare("SELECT * FROM suppliers WHERE id = ?").get(input.supplier_id);
  if (!s) return { error: `No supplier with id ${input.supplier_id}` };
  const mats = db.prepare("SELECT id AS material_id, name, category, spec, unit, price_per_unit, min_order_qty, lead_time_days, stock_qty FROM materials WHERE supplier_id = ?").all(s.id);
  return {
    ...s,
    verified: !!s.verified,
    shipping_days_to_buyer: SHIPPING_DAYS[s.region]?.[buyerRegion] ?? 15,
    catalog: mats,
  };
}

function createRfq(input, userId) {
  const mat = db.prepare(
    "SELECT m.*, s.name AS supplier_name FROM materials m JOIN suppliers s ON s.id = m.supplier_id WHERE m.id = ?"
  ).get(input.material_id);
  if (!mat) return { error: `No material with id ${input.material_id}` };
  const qty = Math.floor(Number(input.quantity));
  if (!Number.isFinite(qty) || qty <= 0) return { error: "Quantity must be a positive integer." };
  if (qty < mat.min_order_qty) {
    return { error: `Quantity ${qty} is below the minimum order of ${mat.min_order_qty} ${mat.unit}(s) for this item.` };
  }
  const info = db.prepare(
    "INSERT INTO rfqs (user_id, supplier_id, material_id, quantity, notes) VALUES (?, ?, ?, ?, ?)"
  ).run(userId, mat.supplier_id, mat.id, qty, String(input.notes ?? ""));
  return {
    ok: true,
    rfq_id: Number(info.lastInsertRowid),
    supplier: mat.supplier_name,
    material: mat.name,
    quantity: qty,
    unit: mat.unit,
    estimated_line_total_usd: +(qty * mat.price_per_unit).toFixed(2),
    status: "sent",
  };
}

function runTool(name, input, ctx) {
  switch (name) {
    case "search_materials": return searchMaterials(input, ctx.buyerRegion);
    case "get_supplier": return getSupplier(input, ctx.buyerRegion);
    case "create_rfq": return createRfq(input, ctx.userId);
    default: return { error: `Unknown tool: ${name}` };
  }
}

function buildSystemPrompt(business) {
  return `You are the ForgeLink sourcing assistant, a procurement copilot for B2B engineering-industry buyers. You help businesses find materials and components, compare suppliers across regions, and send RFQs (requests for quote).

The buyer you are assisting:
- Company: ${business.name}
- Industry: ${business.industry || "not specified"}
- Location: ${business.country || "not specified"} (${business.region})
- Typical needs: ${business.needs || "not specified"}

How to work:
- Ground every catalog claim in tool results. Search before answering questions about availability, price, or suppliers; never invent listings, prices, or lead times.
- Search broadly first (few filters), then narrow. If a search returns nothing, retry with fewer or looser terms before telling the user nothing matched.
- When comparing options, weigh total cost (unit price x realistic quantity vs. minimum order) and total time to receive (supplier lead time + shipping days to the buyer's region), not just sticker price. A cheaper far-away supplier is often slower; say so plainly.
- Mention supplier rating and verification status when recommending. Prefer verified suppliers when options are close.
- Only file an RFQ with create_rfq after the user clearly confirms the specific material, supplier, and quantity. If they haven't confirmed, propose the RFQ and ask.
- Prices are USD estimates for planning; the RFQ process gets the firm quote.

Style: be concise and practical, like a sharp procurement colleague. Use short paragraphs and hyphen bullet lists. Use **bold** for material names and totals. Do not use markdown tables or headings. Never use em dashes; use commas, colons, or separate sentences instead. When you present options, give at most 3, each with price, minimum order, total-days estimate, and a one-line tradeoff.`;
}

/**
 * Run one chat turn with the tool loop.
 * Returns { text, steps, newMessages } where newMessages are the API-shaped
 * messages created this turn (for persistence), excluding the user message.
 */
export async function runChat(business, userId, history) {
  const anthropic = getClient();
  const system = buildSystemPrompt(business);
  const ctx = { buyerRegion: business.region, userId };

  const messages = [...history];
  const newMessages = [];
  const steps = [];
  let finalText = "";

  for (let i = 0; i < MAX_TOOL_ITERATIONS; i++) {
    const response = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 16000,
      thinking: { type: "adaptive" },
      system,
      tools,
      messages,
    });

    const assistantMsg = { role: "assistant", content: response.content };
    messages.push(assistantMsg);
    newMessages.push(assistantMsg);

    for (const block of response.content) {
      if (block.type === "text") finalText = block.text;
    }

    if (response.stop_reason !== "tool_use") break;

    const toolResults = [];
    for (const block of response.content) {
      if (block.type !== "tool_use") continue;
      steps.push({ tool: block.name, input: block.input });
      let result;
      try {
        result = runTool(block.name, block.input, ctx);
      } catch (err) {
        result = { error: `Tool failed: ${err.message}` };
      }
      toolResults.push({
        type: "tool_result",
        tool_use_id: block.id,
        content: JSON.stringify(result),
        ...(result && result.error ? { is_error: true } : {}),
      });
    }
    const toolMsg = { role: "user", content: toolResults };
    messages.push(toolMsg);
    newMessages.push(toolMsg);
  }

  return { text: finalText, steps, newMessages };
}

export const HISTORY_LIMIT_ROWS = HISTORY_LIMIT;

# ForgeLink

**AI-powered B2B materials sourcing assistant for engineering teams.** Businesses describe what they need in plain language; a Claude-powered assistant searches a multi-region supplier catalog, compares real landed cost and delivery time, and files requests-for-quote (RFQs) on their behalf.

![ForgeLink screenshot](docs/screenshot.png)
*(Screenshot coming soon: landing page, chat with tool-activity chips, and RFQ tracker.)*

## How it works

1. **Sign up with a business profile.** Company, industry, region, and typical sourcing needs. The profile is injected into the assistant's system prompt so recommendations account for where you are and what you buy.
2. **Chat with the sourcing assistant.** The server runs an agentic tool-use loop with Claude ([ai.js](ai.js)). The model can call three tools against the local catalog:
   - `search_materials`: keyword, category, region, price, and lead-time search over the supplier catalog
   - `get_supplier`: full supplier profile with ratings, verification status, and complete catalog
   - `create_rfq`: files an RFQ, but only after the user explicitly confirms material, supplier, and quantity
3. **Grounded comparisons.** The assistant is instructed to never invent listings. Every price and lead time comes from tool results, and comparisons weigh total landed time (supplier lead time plus region-to-region shipping estimate) rather than sticker price alone.
4. **Track RFQs.** Filed RFQs appear in a dashboard with material, supplier, quantity, and estimated line total.

Conversation history (including tool calls) is persisted per user in SQLite and replayed to the API on each turn, trimmed on message boundaries so tool call/result pairs stay intact.

## Tech stack

- **Backend:** Node.js (22.5+), Express, `node:sqlite` (built in, no external database)
- **AI:** Anthropic SDK, Claude Opus 4.8 with tool use and adaptive thinking
- **Auth:** bcryptjs password hashing, httpOnly session cookies backed by a sessions table
- **Frontend:** single-page vanilla HTML/CSS/JS ([public/index.html](public/index.html)) with no framework and no build step

## Run it locally

Requires **Node.js 22.5 or newer** (for the built-in SQLite module).

```bash
npm install
cp .env.example .env   # then add your Anthropic API key
npm start              # open http://localhost:3000
```

Get an API key at [platform.claude.com](https://platform.claude.com). The app starts without one, but the chat assistant will be unavailable until it's set.

On first run the server creates `forgelink.db` and seeds it with a demo catalog: 14 suppliers across 7 regions and 42 materials with realistic specs, prices, minimum order quantities, and lead times.

macOS users can also double-click `Start ForgeLink.command` to launch.

## Limitations / future improvements

- **Demo catalog.** Supplier and material data is seeded, realistic-but-fictional demo data; RFQs are stored locally and not actually sent to suppliers.
- **Shipping estimates are static.** Region-to-region transit days are a hardcoded lookup table, not live freight data.
- **No streaming.** Assistant replies arrive all at once; streaming responses would improve perceived latency.
- **Single-user-scale persistence.** SQLite with sessions in the database is great for a demo, but a production version would need managed Postgres, rate limiting, and password reset flows.
- **RFQ lifecycle.** RFQs only have a "sent" status today; a real version needs supplier responses, quotes, and status transitions.

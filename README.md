# Hansel Cottage Chatbot Backend (Render-ready)

TypeScript/Express backend that powers a website chatbot **using only your own site content** and checks **availability** from a Bookalet **ICS** feed. Includes a simple **pricing** engine and endpoints for chat, availability, and quotes.

## Features
- **/api/chat**: Retrieval-augmented answers from your site pages (strictly whitelisted).
- **/api/availability**: Checks requested dates against **Bookalet ICS** (hourly refresh by default).
- **/api/quote**: Simple, configurable pricing (nightly/weekly + dog fee + rules).
- **/health**: Simple health endpoint for Render.
- **CORS**: Locked down to your domain via env var.
- **Admin**: `/admin/*` endpoints protected by `X-Admin-Token` header.
- **Zero DB required**: In-memory caches; add Postgres later if desired.

## Quick Start (Local)
1. **Install**:
   ```bash
   npm install
   ```
2. **Configure**: Copy `.env.example` to `.env` and edit values.
3. **Run**:
   ```bash
   npm run dev
   ```
4. Visit: `http://localhost:3000/health`

## Deploy to Render
- **Create Web Service** from your GitHub repo.
- **Build Command**: `npm ci && npm run build`
- **Start Command**: `npm start`
- **Environment**: set the variables from `.env.example` (at minimum `ICS_URL`, `ALLOWED_ORIGIN`, `BASE_URLS`, `OPENAI_API_KEY` if you want AI answers).
- (Optional) Create a **Cron Job** to hit `POST /admin/ics/refresh` hourly.

## Endpoints
- `GET /health`
- `GET /api/availability?from=YYYY-MM-DD&nights=7`
- `POST /api/quote` → JSON body `{ "from": "2025-12-19", "nights": 7, "dogs": 0 }`
- `POST /api/chat` → JSON body `{ "message": "What time is check-in?" }`
- Admin:
  - `POST /admin/ics/refresh` (X-Admin-Token)
  - `POST /admin/reindex` (X-Admin-Token)

## Notes
- **RAG/Chat**: If `OPENAI_API_KEY` is not set, chat returns top snippets only (no LLM generation).
- **Pricing**: Adjust `config/pricing.json` (copy from the provided example). For cross-season stays, the engine applies nightly rates per night; exact weekly handling can be tuned.
- **ICS**: The ICS describes **booked** periods. Availability = your requested window does **not overlap** any booked interval and passes rules (min stay, optional changeover).

---

© 2025 Hansel Cottage / Your Org. MIT licensed for convenience.

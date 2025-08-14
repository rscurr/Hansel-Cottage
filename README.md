# Hansel Cottage Chatbot Backend (Render-ready, patched)

This is a **patched** version that compiles cleanly on Node 18+ on Render.

Key fixes:
- Switched to **global `fetch`** (no `node-fetch` needed).
- TS config now includes **DOM** lib and **Node** types for `fetch` + `process` typings.
- `node-ical` imported as a **namespace** (`import * as ical from 'node-ical'`).

---
© 2025 Hansel Cottage / Your Org. MIT licensed.

import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import path from 'node:path';
import { z } from 'zod';

// Your local modules
import { refreshIcs, isRangeAvailable, suggestAlternatives, getIcsStats } from './ics.js';
import { quoteForStay } from './pricing.js';
import {
  answerWithContext,
  refreshContentIndex,
  addExternalDocumentToIndex
} from './rag.js';
import { extractPdfTextFromUrl } from './pdf.js';
import { interpretMessageWithLLM } from './nlp.js';

const app = express();
app.use(express.json({ limit: '1mb' }));

/* ---------- CORS ---------- */
const allowed = (process.env.ALLOWED_ORIGIN || '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);
app.use(cors({ origin: allowed.length ? allowed : true }));

/* ---------- Static assets (widget, PDFs, etc.) ---------- */
// Use an absolute path so it works after TS compilation to dist/
const publicDir = path.resolve(process.cwd(), 'public');
app.use(express.static(publicDir));

/* ---------- Boot tasks (non-blocking) ---------- */
refreshIcs().catch(e => console.error('[ics] init error', e));
refreshContentIndex().catch(e => console.error('[rag] init error', e));

// Optional: auto-ingest one or more PDFs on boot via env PDF_URLS (comma-separated)
(async () => {
  const urls = (process.env.PDF_URLS || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);

  for (const u of urls) {
    try {
      const text = await extractPdfTextFromUrl(u);
      await addExternalDocumentToIndex('PDF', u, text);
      console.log('[pdf] indexed on boot:', u);
    } catch (e) {
      console.error('[pdf] boot ingest failed:', u, e);
    }
  }
})();

/* ---------- Health ---------- */
app.get('/health', (_req, res) => {
  res.json({
    ok: true,
    service: 'hanselcottage-chatbot-backend',
    ics: getIcsStats?.(),
    time: new Date().toISOString()
  });
});

/* ---------- Availability (deterministic) ---------- */
const AvailQuery = z.object({
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  nights: z.coerce.number().int().min(1).max(30)
});

app.get('/api/availability', (req, res) => {
  const parsed = AvailQuery.safeParse(req.query);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const { from, nights } = parsed.data;
  const available = isRangeAvailable(from, nights);
  const reasons = available ? [] : ['Requested dates overlap an existing booking or violate rules'];
  const suggestions = available ? [] : suggestAlternatives(from, nights, 10);
  res.json({ available, reasons, suggestions });
});

/* ---------- Quote (deterministic) ---------- */
const QuoteReq = z.object({
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  nights: z.number().int().min(1).max(30),
  dogs: z.number().int().min(0).max(4).default(0)
});

app.post('/api/quote', (req, res) => {
  const parsed = QuoteReq.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  res.json(quoteForStay(parsed.data));
});

/* ---------- Chat ---------- */
/*
  Flow:
  1) Try LLM-only date extraction (1 OpenAI call). If it yields {from,nights,dogs}:
     - Run deterministic availability + quote and reply.
  2) Otherwise, answer via RAG (PDF/site context). If OPENAI_API_KEY is set, the answer is nicely phrased;
     if not, it returns helpful snippets. Never throws 500 to the client.
*/
const ChatReq = z.object({ message: z.string().min(1).max(2000) });

app.post('/api/chat', async (req, res) => {
  const parsed = ChatReq.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const message = parsed.data.message;

  // Step 1: LLM date extraction → availability/quote
  try {
    const intent = await interpretMessageWithLLM(message);
    if (intent.kind === 'dates') {
      const available = isRangeAvailable(intent.from, intent.nights);
      if (available) {
        const quote = quoteForStay({
          from: intent.from,
          nights: intent.nights,
          dogs: intent.dogs
        });
        const dogsText = intent.dogs
          ? ` (incl. ${intent.dogs} dog${intent.dogs > 1 ? 's' : ''})`
          : '';
        return res.json({
          answer: `✅ Yes, it looks available from ${intent.from} for ${intent.nights} night(s). Estimated total: ${quote.currency} ${quote.total}${dogsText}.`
        });
      } else {
        const alts = suggestAlternatives(intent.from, intent.nights, 10)
          .slice(0, 3)
          .map(a => a.from)
          .join(', ');
        return res.json({
          answer: `❌ Sorry, those dates look unavailable.${alts ? ` Closest alternatives: ${alts}.` : ''}`
        });
      }
    }
  } catch (e) {
    // E.g., OpenAI 401/429/etc. Continue with RAG.
    console.warn('[chat] LLM extract failed/limited — falling back to RAG:', (e as any)?.message || e);
  }

  // Step 2: RAG answer (internally resilient; will fall back to snippets if OpenAI not available)
  try {
    const ans = await answerWithContext(message);
    return res.json(ans);
  } catch (e) {
    console.error('[chat] RAG failed:', e);
    return res.json({
      answer:
        "I couldn’t reach the AI service just now. You can ask like ‘from YYYY-MM-DD for N nights with D dogs’, or try again shortly."
    });
  }
});

/* ---------- Admin: ICS refresh ---------- */
app.post('/admin/ics/refresh', async (req, res) => {
  if (req.headers['x-admin-token'] !== process.env.ADMIN_TOKEN) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  try {
    await refreshIcs(true);
    res.json({ ok: true, ics: getIcsStats?.() });
  } catch (e: any) {
    res.status(500).json({ error: e?.message || 'ics-refresh-error' });
  }
});

/* ---------- Admin: reindex site content (optional no-op) ---------- */
app.post('/admin/reindex', async (req, res) => {
  if (req.headers['x-admin-token'] !== process.env.ADMIN_TOKEN) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  try {
    await refreshContentIndex(true);
    res.json({ ok: true });
  } catch (e: any) {
    res.status(500).json({ error: e?.message || 'reindex-error' });
  }
});

/* ---------- Admin: ingest a PDF by URL ---------- */
app.post('/admin/ingest-pdf', async (req, res) => {
  if (req.headers['x-admin-token'] !== process.env.ADMIN_TOKEN) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  try {
    const url = String((req.body && (req.body.url || req.query.url)) || '');
    const name = String((req.body && (req.body.name || req.query.name)) || 'PDF');
    if (!url || !/^https?:\/\//i.test(url)) {
      return res.status(400).json({ error: 'Provide a valid PDF ?url=' });
    }
    const text = await extractPdfTextFromUrl(url);
    const result = await addExternalDocumentToIndex(name, url, text);
    res.json({ ok: true, ...result });
  } catch (e: any) {
    res.status(500).json({ error: e?.message || 'pdf-ingest-failed' });
  }
});

/* ---------- Start server ---------- */
const PORT = Number(process.env.PORT) || 3000;
app.listen(PORT, () => console.log(`Server listening on :${PORT}`));

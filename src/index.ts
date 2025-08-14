// src/index.ts
import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import path from 'node:path';
import { z } from 'zod';

import { refreshIcs, isRangeAvailable, suggestAlternatives, getIcsStats } from './ics.js';
import { quoteForStay } from './pricing.js';
import { answerWithContext, refreshContentIndex, addExternalDocumentToIndex } from './rag.js';
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

/* ---------- Static ---------- */
const publicDir = path.resolve(process.cwd(), 'public');
app.use(express.static(publicDir));

/* ---------- Boot tasks ---------- */
refreshIcs().catch(e => console.error('[ics] init error', e));
refreshContentIndex().catch(e => console.error('[rag] init error', e));

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

/* ---------- Availability API ---------- */
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

/* ---------- Quote API ---------- */
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

/* ---------- Chat API ---------- */
const ChatReq = z.object({ message: z.string().min(1).max(2000) });

app.post('/api/chat', async (req, res) => {
  const parsed = ChatReq.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const message = parsed.data.message;

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
        return res.json({
          answer: `✅ Available from ${intent.from} for ${intent.nights} nights. Total: ${quote.currency} ${quote.total}`
        });
      } else {
        const alts = suggestAlternatives(intent.from, intent.nights, 10)
          .slice(0, 3)
          .map(a => a.from)
          .join(', ');
        return res.json({
          answer: `❌ Not available. Alternatives: ${alts || 'none found'}.`
        });
      }
    }
  } catch (e) {
    console.warn('[chat] LLM extract failed — fallback to RAG');
  }

  try {
    const ans = await answerWithContext(message);
    return res.json(ans);
  } catch (e) {
    return res.json({ answer: 'I had trouble contacting the AI service. Please try again later.' });
  }
});

/* ---------- Admin endpoints ---------- */
app.post('/admin/ics/refresh', async (req, res) => {
  if (req.headers['x-admin-token'] !== process.env.ADMIN_TOKEN) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  await refreshIcs(true);
  res.json({ ok: true, ics: getIcsStats?.() });
});

app.post('/admin/reindex', async (req, res) => {
  if (req.headers['x-admin-token'] !== process.env.ADMIN_TOKEN) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  await refreshContentIndex(true);
  res.json({ ok: true });
});

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
    console.log('[pdf ingest] url received:', url); // ✅ Debugging aid
    const text = await extractPdfTextFromUrl(url);
    const result = await addExternalDocumentToIndex(name, url, text);
    res.json({ ok: true, ...result });
  } catch (e: any) {
    res.status(500).json({ error: e?.message || 'pdf-ingest-failed' });
  }
});

/* ---------- Start ---------- */
const PORT = Number(process.env.PORT) || 3000;
app.listen(PORT, () => console.log(`Server listening on :${PORT}`));

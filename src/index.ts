import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import path from 'node:path';
import { z } from 'zod';

import { refreshIcs, isRangeAvailable, suggestAlternatives, getIcsStats } from './ics.js';
import { quoteForStay } from './pricing.js';
import {
  answerWithContext,
  refreshContentIndex,
  addExternalDocumentToIndex
} from './rag.js';
import { extractPdfTextFromUrl, extractPdfTextFromFile } from './pdf.js';
import { interpretMessageWithLLM } from './nlp.js';

const app = express();
app.use(express.json({ limit: '1mb' }));

/* ---------- CORS ---------- */
const allowed = (process.env.ALLOWED_ORIGIN || '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);
app.use(cors({ origin: allowed.length ? allowed : true }));

/* ---------- Static (widget, PDFs, etc.) ---------- */
const publicDir = path.resolve(process.cwd(), 'public');
app.use(express.static(publicDir));

/* ---------- Health ---------- */
app.get('/health', (_req, res) => {
  res.json({
    ok: true,
    service: 'hanselcottage-chatbot-backend',
    ics: getIcsStats?.(),
    time: new Date().toISOString()
  });
});

/* ---------- Availability ---------- */
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

/* ---------- Quote ---------- */
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
        const dogsText = intent.dogs ? ` (incl. ${intent.dogs} dog${intent.dogs > 1 ? 's' : ''})` : '';
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
    console.warn('[chat] LLM extract failed/limited — falling back to RAG:', (e as any)?.message || e);
  }

  try {
    const ans = await answerWithContext(message);
    return res.json(ans);
  } catch {
    return res.json({
      answer:
        "I couldn’t reach the AI service just now. You can ask like ‘from YYYY-MM-DD for N nights with D dogs’, or try again shortly."
    });
  }
});

/* ---------- Admin ---------- */
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
    if (!url) return res.status(400).json({ error: 'Provide a PDF url or relative filename in /public' });

    let text: string;
    if (/^https?:\/\//i.test(url)) {
      console.log('[pdf ingest] fetching via HTTP:', url);
      text = await extractPdfTextFromUrl(url);
    } else {
      const local = path.resolve(publicDir, url);
      console.log('[pdf ingest] reading local file:', local);
      text = await extractPdfTextFromFile(local);
    }
    const result = await addExternalDocumentToIndex(name, url, text);
    res.json({ ok: true, ...result });
  } catch (e: any) {
    res.status(500).json({ error: e?.message || 'pdf-ingest-failed' });
  }
});

/* ---------- Start & deferred boot tasks ---------- */
const PORT = Number(process.env.PORT) || 3000;
app.listen(PORT, async () => {
  console.log(`Server listening on :${PORT}`);

  // Kick off non-blocking boot tasks AFTER we are listening.

  // 1) RAG index (site, if any)
  refreshContentIndex().catch(e => console.error('[rag] init error', e));

  // 2) ICS refresh
  refreshIcs().catch(e => console.error('[ics] init error', e));

  // 3) PDF auto-ingest:
  //    - If an entry in PDF_URLS looks like a full URL, fetch over HTTP(S).
  //    - If it looks like "HouseInformation.pdf", read from local /public/HouseInformation.pdf.
  const raw = (process.env.PDF_URLS || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);

  for (const entry of raw) {
    try {
      let text: string;
      if (/^https?:\/\//i.test(entry)) {
        console.log('[pdf boot] HTTP:', entry);
        text = await extractPdfTextFromUrl(entry);
      } else {
        const local = path.resolve(publicDir, entry);
        console.log('[pdf boot] LOCAL:', local);
        text = await extractPdfTextFromFile(local);
      }
      await addExternalDocumentToIndex('PDF', entry, text);
      console.log('[pdf boot] indexed:', entry);
    } catch (e) {
      console.error('[pdf] boot ingest failed:', entry, e);
    }
  }
});

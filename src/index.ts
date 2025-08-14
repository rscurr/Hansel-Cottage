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
const allowed = (process.env.ALLOWED_ORIGIN || '').split(',').map(s => s.trim()).filter(Boolean);
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

/* ---------- Helper: decide if a message is about booking/availability ---------- */
function isBookingLike(message: string): boolean {
  const txt = message.toLowerCase();

  // Fast path: obvious booking words
  const bookingWords = [
    'available', 'availability', 'book', 'booking', 'reserve', 'reservation',
    'price', 'pricing', 'cost', 'quote', 'deposit',
    'night', 'nights', 'week', 'weekend', 'dogs', 'dog',
    'check-in', 'check in', 'checkout', 'check-out'
  ];
  if (bookingWords.some(w => txt.includes(w))) return true;

  // Dates/ranges present?
  if (/\b\d{4}-\d{2}-\d{2}\b/.test(txt)) return true;            // ISO date
  if (/\bfrom\b.*\b(to|until)\b/.test(txt)) return true;         // "from X to/until Y"
  if (/\bnext\s+(mon|tue|wed|thu|fri|sat|sun|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/.test(txt)) return true;
  if (/\bthis\s+(mon|tue|wed|thu|fri|sat|sun|monday|tuesday|wednesday|thursday|friday|saturday|sunday|weekend)\b/.test(txt)) return true;

  return false;
}

/* ---------- Chat ---------- */
const ChatReq = z.object({ message: z.string().min(1).max(2000) });
app.post('/api/chat', async (req, res) => {
  const parsed = ChatReq.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const message = parsed.data.message;

  // 💡 Only try date extraction + availability flow if the message looks booking-related.
  if (isBookingLike(message)) {
    try {
      const intent = await interpretMessageWithLLM(message);
      if (intent.kind === 'dates') {
        const available = isRangeAvailable(intent.from, intent.nights);
        if (available) {
          const quote = quoteForStay({ from: intent.from, nights: intent.nights, dogs: intent.dogs });
          const dogsText = intent.dogs ? ` (incl. ${intent.dogs} dog${intent.dogs > 1 ? 's' : ''})` : '';
          return res.json({
            answer: `✅ Yes, it looks available from ${intent.from} for ${intent.nights} night(s). Estimated total: ${quote.currency} ${quote.total}${dogsText}.`
          });
        } else {
          const alts = suggestAlternatives(intent.from, intent.nights, 10).slice(0, 3).map(a => a.from).join(', ');
          return res.json({
            answer: `❌ Sorry, those dates look unavailable.${alts ? ` Closest alternatives: ${alts}.` : ''}`
          });
        }
      }
      // If intent.kind !== 'dates', we’ll fall through to RAG below.
    } catch (e) {
      console.warn('[chat] LLM extract failed/limited — falling back to RAG:', (e as any)?.message || e);
    }
  }

  // 🔎 General questions → RAG (PDF/site). If OPENAI_API_KEY is set, this also phrases nicely.
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
  if (req.headers['x-admin-token'] !== process.env.ADMIN_TOKEN) return res.status(401).json({ error: 'unauthorized' });
  await refreshIcs(true);
  res.json({ ok: true, ics: getIcsStats?.() });
});

app.post('/admin/reindex', async (req, res) => {
  if (req.headers['x-admin-token'] !== process.env.ADMIN_TOKEN) return res.status(401).json({ error: 'unauthorized' });
  await refreshContentIndex(true);
  res.json({ ok: true });
});

// Normalize entries like "public/HouseInformation.pdf" → "HouseInformation.pdf"
function normalizePublicEntry(entry: string): string {
  let e = entry.trim();
  if (e.startsWith('/')) e = e.slice(1);
  if (e.toLowerCase().startsWith('public/')) e = e.slice('public/'.length);
  return e;
}

app.post('/admin/ingest-pdf', async (req, res) => {
  if (req.headers['x-admin-token'] !== process.env.ADMIN_TOKEN) return res.status(401).json({ error: 'unauthorized' });
  try {
    let url = String((req.body && (req.body.url || req.query.url)) || '');
    const name = String((req.body && (req.body.name || req.query.name)) || 'PDF');
    if (!url) return res.status(400).json({ error: 'Provide a PDF url or relative filename in /public' });

    let text: string;
    if (/^https?:\/\//i.test(url)) {
      console.log('[pdf ingest] HTTP:', url);
      text = await extractPdfTextFromUrl(url);
    } else {
      url = normalizePublicEntry(url);
      const local = path.resolve(publicDir, url);
      console.log('[pdf ingest] LOCAL:', local);
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

  refreshContentIndex().catch(e => console.error('[rag] init error', e));
  refreshIcs().catch(e => console.error('[ics] init error', e));

  const raw = (process.env.PDF_URLS || '').split(',').map(s => s.trim()).filter(Boolean);
  for (let entry of raw) {
    try {
      let text: string;
      if (/^https?:\/\//i.test(entry)) {
        console.log('[pdf boot] HTTP:', entry);
        text = await extractPdfTextFromUrl(entry);
      } else {
        entry = normalizePublicEntry(entry);
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

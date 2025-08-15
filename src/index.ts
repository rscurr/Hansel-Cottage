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
import { crawlSite } from './crawl.js';

const app = express();
app.use(express.json({ limit: '1mb' }));

/* ---------- CORS (comma-separated origins) ---------- */
const allowed = (process.env.ALLOWED_ORIGIN || '').split(',').map(s => s.trim()).filter(Boolean);
app.use(cors({
  origin(origin, cb) {
    if (!origin) return cb(null, true); // allow curl/local tools and file://
    if (allowed.includes('*') || allowed.includes(origin)) return cb(null, true);
    return cb(new Error('Not allowed by CORS'));
  }
}));

/* ---------- Static (widget, PDFs) ---------- */
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

/* ---------- Booking intent helpers ---------- */
// Stricter heuristic: requires a booking verb or explicit date/range.
// Pet/fence/garden words alone should NOT trigger booking flow.
function hasDateHints(t: string): boolean {
  return (
    /\b\d{4}-\d{2}-\d{2}\b/.test(t) ||                                   // ISO date
    /\bfrom\b.*\b(to|until)\b/.test(t) ||                                 // from X to Y
    /\bfor\s+\d+\s+nights?\b/.test(t) ||                                  // for 3 nights
    /\b\d+\s+nights?\b/.test(t) ||                                        // 3 nights
    /\b(next|this)\s+(mon|tue|wed|thu|fri|sat|sun|monday|tuesday|wednesday|thursday|friday|saturday|sunday|weekend)\b/.test(t)
  );
}

function isBookingLikeHeuristic(message: string): boolean {
  const t = message.toLowerCase();

  const bookingVerbs =
    /\b(book|booking|reserve|reservation|availability|available|price|pricing|cost|quote|deposit|rate|rates)\b/;

  // Clearly informational pet/garden queries should NOT trigger booking flow unless they also have dates/booking verbs
  const petGarden =
    /\b(dog|dogs|pet|pets|fence|fenced|garden|yard|gate|secure|safety|enclosure|lawn|grass)\b/;

  if (petGarden.test(t) && !bookingVerbs.test(t) && !hasDateHints(t)) {
    return false;
  }

  // Booking if explicit verb or any date/range hint
  if (bookingVerbs.test(t)) return true;
  if (hasDateHints(t)) return true;

  return false;
}

// Optional: small LLM intent classifier. Falls back to heuristic if API not available.
async function classifyIntentLLM(message: string): Promise<'booking' | 'info' | 'unknown'> {
  if (!process.env.OPENAI_API_KEY) return 'unknown';
  try {
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        temperature: 0,
        messages: [
          {
            role: 'system',
            content:
              'Classify the user message as "booking" (asks about dates, prices, availability, or making a reservation) or "info" (general questions about the property, pets, garden, rules, amenities, area). Reply with ONLY "booking" or "info".'
          },
          { role: 'user', content: message }
        ]
      })
    });
    if (!res.ok) return 'unknown';
    const j: any = await res.json();
    const label = String(j.choices?.[0]?.message?.content || '').toLowerCase().trim();
    if (label.includes('booking')) return 'booking';
    if (label.includes('info')) return 'info';
    return 'unknown';
  } catch {
    return 'unknown';
  }
}

/* ---------- Chat ---------- */
const ChatReq = z.object({ message: z.string().min(1).max(2000) });
app.post('/api/chat', async (req, res) => {
  const parsed = ChatReq.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const message = parsed.data.message;

  // Decide booking intent: try LLM (if available), otherwise heuristic
  let bookingIntent = false;
  try {
    const label = await classifyIntentLLM(message);
    if (label === 'booking') bookingIntent = true;
    else if (label === 'info') bookingIntent = false;
    else bookingIntent = isBookingLikeHeuristic(message);
  } catch {
    bookingIntent = isBookingLikeHeuristic(message);
  }

  // Booking/availability flow
  if (bookingIntent) {
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
          return res.json({ answer: `❌ Sorry, those dates look unavailable.${alts ? ` Closest alternatives: ${alts}.` : ''}` });
        }
      }
      // If LLM didn't produce dates, drop to RAG
    } catch (e) {
      console.warn('[chat] LLM extract failed — falling back to RAG:', (e as any)?.message || e);
    }
  }

  // General Qs → RAG (PDF + website)
  try {
    const ans = await answerWithContext(message);
    return res.json(ans);
  } catch {
    return res.json({ answer: 'I had trouble contacting the AI service. Please try again.' });
  }
});

/* ---------- Admin: ICS refresh ---------- */
app.post('/admin/ics/refresh', async (req, res) => {
  if (req.headers['x-admin-token'] !== process.env.ADMIN_TOKEN) return res.status(401).json({ error: 'unauthorized' });
  await refreshIcs(true);
  res.json({ ok: true, ics: getIcsStats?.() });
});

/* ---------- Admin: reindex site (crawler) ---------- */
app.post('/admin/ingest-site', async (req, res) => {
  if (req.headers['x-admin-token'] !== process.env.ADMIN_TOKEN) return res.status(401).json({ error: 'unauthorized' });
  try {
    const baseUrl = String(req.body?.baseUrl || req.query.baseUrl || process.env.SITE_BASE_URL || '');
    if (!/^https?:\/\//i.test(baseUrl)) return res.status(400).json({ error: 'Provide ?baseUrl=https://yoursite or set SITE_BASE_URL' });

    const sitemapUrl = String(req.body?.sitemap || req.query.sitemap || process.env.SITEMAP_URL || '');
    const includeRe = (process.env.CRAWL_INCLUDE || req.body?.include || req.query.include)
      ? new RegExp(String(process.env.CRAWL_INCLUDE || req.body?.include || req.query.include)) : undefined;
    const excludeRe = (process.env.CRAWL_EXCLUDE || req.body?.exclude || req.query.exclude)
      ? new RegExp(String(process.env.CRAWL_EXCLUDE || req.body?.exclude || req.query.exclude)) : undefined;
    const maxPages = Number(req.body?.max || req.query.max || process.env.CRAWL_MAX || 50);

    const pages = await crawlSite({ baseUrl, sitemapUrl: sitemapUrl || undefined, include: includeRe, exclude: excludeRe, maxPages });
    let added = 0;
    for (const p of pages) {
      const r = await addExternalDocumentToIndex('WEB', p.url, p.text);
      added += r.added;
    }
    res.json({ ok: true, pages: pages.length, chunks: added });
  } catch (e: any) {
    res.status(500).json({ error: e?.message || 'site-ingest-failed' });
  }
});

/* ---------- Admin: ingest a PDF ---------- */
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

/* ---------- Start & auto-ingest on boot ---------- */
const PORT = Number(process.env.PORT) || 3000;
app.listen(PORT, async () => {
  console.log(`Server listening on :${PORT}`);

  // Initialize (non-blocking)
  refreshContentIndex().catch(e => console.error('[rag] init error', e));
  refreshIcs().catch(e => console.error('[ics] init error', e));

  // Auto-ingest PDFs on boot (comma-separated; support local /public or full URLs)
  const pdfEntries = (process.env.PDF_URLS || '').split(',').map(s => s.trim()).filter(Boolean);
  for (let entry of pdfEntries) {
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

  // Auto-crawl website on boot if SITE_BASE_URL is set
  const BASE = process.env.SITE_BASE_URL || '';
  if (BASE) {
    try {
      const pages = await crawlSite({
        baseUrl: BASE,
        sitemapUrl: process.env.SITEMAP_URL || undefined,
        include: process.env.CRAWL_INCLUDE ? new RegExp(process.env.CRAWL_INCLUDE) : undefined,
        exclude: process.env.CRAWL_EXCLUDE ? new RegExp(process.env.CRAWL_EXCLUDE) : undefined,
        maxPages: Number(process.env.CRAWL_MAX || 50)
      });
      for (const p of pages) await addExternalDocumentToIndex('WEB', p.url, p.text);
      console.log('[crawl] indexed pages:', pages.length);
    } catch (e) {
      console.error('[crawl] boot crawl failed:', e);
    }
  }
});

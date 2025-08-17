import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import path from 'node:path';
import { z } from 'zod';

import {
  refreshIcs,
  isRangeAvailable,
  suggestAlternatives,
  getIcsStats,
  findAvailabilityInMonth
} from './ics.js';
import { quoteForStay } from './pricing.js';
import {
  answerWithContext,
  refreshContentIndex,
  addExternalDocumentToIndex
} from './rag.js';
import { extractPdfTextFromUrl, extractPdfTextFromFile } from './pdf.js';
import { interpretMessageWithLLM } from './nlp.js';
import { crawlSite } from './crawl.js';

import {
  initSessionSweeper,
  getSession,
  pushMessage,
  getRecentMessages
} from './session.js';

const app = express();
app.use(express.json({ limit: '1mb' }));
app.set('trust proxy', 1);

/* ---------- CORS (comma-separated origins) ---------- */
const allowed = (process.env.ALLOWED_ORIGIN || '').split(',').map(s => s.trim()).filter(Boolean);
app.use(cors({
  origin(origin, cb) {
    if (!origin) return cb(null, true);
    if (allowed.includes('*') || allowed.includes(origin)) return cb(null, true);
    return cb(new Error('Not allowed by CORS'));
  },
  allowedHeaders: ['Content-Type', 'X-Session-Id']
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

/* ---------- Availability endpoints ---------- */
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

const QuoteReq = z.object({
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  nights: z.number().int().min(1).max(30),
  dogs: z.number().int().min(0).max(4).default(0)
});
app.post('/api/quote', async (req, res) => {
  const parsed = QuoteReq.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const q = await quoteForStay(parsed.data);
  res.json(q);
});

/* ---------- Chit-chat ---------- */
function isChitChat(message: string): boolean {
  const t = message.trim().toLowerCase();
  return (
    /^(hi|hey|hello|howdy)\b/.test(t) ||
    /^(thanks|thank you|cheers|ta)$/.test(t) ||
    /^(ok|okay|great|perfect|awesome|brilliant|sounds good|cool|nice)$/.test(t) ||
    /^(bye|goodbye|see ya|see you|later)$/.test(t)
  );
}
function replyChitChat(message: string): string {
  const t = message.trim().toLowerCase();
  if (/^(thanks|thank you|cheers|ta)$/.test(t)) return "You’re very welcome! Anything else I can help with?";
  if (/^(hi|hey|hello|howdy)\b/.test(t)) return "Hi! 👋 How can I help—availability, pricing, or questions about the cottage?";
  if (/^(ok|okay|great|perfect|awesome|brilliant|sounds good|cool|nice)$/.test(t)) return "👍 Got it. If you’d like, I can check dates or answer questions from the house info.";
  if (/^(bye|goodbye|see ya|see you|later)$/.test(t)) return "Bye for now! If you need anything else, just pop back in.";
  return "Happy to help! Would you like me to check dates or answer something about the cottage?";
}

/* ---------- Intent helpers ---------- */
function hasDateHints(t: string): boolean {
  return (
    /\b\d{4}-\d{2}-\d{2}\b/.test(t) ||
    /\bfrom\b.*\b(to|until)\b/.test(t) ||
    /\bfor\s+\d+\s+nights?\b/.test(t) ||
    /\b\d+\s+nights?\b/.test(t) ||
    /\b(next|this)\s+(mon|tue|wed|thu|fri|sat|sun|monday|tuesday|wednesday|thursday|friday|saturday|sunday|weekend)\b/.test(t)
  );
}
function isBookingLikeHeuristic(message: string): boolean {
  const t = message.toLowerCase();
  const bookingVerbs = /\b(book|booking|reserve|reservation|availability|available|price|pricing|cost|quote|deposit|rate|rates)\b/;
  const petGarden = /\b(dog|dogs|pet|pets|fence|fenced|garden|yard|gate|secure|safety|enclosure|lawn|grass)\b/;
  if (petGarden.test(t) && !bookingVerbs.test(t) && !hasDateHints(t)) return false;
  if (bookingVerbs.test(t)) return true;
  if (hasDateHints(t)) return true;
  return false;
}

/* ---------- Month parsing ---------- */
const MONTHS = ['january','february','march','april','may','june','july','august','september','october','november','december'];

function extractMonthYearFromText(message: string): { year?: number; month?: number } {
  const t = message.toLowerCase();
  const m = t.match(/\b(january|february|march|april|may|june|july|august|september|october|november|december)\b(?:\s+(\d{4}))?/i);
  if (!m) return {};
  const monthName = m[1].toLowerCase();
  let month = MONTHS.indexOf(monthName) + 1;
  let year = m[2] ? parseInt(m[2], 10) : undefined;
  if (!year) {
    const now = new Date();
    const nowMonth = now.getUTCMonth() + 1;
    const nowYear = now.getUTCFullYear();
    year = month >= nowMonth ? nowYear : nowYear + 1;
  }
  return { year, month };
}
function extractNightsFromText(message: string): number | undefined {
  const t = message.toLowerCase();
  if (/\b(a\s+week|one\s+week|1\s+week)\b/.test(t)) return 7;
  const nn = t.match(/\bfor\s+(\d+)\s+nights?\b/i) || t.match(/\b(\d+)\s+nights?\b/i);
  if (nn) {
    const n = parseInt(nn[1], 10);
    if (Number.isFinite(n)) return Math.max(1, Math.min(30, n));
  }
  if (/\b(long\s+weekend)\b/.test(t)) return 3;
  return undefined;
}
function parseMonthAvailabilityRequest(message: string): { year: number; month: number; nights: number } | null {
  const t = message.toLowerCase();
  const mm = extractMonthYearFromText(t);
  if (!mm.month || !mm.year) return null;
  let nights = extractNightsFromText(t);
  if (!nights) nights = 7;
  return { year: mm.year!, month: mm.month!, nights };
}

/* ---------- Simple extractors & helpers ---------- */
function extractIsoDate(message: string): string | null {
  const m = message.match(/\b(\d{4}-\d{2}-\d{2})\b/);
  return m ? m[1] : null;
}
function extractExplicitNightsStrict(message: string): number | undefined {
  const m = message.toLowerCase().match(/\bfor\s+(\d{1,2})\s+nights?\b/);
  if (!m) return undefined;
  const n = parseInt(m[1], 10);
  if (Number.isFinite(n) && n >= 1 && n <= 30) return n;
  return undefined;
}
async function withTimeout<T>(p: Promise<T>, ms = 2000, onTimeout: () => T): Promise<T> {
  let to: NodeJS.Timeout;
  return await Promise.race([
    p.finally(() => clearTimeout(to)),
    new Promise<T>(resolve => { to = setTimeout(() => resolve(onTimeout()), ms); })
  ]);
}
function fmtGBP(n: number): string {
  return `£${(Math.round(n * 100) / 100).toFixed(2)}`;
}

/* ---------- Price gating for options ---------- */
/** small LRU-ish cache to avoid repeated quoting while filtering */
const PRICE_CACHE = new Map<string, { when: number; total: number }>();
const PRICE_TTL = 60 * 1000; // 60s

async function getPriceTotal(from: string, nights: number): Promise<number> {
  const key = `${from}|${nights}`;
  const now = Date.now();
  const hit = PRICE_CACHE.get(key);
  if (hit && (now - hit.when) < PRICE_TTL) return hit.total;

  const q = await withTimeout(
    quoteForStay({ from, nights, dogs: 0 }),
    2500,
    () => ({ total: 0 } as any)
  );
  const total = (q && typeof (q as any).total === 'number') ? (q as any).total : 0;
  PRICE_CACHE.set(key, { when: now, total });
  return total;
}

/**
 * Filter availability options to those that Bookalet can price (total > 0).
 * Limits how many we probe to keep latency predictable.
 */
async function filterOptionsWithPrice(
  options: Array<{ from: string; nights: number }>,
  nights: number,
  probeLimit = 24
): Promise<Array<{ from: string; nights: number; total: number }>> {
  const subset = options.slice(0, probeLimit);
  const priced = await Promise.all(subset.map(async o => {
    const total = await getPriceTotal(o.from, nights);
    return { from: o.from, nights, total };
  }));
  return priced.filter(p => p.total > 0);
}

/* ---------- Chat ---------- */
const ChatReq = z.object({ message: z.string().min(1).max(2000) });
app.post('/api/chat', async (req, res) => {
  const parsed = ChatReq.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const message = parsed.data.message;
  const session = getSession(req);

  // record user message
  pushMessage(session, 'user', message);

  // 1) Chit-chat
  if (isChitChat(message)) {
    const answer = replyChitChat(message);
    pushMessage(session, 'assistant', answer);
    return res.json({ answer });
  }

  // 2) Pending date pick: keep nights sticky
  if ((session as any).pending?.kind === 'awaiting-date-pick') {
    const picked = extractIsoDate(message);
    if (picked) {
      const nights = (session as any).pending.nights;
      (session as any).pending = undefined;
      (session as any).prefs = (session as any).prefs || {};
      (session as any).prefs.lastRequestedNights = nights;

      const available = isRangeAvailable(picked, nights);
      if (available) {
        const q = await quoteForStay({ from: picked, nights, dogs: 0 });
        const answer = `✅ Available from ${picked} for ${nights} night(s). Estimated total: ${q.currency} ${q.total}. Would you like the booking link?`;
        pushMessage(session, 'assistant', answer);
        return res.json({ answer });
      } else {
        const alts = suggestAlternatives(picked, nights, 12).slice(0, 10);
        const filtered = await filterOptionsWithPrice(alts, nights, 10);
        const priced = filtered.map(a => `${a.from} — ${fmtGBP(a.total)}`);
        const answer = `❌ Sorry, those dates look unavailable.${priced.length ? ` Closest alternatives: ${priced.join(', ')}.` : ''}`;
        pushMessage(session, 'assistant', answer);
        return res.json({ answer });
      }
    }
  }

  // 3) Nearby-month follow-ups
  if ((session as any).pending?.kind === 'ask-nearby-months') {
    let { year, month, nights } = (session as any).pending;

    const mm = extractMonthYearFromText(message);
    if (mm.month) month = mm.month!;
    if (mm.year) year = mm.year!;
    const n2 = extractNightsFromText(message);
    if (typeof n2 === 'number') nights = n2;

    if (/^\s*next\s*$/i.test(message)) { month += 1; if (month > 12) { month = 1; year += 1; } }
    if (/^\s*prev(ious)?\s*$/i.test(message)) { month -= 1; if (month < 1) { month = 12; year -= 1; } }

    if (/\b(no|nope|nah|not now|cancel|stop)\b/i.test(message)) {
      (session as any).pending = undefined;
      const answer = "No problem. Would you like me to search a different month or a different length of stay?";
      pushMessage(session, 'assistant', answer);
      return res.json({ answer });
    }

    // Find availability and then **filter by price**
    const opts = findAvailabilityInMonth(year, month, nights, 50);
    const pricedOpts = await filterOptionsWithPrice(opts, nights, 24);

    if (pricedOpts.length) {
      (session as any).prefs = (session as any).prefs || {};
      (session as any).prefs.lastRequestedNights = nights;
      (session as any).pending = { kind: 'awaiting-date-pick', nights };

      const niceMonth = MONTHS[month - 1][0].toUpperCase() + MONTHS[month - 1].slice(1);
      const lines = pricedOpts.slice(0, 12).map(p => `• ${p.from} (${nights} nights) — ${fmtGBP(p.total)}`);
      const answer = `Here are options in ${niceMonth} ${year}:\n\n${lines.join('\n')}\n\nTell me which date you prefer (e.g., 2026-08-14).`;
      pushMessage(session, 'assistant', answer);
      return res.json({ answer });
    } else {
      (session as any).pending = { kind: 'ask-nearby-months', year, month, nights };
      const niceMonth = MONTHS[month - 1][0].toUpperCase() + MONTHS[month - 1].slice(1);
      const answer = `I couldn’t find any priceable ${nights}-night options in ${niceMonth} ${year}. Say "next" to check the following month, or tell me a different month/length.`;
      pushMessage(session, 'assistant', answer);
      return res.json({ answer });
    }
  }

  // 4) Flexible month request (first time)
  const flex = parseMonthAvailabilityRequest(message);
  if (flex) {
    const { year, month, nights } = flex;

    (session as any).prefs = (session as any).prefs || {};
    (session as any).prefs.lastRequestedNights = nights;

    // Find availability then **filter by price**
    const opts = findAvailabilityInMonth(year, month, nights, 100);
    const pricedOpts = await filterOptionsWithPrice(opts, nights, 24);

    if (pricedOpts.length) {
      (session as any).pending = { kind: 'awaiting-date-pick', nights };
      const niceMonth = MONTHS[month-1][0].toUpperCase()+MONTHS[month-1].slice(1);
      const lines = pricedOpts.slice(0, 12).map(p => `• ${p.from} (${nights} nights) — ${fmtGBP(p.total)}`);
      const answer =
        `Here are the available start dates in ${niceMonth} ${year} (priced):\n` +
        lines.join('\n') +
        `\n\nTell me which one you’d like (e.g., 2026-08-14).`;
      pushMessage(session, 'assistant', answer);
      return res.json({ answer });
    } else {
      (session as any).pending = { kind: 'ask-nearby-months', year, month, nights };
      const niceMonth = MONTHS[month - 1][0].toUpperCase() + MONTHS[month - 1].slice(1);
      const answer = `I couldn’t find any priceable ${nights}-night options in ${niceMonth} ${year}. Would you like me to look at nearby months or try a different length of stay?`;
      pushMessage(session, 'assistant', answer);
      return res.json({ answer });
    }
  }

  // 5) Booking flow for specific dates OR date-only replies
  {
    const dateOnly = extractIsoDate(message);
    let requestedNights =
      extractExplicitNightsStrict(message) ??
      (session as any).prefs?.lastRequestedNights ??
      undefined;
    let requestedFrom = dateOnly || '';

    const bookingIntent = isBookingLikeHeuristic(message) || !!dateOnly;
    if (bookingIntent && !requestedFrom && process.env.OPENAI_API_KEY) {
      try {
        const intent = await interpretMessageWithLLM(message);
        if ((intent as any)?.kind === 'dates') {
          requestedFrom = (intent as any).from || requestedFrom;
          if (requestedNights == null && typeof (intent as any).nights === 'number') {
            requestedNights = (intent as any).nights;
          }
        }
      } catch (e) {
        console.warn('[chat] LLM extract failed — continuing with heuristics:', (e as any)?.message || e);
      }
    }
    if (!requestedNights) requestedNights = 7;

    if (requestedFrom) {
      (session as any).prefs = (session as any).prefs || {};
      (session as any).prefs.lastRequestedNights = requestedNights;

      const available = isRangeAvailable(requestedFrom, requestedNights);
      if (available) {
        const q = await quoteForStay({ from: requestedFrom, nights: requestedNights, dogs: 0 });
        const answer = `✅ Available from ${requestedFrom} for ${requestedNights} night(s). Estimated total: ${q.currency} ${q.total}. Would you like the booking link?`;
        pushMessage(session, 'assistant', answer);
        return res.json({ answer });
      } else {
        // Suggest alternatives, but **only ones with a price**
        const alts = suggestAlternatives(requestedFrom, requestedNights, 20);
        const filtered = await filterOptionsWithPrice(alts, requestedNights, 12);
        const priced = filtered.map(a => `${a.from} — ${fmtGBP(a.total)}`);

        // keep nights sticky if they pick an alternative next
        (session as any).pending = { kind: 'awaiting-date-pick', nights: requestedNights };

        const answer = `❌ Sorry, those dates look unavailable.${priced.length ? ` Closest priceable alternatives: ${priced.join(', ')}.` : ' I couldn’t find priceable alternatives right now.'}`;
        pushMessage(session, 'assistant', answer);
        return res.json({ answer });
      }
    }
  }

  // 6) General questions → RAG (pass history for better phrasing)
  try {
    const ans = await answerWithContext(message, getRecentMessages(session, 8));
    const answer = ans.answer;
    pushMessage(session, 'assistant', answer);
    return res.json(ans);
  } catch {
    const answer = 'I had trouble contacting the AI service. Please try again.';
    pushMessage(session, 'assistant', answer);
    return res.json({ answer });
  }
});

/* ---------- Admin & boot tasks ---------- */
app.post('/admin/ics/refresh', async (req, res) => {
  if (req.headers['x-admin-token'] !== process.env.ADMIN_TOKEN) return res.status(401).json({ error: 'unauthorized' });
  await refreshIcs(true);
  res.json({ ok: true, ics: getIcsStats?.() });
});

app.post('/admin/ingest-site', async (req, res) => {
  if (req.headers['x-admin-token'] !== process.env.ADMIN_TOKEN) return res.status(401).json({ error: 'unauthorized' });
  try {
    const baseUrl = String(req.body?.baseUrl || req.query.baseUrl || process.env.SITE_BASE_URL || '');
    if (!/^https?:\/\//i.test(baseUrl)) return res.status(400).json({ error: 'Provide ?baseUrl=https://yoursite or set SITE_BASE_URL' });
    const sitemapUrl = String(req.body?.sitemap || req.query.sitemap || process.env.SITEMAP_URL || '');
    const includeRe = (process.env.CRAWL_INCLUDE || req.body?.include || req.query.include) ? new RegExp(String(process.env.CRAWL_INCLUDE || req.body?.include || req.query.include)) : undefined;
    const excludeRe = (process.env.CRAWL_EXCLUDE || req.body?.exclude || req.query.exclude) ? new RegExp(String(process.env.CRAWL_EXCLUDE || req.body?.exclude || req.query.exclude)) : undefined;
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

const PORT = Number(process.env.PORT) || 3000;
app.listen(PORT, async () => {
  console.log(`Server listening on :${PORT}`);
  refreshContentIndex().catch(e => console.error('[rag] init error', e));
  initSessionSweeper();

  refreshIcs().catch(e => console.error('[ics] init error', e));

  // PDFs
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
    } catch (e) { console.error('[pdf] boot ingest failed:', entry, e); }
  }

  // Crawl website if configured
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
    } catch (e) { console.error('[crawl] boot crawl failed:', e); }
  }
});

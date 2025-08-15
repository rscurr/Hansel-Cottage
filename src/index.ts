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
async function classifyIntentLLM(
  message: string,
  history: Array<{role:'user'|'assistant',content:string}>
): Promise<'booking'|'info'|'unknown'> {
  if (!process.env.OPENAI_API_KEY) return 'unknown';
  try {
    const messages = [
      { role: 'system', content: 'Classify as "booking" (dates/prices/reservation) or "info" (general property questions). Reply ONLY "booking" or "info". Consider the recent conversation.' },
      ...history.slice(-6),
      { role: 'user', content: message }
    ];
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
      body: JSON.stringify({ model: 'gpt-4o-mini', temperature: 0, messages })
    });
    if (!res.ok) return 'unknown';
    const j: any = await res.json();
    const label = String(j.choices?.[0]?.message?.content || '').toLowerCase().trim();
    if (label.includes('booking')) return 'booking';
    if (label.includes('info')) return 'info';
    return 'unknown';
  } catch { return 'unknown'; }
}

/* ---------- Flexible month availability ---------- */
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

/* ---------- Robust follow-up helpers ---------- */
function isNegative(raw: string) {
  let t = raw.trim().toLowerCase().replace(/[!.\s]+$/g, '');
  return (
    /^n$/.test(t) ||
    /\b(no|nope|nah|not now|cancel|stop|don’t|do not|rather not|no thanks|no thank you)\b/.test(t)
  );
}
function isAffirmative(raw: string) {
  let t = raw.trim().toLowerCase().replace(/[!.\s]+$/g, '');
  if (isNegative(t)) return false;
  if (/\b(yes|yeah|yep|yup|sure|certainly|absolutely|of course|please do|go ahead|do it|ok|okay|alright|all right|sounds good|that works|that would be great|yes please|yes please do|yes go ahead|yes do)\b/.test(t)) return true;
  return /^y$/.test(t);
}
function wantsNext(t: string) {
  t = t.trim().toLowerCase();
  return /\bnext\b/.test(t);
}
function wantsPrevious(t: string) {
  t = t.trim().toLowerCase();
  return /\bprev(ious)?\b/.test(t);
}

/* ---------- helpers: price peek with timeout ---------- */
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

  // 2) Handle pending follow-ups FIRST (nearby months)
  if (session.pending?.kind === 'ask-nearby-months') {
    let { year, month, nights } = session.pending;

    // parse tweaks in follow-up
    const mm = extractMonthYearFromText(message);
    if (mm.month) month = mm.month!;
    if (mm.year) year = mm.year!;
    const n2 = extractNightsFromText(message);
    if (typeof n2 === 'number') nights = n2;

    if (wantsNext(message)) { month += 1; if (month > 12) { month = 1; year += 1; } }
    if (wantsPrevious(message)) { month -= 1; if (month < 1) { month = 12; year -= 1; } }

    if (isNegative(message)) {
      session.pending = undefined;
      const answer = "No problem. Would you like me to search a different month or a different length of stay?";
      pushMessage(session, 'assistant', answer);
      return res.json({ answer });
    }

    if (isAffirmative(message) || wantsNext(message) || wantsPrevious(message) || mm.month || typeof n2 === 'number') {
      const monthsToScan = isAffirmative(message) && !mm.month && typeof n2 !== 'number' ? [0, 1, 2] : [0];
      const results: Array<{ year: number; month: number; nights: number; options: Array<{ from: string; nights: number }> }> = [];
      for (const delta of monthsToScan) {
        let y = year, m = month + delta;
        while (m > 12) { m -= 12; y += 1; }
        const opts = findAvailabilityInMonth(y, m, nights, 20);
        if (opts.length) results.push({ year: y, month: m, nights, options: opts });
      }

      if (results.length) {
        session.pending = undefined;

        // Attach price peeks (first 5 per bucket to keep it snappy)
        const bullets: string[] = [];
        for (const r of results) {
          const niceMonth = MONTHS[r.month - 1][0].toUpperCase() + MONTHS[r.month - 1].slice(1);
          const subset = r.options.slice(0, 5);
          const priced = await Promise.all(subset.map(async o => {
            const q = await withTimeout(
              quoteForStay({ from: o.from, nights: r.nights, dogs: 0 }),
              2000,
              () => ({ total: 0, currency: 'GBP', from: o.from, nights: r.nights, dogs: 0, lineItems: [], subtotal: 0, tax: 0, nightly: [] } as any)
            );
            const priceTxt = q && typeof (q as any).total === 'number' && (q as any).total > 0 ? ` — ${fmtGBP((q as any).total)}` : '';
            return `• ${o.from} (${r.nights} nights)${priceTxt}`;
          }));
          bullets.push(`**${niceMonth} ${r.year}**\n` + priced.join('\n'));
        }

        const answer = `Here are options I found:\n\n${bullets.join('\n\n')}\n\nTell me which date you prefer, or say "next" to see the following month.`;
        pushMessage(session, 'assistant', answer);
        return res.json({ answer });
      } else {
        session.pending = { kind: 'ask-nearby-months', year, month, nights };
        const niceMonth = MONTHS[month - 1][0].toUpperCase() + MONTHS[month - 1].slice(1);
        const answer = `I still can’t find a ${nights}-night opening in ${niceMonth} ${year}. Say "next" to check the following month, or tell me a different month or length of stay.`;
        pushMessage(session, 'assistant', answer);
        return res.json({ answer });
      }
    }
  }

  // 3) Flexible month request (first time)
  const flex = parseMonthAvailabilityRequest(message);
  if (flex) {
    const { year, month, nights } = flex;
    const options = findAvailabilityInMonth(year, month, nights, 20);
    if (options.length) {
      // Price the first 8 to keep latency reasonable
      const first = options.slice(0, 8);
      const priced = await Promise.all(first.map(async o => {
        const q = await withTimeout(
          quoteForStay({ from: o.from, nights, dogs: 0 }),
          2000,
          () => ({ total: 0 } as any)
        );
        const priceTxt = q && typeof (q as any).total === 'number' && (q as any).total > 0 ? ` — ${fmtGBP((q as any).total)}` : '';
        return `• ${o.from} (${nights} nights)${priceTxt}`;
      }));
      const niceMonth = MONTHS[month-1][0].toUpperCase()+MONTHS[month-1].slice(1);
      const answer =
        `Here are the available start dates in ${niceMonth} ${year} for ${nights} night(s):\n` +
        priced.join('\n') +
        `\n\nTell me which one you’d like and I can price it in full and give you booking steps.`;
      pushMessage(session, 'assistant', answer);
      return res.json({ answer });
    } else {
      const niceMonth = MONTHS[month - 1][0].toUpperCase() + MONTHS[month - 1].slice(1);
      session.pending = { kind: 'ask-nearby-months', year, month, nights };
      const answer = `I couldn’t find a ${nights}-night opening in ${niceMonth} ${year}. Would you like me to look at nearby months or try a different length of stay?`;
      pushMessage(session, 'assistant', answer);
      return res.json({ answer });
    }
  }

  // 4) Booking intent decision (consider history)
  let bookingIntent = false;
  try {
    const label = await classifyIntentLLM(message, getRecentMessages(session, 6));
    bookingIntent = (label === 'booking') ? true : (label === 'info') ? false : isBookingLikeHeuristic(message);
  } catch {
    bookingIntent = isBookingLikeHeuristic(message);
  }

  // 5) Booking flow for specific dates
  if (bookingIntent) {
    try {
      const intent = await interpretMessageWithLLM(message);
      if (intent.kind === 'dates') {
        const available = isRangeAvailable(intent.from, intent.nights);
        if (available) {
          const q = await quoteForStay({ from: intent.from, nights: intent.nights, dogs: 0 });
          const answer = `✅ Available from ${intent.from} for ${intent.nights} night(s). Estimated total: ${q.currency} ${q.total}. Would you like the booking link?`;
          pushMessage(session, 'assistant', answer);
          return res.json({ answer });
        } else {
          const alts = suggestAlternatives(intent.from, intent.nights, 6).slice(0, 5);
          // Price peeks for alternatives
          const priced = await Promise.all(alts.map(async a => {
            const q = await withTimeout(
              quoteForStay({ from: a.from, nights: intent.nights, dogs: 0 }),
              2000,
              () => ({ total: 0 } as any)
            );
            const priceTxt = q && typeof (q as any).total === 'number' && (q as any).total > 0 ? ` — ${fmtGBP((q as any).total)}` : '';
            return `${a.from}${priceTxt}`;
          }));
          const answer = `❌ Sorry, those dates look unavailable.${priced.length ? ` Closest alternatives: ${priced.join(', ')}.` : ''}`;
          pushMessage(session, 'assistant', answer);
          return res.json({ answer });
        }
      }
      // If LLM didn't produce dates, fall through to RAG
    } catch (e) {
      console.warn('[chat] LLM extract failed — falling back to RAG:', (e as any)?.message || e);
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

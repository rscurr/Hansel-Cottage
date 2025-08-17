// src/index.ts
// Hansel Cottage chatbot server (compat mode).
// - ICS scan + Bookalet price validation
// - RAG for PDFs/site
// - Flexible narrowing follow-ups, but auto-escapes narrowing when the next turn isn't about dates
// - Accepts {message}|{text}|{question}; optional conversationId (auto if missing)
// - Returns {answer, reply, message, text, success, history}
// - /chat and /api/chat routes
// - PDF boot ingest logs
// - Node16 module resolution friendly (.js imports)

import express from 'express';
import cors from 'cors';
import bodyParser from 'body-parser';
import path from 'node:path';
import { parseISO, getDay, getDate } from 'date-fns';

import {
  refreshIcs,
  findAvailabilityInMonth,
  isRangeAvailable,
  suggestAlternatives
} from './ics.js';

import { quoteForStay } from './pricing.js';
import { interpretMessageWithLLM } from './nlp.js';
import {
  answerWithContext,
  refreshContentIndex,
  addExternalDocumentToIndex
} from './rag.js';
import { extractPdfTextFromUrl, extractPdfTextFromFile } from './pdf.js';

const PORT = Number(process.env.PORT || 3000);

/* ---------- CORS (comma-separated origins, null allowed for local files) ---------- */
const allowedList = (process.env.ALLOWED_ORIGIN || '*')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

const app = express();
app.use(cors({
  origin(origin, cb) {
    if (!origin) return cb(null, true);
    if (allowedList.includes('*') || allowedList.includes(origin)) return cb(null, true);
    return cb(new Error('Not allowed by CORS'));
  },
  credentials: false,
  allowedHeaders: ['Content-Type', 'X-Session-Id'],
  methods: ['GET', 'POST', 'OPTIONS']
}));
app.options('*', cors());
app.use(bodyParser.json());

// Serve static (for /public PDFs)
const publicDir = path.resolve(process.cwd(), 'public');
app.use(express.static(publicDir));

/* ---------- Tiny session store ---------- */
type ChatMessage = { role: 'user' | 'assistant'; content: string };
const conversations = new Map<string, ChatMessage[]>();
function getHistory(id: string) { if (!conversations.has(id)) conversations.set(id, []); return conversations.get(id)!; }
function addToHistory(id: string, msg: ChatMessage) {
  const hist = getHistory(id); hist.push(msg);
  if (hist.length > 40) hist.splice(0, hist.length - 40);
}
function makeSessionId(req: express.Request): string {
  const fromHeader = (req.headers['x-session-id'] as string) || '';
  if (fromHeader) return String(fromHeader);
  const ua = (req.headers['user-agent'] || '').toString();
  const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').toString();
  const seed = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}-${ua.slice(0,12)}-${ip.slice(0,12)}`;
  return Buffer.from(seed).toString('base64').replace(/[^a-zA-Z0-9]/g, '').slice(0, 24);
}

/* ---------- Narrowing follow-up memory ---------- */
type PendingNarrow = { year: number; month: number; nights: number };
const pendingNarrowByConv = new Map<string, PendingNarrow>();

/* ---------- Helpers ---------- */
function okPayload(answer: string, history: ChatMessage[]) {
  return { success: true, answer, reply: answer, message: answer, text: answer, history };
}
function errPayload(answer: string, history: ChatMessage[]) {
  return { success: false, answer, reply: answer, message: answer, text: answer, history };
}
function isoFromBody(body: any): string | null {
  const raw = String(body.message ?? body.text ?? body.question ?? '');
  const m = raw.match(/\b(\d{4}-\d{2}-\d{2})\b/);
  return m ? m[1] : null;
}

/* ---------- Flexible narrowing parsing ---------- */
const WEEKDAY_NAMES: Record<string, number> = {
  sunday: 0, sun: 0, monday: 1, mon: 1, tuesday: 2, tue: 2, tues: 2,
  wednesday: 3, wed: 3, thursday: 4, thu: 4, thurs: 4, friday: 5, fri: 5, saturday: 6, sat: 6
};
type NarrowFilter =
  | { kind: 'fridays' }
  | { kind: 'weekdays' }
  | { kind: 'weekends' }
  | { kind: 'weekday'; dow: number }
  | { kind: 'early' }
  | { kind: 'mid' }
  | { kind: 'late' }
  | { kind: 'firsthalf' }
  | { kind: 'secondhalf' }
  | { kind: 'around'; day: number; dow?: number }
  | { kind: 'dayrange'; lo: number; hi: number }
  | { kind: 'weeknum'; n: 1|2|3|4|5 }
  | { kind: 'nthWeekday'; n: 1|2|3|4|5; dow: number }
  | { kind: 'date'; date: string };

function parseOrdinalWord(t: string): 1|2|3|4|5|null {
  if (/\b(first|1st)\b/.test(t)) return 1;
  if (/\b(second|2nd)\b/.test(t)) return 2;
  if (/\b(third|3rd)\b/.test(t)) return 3;
  if (/\b(fourth|4th)\b/.test(t)) return 4;
  if (/\b(fifth|5th)\b/.test(t)) return 5;
  return null;
}

function parseNarrowing(msg: string): NarrowFilter | null {
  const t = msg.trim().toLowerCase();
  const dateMatch = t.match(/\b(\d{4}-\d{2}-\d{2})\b/);
  if (dateMatch) return { kind: 'date', date: dateMatch[1] };
  if (/\b(friday|fridays)\b/.test(t)) return { kind: 'fridays' };
  if (/\b(weekday|weekdays|midweek|mid-week)\b/.test(t)) return { kind: 'weekdays' };
  if (/\b(weekend|weekends)\b/.test(t)) return { kind: 'weekends' };
  for (const name in WEEKDAY_NAMES) if (new RegExp(`\\b${name}\\b`).test(t)) return { kind: 'weekday', dow: WEEKDAY_NAMES[name] };
  if (/\b(first\s+half|1st\s+half|first\s+part|beginning\s+of\s+the\s+month)\b/.test(t)) return { kind: 'firsthalf' };
  if (/\b(second\s+half|2nd\s+half|last\s+half|end\s+of\s+the\s+month)\b/.test(t)) return { kind: 'secondhalf' };
  if (/\b(mid[-\s]?month|middle)\b/.test(t)) return { kind: 'mid' };
  if (/\b(early|start|beginning)\b/.test(t)) return { kind: 'early' };
  if (/\b(late|end|ending|last)\b/.test(t)) return { kind: 'late' };
  const aroundWk = t.match(/\baround(?:\s+(mon|monday|tue|tues|tuesday|wed|wednesday|thu|thurs|thursday|fri|friday|sat|saturday|sun|sunday))?(?:\s+the)?\s+(\d{1,2})(?:st|nd|rd|th)?\b/);
  if (aroundWk) { const wd = aroundWk[1] ? WEEKDAY_NAMES[aroundWk[1]] : undefined; const d = parseInt(aroundWk[2], 10); if (d >= 1 && d <= 31) return { kind: 'around', day: d, dow: wd }; }
  const range1 = t.match(/\b(\d{1,2})(?:st|nd|rd|th)?\s*(?:-|to|–|—|and)\s*(\d{1,2})(?:st|nd|rd|th)?\b/);
  if (range1) { const lo = parseInt(range1[1], 10); const hi = parseInt(range1[2], 10); if (lo >= 1 && hi >= lo && hi <= 31) return { kind: 'dayrange', lo, hi }; }
  const ord = parseOrdinalWord(t);
  if (ord && /\bweek\b/.test(t)) return { kind: 'weeknum', n: ord };
  if (ord) for (const name in WEEKDAY_NAMES) if (new RegExp(`\\b${name}\\b`).test(t)) return { kind: 'nthWeekday', n: ord as 1|2|3|4|5, dow: WEEKDAY_NAMES[name] };
  const justAround = t.match(/\baround(?:\s+the)?\s+(\d{1,2})(?:st|nd|rd|th)?\b/);
  if (justAround) { const d = parseInt(justAround[1], 10); if (d >= 1 && d <= 31) return { kind: 'around', day: d }; }
  return null;
}

function applyNarrowingFilter(dates: Array<{ from: string; price: number }>, f: NarrowFilter) {
  const byDay = (pred: (day: number) => boolean) => dates.filter(d => pred(getDate(parseISO(d.from))));
  const byDOW = (pred: (dow: number) => boolean) => dates.filter(d => pred(getDay(parseISO(d.from))));
  switch (f.kind) {
    case 'date': return dates.filter(d => d.from === f.date);
    case 'fridays':
    case 'weekends': return byDOW(dow => dow === 5);
    case 'weekdays': return byDOW(dow => dow >= 1 && dow <= 4);
    case 'weekday': return byDOW(dow => dow === f.dow);
    case 'early': return byDay(day => day <= 10);
    case 'mid': return byDay(day => day >= 10 && day <= 20);
    case 'late': return byDay(day => day >= 21);
    case 'firsthalf': return byDay(day => day <= 15);
    case 'secondhalf': return byDay(day => day >= 16);
    case 'around': return dates.filter(d => { const day = getDate(parseISO(d.from)); const ok = Math.abs(day - f.day) <= 3; if (f.dow == null) return ok; const dow = getDay(parseISO(d.from)); return ok && dow === f.dow; });
    case 'dayrange': return byDay(day => day >= f.lo && day <= f.hi);
    case 'weeknum': { const ranges: Record<number,[number,number]> = {1:[1,7],2:[8,14],3:[15,21],4:[22,28],5:[29,31]}; const [lo,hi]=ranges[f.n]; return byDay(day => day >= lo && day <= hi); }
    case 'nthWeekday': { const ranges: Record<number,[number,number]> = {1:[1,7],2:[8,14],3:[15,21],4:[22,28],5:[29,31]}; const [lo,hi]=ranges[f.n]; return dates.filter(d => { const dt=parseISO(d.from); const day=getDate(dt); const dow=getDay(dt); return (day>=lo && day<=hi) && (dow===f.dow); }); }
  }
}

/* ---------- Core chat handler ---------- */
async function handleChat(req: express.Request, res: express.Response) {
  const body: any = req.body || {};
  const message: string = String(body.message ?? body.text ?? body.question ?? '').trim();
  let conversationId: string = String(body.conversationId ?? '').trim();
  if (!message) return res.status(400).json(errPayload('Message is required', []));
  if (!conversationId) conversationId = makeSessionId(req);

  const history = getHistory(conversationId);
  addToHistory(conversationId, { role: 'user', content: message });

  // If we’re in a narrowing state, only use it when the message is really a narrowing cue.
  let pending = pendingNarrowByConv.get(conversationId);
  if (pending) {
    const navNext = /^\s*next\s*$/i.test(message);
    const navPrev = /^\s*prev(ious)?\s*$/i.test(message);
    const explicitDate = isoFromBody(body);
    const nf0 = parseNarrowing(message);

    if (navNext || navPrev) {
      let { year, month } = pending;
      if (navNext) { month += 1; if (month > 12) { month = 1; year += 1; } }
      if (navPrev) { month -= 1; if (month < 1) { month = 12; year -= 1; } }
      pending = { ...pending, year, month };
      pendingNarrowByConv.set(conversationId, pending);
      const phantomIntent = { kind: 'month', year, month, nights: pending.nights } as const;
      return await runMonthFlow(phantomIntent, conversationId, history, res, /*keepPending*/ true);
    }

    if (explicitDate) {
      const nights = pending.nights;
      await refreshIcs();
      if (!isRangeAvailable(explicitDate, nights)) {
        const answer = '❌ Sorry, that date looks unavailable. Would you like me to try nearby Fridays or a different length of stay?';
        addToHistory(conversationId, { role: 'assistant', content: answer });
        return res.json(okPayload(answer, history));
      }
      const q = await quoteForStay({ from: explicitDate, nights });
      if (q.total <= 0) {
        const answer = 'That date doesn’t appear to be a valid start day. Would you like me to show valid (priced) starts for that period?';
        addToHistory(conversationId, { role: 'assistant', content: answer });
        return res.json(okPayload(answer, history));
      }
      const answer = `✅ Available from ${explicitDate} for ${nights} night(s). Estimated total: GBP ${q.total.toFixed(2)}. Would you like the booking link?`;
      addToHistory(conversationId, { role: 'assistant', content: answer });
      pendingNarrowByConv.delete(conversationId);
      return res.json(okPayload(answer, history));
    }

    if (nf0) {
      const { year, month, nights } = pending;
      await refreshIcs();
      const candidates = findAvailabilityInMonth(year, month, nights, 200);
      const priced: { from: string; price: number }[] = [];
      for (const c of candidates) {
        try { const q = await quoteForStay({ from: c.from, nights: c.nights }); if (q.total > 0) priced.push({ from: c.from, price: q.total }); } catch {}
      }
      let narrowed = applyNarrowingFilter(priced, nf0);
      if (!narrowed.length) {
        const example = priced.length ? priced[0].from : `${year}-${String(month).padStart(2,'0')}-18`;
        const answer = `I couldn’t find priced options with that preference. Try a specific date (e.g., ${example}) or say “Fridays only”, “weekdays only”, “first half”, “second half”, “between 10th and 20th”, or “around the 18th”.`;
        addToHistory(conversationId, { role: 'assistant', content: answer });
        return res.json(okPayload(answer, history));
      }
      if (narrowed.length > 6) {
        const answer = `There are still quite a few options. Could you pick a specific date in that range (e.g., ${narrowed[0].from})?`;
        addToHistory(conversationId, { role: 'assistant', content: answer });
        return res.json(okPayload(answer, history));
      }
      const lines = narrowed.slice(0, 6).map(v => `• ${v.from} (${nights} nights) — £${v.price.toFixed(2)}`).join('\n');
      const answer = `Here are the options I found:\n${lines}\n\nTell me which date you prefer.`;
      addToHistory(conversationId, { role: 'assistant', content: answer });
      return res.json(okPayload(answer, history));
    }

    // Not a narrowing cue — ask LLM what this message is. If it's not a dates/month intent, exit narrowing and answer normally.
    try {
      const intentProbe = await interpretMessageWithLLM(message);
      if (intentProbe.kind !== 'dates' && intentProbe.kind !== 'month') {
        pendingNarrowByConv.delete(conversationId); // <-- escape narrowing
        const rag = await answerWithContext(message, history);
        addToHistory(conversationId, { role: 'assistant', content: rag.answer });
        return res.json(okPayload(rag.answer, history));
      }
      // if it *is* a dates/month intent, continue below to the main intent handler
    } catch {
      // If the probe fails, be safe: clear narrowing and answer normally.
      pendingNarrowByConv.delete(conversationId);
      const rag = await answerWithContext(message, history);
      addToHistory(conversationId, { role: 'assistant', content: rag.answer });
      return res.json(okPayload(rag.answer, history));
    }
  }

  // ---- No (active) narrowing, run main intents ----
  try {
    const intent = await interpretMessageWithLLM(message);

    if (intent.kind === 'dates') {
      await refreshIcs();
      const { from, nights } = intent;

      if (!isRangeAvailable(from, nights)) {
        const alts = suggestAlternatives(from, nights, 16);
        const priced: { from: string; price: number }[] = [];
        for (const a of alts) { try { const q = await quoteForStay({ from: a.from, nights: a.nights }); if (q.total > 0) priced.push({ from: a.from, price: q.total }); } catch {} }
        const lines = priced.slice(0, 6).map(v => `• ${v.from} — £${v.price.toFixed(2)}`).join('\n');
        const answer = `❌ Sorry, those dates look unavailable.${lines ? ` Closest priceable alternatives:\n${lines}` : ''}`;
        addToHistory(conversationId, { role: 'assistant', content: answer });
        return res.json(okPayload(answer, history));
      }

      const q = await quoteForStay({ from, nights });
      const answer = `✅ Available from ${from} for ${nights} night(s). Estimated total: GBP ${q.total.toFixed(2)}. Would you like the booking link?`;
      addToHistory(conversationId, { role: 'assistant', content: answer });
      return res.json(okPayload(answer, history));
    }

    if (intent.kind === 'month') {
      return await runMonthFlow(intent, conversationId, history, res, /*keepPending*/ false);
    }

    // General questions → RAG
    const rag = await answerWithContext(message, history);
    addToHistory(conversationId, { role: 'assistant', content: rag.answer });
    return res.json(okPayload(rag.answer, history));

  } catch (e: any) {
    console.error('chat error', e?.message || e);
    const answer = '⚠️ Sorry, something went wrong. Please try again.';
    addToHistory(conversationId, { role: 'assistant', content: answer });
    return res.json(errPayload(answer, history));
  }
}

/* ---------- Month flow helper ---------- */
async function runMonthFlow(
  intent: { kind: 'month'; year: number; month: number; nights: number },
  conversationId: string,
  history: ChatMessage[],
  res: express.Response,
  keepPending: boolean
) {
  await refreshIcs();
  const { year, month, nights } = intent;
  const candidates = findAvailabilityInMonth(year, month, nights, 220);

  const valid: { from: string; price: number }[] = [];
  for (const c of candidates) {
    try { const q = await quoteForStay({ from: c.from, nights: c.nights }); if (q.total > 0) valid.push({ from: c.from, price: q.total }); } catch {}
  }

  if (!valid.length) {
    const answer = `❌ I couldn’t find a ${nights}-night opening in ${year}-${String(month).padStart(2, '0')}.`;
    addToHistory(conversationId, { role: 'assistant', content: answer });
    return res.json(okPayload(answer, history));
  }

  if (valid.length > 6) {
    pendingNarrowByConv.set(conversationId, { year, month, nights });
    const answer = `We have lots of dates available then. You can narrow it down with “Fridays only”, any weekday (e.g., “Monday”), “weekdays only”, “first/second week”, “first/second half”, “mid-month”, “between 10th and 20th”, “around the 18th”, “second Friday”, or say “next/previous” to change month.`;
    addToHistory(conversationId, { role: 'assistant', content: answer });
    return res.json(okPayload(answer, history));
  }

  if (!keepPending) pendingNarrowByConv.delete(conversationId);

  const lines = valid.slice(0, 6).map(v => `• ${v.from} (${nights} nights) — £${v.price.toFixed(2)}`).join('\n');
  const answer = `Here are the available start dates in ${year}-${String(month).padStart(2,'0')} for ${nights} night(s):\n${lines}\n\nTell me which one you’d like and I can give you the booking steps.`;
  addToHistory(conversationId, { role: 'assistant', content: answer });
  return res.json(okPayload(answer, history));
}

/* ---------- Routes (both /chat and /api/chat) ---------- */
app.post('/chat', handleChat);
app.post('/api/chat', handleChat);

/* ---------- health ---------- */
app.get('/health', (_req, res) => res.json({ ok: true, time: new Date().toISOString() }));
app.get('/', (_req, res) => res.send('Hansel Cottage Chatbot running.'));

/* ---------- boot tasks: RAG + PDF ingest + ICS refresh ---------- */
app.listen(PORT, async () => {
  console.log(`Server listening on ${PORT}`);

  try { await refreshContentIndex(); } catch (e: any) {
    console.warn('[rag] init error', e?.message || e);
  }

  const raw = (process.env.PDF_URLS || '').split(',').map(s => s.trim()).filter(Boolean);
  for (let entry of raw) {
    try {
      let text: string;
      if (/^https?:\/\//i.test(entry)) {
        console.log('[pdf boot] HTTP:', entry);
        text = await extractPdfTextFromUrl(entry);
      } else {
        let rel = entry.replace(/^\/+/, '');
        if (/^public\//i.test(rel)) rel = rel.slice(7);
        const localPath = path.resolve(publicDir, rel);
        console.log('[pdf boot] LOCAL:', localPath);
        text = await extractPdfTextFromFile(localPath);
      }
      await addExternalDocumentToIndex('PDF', entry, text);
      console.log('[pdf boot] indexed:', entry);
    } catch (e: any) {
      console.error('[pdf boot] ingest failed:', entry, e?.message || e);
    }
  }

  try { await refreshIcs(); } catch (e: any) {
    console.warn('[ics] init error', e?.message || e);
  }
});

// src/index.ts
//
// Hansel Cottage chatbot server.
// - Availability via ICS + Bookalet price validation (exact nights, total > 0)
// - Month and exact-date queries
// - Conversation memory for narrowing follow-ups
// - PDF and website RAG ingest on boot
// - Dates shown as "Fri 10 May"
// - Returns ALL priceable starts (no 6-cap)
// - Flexible date/narrowing parsing
// - Booking CTA uses Markdown link: [book here](https://www.hanselcottage.com/availability)

import express from 'express';
import cors from 'cors';
import bodyParser from 'body-parser';
import path from 'node:path';
import { parseISO, getDay, getDate, format, getDaysInMonth } from 'date-fns';

import {
  refreshIcs,
  findAvailabilityInMonth,
  isRangeAvailable,
  suggestAlternatives,
} from './ics.js';

import { quoteForStay } from './pricing.js';
import { interpretMessageWithLLM } from './nlp.js';
import {
  answerWithContext,
  refreshContentIndex,
  addExternalDocumentToIndex,
} from './rag.js';
import { extractPdfTextFromUrl, extractPdfTextFromFile } from './pdf.js';

/* ---------- Server ---------- */
const PORT = Number(process.env.PORT || 3000);

/* ---------- CORS with wildcard + logging ---------- */
type OriginMatcher = { raw: string; test: (ori: string) => boolean };

function buildOriginMatchers(csv: string | undefined): OriginMatcher[] {
  const parts = (csv || '*')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);

  return parts.map(p => {
    if (p === '*') {
      return { raw: '*', test: () => true };
    }
    if (p.includes('*')) {
      // Turn https://*.onrender.com into /^https:\/\/.*\.onrender\.com$/
      const rx = new RegExp('^' + p
        .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')   // escape regex
        .replace(/\\\*/g, '.*') + '$');
      return { raw: p, test: (ori: string) => rx.test(ori) };
    }
    // Exact match
    return { raw: p, test: (ori: string) => ori === p };
  });
}

const originMatchers = buildOriginMatchers(process.env.ALLOWED_ORIGIN);
const app = express();

app.use((req, _res, next) => {
  // Helpful log for CORS debugging (shows exact Origin header)
  const o = req.headers.origin || '';
  if (o) console.log('[cors] request origin:', o);
  next();
});

app.use(
  cors({
    origin(origin, cb) {
      if (!origin) return cb(null, true); // allow curl/local tools
      const ok = originMatchers.some(m => m.test(origin));
      if (ok) return cb(null, true);
      console.warn('[cors] blocked origin:', origin, 'allowed:', originMatchers.map(m => m.raw));
      return cb(new Error('Not allowed by CORS'));
    },
    credentials: false,
    allowedHeaders: ['Content-Type', 'X-Session-Id'],
    methods: ['GET', 'POST', 'OPTIONS'],
  })
);
app.options('*', cors());
app.use(bodyParser.json());

/* ---------- Static (PDFs & widget) ---------- */
const publicDir = path.resolve(process.cwd(), 'public');
app.use(express.static(publicDir));

/* ---------- Conversation memory ---------- */
type ChatMessage = { role: 'user' | 'assistant'; content: string };
const conversations = new Map<string, ChatMessage[]>();

function getHistory(id: string) {
  if (!conversations.has(id)) conversations.set(id, []);
  return conversations.get(id)!;
}

function addToHistory(id: string, msg: ChatMessage) {
  const hist = getHistory(id);
  hist.push(msg);
  if (hist.length > 40) hist.splice(0, hist.length - 40);
}

function makeSessionId(req: express.Request): string {
  const fromHeader = (req.headers['x-session-id'] as string) || '';
  if (fromHeader) return String(fromHeader);
  const ua = (req.headers['user-agent'] || '').toString();
  const ip = (
    req.headers['x-forwarded-for'] ||
    req.socket.remoteAddress ||
    ''
  ).toString();
  const seed = `${Date.now()}-${Math.random()
    .toString(36)
    .slice(2, 8)}-${ua.slice(0, 12)}-${ip.slice(0, 12)}`;
  return Buffer.from(seed)
    .toString('base64')
    .replace(/[^a-zA-Z0-9]/g, '')
    .slice(0, 24);
}

/* ---------- Narrowing follow-up memory ---------- */
type PendingNarrow = { year: number; month: number; nights: number };
const pendingNarrowByConv = new Map<string, PendingNarrow>();

/* ---------- Helpers ---------- */
function okPayload(answer: string, history: ChatMessage[]) {
  return { success: true, answer, history };
}
function errPayload(answer: string, history: ChatMessage[]) {
  return { success: false, answer, history };
}
function isoFromBody(body: any): string | null {
  const raw = String(body.message ?? body.text ?? body.question ?? '');
  const m = raw.match(/\b(\d{4}-\d{2}-\d{2})\b/);
  return m ? m[1] : null;
}
function formatDate(iso: string): string {
  return format(parseISO(iso), 'EEE d MMM'); // "Fri 10 May"
}

/* ---------- Flexible date parsing ---------- */
const MONTH_MAP: Record<string, number> = {
  jan: 1, january: 1,
  feb: 2, february: 2,
  mar: 3, march: 3,
  apr: 4, april: 4,
  may: 5,
  jun: 6, june: 6,
  jul: 7, july: 7,
  aug: 8, august: 8,
  sep: 9, sept: 9, september: 9,
  oct: 10, october: 10,
  nov: 11, november: 11,
  dec: 12, december: 12,
};
function pad2(n: number) { return n < 10 ? `0${n}` : String(n); }
function clampDay(year: number, month: number, day: number) {
  const dim = getDaysInMonth(new Date(year, month - 1, 1));
  return Math.max(1, Math.min(dim, day));
}
function buildISO(y: number, m: number, d: number) {
  return `${y}-${pad2(m)}-${pad2(clampDay(y, m, d))}`;
}
function nthWeekdayISO(year: number, month: number, dow: number, n: 1|2|3|4|5): string | null {
  const dim = getDaysInMonth(new Date(year, month - 1, 1));
  let firstDowDay = -1;
  for (let d = 1; d <= 7; d++) {
    const dt = new Date(year, month - 1, d);
    if (dt.getDay() === dow) { firstDowDay = d; break; }
  }
  if (firstDowDay < 0) return null;
  const day = firstDowDay + (n - 1) * 7;
  if (day > dim) return null;
  return buildISO(year, month, day);
}
function lastWeekdayISO(year: number, month: number, dow: number): string {
  const dim = getDaysInMonth(new Date(year, month - 1, 1));
  for (let d = dim; d >= 1; d--) {
    const dt = new Date(year, month - 1, d);
    if (dt.getDay() === dow) return buildISO(year, month, d);
  }
  return buildISO(year, month, dim);
}
function parseHumanDateInMonth(
  text: string,
  fallbackYear?: number,
  fallbackMonth?: number
): string | null {
  const t = text.trim().toLowerCase().replace(/\s+/g, ' ');
  const tryWithFallback = (day: number) =>
    fallbackYear && fallbackMonth ? buildISO(fallbackYear, fallbackMonth, day) : null;

  let m = t.match(/\b(early|mid|late|end(?:\s+of)?)\s+([a-z]{3,9})(?:\s+(\d{4}))?\b/);
  if (m) {
    const phase = m[1], monKey = m[2];
    const y = m[3] ? Number(m[3]) : (fallbackYear ?? NaN);
    const mo = MONTH_MAP[monKey];
    if (mo && Number.isFinite(y)) {
      let day = 15;
      if (/^early/.test(phase)) day = 5;
      else if (/^mid/.test(phase)) day = 15;
      else if (/^late/.test(phase)) day = 25;
      else if (/^end/.test(phase)) day = getDaysInMonth(new Date(y, mo - 1, 1));
      return buildISO(y, mo, day);
    }
  }
  m = t.match(/\b(early|mid(?:-|\s)?month|late|end(?:\s+of)?\s+month|end(?:\s+of)?)\b/);
  if (m && fallbackYear && fallbackMonth) {
    const phrase = m[1];
    let day = 15;
    if (/^early/.test(phrase)) day = 5;
    else if (/^mid/.test(phrase)) day = 15;
    else if (/^late/.test(phrase)) day = 25;
    else if (/^end/.test(phrase)) day = getDaysInMonth(new Date(fallbackYear, fallbackMonth - 1, 1));
    return buildISO(fallbackYear, fallbackMonth, day);
  }
  m = t.match(/\b(last|first|second|third|fourth|fifth|1st|2nd|3rd|4th|5th)\s+(mon|monday|tue|tues|tuesday|wed|wednesday|thu|thurs|thursday|fri|friday|sat|saturday|sun|sunday)(?:\s+of\s+([a-z]{3,9})(?:\s+(\d{4}))?)?\b/);
  if (m) {
    const ordRaw = m[1], wdKey = m[2], monKey = m[3];
    const yearOpt = m[4] ? Number(m[4]) : (fallbackYear ?? NaN);
    const dowMap: Record<string, number> = {
      mon:1,monday:1,tue:2,tues:2,tuesday:2,wed:3,wednesday:3,thu:4,thurs:4,thursday:4,fri:5,friday:5,sat:6,saturday:6,sun:0,sunday:0
    };
    const dow = dowMap[wdKey];
    const mo = monKey ? MONTH_MAP[monKey] : (fallbackMonth ?? NaN);
    const y = Number.isFinite(yearOpt) ? yearOpt : NaN;
    if (Number.isFinite(dow) && Number.isFinite(mo) && Number.isFinite(y)) {
      if (/^last$/i.test(ordRaw)) return lastWeekdayISO(y, mo, dow);
      const ordMap: Record<string, 1|2|3|4|5> = { first:1,'1st':1,second:2,'2nd':2,third:3,'3rd':3,fourth:4,'4th':4,fifth:5,'5th':5 };
      const n = ordMap[ordRaw as keyof typeof ordMap];
      if (n) return nthWeekdayISO(y, mo, dow, n) ?? lastWeekdayISO(y, mo, dow);
    }
  }
  m = t.match(/\b(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{4})\b/);
  if (m) { const d = +m[1], mo = +m[2], y = +m[3]; if (mo>=1&&mo<=12&&d>=1&&d<=31) return buildISO(y,mo,d); }
  m = t.match(/\b(\d{4})[\/\-.](\d{1,2})[\/\-.](\d{1,2})\b/);
  if (m) { const y = +m[1], mo = +m[2], d = +m[3]; if (mo>=1&&mo<=12&&d>=1&&d<=31) return buildISO(y,mo,d); }
  m = t.match(/\b(\d{1,2})[\/\-.](\d{1,2})\b/);
  if (m && fallbackYear) { const d = +m[1], mo = +m[2]; if (mo>=1&&mo<=12&&d>=1&&d<=31) return buildISO(fallbackYear,mo,d); }
  m = t.match(/\b(\d{1,2})\s+([a-z]{3,9})(?:\s+(\d{4}))?\b/);
  if (m) { const d = +m[1], monKey = m[2], y = m[3]?+m[3]:(fallbackYear??NaN); const mo = MONTH_MAP[monKey]; if (mo&&d>=1&&d<=31&&Number.isFinite(y)) return buildISO(y,mo,d); }
  m = t.match(/\b([a-z]{3,9})\s+(\d{1,2})(?:\s+(\d{4}))?\b/);
  if (m) { const monKey = m[1], d = +m[2], y = m[3]?+m[3]:(fallbackYear??NaN); const mo = MONTH_MAP[monKey]; if (mo&&d>=1&&d<=31&&Number.isFinite(y)) return buildISO(y,mo,d); }
  m = t.match(/\b(\d{4})\s+([a-z]{3,9})\s+(\d{1,2})\b/);
  if (m) { const y = +m[1], monKey = m[2], d = +m[3]; const mo = MONTH_MAP[monKey]; if (mo&&d>=1&&d<=31) return buildISO(y,mo,d); }
  m = t.match(/\b(?:the\s+)?(\d{1,2})(?:st|nd|rd|th)\b/);
  if (m) { const d = +m[1]; if (d>=1&&d<=31) return tryWithFallback(d); }
  if (fallbackYear && fallbackMonth) {
    m = t.match(/\b(?:mon|tue|tues|wed|thu|thurs|fri|sat|sun)?\s*(\d{1,2})\b/);
    if (m) { const d = +m[1]; if (d>=1&&d<=31) return buildISO(fallbackYear,fallbackMonth,d); }
  }
  m = t.match(/\b(last|first|second|third|fourth|fifth|1st|2nd|3rd|4th|5th)\s+(mon|monday|tue|tues|tuesday|wed|wednesday|thu|thurs|thursday|fri|friday|sat|saturday|sun|sunday)\b/);
  if (m && fallbackYear && fallbackMonth) {
    const ordRaw = m[1], wdKey = m[2];
    const dowMap: Record<string, number> = { mon:1,monday:1,tue:2,tues:2,tuesday:2,wed:3,wednesday:3,thu:4,thurs:4,thursday:4,fri:5,friday:5,sat:6,saturday:6,sun:0,sunday:0 };
    const dow = dowMap[wdKey];
    if (/^last$/i.test(ordRaw)) return lastWeekdayISO(fallbackYear, fallbackMonth, dow);
    const ordMap: Record<string, 1|2|3|4|5> = { first:1,'1st':1,second:2,'2nd':2,third:3,'3rd':3,fourth:4,'4th':4,fifth:5,'5th':5 };
    const n = ordMap[ordRaw as keyof typeof ordMap];
    if (n) return nthWeekdayISO(fallbackYear, fallbackMonth, dow, n) ?? lastWeekdayISO(fallbackYear, fallbackMonth, dow);
  }
  return null;
}

/* ---------- Narrowing parsing ---------- */
const WEEKDAY_NAMES: Record<string, number> = {
  sunday: 0, sun: 0,
  monday: 1, mon: 1,
  tuesday: 2, tue: 2, tues: 2,
  wednesday: 3, wed: 3,
  thursday: 4, thu: 4, thurs: 4,
  friday: 5, fri: 5,
  saturday: 6, sat: 6,
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
  | { kind: 'weeknum'; n: 1 | 2 | 3 | 4 | 5 }
  | { kind: 'nthWeekday'; n: 1 | 2 | 3 | 4 | 5; dow: number }
  | { kind: 'lastWeekday'; dow: number }
  | { kind: 'date'; date: string };

function parseOrdinalWord(t: string): 1 | 2 | 3 | 4 | 5 | null {
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

  for (const name in WEEKDAY_NAMES) {
    if (new RegExp(`\\b${name}\\b`).test(t))
      return { kind: 'weekday', dow: WEEKDAY_NAMES[name] };
  }

  if (/\blast\s+(mon|monday|tue|tues|tuesday|wed|wednesday|thu|thurs|thursday|fri|friday|sat|saturday|sun|sunday)\b/.test(t)) {
    const wdKey = (t.match(/\blast\s+(mon|monday|tue|tues|tuesday|wed|wednesday|thu|thurs|thursday|fri|friday|sat|saturday|sun|sunday)\b/) || [])[1]!;
    const dowMap: Record<string, number> = { mon:1,monday:1,tue:2,tues:2,tuesday:2,wed:3,wednesday:3,thu:4,thurs:4,thursday:4,fri:5,friday:5,sat:6,saturday:6,sun:0,sunday:0 };
    return { kind: 'lastWeekday', dow: dowMap[wdKey] };
  }

  if (/\b(first|1st|second|2nd|third|3rd|fourth|4th|fifth|5th)\s+(mon|monday|tue|tues|tuesday|wed|wednesday|thu|thurs|thursday|fri|friday|sat|saturday|sun|sunday)\b/.test(t)) {
    const m2 = t.match(/\b(first|1st|second|2nd|third|3rd|fourth|4th|fifth|5th)\s+(mon|monday|tue|tues|tuesday|wed|wednesday|thu|thurs|thursday|fri|friday|sat|saturday|sun|sunday)\b/)!;
    const wdKey = m2[2];
    const dowMap: Record<string, number> = { mon:1,monday:1,tue:2,tues:2,tuesday:2,wed:3,wednesday:3,thu:4,thurs:4,thursday:4,fri:5,friday:5,sat:6,saturday:6,sun:0,sunday:0 };
    const ordMap: Record<string, 1|2|3|4|5> = { first:1, '1st':1, second:2, '2nd':2, third:3, '3rd':3, fourth:4, '4th':4, fifth:5, '5th':5 };
    return { kind: 'nthWeekday', n: ordMap[m2[1] as keyof typeof ordMap], dow: dowMap[wdKey] };
  }

  if (/\b(first\s+half|1st\s+half|first\s+part|beginning\s+of\s+the\s+month)\b/.test(t)) return { kind: 'firsthalf' };
  if (/\b(second\s+half|2nd\s+half|last\s+half|end\s+of\s+the\s+month)\b/.test(t)) return { kind: 'secondhalf' };
  if (/\b(mid[-\s]?month|middle)\b/.test(t)) return { kind: 'mid' };
  if (/\b(early|start|beginning)\b/.test(t)) return { kind: 'early' };
  if (/\b(late|end|ending|last)\b/.test(t)) return { kind: 'late' };

  const aroundWk = t.match(/\baround(?:\s+(mon|monday|tue|tues|tuesday|wed|wednesday|thu|thurs|thursday|fri|friday|sat|saturday|sun|sunday))?(?:\s+the)?\s+(\d{1,2})(?:st|nd|rd|th)?\b/);
  if (aroundWk) {
    const wd = aroundWk[1] ? WEEKDAY_NAMES[aroundWk[1]] : undefined;
    const d = parseInt(aroundWk[2], 10);
    if (d >= 1 && d <= 31) return { kind: 'around', day: d, dow: wd };
  }

  const range1 = t.match(/\b(\d{1,2})(?:st|nd|rd|th)?\s*(?:-|to|–|—|and)\s*(\d{1,2})(?:st|nd|rd|th)?\b/);
  if (range1) {
    const lo = parseInt(range1[1], 10);
    const hi = parseInt(range1[2], 10);
    if (lo >= 1 && hi >= lo && hi <= 31) return { kind: 'dayrange', lo, hi };
  }

  const ord = parseOrdinalWord(t);
  if (ord && /\bweek\b/.test(t)) return { kind: 'weeknum', n: ord };

  const justAround = t.match(/\baround(?:\s+the)?\s+(\d{1,2})(?:st|nd|rd|th)?\b/);
  if (justAround) {
    const d = parseInt(justAround[1], 10);
    if (d >= 1 && d <= 31) return { kind: 'around', day: d };
  }

  return null;
}

function applyNarrowingFilter(
  dates: Array<{ from: string; price: number }>,
  f: NarrowFilter
) {
  const byDay = (pred: (day: number) => boolean) =>
    dates.filter((d) => pred(getDate(parseISO(d.from))));
  const byDOW = (pred: (dow: number) => boolean) =>
    dates.filter((d) => pred(getDay(parseISO(d.from))));
  switch (f.kind) {
    case 'date':
      return dates.filter((d) => d.from === f.date);
    case 'fridays':
    case 'weekends':
      return byDOW((dow) => dow === 5);
    case 'weekdays':
      return byDOW((dow) => dow >= 1 && dow <= 4);
    case 'weekday':
      return byDOW((dow) => dow === f.dow);
    case 'early':
      return byDay((day) => day <= 10);
    case 'mid':
      return byDay((day) => day >= 10 && day <= 20);
    case 'late':
      return byDay((day) => day >= 21);
    case 'firsthalf':
      return byDay((day) => day <= 15);
    case 'secondhalf':
      return byDay((day) => day >= 16);
    case 'around':
      return dates.filter((d) => {
        const day = getDate(parseISO(d.from));
        const ok = Math.abs(day - f.day) <= 3;
        if (f.dow == null) return ok;
        const dow = getDay(parseISO(d.from));
        return ok && dow === f.dow;
      });
    case 'dayrange':
      return byDay((day) => day >= f.lo && day <= f.hi);
    case 'weeknum': {
      const ranges: Record<number, [number, number]> = {
        1: [1, 7],
        2: [8, 14],
        3: [15, 21],
        4: [22, 28],
        5: [29, 31],
      };
      const [lo, hi] = ranges[f.n];
      return byDay((day) => day >= lo && day <= hi);
    }
    case 'nthWeekday': {
      const ranges: Record<number, [number, number]> = {
        1: [1, 7],
        2: [8, 14],
        3: [15, 21],
        4: [22, 28],
        5: [29, 31],
      };
      const [lo, hi] = ranges[f.n];
      return dates.filter((d) => {
        const dt = parseISO(d.from);
        const day = getDate(dt);
        const dow = getDay(dt);
        return day >= lo && day <= hi && dow === f.dow;
      });
    }
    case 'lastWeekday': {
      const candidates = dates.filter((d) => getDay(parseISO(d.from)) === f.dow);
      if (!candidates.length) return [];
      const maxIso = candidates
        .map((c) => c.from)
        .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
        .slice(-1)[0];
      return dates.filter((d) => d.from === maxIso);
    }
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

  // If narrowing is pending, try to interpret as navigation/narrowing first
  let pending = pendingNarrowByConv.get(conversationId);
  if (pending) {
    const navNext = /^\s*next\s*$/i.test(message);
    const navPrev = /^\s*prev(ious)?\s*$/i.test(message);
    const explicitIso = isoFromBody(body);
    const humanIso = parseHumanDateInMonth(message, pending.year, pending.month);
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

    const explicitDate = explicitIso || humanIso;
    if (explicitDate) {
      const nights = pending.nights;
      await refreshIcs();
      if (!isRangeAvailable(explicitDate, nights)) {
        const answer = '❌ Sorry, that date looks unavailable. Would you like me to try nearby Fridays or a different length of stay?';
        addToHistory(conversationId, { role: 'assistant', content: answer });
        return res.json(okPayload(answer, history));
      }
      const q = await quoteForStay({ from: explicitDate, nights });
      if (!q.matchedNights || q.total <= 0) {
        const answer = 'That start date doesn’t appear valid for that length. Want me to show valid (priced) starts near it?';
        addToHistory(conversationId, { role: 'assistant', content: answer });
        return res.json(okPayload(answer, history));
      }
      const answer = `✅ Available from ${formatDate(explicitDate)} for ${nights} night(s). Estimated total: GBP ${q.total.toFixed(2)}. You can [book here](https://www.hanselcottage.com/availability).`;
      addToHistory(conversationId, { role: 'assistant', content: answer });
      pendingNarrowByConv.delete(conversationId);
      return res.json(okPayload(answer, history));
    }

    if (nf0) {
      const { year, month, nights } = pending;
      await refreshIcs();
      const candidates = findAvailabilityInMonth(year, month, nights, 1000);
      const priced: { from: string; price: number }[] = [];
      for (const c of candidates) {
        try {
          const q = await quoteForStay({ from: c.from, nights: c.nights });
          if (q.matchedNights && q.total > 0) priced.push({ from: c.from, price: q.total });
        } catch {}
      }

      let narrowed = applyNarrowingFilter(priced, nf0);
      if (!narrowed.length) {
        const example = priced.length ? priced[0].from : `${year}-${String(month).padStart(2, '0')}-18`;
        const answer = `I couldn’t find priced options with that preference. Try a specific date (e.g., ${formatDate(example)}) or say “Fridays only”, “weekdays only”, “first half”, “second half”, “between 10th and 20th”, or “around the 18th”.`;
        addToHistory(conversationId, { role: 'assistant', content: answer });
        return res.json(okPayload(answer, history));
      }

      const lines = narrowed.map((v) => `• ${formatDate(v.from)} (${nights} nights) — £${v.price.toFixed(2)}`).join('\n');
      const answer = `Here are the options I found:\n${lines}\n\nYou can [book here](https://www.hanselcottage.com/availability).`;
      addToHistory(conversationId, { role: 'assistant', content: answer });
      return res.json(okPayload(answer, history));
    }
  }

  // ---- Main intent parsing ----
  try {
    const intent = await interpretMessageWithLLM(message);

    if (intent && intent.kind === 'dates') {
      await refreshIcs();
      const { from, nights } = intent;

      if (!isRangeAvailable(from, nights)) {
        const alts = suggestAlternatives(from, nights, 30);
        const priced: { from: string; price: number }[] = [];
        for (const a of alts) {
          try {
            const q = await quoteForStay({ from: a.from, nights: a.nights });
            if (q.matchedNights && q.total > 0) priced.push({ from: a.from, price: q.total });
          } catch {}
        }
        if (!priced.length) {
          const answer = '❌ Sorry, those dates look unavailable.';
          addToHistory(conversationId, { role: 'assistant', content: answer });
          return res.json(okPayload(answer, history));
        }
        const lines = priced.map((v) => `• ${formatDate(v.from)} — £${v.price.toFixed(2)}`).join('\n');
        const answer = `❌ Sorry, those dates look unavailable. Here are some priceable alternatives:\n${lines}\n\nYou can [book here](https://www.hanselcottage.com/availability).`;
        addToHistory(conversationId, { role: 'assistant', content: answer });
        return res.json(okPayload(answer, history));
      }

      const q = await quoteForStay({ from, nights });
      if (!q.matchedNights || q.total <= 0) {
        const answer = 'That start date doesn’t look valid for that length. Would you like me to show valid start days near it?';
        addToHistory(conversationId, { role: 'assistant', content: answer });
        return res.json(okPayload(answer, history));
      }

      const answer = `✅ Available from ${formatDate(from)} for ${nights} night(s). Estimated total: GBP ${q.total.toFixed(2)}. You can [book here](https://www.hanselcottage.com/availability).`;
      addToHistory(conversationId, { role: 'assistant', content: answer });
      return res.json(okPayload(answer, history));
    }

    if (intent && intent.kind === 'month') {
      return await runMonthFlow(intent, conversationId, history, res, /*keepPending*/ false);
    }

    // General Qs → RAG
    const rag = await answerWithContext(message);
    const reply = typeof rag === 'string' ? rag : rag?.answer ?? 'OK';
    addToHistory(conversationId, { role: 'assistant', content: reply });
    return res.json(okPayload(reply, history));
  } catch (e: any) {
    console.error('chat error', e?.message || e);
    const answer = '⚠️ Sorry, something went wrong. Please try again.';
    addToHistory(conversationId, { role: 'assistant', content: answer });
    return res.json(errPayload(answer, history));
  }
}

/* ---------- Month flow ---------- */
async function runMonthFlow(
  intent: { kind: 'month'; year: number; month: number; nights: number },
  conversationId: string,
  history: ChatMessage[],
  res: express.Response,
  keepPending: boolean
) {
  await refreshIcs();
  const { year, month, nights } = intent;

  const candidates = findAvailabilityInMonth(year, month, nights, 1000);
  const valid: { from: string; price: number }[] = [];
  for (const c of candidates) {
    try {
      const q = await quoteForStay({ from: c.from, nights: c.nights });
      if (q.matchedNights && q.total > 0) valid.push({ from: c.from, price: q.total });
    } catch {}
  }

  if (!valid.length) {
    const answer = `❌ I couldn’t find a ${nights}-night opening in ${year}-${String(month).padStart(2, '0')}.`;
    addToHistory(conversationId, { role: 'assistant', content: answer });
    return res.json(okPayload(answer, history));
  }

  if (!keepPending) pendingNarrowByConv.delete(conversationId);
  else pendingNarrowByConv.set(conversationId, { year, month, nights });

  const lines = valid
    .map((v) => `• ${formatDate(v.from)} (${nights} nights) — £${v.price.toFixed(2)}`)
    .join('\n');

  const answer = `Here are all priceable start dates in ${year}-${String(month).padStart(
    2,
    '0'
  )} for ${nights} night(s):\n${lines}\n\nYou can [book here](https://www.hanselcottage.com/availability).`;

  addToHistory(conversationId, { role: 'assistant', content: answer });
  return res.json(okPayload(answer, history));
}

/* ---------- Routes ---------- */
app.post('/chat', handleChat);
app.post('/api/chat', handleChat);

/* ---------- Health ---------- */
app.get('/health', (_req, res) =>
  res.json({ ok: true, time: new Date().toISOString() })
);
app.get('/', (_req, res) => res.send('Hansel Cottage Chatbot running.'));

/* ---------- Boot ingest (PDFs + ICS + RAG) ---------- */
app.listen(PORT, async () => {
  console.log(`Server listening on ${PORT}`);

  try {
    await refreshContentIndex();
  } catch (e: any) {
    console.warn('[rag] init error', e?.message || e);
  }

  const publicDir = path.resolve(process.cwd(), 'public');
  const raw = (process.env.PDF_URLS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

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

  try {
    await refreshIcs();
  } catch (e: any) {
    console.warn('[ics] init error', e?.message || e);
  }
});

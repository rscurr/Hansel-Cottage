// src/index.ts
//
// Hansel Cottage chatbot server (compat mode).
// - Uses ICS scan + Bookalet pricing
// - RAG for PDFs and website crawl
// - Flexible follow-ups, conversation history
// - Dates formatted for user: "Fri 10 May"

import express from 'express';
import cors from 'cors';
import bodyParser from 'body-parser';
import path from 'node:path';
import { parseISO, getDay, getDate, format } from 'date-fns';

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

/* ---------- CORS ---------- */
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

/* ---------- Static (PDFs) ---------- */
const publicDir = path.resolve(process.cwd(), 'public');
app.use(express.static(publicDir));

/* ---------- Session store ---------- */
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
function formatDate(iso: string): string {
  return format(parseISO(iso), 'EEE d MMM'); // e.g. "Fri 10 May"
}

/* ---------- Narrowing parsing ---------- */
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

// … your narrowing parser code goes here (unchanged) …

/* ---------- Core chat handler ---------- */
app.post('/chat', async (req, res) => {
  const sessionId = makeSessionId(req);
  const history = getHistory(sessionId);
  const userMsg = String(req.body.message ?? req.body.text ?? req.body.question ?? '').trim();
  if (!userMsg) return res.json(errPayload('Please provide a message.', history));

  addToHistory(sessionId, { role: 'user', content: userMsg });

  try {
    const parsed = await interpretMessageWithLLM(userMsg, history);

    // if it's availability check
    if (parsed.intent === 'availability') {
      const { year, month, nights } = parsed;
      const avail = await findAvailabilityInMonth(year, month, nights);

      const priceable = [];
      for (const c of avail) {
        const q = await quoteForStay(c.from, nights);
        if (q && q.total > 0) priceable.push({ from: c.from, price: q.total });
      }

      if (priceable.length === 0) {
        const alts = await suggestAlternatives(year, month, nights);
        if (alts.length > 0) {
          const lines = await Promise.all(alts.map(async a => {
            const q = await quoteForStay(a.from, nights);
            return q && q.total > 0 ? `• ${formatDate(a.from)} — £${q.total.toFixed(2)}` : '';
          }));
          const answer = `❌ Sorry, those dates look unavailable. Here are some priceable alternatives:\n${lines.filter(Boolean).join('\n')}`;
          addToHistory(sessionId, { role: 'assistant', content: answer });
          return res.json(okPayload(answer, history));
        }
        const answer = '❌ Sorry, those dates look unavailable.';
        addToHistory(sessionId, { role: 'assistant', content: answer });
        return res.json(errPayload(answer, history));
      }

      const lines = priceable.map(v => `• ${formatDate(v.from)} (${nights} nights) — £${v.price.toFixed(2)}`).join('\n');
      const answer = `Here are all priceable start dates in ${year}-${String(month).padStart(2,'0')} for ${nights} night(s):\n${lines}\n\nTell me which one you’d like and I can give you the booking steps.`;
      pendingNarrowByConv.set(sessionId, { year, month, nights });
      addToHistory(sessionId, { role: 'assistant', content: answer });
      return res.json(okPayload(answer, history));
    }

    // fallback to RAG or small talk
    const answer = await answerWithContext(userMsg, history);
    addToHistory(sessionId, { role: 'assistant', content: answer });
    res.json(okPayload(answer, history));

  } catch (err: any) {
    console.error('[chat] error', err);
    const answer = 'Sorry, something went wrong.';
    addToHistory(sessionId, { role: 'assistant', content: answer });
    res.json(errPayload(answer, history));
  }
});

/* ---------- Boot tasks ---------- */
(async () => {
  try {
    console.log('[boot] refreshing ICS + content index');
    await refreshIcs();
    await refreshContentIndex();

    const pdfs = (process.env.PDF_URLS || '').split(',').map(s => s.trim()).filter(Boolean);
    for (const u of pdfs) {
      if (u.startsWith('http')) {
        const txt = await extractPdfTextFromUrl(u);
        await addExternalDocumentToIndex(u, txt);
      } else {
        const filePath = path.resolve(publicDir, u);
        const txt = await extractPdfTextFromFile(filePath);
        await addExternalDocumentToIndex(u, txt);
      }
    }

    console.log('[boot] initial ingest complete');
  } catch (err) {
    console.error('[boot] init error', err);
  }
})();

/* ---------- Start server ---------- */
app.listen(PORT, () => {
  console.log(`Chatbot server running on http://localhost:${PORT}`);
});

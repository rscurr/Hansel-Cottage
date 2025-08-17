// src/index.ts
//
// Hansel Cottage chatbot server (compat mode).
// - ICS scan + Bookalet price validation
// - RAG for PDFs/site
// - Accepts {message}|{text}|{question}; optional conversationId (auto if missing)
// - Returns {answer, reply, message, text, success, history} to satisfy older widgets
// - /chat and /api/chat routes
// - PDF boot ingest logs
// - Node16 module resolution friendly (.js extensions)

import express from 'express';
import cors from 'cors';
import bodyParser from 'body-parser';
import path from 'node:path';

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
    if (!origin) return cb(null, true); // allow curl / local files opened from disk
    if (allowedList.includes('*') || allowedList.includes(origin)) return cb(null, true);
    return cb(new Error('Not allowed by CORS'));
  },
  credentials: false,
  allowedHeaders: ['Content-Type', 'X-Session-Id'],
  methods: ['GET', 'POST', 'OPTIONS']
}));
app.options('*', cors()); // preflight

app.use(bodyParser.json());

// Serve static (for /public PDFs)
const publicDir = path.resolve(process.cwd(), 'public');
app.use(express.static(publicDir));

/* ---------- Tiny session store ---------- */
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
  // Use provided header/id if any; else synthesize a short session token
  const fromHeader = (req.headers['x-session-id'] as string) || '';
  if (fromHeader) return String(fromHeader);
  const ua = (req.headers['user-agent'] || '').toString();
  const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').toString();
  const seed = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}-${ua.slice(0,12)}-${ip.slice(0,12)}`;
  return Buffer.from(seed).toString('base64').replace(/[^a-zA-Z0-9]/g, '').slice(0, 24);
}

/* ---------- Utilities ---------- */
function okPayload(answer: string, history: ChatMessage[]) {
  // Return many aliases so any widget picks one it expects
  return {
    success: true,
    answer,
    reply: answer,
    message: answer,
    text: answer,
    history
  };
}
function errPayload(answer: string, history: ChatMessage[]) {
  return {
    success: false,
    answer,
    reply: answer,
    message: answer,
    text: answer,
    history
  };
}

/* ---------- Core chat handler ---------- */
async function handleChat(req: express.Request, res: express.Response) {
  // Accept multiple shapes
  const body: any = req.body || {};
  const message: string = String(body.message ?? body.text ?? body.question ?? '').trim();
  let conversationId: string = String(body.conversationId ?? '').trim();
  if (!message) return res.status(400).json(errPayload('Message is required', []));

  if (!conversationId) {
    conversationId = makeSessionId(req);
  }

  const history = getHistory(conversationId);
  addToHistory(conversationId, { role: 'user', content: message });

  try {
    const intent = await interpretMessageWithLLM(message);

    // ---- Specific date flow ----
    if (intent.kind === 'dates') {
      await refreshIcs();
      const { from, nights } = intent;

      if (!isRangeAvailable(from, nights)) {
        // Suggest alternatives that are actually priceable
        const alts = suggestAlternatives(from, nights, 16);
        const priced: { from: string; price: number }[] = [];
        for (const a of alts) {
          try {
            const q = await quoteForStay({ from: a.from, nights: a.nights });
            if (q.total > 0) priced.push({ from: a.from, price: q.total });
          } catch { /* ignore */ }
        }
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

    // ---- Month flow ----
    if (intent.kind === 'month') {
      await refreshIcs();
      const { year, month, nights } = intent;
      const candidates = findAvailabilityInMonth(year, month, nights, 100);

      // Only keep starts that price > 0 (e.g., Bookalet-allowed changeover)
      const valid: { from: string; price: number }[] = [];
      for (const c of candidates) {
        try {
          const q = await quoteForStay({ from: c.from, nights: c.nights });
          if (q.total > 0) valid.push({ from: c.from, price: q.total });
        } catch { /* skip */ }
      }

      if (!valid.length) {
        const answer = `❌ I couldn’t find a ${nights}-night opening in ${year}-${String(month).padStart(2, '0')}.`;
        addToHistory(conversationId, { role: 'assistant', content: answer });
        return res.json(okPayload(answer, history));
      }

      if (valid.length > 6) {
        const answer = `We have lots of dates available then. Can you narrow it down and be more specific (e.g., “Fridays only”, “mid-month”, or a specific date like ${year}-${String(month).padStart(2, '0')}-18)?`;
        addToHistory(conversationId, { role: 'assistant', content: answer });
        return res.json(okPayload(answer, history));
      }

      const lines = valid
        .slice(0, 6)
        .map(v => `• ${v.from} (${nights} nights) — £${v.price.toFixed(2)}`)
        .join('\n');

      const answer = `Here are the available start dates in ${year}-${String(month).padStart(2, '0')} for ${nights} night(s):\n${lines}\n\nTell me which one you’d like and I can give you the booking steps.`;
      addToHistory(conversationId, { role: 'assistant', content: answer });
      return res.json(okPayload(answer, history));
    }

    // ---- General questions → RAG ----
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

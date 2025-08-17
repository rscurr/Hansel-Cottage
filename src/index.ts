// src/index.ts
//
// Main chatbot server for Hansel Cottage.
// Availability via ICS (broad scan) + Bookalet API for pricing.
// RAG for website/PDF content.
// Multi-turn context-aware conversation.
// Restores boot-time PDF ingest logging and adds /api/chat alias.

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
    if (!origin) return cb(null, true); // allow curl / local files with null origin
    if (allowedList.includes('*') || allowedList.includes(origin)) return cb(null, true);
    return cb(new Error('Not allowed by CORS'));
  },
  credentials: false,
  allowedHeaders: ['Content-Type', 'X-Session-Id'],
  methods: ['GET', 'POST', 'OPTIONS']
}));
app.options('*', cors()); // preflight

app.use(bodyParser.json());

// Serve static files (so local PDFs under /public are fetchable)
const publicDir = path.resolve(process.cwd(), 'public');
app.use(express.static(publicDir));

type ChatMessage = { role: 'user' | 'assistant'; content: string };
const conversations = new Map<string, ChatMessage[]>(); // conversationId -> history

// ---- conversation helpers ----
function getHistory(id: string) {
  if (!conversations.has(id)) conversations.set(id, []);
  return conversations.get(id)!;
}
function addToHistory(id: string, msg: ChatMessage) {
  const hist = getHistory(id);
  hist.push(msg);
  if (hist.length > 40) hist.splice(0, hist.length - 40); // keep last 20 exchanges
}

/* ---------- Shared chat handler ---------- */
async function handleChat(message: string, conversationId: string) {
  const history = getHistory(conversationId);
  addToHistory(conversationId, { role: 'user', content: message });

  try {
    // Step 1. Interpret intent
    const intent = await interpretMessageWithLLM(message);

    // Step 2. Handle availability & pricing queries
    if (intent.kind === 'dates') {
      await refreshIcs();
      const { from, nights } = intent;

      if (!isRangeAvailable(from, nights)) {
        const alts = suggestAlternatives(from, nights, 12);
        if (alts.length === 0) {
          const reply = `❌ Sorry, those dates look unavailable.`;
          addToHistory(conversationId, { role: 'assistant', content: reply });
          return { reply, history };
        }
        // Filter alternatives by Bookalet price > 0
        const priced: { from: string; price: number }[] = [];
        for (const a of alts.slice(0, 12)) {
          try {
            const q = await quoteForStay({ from: a.from, nights: a.nights });
            if (q.total > 0) priced.push({ from: a.from, price: q.total });
          } catch { /* ignore */ }
        }
        const formatted = priced.slice(0, 6).map(v => `• ${v.from} — £${v.price.toFixed(2)}`).join('\n');
        const reply = `❌ Sorry, those dates look unavailable.` + (formatted ? ` Closest priceable alternatives:\n${formatted}` : '');
        addToHistory(conversationId, { role: 'assistant', content: reply });
        return { reply, history };
      }

      const quote = await quoteForStay({ from, nights });
      const reply = `✅ Available from ${from} for ${nights} night(s). Estimated total: GBP ${quote.total.toFixed(2)}. Would you like the booking link?`;
      addToHistory(conversationId, { role: 'assistant', content: reply });
      return { reply, history };
    }

    if (intent.kind === 'month') {
      await refreshIcs();
      const { year, month, nights } = intent;
      const candidates = findAvailabilityInMonth(year, month, nights, 100);

      // Check Bookalet pricing to filter only valid start dates (e.g., Fridays)
      const valid: { from: string; price: number }[] = [];
      for (const c of candidates) {
        try {
          const q = await quoteForStay({ from: c.from, nights: c.nights });
          if (q.total > 0) valid.push({ from: c.from, price: q.total });
        } catch { /* skip */ }
      }

      if (valid.length === 0) {
        const reply = `❌ I couldn’t find a ${nights}-night opening in ${year}-${String(month).padStart(2,'0')}.`;
        addToHistory(conversationId, { role: 'assistant', content: reply });
        return { reply, history };
      }

      if (valid.length > 6) {
        const reply = `We have lots of dates available then. Can you narrow it down and be more specific (e.g., “Fridays only”, “mid-month”, or a specific date like ${year}-${String(month).padStart(2,'0')}-18)?`;
        addToHistory(conversationId, { role: 'assistant', content: reply });
        return { reply, history };
      }

      const formatted = valid
        .slice(0, 6)
        .map(v => `• ${v.from} (${nights} nights) — £${v.price.toFixed(2)}`)
        .join('\n');

      const reply = `Here are the available start dates in ${year}-${String(month).padStart(2,'0')} for ${nights} night(s):\n${formatted}\n\nTell me which one you’d like and I can give you the booking steps.`;
      addToHistory(conversationId, { role: 'assistant', content: reply });
      return { reply, history };
    }

    // Step 3. Fallback to RAG for general Q&A
    const rag = await answerWithContext(message, history);
    addToHistory(conversationId, { role: 'assistant', content: rag.answer });
    return { reply: rag.answer, history };

  } catch (err: any) {
    console.error('chat error', err);
    const reply = '⚠️ Sorry, something went wrong. Please try again.';
    addToHistory(conversationId, { role: 'assistant', content: reply });
    return { reply, history };
  }
}

/* ---------- Routes (both /chat and /api/chat) ---------- */
app.post('/chat', async (req, res) => {
  const { message, conversationId } = req.body as { message: string; conversationId: string };
  if (!message || !conversationId) return res.status(400).json({ error: 'message and conversationId required' });
  const result = await handleChat(message, conversationId);
  res.json(result);
});

// Alias to support older widget/test pages
app.post('/api/chat', async (req, res) => {
  const { message, conversationId } = req.body as { message: string; conversationId: string };
  if (!message || !conversationId) return res.status(400).json({ error: 'message and conversationId required' });
  const result = await handleChat(message, conversationId);
  res.json(result);
});

/* ---------- health ---------- */
app.get('/health', (_req, res) => res.json({ ok: true, time: new Date().toISOString() }));
app.get('/', (_req, res) => res.send('Hansel Cottage Chatbot running.'));

/* ---------- boot tasks: RAG + PDF ingest + ICS refresh ---------- */
app.listen(PORT, async () => {
  console.log(`Server listening on ${PORT}`);

  // Prime RAG index (placeholder)
  try {
    await refreshContentIndex();
  } catch (e: any) {
    console.warn('[rag] init error', e?.message || e);
  }

  // PDF auto-ingest on boot (supports full URLs or files under /public)
  const raw = (process.env.PDF_URLS || '').split(',').map(s => s.trim()).filter(Boolean);
  for (let entry of raw) {
    try {
      let text: string;
      if (/^https?:\/\//i.test(entry)) {
        console.log('[pdf boot] HTTP:', entry);
        text = await extractPdfTextFromUrl(entry);
      } else {
        // normalise relative path to /public
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

  // Keep ICS fresh
  try {
    await refreshIcs();
  } catch (e: any) {
    console.warn('[ics] init error', e?.message || e);
  }
});

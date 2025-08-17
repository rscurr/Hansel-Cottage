// src/index.ts
//
// Main chatbot server for Hansel Cottage.
// Availability via ICS (broad scan) + Bookalet API for pricing.
// RAG for website/PDF content.
// Multi-turn context-aware conversation.

import express from 'express';
import cors from 'cors';
import bodyParser from 'body-parser';
import { refreshIcs, findAvailabilityInMonth, isRangeAvailable, suggestAlternatives } from './ics';
import { quoteForStay } from './pricing';
import { interpretMessageWithLLM } from './nlp';
import { answerWithContext } from './rag';

const PORT = process.env.PORT || 3000;
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || '*';

const app = express();
app.use(cors({ origin: ALLOWED_ORIGIN }));
app.use(bodyParser.json());

type ChatMessage = { role: 'user' | 'assistant'; content: string };
const conversations = new Map<string, ChatMessage[]>(); // conversationId -> history

// ---- conversation helpers ----
function getHistory(id: string) {
  if (!conversations.has(id)) conversations.set(id, []);
  return conversations.get(id)!;
}
function addToHistory(id: string, msg: ChatMessage) {
  getHistory(id).push(msg);
  // keep only last 20 exchanges
  if (getHistory(id).length > 40) getHistory(id).splice(0, getHistory(id).length - 40);
}

// ---- main chat handler ----
app.post('/chat', async (req, res) => {
  const { message, conversationId } = req.body as { message: string; conversationId: string };
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
        const alts = suggestAlternatives(from, nights, 3);
        if (alts.length === 0) {
          const reply = `❌ Sorry, those dates look unavailable.`;
          addToHistory(conversationId, { role: 'assistant', content: reply });
          return res.json({ reply, history });
        }
        const formatted = alts.map(a => `• ${a.from}`).join('\n');
        const reply = `❌ Sorry, those dates look unavailable. Closest alternatives:\n${formatted}`;
        addToHistory(conversationId, { role: 'assistant', content: reply });
        return res.json({ reply, history });
      }

      const quote = await quoteForStay({ from, nights });
      const reply = `✅ Available from ${from} for ${nights} night(s). Estimated total: GBP ${quote.total.toFixed(2)}. Would you like the booking link?`;
      addToHistory(conversationId, { role: 'assistant', content: reply });
      return res.json({ reply, history });
    }

    if (intent.kind === 'month') {
      await refreshIcs();
      const { year, month, nights } = intent;
      const candidates = findAvailabilityInMonth(year, month, nights, 50);

      // Check Bookalet pricing to filter only valid start dates
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
        return res.json({ reply, history });
      }

      if (valid.length > 6) {
        const reply = `We have lots of dates available then. Can you narrow it down and be more specific?`;
        addToHistory(conversationId, { role: 'assistant', content: reply });
        return res.json({ reply, history });
      }

      const formatted = valid.map(v => `• ${v.from} (${nights} nights) — £${v.price.toFixed(2)}`).join('\n');
      const reply = `Here are the available start dates in ${year}-${String(month).padStart(2,'0')} for ${nights} night(s):\n${formatted}\n\nTell me which one you’d like and I can price it in full and give you booking steps.`;
      addToHistory(conversationId, { role: 'assistant', content: reply });
      return res.json({ reply, history });
    }

    // Step 3. Fallback to RAG for general Q&A
    const rag = await answerWithContext(message, history);
    addToHistory(conversationId, { role: 'assistant', content: rag.answer });
    return res.json({ reply: rag.answer, history });

  } catch (err: any) {
    console.error('chat error', err);
    const reply = '⚠️ Sorry, something went wrong. Please try again.';
    addToHistory(conversationId, { role: 'assistant', content: reply });
    return res.json({ reply, history });
  }
});

// ---- health check ----
app.get('/', (_req, res) => res.send('Hansel Cottage Chatbot running.'));

app.listen(PORT, () => {
  console.log(`Server listening on ${PORT}`);
});

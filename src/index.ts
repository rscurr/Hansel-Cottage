import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { z } from 'zod';

import { refreshIcs, isRangeAvailable, suggestAlternatives, getIcsStats } from './ics.js';
import { quoteForStay } from './pricing.js';
import { answerWithContext, refreshContentIndex } from './rag.js';
// ⬇️ use LLM-only NLP
import { interpretMessageWithLLM } from './nlp.js';

const app = express();
app.use(express.json({ limit: '1mb' }));

const allowed = (process.env.ALLOWED_ORIGIN || '').split(',').map(s => s.trim()).filter(Boolean);
app.use(cors({ origin: allowed.length ? allowed : true }));

app.use(express.static('public'));

refreshIcs().catch(e => console.error('ICS init error', e));
refreshContentIndex().catch(e => console.error('Crawler init error', e));

app.get('/health', (_req, res) => {
  res.json({ ok: true, service: 'hanselcottage-chatbot-backend', ics: getIcsStats(), time: new Date().toISOString() });
});

const AvailQuery = z.object({
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  nights: z.coerce.number().int().min(1).max(30)
});
app.get('/api/availability', (req, res) => {
  const parsed = AvailQuery.safeParse(req.query);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const { from, nights } = parsed.data;
  const available = isRangeAvailable(from, nights);
  const reasons = available ? [] : ['Requested dates overlap existing booking or violate rules'];
  const suggestions = available ? [] : suggestAlternatives(from, nights, 10);
  res.json({ available, reasons, suggestions });
});

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

// ✅ Chat: try LLM extraction; if dates found → deterministic availability+quote; else RAG
const ChatReq = z.object({ message: z.string().min(1).max(2000) });
app.post('/api/chat', async (req, res) => {
  const parsed = ChatReq.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  try {
    const intent = await interpretMessageWithLLM(parsed.data.message);

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

    // Fallback: site-grounded Q&A
    const answer = await answerWithContext(parsed.data.message);
    res.json(answer);
  } catch (e: any) {
    res.status(500).json({ error: e?.message || 'chat-error' });
  }
});

// Admin endpoints unchanged...
app.post('/admin/ics/refresh', async (req, res) => {
  if (req.headers['x-admin-token'] !== process.env.ADMIN_TOKEN) return res.status(401).json({ error: 'unauthorized' });
  await refreshIcs(true);
  res.json({ ok: true, ics: getIcsStats() });
});

app.post('/admin/reindex', async (req, res) => {
  if (req.headers['x-admin-token'] !== process.env.ADMIN_TOKEN) return res.status(401).json({ error: 'unauthorized' });
  await refreshContentIndex(true);
  res.json({ ok: true });
});

const PORT = Number(process.env.PORT) || 3000;
app.listen(PORT, () => console.log(`Server listening on :${PORT}`));

import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { z } from 'zod';

import { refreshIcs, isRangeAvailable, suggestAlternatives, getIcsStats } from './ics.js';
import { quoteForStay } from './pricing.js';
import { answerWithContext, refreshContentIndex } from './rag.js';
import { interpretMessage } from './nlp.js';

const app = express();
app.use(express.json({ limit: '1mb' }));

// CORS
const allowed = (process.env.ALLOWED_ORIGIN || '').split(',').map(s => s.trim()).filter(Boolean);
app.use(cors({ origin: allowed.length ? allowed : true }));

// Serve hosted widget
app.use(express.static('public'));

// Boot-time refreshes
refreshIcs().catch(e => console.error('ICS init error', e));
refreshContentIndex().catch(e => console.error('Crawler init error', e));

// Health
app.get('/health', (_req, res) => {
  res.json({ ok: true, service: 'hanselcottage-chatbot-backend', ics: getIcsStats(), time: new Date().toISOString() });
});

// Availability
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

// Quote
const QuoteReq = z.object({
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  nights: z.number().int().min(1).max(30),
  dogs: z.number().int().min(0).max(4).default(0)
});
app.post('/api/quote', (req, res) => {
  const parsed = QuoteReq.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const result = quoteForStay(parsed.data);
  res.json(result);
});

// Chat with smart booking intent
const ChatReq = z.object({ message: z.string().min(1).max(2000) });
app.post('/api/chat', async (req, res) => {
  const parsed = ChatReq.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const { message } = parsed.data;

  // 1) Try to interpret booking intent & answer deterministically
  const intent = interpretMessage(message);
  if (intent.kind === 'dates') {
    const available = isRangeAvailable(intent.from, intent.nights);
    if (available) {
      const quote = quoteForStay({ from: intent.from, nights: intent.nights, dogs: intent.dogs });
      const dogsText = intent.dogs ? ` (incl. ${intent.dogs} dog${intent.dogs>1?'s':''})` : '';
      return res.json({
        answer: `✅ Yes, it looks available from ${intent.from} for ${intent.nights} night(s). Estimated total: ${quote.currency} ${quote.total}${dogsText}.`
      });
    } else {
      const alts = suggestAlternatives(intent.from, intent.nights, 10).slice(0,3).map(a => a.from).join(', ');
      return res.json({
        answer: `❌ Sorry, those dates look unavailable. ${alts ? `Closest alternatives: ${alts}.` : ''}`
      });
    }
  }

  // 2) Fallback to RAG/LLM over your site content
  try {
    const answer = await answerWithContext(message);
    return res.json(answer);
  } catch (e: any) {
    console.error(e);
    return res.status(500).json({ error: e?.message || 'chat-error' });
  }
});

// Admin
app.post('/admin/ics/refresh', async (req, res) => {
  if (req.headers['x-admin-token'] !== process.env.ADMIN_TOKEN) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  try {
    await refreshIcs(true);
    res.json({ ok: true, ics: getIcsStats() });
  } catch (e: any) {
    res.status(500).json({ error: e?.message || 'ics-refresh-error' });
  }
});
app.post('/admin/reindex', async (req, res) => {
  if (req.headers['x-admin-token'] !== process.env.ADMIN_TOKEN) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  try {
    await refreshContentIndex(true);
    res.json({ ok: true });
  } catch (e: any) {
    res.status(500).json({ error: e?.message || 'reindex-error' });
  }
});

const PORT = Number(process.env.PORT) || 3000;
app.listen(PORT, () => console.log(`Server listening on :${PORT}`));

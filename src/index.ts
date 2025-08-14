import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { z } from 'zod';

// ✅ use the existing modules you have
import { refreshIcs, isRangeAvailable, suggestAlternatives, getIcsStats } from './ics.js';
import { quoteForStay } from './pricing.js';
import { answerWithContext, refreshContentIndex } from './rag.js';

const app = express();
app.use(express.json({ limit: '1mb' }));

// CORS: allow your site origin (or comma-separated list)
const allowed = (process.env.ALLOWED_ORIGIN || '').split(',').map(s => s.trim()).filter(Boolean);
app.use(cors({
  origin: allowed.length ? allowed : true,
}));

// Serve the hosted widget script
app.use(express.static('public'));

// --- Kick off background refreshes (non-blocking)
refreshIcs().catch(err => console.error('ICS init error', err));
refreshContentIndex().catch(err => console.error('Crawler init error', err));

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

// Chat (RAG over your site content)
const ChatReq = z.object({ message: z.string().min(1).max(2000) });
app.post('/api/chat', async (req, res) => {
  const parsed = ChatReq.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  try {
    const answer = await answerWithContext(parsed.data.message);
    res.json(answer);
  } catch (e: any) {
    res.status(500).json({ error: e?.message || 'chat-error' });
  }
});

// Admin: force ICS refresh (requires header X-Admin-Token)
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

// Admin: force content reindex (requires header X-Admin-Token)
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
app.listen(PORT, () => {
  console.log(`Server listening on :${PORT}`);
});

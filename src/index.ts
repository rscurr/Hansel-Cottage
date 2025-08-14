import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { z } from 'zod';
import { checkAvailability } from './availability';
import { quoteForStay } from './pricing';
import { refreshContentIndex, answerWithContext } from './rag';

const app = express();
app.use(express.json());
app.use(cors({
  origin: process.env.ALLOWED_ORIGIN?.split(',') || '*',
}));

// 👇 NEW: serve static widget + other public assets
app.use(express.static('public'));

app.get('/health', (_req, res) => {
  res.json({ ok: true, time: new Date().toISOString() });
});

app.get('/api/availability', async (req, res) => {
  const schema = z.object({
    from: z.string(),
    nights: z.coerce.number().int().positive(),
  });
  const parsed = schema.safeParse(req.query);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.format() });

  const { from, nights } = parsed.data;
  const result = await checkAvailability(from, nights);
  res.json(result);
});

app.post('/api/quote', (req, res) => {
  const schema = z.object({
    from: z.string(),
    nights: z.number().int().positive(),
    dogs: z.number().int().nonnegative().optional(),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.format() });

  const q = quoteForStay(parsed.data);
  res.json(q);
});

app.post('/api/chat', async (req, res) => {
  const schema = z.object({
    message: z.string(),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.format() });

  const answer = await answerWithContext(parsed.data.message);
  res.json(answer);
});

app.post('/admin/ics/refresh', async (req, res) => {
  const token = req.header('X-Admin-Token');
  if (!token || token !== process.env.ADMIN_TOKEN) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  await checkAvailability('', 0, true); // force refresh
  res.json({ refreshed: true });
});

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`Server listening on port ${port}`);
});

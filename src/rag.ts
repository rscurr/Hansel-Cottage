import axios from 'axios';
import cheerio from 'cheerio';

type Chunk = { url: string; text: string; embedding?: number[] };
let chunks: Chunk[] = [];
let lastCrawl = 0;

const BASE_URLS = (process.env.BASE_URLS || '').split(',').map(s => s.trim()).filter(Boolean);
const REFRESH_INTERVAL_MINUTES = Number(process.env.REFRESH_INTERVAL_MINUTES || '60');
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';

function textify(html: string) {
  const $ = cheerio.load(html);
  ['script','style','noscript','iframe','svg'].forEach(s => $(s).remove());
  const body = $('body').text().replace(/\s+/g, ' ').trim();
  return body;
}

async function crawlOnce() {
  const out: Chunk[] = [];
  const seen = new Set<string>();
  const queue = [...BASE_URLS];

  const sameOrigin = (base: string, url: string) => {
    try {
      const a = new URL(url, base);
      const b = new URL(base);
      return a.hostname === b.hostname;
    } catch { return false; }
  };

  while (queue.length > 0 && out.length < 200) {
    const url = queue.shift() as string;
    if (seen.has(url)) continue;
    seen.add(url);

    try {
      const res = await axios.get(url, { timeout: 10000 });
      const html = res.data as string;
      const text = textify(html);
      if (text.length > 100) {
        const size = 1200;
        for (let i = 0; i < text.length; i += size) {
          out.push({ url, text: text.slice(i, i + size) });
        }
      }
      const $ = cheerio.load(res.data);
      $('a[href]').each((_i, el) => {
        const href = ($(el).attr('href') || '').trim();
        if (!href) return;
        const next = new URL(href, url).toString();
        if (sameOrigin(url, next) && !seen.has(next) && queue.length < 200) queue.push(next);
      });
    } catch (e) {
      // ignore fetch errors per-page
    }
  }
  chunks = out;
}

async function embedAll() {
  if (!OPENAI_API_KEY) return;
  for (const c of chunks) {
    c.embedding = await embedText(c.text);
  }
}

export async function refreshContentIndex(force = false) {
  const due = Date.now() - lastCrawl > REFRESH_INTERVAL_MINUTES * 60_000;
  if (!force && !due) return;
  if (BASE_URLS.length === 0) {
    console.warn('BASE_URLS not set; chat answers will be limited.');
    chunks = [];
    lastCrawl = Date.now();
    return;
  }
  await crawlOnce();
  await embedAll();
  lastCrawl = Date.now();
  console.log(`Crawl complete. ${chunks.length} chunks indexed.`);
}

function cosine(a: number[], b: number[]) {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i]*b[i]; na += a[i]*a[i]; nb += b[i]*b[i]; }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) + 1e-9);
}

async function embedText(text: string): Promise<number[]> {
  const res = await fetch('https://api.openai.com/v1/embeddings', {
    method: 'POST',
    headers: { 'Content-Type':'application/json', 'Authorization': `Bearer ${OPENAI_API_KEY}` },
    body: JSON.stringify({ model: 'text-embedding-3-small', input: text })
  });
  if (!res.ok) throw new Error(`embedding failed: ${res.status}`);
  const j = await res.json();
  return j.data[0].embedding as number[];
}

async function chatWithContext(prompt: string, context: string) {
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type':'application/json', 'Authorization': `Bearer ${OPENAI_API_KEY}` },
    body: JSON.stringify({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: 'You are a lodging assistant. Answer using ONLY the provided context. If the answer is not in context, say you do not know.' },
        { role: 'user', content: `Context:\n${context}\n\nQuestion: ${prompt}` }
      ],
      temperature: 0.2
    })
  });
  if (!res.ok) throw new Error(`chat failed: ${res.status}`);
  const j = await res.json();
  const text = j.choices?.[0]?.message?.content || 'No answer';
  return text;
}

export async function answerWithContext(message: string) {
  if (chunks.length === 0) await refreshContentIndex(true);
  const OPENAI = !!OPENAI_API_KEY;

  let top: Chunk[] = [];
  if (OPENAI && chunks[0]?.embedding) {
    const qvec = await embedText(message);
    top = chunks
      .map(c => ({ c, score: cosine(qvec, c.embedding as number[]) }))
      .sort((a,b) => b.score - a.score)
      .slice(0, 6)
      .map(x => x.c);
  } else {
    const terms = message.toLowerCase().split(/\W+/).filter(Boolean);
    const score = (t: string) => terms.reduce((s, w) => s + (t.toLowerCase().includes(w) ? 1 : 0), 0);
    top = chunks
      .map(c => ({ c, s: score(c.text) }))
      .sort((a,b) => b.s - a.s).slice(0, 6)
      .map(x => x.c);
  }

  const context = top.map(t => `From ${t.url}:\n${t.text}`).join('\n---\n');
  if (!OPENAI) {
    return {
      answer: "LLM disabled. Here are the most relevant snippets from your site.",
      context: top.map(t => ({ url: t.url, snippet: t.text.slice(0, 500) }))
    };
  } else {
    const text = await chatWithContext(message, context);
    return { answer: text, sources: [...new Set(top.map(t => t.url))] };
  }
}

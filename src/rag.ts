// src/rag.ts
// Lightweight RAG: in-memory chunks, keyword ranking fallback, optional OpenAI
// embeddings + LLM phrasing when OPENAI_API_KEY is present.

const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';

export type Chunk = {
  id: string;
  url: string;
  text: string;
  embedding?: number[];
};

// Keep chunks across hot reloads/container lifetime
export const chunks: Chunk[] = (global as any).__HC_CHUNKS__ ||= [];

/** Initialize/refresh your content index (no-op placeholder for site crawling) */
export async function refreshContentIndex(force = false): Promise<void> {
  if (force) {
    // If you later add a crawler, (re)populate `chunks` here.
    console.log('[rag] refresh requested (no-op placeholder)');
  }
}

/** Simple id generator */
function cryptoId(): string {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

/** Split plain text into ~1000 char chunks at paragraph boundaries */
function splitIntoChunks(text: string, sourceUrl: string, maxLen = 1000): Chunk[] {
  const paras = text.split(/\n{2,}/g).map(s => s.trim()).filter(Boolean);
  const out: Chunk[] = [];
  let buf = '';
  for (const p of paras) {
    if ((buf ? buf + '\n\n' : '').length + p.length > maxLen && buf) {
      out.push({ id: cryptoId(), url: sourceUrl, text: buf });
      buf = p;
    } else {
      buf = buf ? buf + '\n\n' + p : p;
    }
  }
  if (buf) out.push({ id: cryptoId(), url: sourceUrl, text: buf });
  return out;
}

/** Cosine similarity between two equal-length vectors */
function cosine(a: number[], b: number[]): number {
  let dot = 0, na = 0, nb = 0;
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const x = a[i], y = b[i];
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb) || 1;
  return dot / denom;
}

/** Keyword ranking fallback (no OpenAI needed) */
function keywordRank(query: string, k = 6): Chunk[] {
  const terms = query.toLowerCase().split(/\W+/).filter(Boolean);
  const score = (t: string): number =>
    terms.reduce((s: number, w: string) => s + (t.toLowerCase().includes(w) ? 1 : 0), 0);

  return chunks
    .map((c: Chunk) => ({ c, s: score(c.text) }))
    .sort((a, b) => b.s - a.s)
    .slice(0, k)
    .map(({ c }) => c);
}

/** Batch embed texts with OpenAI (safe: returns [] on failure) */
async function embedBatch(texts: string[]): Promise<number[][]> {
  if (!OPENAI_API_KEY) return [];
  try {
    const res = await fetch('https://api.openai.com/v1/embeddings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${OPENAI_API_KEY}` },
      body: JSON.stringify({ model: 'text-embedding-3-small', input: texts })
    });
    if (!res.ok) {
      return [];
    }
    const j: any = await res.json();
    return (j.data as Array<{ embedding: number[] }>).map((row) => row.embedding);
  } catch {
    return [];
  }
}

/** Embed a single query */
async function embedQuery(text: string): Promise<number[]> {
  const out = await embedBatch([text]);
  return out[0] || [];
}

/** Optional LLM phrasing over retrieved context (friendlier tone) */
async function chatWithContext(prompt: string, context: string): Promise<string> {
  if (!OPENAI_API_KEY) return '';
  try {
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${OPENAI_API_KEY}` },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        temperature: 0.25,
        messages: [
          {
            role: 'system',
            content:
              "You are a friendly, concise holiday-cottage assistant. Prefer using the provided context. " +
              "If the info isn't in context, say so briefly and suggest how the guest can ask (e.g., provide dates, nights, dogs) " +
              "or offer related info you do have. Keep replies short, clear, and helpful."
          },
          { role: 'user', content: `Context:\n${context}\n\nQuestion: ${prompt}` }
        ]
      })
    });
    if (!res.ok) return '';
    const j: any = await res.json();
    return j.choices?.[0]?.message?.content || '';
  } catch {
    return '';
  }
}

/** Public: add external document (e.g., PDF/WEB) into the index (with optional embeddings) */
export async function addExternalDocumentToIndex(title: string, sourceUrl: string, text: string): Promise<{ added: number; title: string; sourceUrl: string }> {
  const newChunks = splitIntoChunks(text, sourceUrl);

  if (OPENAI_API_KEY && newChunks.length) {
    const vecs = await embedBatch(newChunks.map((c) => c.text));
    if (vecs.length === newChunks.length) {
      for (let i = 0; i < newChunks.length; i++) {
        newChunks[i].embedding = vecs[i];
      }
    }
  }

  chunks.push(...newChunks);
  return { added: newChunks.length, title, sourceUrl };
}

/** Answer a user query with RAG. */
export async function answerWithContext(message: string): Promise<{ answer: string; sources?: string[]; context?: Array<{ url: string; snippet: string }> }> {
  if (chunks.length === 0) {
    console.log('[rag] no chunks loaded; returning snippets fallback');
  }

  let top: Chunk[] = [];

  // Prefer embedding search if we have embeddings AND an API key
  const haveEmbeddings = OPENAI_API_KEY && chunks.some((c) => Array.isArray(c.embedding) && c.embedding.length > 0);
  if (haveEmbeddings) {
    try {
      const qvec = await embedQuery(message);
      if (qvec.length) {
        top = chunks
          .filter((c) => Array.isArray(c.embedding) && c.embedding!.length > 0)
          .map((c) => ({ c, score: cosine(qvec, c.embedding as number[]) }))
          .sort((a, b) => b.score - a.score)
          .slice(0, 6)
          .map(({ c }) => c);
      }
    } catch {
      // fall back to keywords below
    }
  }

  if (top.length === 0) {
    top = keywordRank(message, 6);
  }

  const contextBlocks = top.map((t) => `From ${t.url}:\n${t.text}`).join('\n---\n');

  // If API key is present, try to produce a nicely phrased answer
  if (OPENAI_API_KEY) {
    const txt = await chatWithContext(message, contextBlocks);
    if (txt) {
      const uniqueSources = Array.from(new Set(top.map((t) => t.url)));
      return { answer: txt, sources: uniqueSources };
    }
  }

  // Snippet-only fallback (no LLM)
  if (top.length === 0) {
    return {
      answer:
        "I don’t have that in my notes yet. You can ask me about availability (with dates), prices, house info, or local area details."
    };
  }

  return {
    answer: 'Here are the most relevant details I found:',
    context: top.map((t) => ({ url: t.url, snippet: t.text.slice(0, 500) }))
  };
}

// Minimal RAG engine with keyword ranking and optional LLM phrasing.
// Add external documents (PDFs) via addExternalDocumentToIndex().
// If OPENAI_API_KEY is present, answers are nicely phrased with context;
// otherwise returns helpful snippets.

const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';

export type Chunk = { id: string; url: string; text: string; embedding?: number[] };

// Keep chunks in-memory across hot reloads (Render container lifetime)
export const chunks: Chunk[] = (global as any).__HC_CHUNKS__ ||= [];

// No-op placeholder; wire your site crawler here if you have one.
export async function refreshContentIndex(force = false) {
  if (force) {
    // In a real crawler, you'd refresh site pages into `chunks` here.
    console.log('[rag] refresh requested (no-op placeholder)');
  }
}

// --- Chunking helpers ---
function cryptoId() {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

// Split text at paragraph boundaries to ~1000 chars
function splitIntoChunks(text: string, sourceUrl: string, maxLen = 1000): Chunk[] {
  const paras = text.split(/\n{2,}/g).map(s => s.trim()).filter(Boolean);
  const out: Chunk[] = [];
  let buf = '';
  for (const p of paras) {
    if ((buf + '\n\n' + p).length > maxLen && buf) {
      out.push({ id: cryptoId(), url: sourceUrl, text: buf });
      buf = p;
    } else {
      buf = buf ? buf + '\n\n' + p : p;
    }
  }
  if (buf) out.push({ id: cryptoId(), url: sourceUrl, text: buf });
  return out;
}

// --- Public: add external document (e.g., PDF) into index ---
export async function addExternalDocumentToIndex(title: string, sourceUrl: string, text: string) {
  const newChunks = splitIntoChunks(text, sourceUrl);
  // Optional: embed chunks (not required for keyword search)
  if (OPENAI_API_KEY) {
    try {
      const res = await fetch('https://api.openai.com/v1/embeddings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${OPENAI_API_KEY}` },
        body: JSON.stringify({ model: 'text-embedding-3-small', input: newChunks.map(c => c.text) })
      });
      if (res.ok) {
        const j = await res.json();
        j.data.forEach((row: any, i: number) => { newChunks[i].embedding = row.embedding; });
      }
    } catch {
      // Ignore embedding failures; keyword search still works.
    }
  }
  chunks.push(...newChunks);
  return { added: newChunks.length, title, sourceUrl };
}

// Convenience wrapper if you want to keep the name parity
export async function addPdfByUrlToIndex(name: string, pdfUrl: string, fetcher: (u: string)=>Promise<string>) {
  const text = await fetcher(pdfUrl);
  return addExternalDocumentToIndex(name, pdfUrl, text);
}

// --- Retrieval & answer ---
function keywordRank(query: string, k = 6): Chunk[] {
  const terms = query.toLowerCase().split(/\W+/).filter(Boolean);
  const score = (t: string) => terms.reduce((s, w) => s + (t.toLowerCase().includes(w) ? 1 : 0), 0);
  return chunks
    .map(c => ({ c, s: score(c.text) }))
    .sort((a, b) => b.s - a.s)
    .slice(0, k)
    .map(x => x.c);
}

async function chatWithContext(prompt: string, context: string): Promise<string> {
  if (!OPENAI_API_KEY) return '';
  try {
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${OPENAI_API_KEY}` },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        temperature: 0.2,
        messages: [
          { role: 'system', content: 'You are a helpful holiday-cottage assistant. Answer using ONLY the provided context. If the answer is not in context, say you do not know.' },
          { role: 'user', content: `Context:\n${context}\n\nQuestion: ${prompt}` }
        ]
      })
    });
    if (!res.ok) throw new Error(String(await res.text()));
    const j = await res.json();
    return j.choices?.[0]?.message?.content || '';
  } catch {
    return '';
  }
}

export async function answerWithContext(message: string, useOpenAI: boolean = !!OPENAI_API_KEY) {
  if (chunks.length === 0) {
    console.log('[rag] no chunks loaded; returning empty snippets fallback');
  }

  const top = keywordRank(message, 6);
  const contextBlocks = top.map(t => `From ${t.url}:\n${t.text}`).join('\n---\n');

  if (useOpenAI) {
    const txt = await chatWithContext(message, contextBlocks);
    if (txt) {
      return { answer: txt, sources: [...new Set(top.map(t => t.url))] };
    }
  }

  // Snippet-only fallback (no LLM)
  return {
    answer: "Here are the most relevant details I found on the site.",
    context: top.map(t => ({ url: t.url, snippet: t.text.slice(0, 500) }))
  };
}

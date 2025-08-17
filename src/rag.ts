// src/rag.ts
import type { Request } from 'express';

type Doc = { source: string; text: string };
let INDEX: Doc[] = [];

export async function refreshContentIndex(): Promise<void> {
  // no-op placeholder (your boot process adds docs via addExternalDocumentToIndex)
}

export async function addExternalDocumentToIndex(source: string, nameOrUrl: string, text: string) {
  const chunks = chunk(text, 1200, 200).map(t => ({ source: `${source}:${nameOrUrl}`, text: t }));
  INDEX.push(...chunks);
  return { added: chunks.length };
}

export async function answerWithContext(question: string, _history?: Array<{role:string, content:string}>) {
  const key = process.env.OPENAI_API_KEY;
  const top = rank(question, INDEX, 6);
  const context = top.map(t => `Source: ${t.source}\n${t.text}`).join('\n\n');

  if (!key) {
    // simple fallback
    const snippet = top[0]?.text?.slice(0, 400) || 'I don’t have enough info yet.';
    return { answer: `LLM disabled. Here are the most relevant snippets from your site:\n\n${snippet}` };
  }

  const messages = [
    { role: 'system', content: 'You are a helpful assistant for Hansel Cottage. Answer using the provided context. If you are uncertain, say so and offer to find out.' },
    { role: 'user', content: `Question: ${question}\n\nContext:\n${context}` }
  ];

  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify({ model: 'gpt-4o-mini', temperature: 0.2, messages })
  });

  if (!res.ok) {
    return { answer: 'I had trouble contacting the AI service. Please try again.' };
  }

  const data: any = await res.json();
  const answer = String(data.choices?.[0]?.message?.content || '').trim() || 'Sorry, I’m not sure.';
  return { answer };
}

/* -------- tiny utilities -------- */

function chunk(text: string, size: number, overlap: number): string[] {
  const parts: string[] = [];
  let i = 0;
  while (i < text.length) {
    parts.push(text.slice(i, i + size));
    i += size - overlap;
    if (i < 0 || i >= text.length) break;
  }
  return parts;
}

function rank(q: string, docs: Doc[], k: number): Doc[] {
  const terms = tokenize(q);
  const scored = docs.map(d => ({ d, s: score(terms, d.text) }));
  scored.sort((a, b) => b.s - a.s);
  return scored.slice(0, k).map(x => x.d);
}

function tokenize(s: string) {
  return s.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(Boolean);
}
function score(terms: string[], text: string) {
  const t = text.toLowerCase();
  let s = 0;
  for (const w of terms) if (t.includes(w)) s += 1;
  return s + Math.min(5, Math.floor(text.length / 1000)); // tiny tie-breaker on length
}

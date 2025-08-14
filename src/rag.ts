// src/rag.ts
import { OpenAIEmbeddings } from '@langchain/openai';
import { MemoryVectorStore } from 'langchain/vectorstores/memory';
import { Document } from 'langchain/document';

let vectorStore: MemoryVectorStore | null = null;

export async function refreshContentIndex(force = false) {
  if (vectorStore && !force) return;
  vectorStore = new MemoryVectorStore(new OpenAIEmbeddings());
  console.log('[rag] index initialized');
}

export async function addExternalDocumentToIndex(title: string, sourceUrl: string, text: string) {
  if (!vectorStore) {
    await refreshContentIndex(true);
  }
  const doc = new Document({
    pageContent: text,
    metadata: { title, sourceUrl }
  });
  await vectorStore!.addDocuments([doc]);
  return { added: 1, title, sourceUrl };
}

export async function answerWithContext(query: string) {
  if (!vectorStore) {
    await refreshContentIndex(true);
  }

  const results = await vectorStore!.similaritySearch(query, 4);
  if (!process.env.OPENAI_API_KEY) {
    return {
      answer: 'LLM disabled. Here are the most relevant snippets:',
      snippets: results.map(r => r.pageContent.slice(0, 200))
    };
  }

  // Normally you'd call the LLM here to phrase a nice answer
  return {
    answer: `Based on context, possible answer: ${results.map(r => r.pageContent.slice(0, 150)).join(' ... ')}`
  };
}

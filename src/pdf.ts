/// <reference path="./types/pdfjs-dist.d.ts" />

import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.mjs';

/** Extract text from a PDF fetched from a URL. */
export async function extractPdfTextFromUrl(url: string): Promise<string> {
  if (!/^https?:\/\//i.test(url)) throw new Error(`Invalid PDF URL: ${url}`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to fetch PDF (${res.status} ${res.statusText}) from ${url}`);
  const ab = await res.arrayBuffer();
  return extractPdfTextFromArrayBuffer(ab);
}

/** Extract text from a local PDF file path. */
export async function extractPdfTextFromFile(path: string): Promise<string> {
  const { readFile } = await import('node:fs/promises');
  const buf = await readFile(path);
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  return extractPdfTextFromArrayBuffer(ab);
}

/* ---------------------- internals ---------------------- */
async function extractPdfTextFromArrayBuffer(ab: ArrayBufferLike): Promise<string> {
  const loadingTask = (pdfjsLib as any).getDocument({
    data: ab as ArrayBuffer,
    useWorkerFetch: false,
    isEvalSupported: false,
    disableFontFace: true,
    disableRange: true,
    verbosity: 0
  });

  const pdf = await loadingTask.promise;
  try {
    let text = '';
    for (let p = 1; p <= pdf.numPages; p++) {
      const page = await pdf.getPage(p);
      const content = await page.getTextContent({ normalizeWhitespace: true, disableCombineTextItems: false });
      const pageText = (content.items as any[]).map((it: any) => (typeof it?.str === 'string' ? it.str : '')).join(' ');
      text += pageText + '\n\n';
    }
    return normalizeWhitespace(text);
  } finally {
    try { await pdf.destroy(); } catch {}
  }
}

function normalizeWhitespace(s: string): string {
  return s.replace(/\r/g, '\n').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

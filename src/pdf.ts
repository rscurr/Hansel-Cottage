// src/pdf.ts
// Extracts text from a PDF using Mozilla PDF.js (pdfjs-dist) without a worker.
// Uses the legacy ESM build and light type shims so TypeScript is happy.

/// <reference path="./types/pdfjs-dist.d.ts" />

// Import the legacy ESM build (friendlier in Node)
import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.mjs';

/**
 * Extract text from a PDF fetched from a URL.
 */
export async function extractPdfTextFromUrl(url: string): Promise<string> {
  if (!/^https?:\/\//i.test(url)) {
    throw new Error(`Invalid PDF URL: ${url}`);
  }

  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Failed to fetch PDF (${res.status} ${res.statusText}) from ${url}`);
  }

  const ab = await res.arrayBuffer();
  return extractPdfTextFromArrayBuffer(ab);
}

/**
 * Extract text from a local PDF file (if you bundle one with the app).
 */
export async function extractPdfTextFromFile(path: string): Promise<string> {
  const { readFile } = await import('node:fs/promises');
  const buf = await readFile(path);

  // Turn Node Buffer into a clean ArrayBuffer
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  return extractPdfTextFromArrayBuffer(ab);
}

/* ---------------------- internals ---------------------- */

/**
 * Core extractor that works directly from an ArrayBuffer (or ArrayBufferLike).
 * We avoid setting a worker in Node; the legacy build works inline.
 */
async function extractPdfTextFromArrayBuffer(ab: ArrayBufferLike): Promise<string> {
  // pdfjs-dist's getDocument accepts BufferSource; cast is fine here.
  const loadingTask = (pdfjsLib as any).getDocument({
    data: ab as ArrayBuffer,
    // Conservative settings for server-side usage:
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
      const content = await page.getTextContent({
        normalizeWhitespace: true,
        disableCombineTextItems: false
      });

      const pageText = (content.items as any[])
        .map((it: any) => (typeof it?.str === 'string' ? it.str : ''))
        .join(' ');

      text += pageText + '\n\n';
    }
    return normalizeWhitespace(text);
  } finally {
    try { await pdf.destroy(); } catch {}
  }
}

function normalizeWhitespace(s: string): string {
  return s
    .replace(/\r/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// src/pdf.ts
// Extracts text from a PDF using Mozilla PDF.js (pdfjs-dist) without spawning a Web Worker.
// This avoids the pdf-parse ENOENT issue and works in a plain Node server.

import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.js';

/**
 * Extract text from a PDF fetched from a URL.
 * @param url HTTP(S) URL to a PDF file
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
 * @param path local filesystem path
 */
export async function extractPdfTextFromFile(path: string): Promise<string> {
  const { readFile } = await import('node:fs/promises');
  const buf = await readFile(path);
  return extractPdfTextFromArrayBuffer(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
}

/* ---------------------- internals ---------------------- */

/**
 * Core extractor that works directly from an ArrayBuffer.
 * Uses the legacy build and disables features that require a worker or canvas.
 */
async function extractPdfTextFromArrayBuffer(ab: ArrayBuffer): Promise<string> {
  // In Node, we avoid the worker entirely by not setting GlobalWorkerOptions.workerSrc
  // and by using safe flags below.
  const loadingTask = (pdfjsLib as any).getDocument({
    data: ab,
    // Be conservative in Node:
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
      // Concatenate all text items for this page; add blank line between pages
      const pageText = (content.items as any[])
        .map((it: any) => (typeof it.str === 'string' ? it.str : ''))
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

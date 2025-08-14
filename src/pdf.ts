// src/pdf.ts
import pdfParse from 'pdf-parse';

/**
 * Fetch a PDF by URL and return its extracted text.
 * Always passes a real Buffer to pdf-parse (never calls pdfParse() without args).
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
  const buf = Buffer.from(ab);           // ✅ real Buffer for pdf-parse
  const out = await pdfParse(buf);       // ✅ NEVER call pdfParse() with no args
  return normalizeWhitespace(out.text || '');
}

/**
 * Read a local PDF file (inside your container/repo) and return its text.
 * Use this only if you actually bundle PDFs with the app; otherwise prefer the URL variant.
 */
export async function extractPdfTextFromFile(path: string): Promise<string> {
  // Lazy import to avoid bundling fs in environments that don’t need it
  const { readFile } = await import('node:fs/promises');
  const buf = await readFile(path);      // ✅ Buffer for pdf-parse
  const out = await pdfParse(buf);       // ✅ NEVER call without Buffer
  return normalizeWhitespace(out.text || '');
}

/* ----------------- helpers ----------------- */

function normalizeWhitespace(s: string): string {
  return s
    .replace(/\r/g, '\n')         // unify newlines
    .replace(/[ \t]+\n/g, '\n')   // trim end-of-line spaces
    .replace(/\n{3,}/g, '\n\n')   // collapse big gaps
    .trim();
}

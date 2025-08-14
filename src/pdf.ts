// src/pdf.ts
import pdfParse from 'pdf-parse';

/**
 * Fetch a PDF by URL and return its extracted text.
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
  const buf = Buffer.from(ab);
  const out = await pdfParse(buf);
  return normalizeWhitespace(out.text || '');
}

/**
 * Read a local PDF file and return its extracted text.
 */
export async function extractPdfTextFromFile(path: string): Promise<string> {
  const { readFile } = await import('node:fs/promises');
  const buf = await readFile(path);
  const out = await pdfParse(buf);
  return normalizeWhitespace(out.text || '');
}

function normalizeWhitespace(s: string): string {
  return s
    .replace(/\r/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

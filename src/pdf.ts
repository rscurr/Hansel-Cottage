import pdfParse from 'pdf-parse';

// Fetch a PDF by URL and return its text
export async function extractPdfTextFromUrl(url: string): Promise<string> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to fetch PDF: ${res.status} ${res.statusText}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const out = await pdfParse(buf);
  return normalizeWhitespace(out.text);
}

// Read a local PDF (if you bundle one inside the repo)
export async function extractPdfTextFromFile(path: string): Promise<string> {
  const { readFile } = await import('node:fs/promises');
  const buf = await readFile(path);
  const out = await pdfParse(buf);
  return normalizeWhitespace(out.text);
}

function normalizeWhitespace(s: string): string {
  return s.replace(/\r/g, '\n').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

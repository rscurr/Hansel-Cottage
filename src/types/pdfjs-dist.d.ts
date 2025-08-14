// src/types/pdfjs-dist.d.ts

declare module 'pdfjs-dist/legacy/build/pdf.mjs' {
  // We only need getDocument() for this project; keep types loose.
  export const version: string;
  export function getDocument(data: any): {
    promise: Promise<{
      numPages: number;
      getPage(n: number): Promise<{
        getTextContent(opts?: any): Promise<{ items: Array<{ str?: string }> }>;
      }>;
      destroy(): Promise<void>;
    }>;
  };
}

declare module 'pdfjs-dist/legacy/build/pdf.js' {
  export * from 'pdfjs-dist/legacy/build/pdf.mjs';
}

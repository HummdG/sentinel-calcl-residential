// CLIENT-SIDE PDF text extraction (unpdf / bundled pdf.js).
//
// The PDF never leaves the browser: we extract text here and POST only the small
// text payload to /api/parse-pdf. This sidesteps Vercel's ~4.5 MB request-body
// limit and keeps the model call server-side. Pages are tagged "=== PAGE n ===" so
// the extractor can cite a page number and the verifier can look that page back up.
//
// Text hygiene and tagging live in lib/pdf-text.ts, shared with scripts/make-fixtures.ts
// so scoring fixtures are byte-identical to what this function produces.

import { tagPages } from './pdf-text';

export async function extractPdfText(file: File): Promise<string> {
  const { getDocumentProxy, extractText } = await import('unpdf');
  const buffer = new Uint8Array(await file.arrayBuffer());
  const pdf = await getDocumentProxy(buffer);
  const { text } = await extractText(pdf, { mergePages: false });

  return tagPages(Array.isArray(text) ? text : [text]);
}

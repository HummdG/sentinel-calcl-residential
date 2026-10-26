// CLIENT-SIDE PDF text extraction (unpdf / bundled pdf.js).
//
// The model normally reads the PDF itself (uploaded via /api/parse-pdf/upload). This text
// is still extracted in the browser because the verifier needs it: every quote the model
// gives is checked against it. It is also what the model reads when the PDF could not be
// uploaded. Pages are tagged "=== PAGE n ===" so a cited page can be looked back up.
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

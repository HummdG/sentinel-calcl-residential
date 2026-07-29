// CLIENT-SIDE PDF text extraction (unpdf / bundled pdf.js).
//
// The PDF never leaves the browser: we extract text here and POST only the small
// text payload to /api/parse-pdf. This sidesteps Vercel's ~4.5 MB request-body
// limit and keeps the Groq call server-side. Pages are tagged "=== PAGE n ==="
// to match the WordPress smalot extractor so the server-side head/tail fit works.

export async function extractPdfText(file: File): Promise<string> {
  const { getDocumentProxy, extractText } = await import('unpdf');
  const buffer = new Uint8Array(await file.arrayBuffer());
  const pdf = await getDocumentProxy(buffer);
  const { text } = await extractText(pdf, { mergePages: false });

  const pages = Array.isArray(text) ? text : [text];
  const parts: string[] = [];
  pages.forEach((raw, i) => {
    const trimmed = (raw ?? '').trim();
    if (trimmed !== '') {
      parts.push(`=== PAGE ${i + 1} ===\n${trimmed}`);
    }
  });

  return parts.join('\n\n');
}

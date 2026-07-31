// Shared PDF-text hygiene and page tagging.
//
// Imported by lib/pdf-extract.ts (browser) and scripts/make-fixtures.ts (node) so the
// scoring fixtures are byte-identical to what the browser actually sends. Keep this
// module dependency-free. Node runs it directly via type stripping.
//
// Patterns are built with `new RegExp` from escape sequences rather than written as
// literals: the characters involved are invisible control codes, and a literal would be
// unreadable in review and easy to corrupt in an editor.

// pdf.js cannot map some ligature glyphs in these proposals' embedded subset fonts and
// emits a placeholder instead: U+0000 where fi/ffi/fl was ("certified" -> "certi\0ed"),
// U+FFFD where tt/ti was ("Battery" -> "Ba�ery"). Both appear only in marketing
// prose and manufacturer datasheet labels. No financial figure in any sample proposal
// is affected. So the characters are dropped rather than decoded.
//
// Decoding them properly would mean adding pdfjs-dist and serving its cMap files, which
// buys nothing for extraction. Dropping them here also keeps evidence grounding sound:
// the model reads this cleaned text, so its quotes are spans of this same string.
const DROP_CHARS = new RegExp('[\\u0000\\uFFFD]', 'g');

// Remaining C0/C1 controls and zero-width marks. Tab (U+0009) and newline (U+000A) are
// load-bearing. Tabs separate columns in the OpenSolar cashflow tables. So the ranges
// below step around them.
const CONTROL_CHARS = new RegExp(
  '[\\u0001-\\u0008\\u000B-\\u001F\\u007F-\\u009F\\u200B-\\u200F\\uFEFF]',
  'g'
);

/** Strip glyph-mapping artefacts and control characters; normalise line endings. */
export function normalisePdfText(raw: string): string {
  return raw
    .replace(DROP_CHARS, '')
    .replace(CONTROL_CHARS, '')
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.replace(/[ \t]+$/, ''))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n');
}

/**
 * Join per-page text into the tagged form the extractor and verifier both expect.
 *
 * Page numbers stay 1-based against the original document even when a page yields no
 * text, so a page number the model cites always resolves back to the real PDF page.
 */
export function tagPages(pages: (string | null | undefined)[]): string {
  const parts: string[] = [];
  pages.forEach((raw, i) => {
    const trimmed = normalisePdfText(raw ?? '').trim();
    if (trimmed !== '') parts.push(`=== PAGE ${i + 1} ===\n${trimmed}`);
  });
  return parts.join('\n\n');
}

/** Split tagged text back into a page-number -> text map, for evidence grounding. */
export function splitTaggedPages(tagged: string): Map<number, string> {
  const out = new Map<number, string>();
  const re = /^=== PAGE (\d+) ===$/gm;
  const marks: { page: number; start: number; end: number }[] = [];

  let m: RegExpExecArray | null;
  while ((m = re.exec(tagged)) !== null) {
    marks.push({ page: Number(m[1]), start: m.index, end: re.lastIndex });
  }

  marks.forEach((mark, i) => {
    const bodyEnd = i + 1 < marks.length ? marks[i + 1].start : tagged.length;
    out.set(mark.page, tagged.slice(mark.end, bodyEnd).trim());
  });

  return out;
}

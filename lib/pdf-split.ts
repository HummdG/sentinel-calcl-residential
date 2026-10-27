// Split a proposal PDF into parts small enough to upload.
//
// The model reads the original PDF (text and page images together), but the file has to
// reach the server first, and Vercel caps a request body at ~4.5 MB. Most proposals are
// 2.5-3.6 MB and go up whole. Murray Road is 5 MB, so anything over the cap is cut into
// consecutive page ranges, each uploaded on its own and handed to the model as one
// document per part.
//
// Shared by the browser (UploadZone) and node (scripts/score-extraction.mts), so it takes
// and returns plain bytes. Keep it free of DOM and node imports.

import { PDFDocument } from 'pdf-lib';

/** Largest body we send in one request. Leaves headroom under Vercel's ~4.5 MB cap. */
export const MAX_PART_BYTES = 4_000_000;

/**
 * A sanity cap, not the API's limit (600 pages on the 1M-context models in use). Real
 * proposals run 16-20 pages, so anything near 100 is not a proposal, and is better sent
 * down the cheaper text path than billed as a few hundred page images.
 */
export const MAX_PDF_PAGES = 100;

export interface PdfPart {
  bytes: Uint8Array;
  /** 1-based, inclusive, against the original document. */
  firstPage: number;
  lastPage: number;
}

export class PdfTooLargeError extends Error {}

/** Copy pages [from, to] (0-based, inclusive) of `src` into a new PDF. */
async function slice(src: PDFDocument, from: number, to: number): Promise<Uint8Array> {
  const out = await PDFDocument.create();
  const indices = Array.from({ length: to - from + 1 }, (_, i) => from + i);
  const pages = await out.copyPages(src, indices);
  pages.forEach((p) => out.addPage(p));
  return out.save();
}

/**
 * Return the document as one part when it fits, otherwise as the fewest consecutive page
 * ranges that each fit. Shared resources (fonts, logos) are copied into every part that
 * uses them, so the parts together can be larger than the original. That is why sizes are
 * measured after saving rather than estimated by dividing.
 *
 * Throws PdfTooLargeError when the document is over the page limit, or when one page on
 * its own is over the byte limit. The caller falls back to the text pipeline then.
 */
export async function splitPdf(bytes: Uint8Array, maxBytes = MAX_PART_BYTES): Promise<PdfPart[]> {
  const src = await PDFDocument.load(bytes, { ignoreEncryption: true });
  const pageCount = src.getPageCount();

  if (pageCount > MAX_PDF_PAGES) {
    throw new PdfTooLargeError(`${pageCount} pages is over the ${MAX_PDF_PAGES}-page limit.`);
  }
  if (bytes.byteLength <= maxBytes) {
    return [{ bytes, firstPage: 1, lastPage: pageCount }];
  }

  const parts: PdfPart[] = [];
  let start = 0;
  while (start < pageCount) {
    // Grow the range one page at a time and keep the last size that fit. Proposals are
    // ~20 pages, so the repeated saves cost well under a second.
    let best: Uint8Array | null = null;
    let end = start;
    for (let i = start; i < pageCount; i++) {
      const candidate = await slice(src, start, i);
      if (candidate.byteLength > maxBytes) break;
      best = candidate;
      end = i;
    }
    if (best === null) {
      throw new PdfTooLargeError(`Page ${start + 1} alone is over the upload limit.`);
    }
    parts.push({ bytes: best, firstPage: start + 1, lastPage: end + 1 });
    start = end + 1;
  }
  return parts;
}

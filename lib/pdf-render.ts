// CLIENT-SIDE PDF page -> JPEG, for the vision escalation tier.
//
// Runs in the browser for the same reason text extraction does: Vercel caps request
// bodies at ~4.5 MB, and the sample proposals are 2.5-3.6 MB before base64 inflates them
// by a third. Posting a 3.6 MB PDF would exceed the limit outright. Rendering only the
// pages that matter, at a bounded resolution, keeps the payload an order of magnitude
// smaller than the source file.

import type { PageImage } from './extract/anthropic';

/** Long-edge cap. Comfortably above the ~1,500 px where text in these proposals stops
 *  being legible, and below the resolution at which image tokens stop paying for
 *  themselves. */
const MAX_EDGE = 1500;
const JPEG_QUALITY = 0.72;

/** Hard ceilings so a 40-page proposal cannot blow the request-body limit. */
const MAX_PAGES = 8;
const MAX_TOTAL_BYTES = 3_000_000;

/**
 * Pages worth rendering when nothing more specific is known.
 *
 * Across every sample proposal the figures cluster in the same places: a summary tile
 * page near the front, the equipment list, the MCS performance tables, and the financial
 * pages around two-thirds through. Page 1 is the customer address.
 */
function defaultPages(pageCount: number): number[] {
  const picks = new Set<number>([1, 3, 4]);
  for (const frac of [0.35, 0.5, 0.62, 0.72]) {
    picks.add(Math.max(1, Math.min(pageCount, Math.round(pageCount * frac))));
  }
  return [...picks].filter((p) => p >= 1 && p <= pageCount).sort((a, b) => a - b);
}

/**
 * Choose which pages to send.
 *
 * `priority` comes from the provenance of fields the verifier rejected. The page the
 * model claimed to read a bad figure from is exactly the page worth showing it properly.
 */
export function choosePages(pageCount: number, priority: number[] = []): number[] {
  const seen = new Set<number>();
  const out: number[] = [];

  for (const p of [...priority, ...defaultPages(pageCount)]) {
    if (p >= 1 && p <= pageCount && !seen.has(p)) {
      seen.add(p);
      out.push(p);
      if (out.length >= MAX_PAGES) break;
    }
  }
  return out.sort((a, b) => a - b);
}

/** Render the chosen pages of `file` to base64 JPEGs. */
export async function renderPages(file: File, priority: number[] = []): Promise<PageImage[]> {
  const { getDocumentProxy } = await import('unpdf');
  const buffer = new Uint8Array(await file.arrayBuffer());
  const pdf = await getDocumentProxy(buffer);

  const wanted = choosePages(pdf.numPages, priority);
  const images: PageImage[] = [];
  let total = 0;

  for (const pageNo of wanted) {
    const page = await pdf.getPage(pageNo);

    const base = page.getViewport({ scale: 1 });
    const scale = Math.min(MAX_EDGE / Math.max(base.width, base.height), 2);
    const viewport = page.getViewport({ scale });

    const canvas = document.createElement('canvas');
    canvas.width = Math.ceil(viewport.width);
    canvas.height = Math.ceil(viewport.height);
    const ctx = canvas.getContext('2d');
    if (!ctx) continue;

    // JPEG has no alpha; without a white ground, transparent PDF backgrounds render black.
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    await page.render({ canvasContext: ctx, viewport, canvas } as never).promise;

    const dataUrl = canvas.toDataURL('image/jpeg', JPEG_QUALITY);
    const data = dataUrl.slice(dataUrl.indexOf(',') + 1);

    // Approximate decoded size; base64 carries 3 bytes per 4 characters.
    const bytes = Math.ceil((data.length * 3) / 4);
    if (total + bytes > MAX_TOTAL_BYTES) break;
    total += bytes;

    images.push({ page: pageNo, data, mediaType: 'image/jpeg' });
  }

  return images;
}

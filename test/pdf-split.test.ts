// lib/pdf-split.ts: getting a proposal under Vercel's request-size cap without losing or
// reordering a page. Uses the real sample proposals from the repo root.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PDFDocument } from 'pdf-lib';
import { MAX_PART_BYTES, PdfTooLargeError, splitPdf } from '../lib/pdf-split';

const root = join(__dirname, '..', '..');
const load = (name: string) => new Uint8Array(readFileSync(join(root, name)));

describe('splitPdf', () => {
  it('sends a proposal under the cap as one untouched part', async () => {
    const bytes = load('OS_Quote_Proposal_22_Varey_Road.pdf');
    expect(bytes.byteLength).toBeLessThan(MAX_PART_BYTES);

    const parts = await splitPdf(bytes);
    expect(parts).toHaveLength(1);
    expect(parts[0].bytes).toBe(bytes);
    expect(parts[0]).toMatchObject({ firstPage: 1, lastPage: 18 });
  });

  it('splits Murray Road (5 MB) into consecutive parts that each fit', async () => {
    const bytes = load('Proposal_61_Murray_Road.pdf');
    expect(bytes.byteLength).toBeGreaterThan(MAX_PART_BYTES);

    const parts = await splitPdf(bytes);
    expect(parts.length).toBeGreaterThan(1);

    // Every page exactly once, in order.
    let next = 1;
    for (const part of parts) {
      expect(part.bytes.byteLength).toBeLessThanOrEqual(MAX_PART_BYTES);
      expect(part.firstPage).toBe(next);
      const doc = await PDFDocument.load(part.bytes);
      expect(doc.getPageCount()).toBe(part.lastPage - part.firstPage + 1);
      next = part.lastPage + 1;
    }
    expect(next - 1).toBe(20);
  }, 60_000);

  it('refuses a page that cannot fit on its own, so the caller falls back to text', async () => {
    const bytes = load('Proposal_61_Murray_Road.pdf');
    await expect(splitPdf(bytes, 1_000)).rejects.toBeInstanceOf(PdfTooLargeError);
  }, 60_000);
});

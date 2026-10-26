// Store one part of a proposal PDF with the Anthropic Files API.
//
// The model reads the proposal as a PDF, so the file has to reach Anthropic. Doing that
// here, rather than inline in the extraction call, means both tiers can read the same
// upload and the PDF crosses the network once. The browser splits anything over Vercel's
// ~4.5 MB body cap into page ranges first (lib/pdf-split.ts) and calls this once per part.
//
// Body: the raw PDF bytes, Content-Type application/pdf. Returns { fileId }.

import { NextResponse } from 'next/server';
import { guard } from '@/lib/extract/route-handler';
import { uploadPdf } from '@/lib/extract/anthropic';
import { MAX_PART_BYTES } from '@/lib/pdf-split';

export const runtime = 'nodejs';
export const maxDuration = 60;

export async function POST(req: Request) {
  // A proposal over the size cap arrives as two or three parts, so uploads get a larger
  // allowance than extraction calls.
  const stop = guard(req, 'upload', 3);
  if (stop) return stop;

  const bytes = new Uint8Array(await req.arrayBuffer());
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_PART_BYTES + 64_000) {
    return NextResponse.json({ error: 'PDF part is empty or too large.' }, { status: 413 });
  }
  // "%PDF-": refuse anything that is not a PDF before spending an upload on it.
  const magic = String.fromCharCode(...bytes.subarray(0, 5));
  if (magic !== '%PDF-') {
    return NextResponse.json({ error: 'That file is not a PDF.' }, { status: 415 });
  }

  try {
    const fileId = await uploadPdf(bytes);
    return NextResponse.json({ fileId });
  } catch (e) {
    const message = e instanceof Error ? e.message : 'Upload failed.';
    return NextResponse.json({ error: message }, { status: 502 });
  }
}

// Tier 2: stronger model. It re-reads the same uploaded PDF; on the text fallback it gets
// rendered page images alongside the text instead.
//
// Reached in two cases:
//   1. Tier 1 returned `escalate`. A quote could not be grounded, or the figures failed
//      an arithmetic cross-check.
//   2. The PDF has no text layer at all (a scan), so tier 1 was skipped entirely and this
//      is the only route that can read it. That case used to fail outright with
//      "Could not read any text from the PDF".
//
// Page images are what make this tier worth its cost: the layout is the information in
// these proposals, and a figure rendered above its caption is unambiguous in an image
// while being a coin-flip in linearised text.

import { handleExtraction } from '@/lib/extract/route-handler';

export const runtime = 'nodejs';
export const maxDuration = 60;

export async function POST(req: Request) {
  return handleExtraction(req, 'escalation');
}

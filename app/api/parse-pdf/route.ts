// Tier 1: cheap model. It reads the uploaded proposal PDF (see ./upload), or the pdf.js
// text when the PDF could not be uploaded.
//
// Returns as soon as the fast model has been verified, so the surveyor sees most fields
// in a few seconds. If a verification gate failed, `escalate` is set and the client calls
// /api/parse-pdf/escalate. Splitting the tiers across two requests keeps each one inside
// Vercel's 60s function ceiling, which a Haiku call followed by an Opus vision call would
// otherwise breach.

import { handleExtraction } from '@/lib/extract/route-handler';

export const runtime = 'nodejs';
export const maxDuration = 60;

export async function POST(req: Request) {
  return handleExtraction(req, 'primary');
}

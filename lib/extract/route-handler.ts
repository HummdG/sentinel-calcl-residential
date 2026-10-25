// Shared request handling for both extraction tiers.
//
// /api/parse-pdf and /api/parse-pdf/escalate differ only in which model they name and
// whether page images are attached, so the auth, rate limiting, validation and response
// shaping all live here rather than being written twice.

import { NextResponse } from 'next/server';
import { getExtractionConfig } from '../config';
import { extractFields, type PageImage } from './anthropic';
import { verifyExtraction } from './verify';
import { NUMERIC_FIELDS, TEXT_FIELDS } from './schema';
import type { ExtractedFields, ParsedPdfResponse } from '../types';

/**
 * Per-IP rate limiting, in memory.
 *
 * Deliberately simple: serverless instances are not shared, so this bounds abuse per
 * instance rather than globally. That is enough to stop a scripted loop draining the
 * Anthropic account, which is the actual risk. A global limit would need Redis or Vercel
 * KV. Worth adding if the endpoint is ever exposed beyond the surveyor tool.
 */
const hits = new Map<string, number[]>();

function rateLimited(ip: string, perHour: number): boolean {
  const now = Date.now();
  const cutoff = now - 3_600_000;
  const recent = (hits.get(ip) ?? []).filter((t) => t > cutoff);
  recent.push(now);
  hits.set(ip, recent);

  // Opportunistic cleanup so the map cannot grow without bound on a warm instance.
  if (hits.size > 500) {
    for (const [k, v] of hits) if (v.every((t) => t <= cutoff)) hits.delete(k);
  }

  return recent.length > perHour;
}

function clientIp(req: Request): string {
  const fwd = req.headers.get('x-forwarded-for');
  return fwd?.split(',')[0]?.trim() || req.headers.get('x-real-ip') || 'unknown';
}

export interface TierRequest {
  text: string;
  pageImages?: PageImage[];
}

function toFields(values: Record<string, number | string | null>): ExtractedFields {
  const out = {} as ExtractedFields;
  for (const f of TEXT_FIELDS) {
    const v = values[f];
    (out as unknown as Record<string, unknown>)[f] = typeof v === 'string' && v !== '' ? v : null;
  }
  for (const f of NUMERIC_FIELDS) {
    if (f === 'export_pct') continue;
    const v = values[f];
    (out as unknown as Record<string, unknown>)[f] = typeof v === 'number' ? v : null;
  }
  return out;
}

function summarise(
  populated: number,
  total: number,
  missing: string[],
  tier: 'primary' | 'escalation',
  escalate: boolean
): string {
  if (populated === 0) {
    return 'No values could be read from this proposal. Enter the figures manually from the document.';
  }
  const head = `Extracted ${populated} of ${total} values.`;
  if (escalate && tier === 'primary') return `${head} Re-checking a few figures…`;
  if (missing.length) {
    return `${head} ${missing.length} could not be confirmed and are marked below. Enter them from the proposal before calculating.`;
  }
  return `${head} Review and adjust if needed, then click Calculate.`;
}

export async function handleExtraction(
  req: Request,
  tier: 'primary' | 'escalation'
): Promise<NextResponse> {
  const cfg = getExtractionConfig();

  if (!cfg.apiKey) {
    return NextResponse.json(
      { error: 'Extraction is not configured on this server (ANTHROPIC_API_KEY).' },
      { status: 503 }
    );
  }

  if (cfg.sharedSecret && req.headers.get('x-extract-key') !== cfg.sharedSecret) {
    return NextResponse.json({ error: 'Not authorised.' }, { status: 401 });
  }

  if (rateLimited(clientIp(req), cfg.rateLimitPerHour)) {
    return NextResponse.json(
      { error: 'Too many extractions from this address. Try again shortly.' },
      { status: 429 }
    );
  }

  let body: TierRequest;
  try {
    body = (await req.json()) as TierRequest;
  } catch {
    return NextResponse.json({ error: 'Invalid request body.' }, { status: 400 });
  }

  const text = typeof body.text === 'string' ? body.text : '';
  const pageImages = Array.isArray(body.pageImages) ? body.pageImages : undefined;

  // The escalation tier can work from images alone. That is the path a scanned proposal
  // takes, where there is no text layer at all and tier 1 was skipped entirely.
  if (text.trim() === '' && !pageImages?.length) {
    return NextResponse.json(
      { error: 'Could not read this PDF. Please enter the values manually.' },
      { status: 400 }
    );
  }

  const model = tier === 'primary' ? cfg.primaryModel : cfg.escalationModel;

  if (process.env.NODE_ENV !== 'production') {
    const kb = Math.round(
      (pageImages ?? []).reduce((n, i) => n + (i.data?.length ?? 0) * 0.75, 0) / 1024
    );
    console.log(
      `[extract] tier=${tier} model=${model} text=${text.length}ch images=${pageImages?.length ?? 0} (${kb}KB) pages=[${(pageImages ?? []).map((i) => i.page).join(',')}]`
    );
  }

  try {
    const result = await extractFields(text.slice(0, cfg.maxChars), { model, pageImages });
    const verified = verifyExtraction(result.claims, text);

    const fields = toFields(verified.values);
    const total = Object.keys(fields).length;
    const populated = Object.values(fields).filter((v) => v !== null).length;

    // Only the cheap tier asks for a retry. Escalation is the last stop.
    const escalate = tier === 'primary' && verified.escalate;

    const payload: ParsedPdfResponse = {
      fields,
      provenance: verified.provenance,
      missing: verified.missing,
      warnings: verified.warnings,
      populated_count: populated,
      message: summarise(populated, total, verified.missing, tier, escalate),
      tier,
      escalate,
    };
    return NextResponse.json(payload);
  } catch (e) {
    const message = e instanceof Error ? e.message : 'Extraction failed.';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

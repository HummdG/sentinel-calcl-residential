// Shared request handling for both extraction tiers.
//
// /api/parse-pdf and /api/parse-pdf/escalate differ only in which model they name and
// whether page images are attached, so the auth, rate limiting, validation and response
// shaping all live here rather than being written twice.

import { NextResponse, after } from 'next/server';
import { getExtractionConfig } from '../config';
import {
  FILE_ID_RE,
  deleteFiles,
  extractFields,
  type PageImage,
  type PdfDocumentRef,
} from './anthropic';
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

function rateLimited(key: string, perHour: number): boolean {
  const now = Date.now();
  const cutoff = now - 3_600_000;
  const recent = (hits.get(key) ?? []).filter((t) => t > cutoff);
  recent.push(now);
  hits.set(key, recent);

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
  /** pdf.js text of the proposal. Sent to the model only when `documents` is absent. */
  text: string;
  /** The uploaded proposal (see /api/parse-pdf/upload). The model reads this when given. */
  documents?: PdfDocumentRef[];
  pageImages?: PageImage[];
}

/**
 * Checks shared by every extraction route: configured, authorised, not rate limited.
 * Returns the response to send when the request must stop here, otherwise null.
 *
 * `bucket` separates limits: one proposal costs an upload per part plus one or two
 * extraction calls, and those should not eat into each other's allowance.
 */
export function guard(req: Request, bucket: string, perHourFactor = 1): NextResponse | null {
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

  if (rateLimited(`${bucket}:${clientIp(req)}`, cfg.rateLimitPerHour * perHourFactor)) {
    return NextResponse.json(
      { error: 'Too many extractions from this address. Try again shortly.' },
      { status: 429 }
    );
  }
  return null;
}

/** Accept only well-formed references to uploaded parts; anything else is dropped. */
function parseDocuments(raw: unknown): PdfDocumentRef[] | undefined {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > 10) return undefined;
  const docs: PdfDocumentRef[] = [];
  for (const d of raw as Record<string, unknown>[]) {
    const { fileId, firstPage, lastPage } = d ?? {};
    if (
      typeof fileId !== 'string' ||
      !FILE_ID_RE.test(fileId) ||
      !Number.isInteger(firstPage) ||
      !Number.isInteger(lastPage) ||
      (firstPage as number) < 1 ||
      (lastPage as number) < (firstPage as number)
    ) {
      return undefined;
    }
    docs.push({ fileId, firstPage: firstPage as number, lastPage: lastPage as number });
  }
  return docs;
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
  const stop = guard(req, 'extract');
  if (stop) return stop;

  let body: TierRequest;
  try {
    body = (await req.json()) as TierRequest;
  } catch {
    return NextResponse.json({ error: 'Invalid request body.' }, { status: 400 });
  }

  const text = typeof body.text === 'string' ? body.text : '';
  const pageImages = Array.isArray(body.pageImages) ? body.pageImages : undefined;
  const documents = parseDocuments(body.documents);

  // The escalation tier can work from images alone. That is the path a scanned proposal
  // takes, where there is no text layer at all and tier 1 was skipped entirely.
  if (text.trim() === '' && !pageImages?.length && !documents) {
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
      `[extract] tier=${tier} model=${model} text=${text.length}ch documents=${documents?.length ?? 0} images=${pageImages?.length ?? 0} (${kb}KB) pages=[${(pageImages ?? []).map((i) => i.page).join(',')}]`
    );
  }

  try {
    const result = await extractFields(text.slice(0, cfg.maxChars), {
      model,
      documents,
      pageImages: documents ? undefined : pageImages,
    });
    // Grounding always runs against the pdf.js text, even when the model read the PDF.
    const verified = verifyExtraction(result.claims, text);

    const fields = toFields(verified.values);
    const total = Object.keys(fields).length;
    const populated = Object.values(fields).filter((v) => v !== null).length;

    // Only the cheap tier asks for a retry. Escalation is the last stop.
    const escalate = tier === 'primary' && verified.escalate;

    // Nothing will read the uploaded proposal again, so delete it (it carries the
    // customer's name and address). After the response, so the surveyor does not wait.
    // The browser also asks for this in a finally; deleting twice is harmless.
    if (documents && !escalate) {
      after(() => deleteFiles(documents.map((d) => d.fileId)));
    }

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

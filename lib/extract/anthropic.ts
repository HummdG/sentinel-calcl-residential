// The model call. One prompt, one schema, two model strings, two input forms (the PDF
// itself, or its extracted text as a fallback).
//
// Escalation from the cheap tier to the strong one is a parameter change, not a second
// pipeline. Everything that differs between the cheap and strong models is
// confined to paramsFor() below. That keeps the tiering from turning into two code paths
// that drift apart, which is what happened to the PHP and Next.js ports of the old
// extractor.

import Anthropic, { toFile } from '@anthropic-ai/sdk';
import { buildUserPrompt, fieldInstructions, systemPrompt } from './prompt';
import {
  ALL_FIELDS,
  NUMERIC_FIELDS,
  TEXT_FIELDS,
  emptyClaim,
  extractionSchema,
  type Claim,
  type ExtractionClaims,
} from './schema';

/** A rendered PDF page, for the vision tier. */
export interface PageImage {
  page: number;
  /** base64, no data: prefix. */
  data: string;
  mediaType: 'image/jpeg' | 'image/png';
}

/**
 * One uploaded part of the proposal PDF (see lib/pdf-split.ts). Most proposals are a
 * single part covering every page.
 */
export interface PdfDocumentRef {
  fileId: string;
  /** 1-based, inclusive, against the full proposal. */
  firstPage: number;
  lastPage: number;
}

export interface ExtractOptions {
  model: string;
  /**
   * The proposal itself, uploaded through the Files API. When present the model reads
   * the PDF and `documentText` is not sent to it (it is still used by verify.ts).
   */
  documents?: PdfDocumentRef[];
  pageImages?: PageImage[];
  /** Overrides the ANTHROPIC_API_KEY env var (used by the scoring harness). */
  apiKey?: string;
  signal?: AbortSignal;
}

export interface ExtractResult {
  claims: ExtractionClaims;
  model: string;
  usage: { input: number; output: number };
  /** USD, from the rate table below. */
  costUsd: number;
}

// Anthropic list prices, USD per million tokens. Used only for the cost figure the
// scoring harness reports. Nothing branches on it.
const RATES: Record<string, { input: number; output: number }> = {
  // Claude Haiku 5.5's rate for prompts up to 100K tokens; a proposal PDF is ~40K.
  'claude-haiku-5-5': { input: 0.1, output: 0.5 },
  'claude-haiku-4-5': { input: 1, output: 5 },
  'claude-sonnet-5': { input: 3, output: 15 },
  'claude-opus-5': { input: 5, output: 25 },
};

function rateFor(model: string) {
  return RATES[model] ?? { input: 5, output: 25 };
}

/**
 * Per-model request parameters.
 *
 * Current models (Claude Haiku 5.5, Opus 5 / 5.5, Sonnet 5 / 5.5) reject a non-default
 * `temperature` outright, and their thinking is on by default with `max_tokens` capping
 * thinking *plus* output. Hence the much larger budget. Thinking is deliberately left on:
 * `effort` is the supported way to bound spend.
 *
 * Only Claude Haiku 4.5, the previous primary model, takes the older parameters. It is
 * kept so EXTRACT_MODEL_PRIMARY can still point at it.
 */
function paramsFor(model: string): Record<string, unknown> {
  if (!model.startsWith('claude-haiku-4')) {
    return {
      max_tokens: 8000,
      output_config: { effort: 'medium', format: extractionSchema() },
    };
  }
  return {
    max_tokens: 4096,
    temperature: 0,
    output_config: { format: extractionSchema() },
  };
}

function contentBlocks(
  text: string,
  documents: PdfDocumentRef[] | undefined,
  pageImages: PageImage[] | undefined
) {
  const blocks: unknown[] = [];

  // The PDF route. The model gets the real pages, laid out, so it no longer has to
  // reconstruct tables from a linearised string. Documents go before the instructions.
  if (documents?.length) {
    for (const d of documents) {
      blocks.push({
        type: 'document',
        source: { type: 'file', file_id: d.fileId },
        title: `Proposal pages ${d.firstPage}-${d.lastPage}`,
      });
    }
    blocks.push({ type: 'text', text: fieldInstructions() });
    return blocks;
  }

  // Images first: the page a figure sits on reads more naturally before the linearised
  // text that repeats it, and it matches the ordering used in the vision docs.
  for (const img of pageImages ?? []) {
    blocks.push({
      type: 'image',
      source: { type: 'base64', media_type: img.mediaType, data: img.data },
    });
    blocks.push({ type: 'text', text: `(above: page ${img.page})` });
  }

  blocks.push({ type: 'text', text: buildUserPrompt(text) });
  return blocks;
}

/** Coerce one entry of the model's reply into a Claim, tolerating a missing entry. */
function toClaim<T>(raw: unknown, kind: 'number' | 'string'): Claim<T> {
  if (raw === null || typeof raw !== 'object') return emptyClaim<T>();
  const o = raw as Record<string, unknown>;

  // `stated: false` is the schema's way of saying null (see extractionSchema).
  let value: unknown = o.stated === false ? null : (o.value ?? null);
  if (value !== null) {
    if (kind === 'number') {
      // The schema returns every value as a string. Strip what a model might leave in
      // despite the prompt: parseFloat("1,443") is 1, so the comma must go first.
      const cleaned = String(value).replace(/[£$,%\s]/g, '');
      const n = cleaned === '' ? NaN : Number.parseFloat(cleaned);
      value = Number.isFinite(n) ? n : null;
    } else {
      const s = String(value).replace(/\s+/g, ' ').trim();
      value = s === '' ? null : s;
    }
  }

  const page =
    typeof o.page === 'number' && Number.isInteger(o.page) && o.page > 0 ? o.page : null;
  const evidence =
    typeof o.evidence === 'string' && o.evidence.trim() !== '' ? o.evidence.trim() : null;

  return { value: value as T | null, page, evidence };
}

function toClaims(parsed: Record<string, unknown>): ExtractionClaims {
  // First entry per field wins; a field with no entry is treated as not stated.
  const byField = new Map<string, unknown>();
  for (const entry of Array.isArray(parsed.fields) ? parsed.fields : []) {
    const name = (entry as { field?: unknown } | null)?.field;
    if (typeof name === 'string' && !byField.has(name)) byField.set(name, entry);
  }

  const out = {} as ExtractionClaims;
  for (const f of TEXT_FIELDS) out[f] = toClaim<string>(byField.get(f), 'string');
  for (const f of NUMERIC_FIELDS) out[f] = toClaim<number>(byField.get(f), 'number');
  const monthly = parsed.export_monthly;
  out.export_monthly = Array.isArray(monthly)
    ? monthly.filter((n): n is number => typeof n === 'number' && Number.isFinite(n))
    : [];
  return out;
}

export async function extractFields(
  documentText: string,
  opts: ExtractOptions
): Promise<ExtractResult> {
  const apiKey = opts.apiKey ?? process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY is not configured.');

  const client = new Anthropic({ apiKey });

  const response = await client.messages.create(
    {
      model: opts.model,
      system: systemPrompt(opts.documents?.length ? 'pdf' : 'text'),
      messages: [
        { role: 'user', content: contentBlocks(documentText, opts.documents, opts.pageImages) },
      ],
      ...paramsFor(opts.model),
    } as never,
    { signal: opts.signal }
  );

  if (response.stop_reason === 'refusal') {
    throw new Error('The model declined to process this document.');
  }
  if (response.stop_reason === 'max_tokens') {
    // With structured outputs a truncated reply is unparseable rather than partial, so
    // this is worth naming explicitly instead of surfacing as a JSON error.
    throw new Error(
      `Extraction hit the ${opts.model} output limit before completing. Try the escalation tier.`
    );
  }

  const text = response.content
    .filter((b): b is Anthropic.TextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('');

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw new Error(`Model returned unparseable output: ${text.slice(0, 200)}`);
  }

  const usage = {
    input:
      response.usage.input_tokens +
      (response.usage.cache_read_input_tokens ?? 0) +
      (response.usage.cache_creation_input_tokens ?? 0),
    output: response.usage.output_tokens,
  };
  const rate = rateFor(opts.model);

  return {
    claims: toClaims(parsed),
    model: response.model,
    usage,
    costUsd: (usage.input * rate.input + usage.output * rate.output) / 1_000_000,
  };
}

/** Shape of an Anthropic file ID; anything else is rejected before it reaches the API. */
export const FILE_ID_RE = /^file_[A-Za-z0-9]{8,64}$/;

/** Store one part of a proposal with the Files API so both tiers can read it. */
export async function uploadPdf(bytes: Uint8Array, apiKey?: string): Promise<string> {
  const client = new Anthropic({ apiKey: apiKey ?? process.env.ANTHROPIC_API_KEY });
  const file = await toFile(bytes, 'sentinel-proposal.pdf', { type: 'application/pdf' });
  const meta = await client.beta.files.upload({ file });
  return meta.id;
}

/**
 * Delete uploaded proposal parts. Proposals carry customer names and addresses, so they
 * are not left on the Files API once extraction is over. Best effort: a file that is
 * already gone, or a transient failure, must never fail the extraction it follows.
 */
export async function deleteFiles(fileIds: string[], apiKey?: string): Promise<void> {
  const client = new Anthropic({ apiKey: apiKey ?? process.env.ANTHROPIC_API_KEY });
  await Promise.allSettled(
    fileIds.filter((id) => FILE_ID_RE.test(id)).map((id) => client.beta.files.delete(id))
  );
}

export { ALL_FIELDS };

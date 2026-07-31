// The model call. One prompt, one schema, two model strings.
//
// Escalation from the cheap tier to the strong one is a parameter change, not a second
// pipeline. Everything that differs between Claude Haiku 4.5 and Claude Opus 5 is
// confined to paramsFor() below. That keeps the tiering from turning into two code paths
// that drift apart, which is what happened to the PHP and Next.js ports of the old
// extractor.

import Anthropic from '@anthropic-ai/sdk';
import { SYSTEM_PROMPT, buildUserPrompt } from './prompt';
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

export interface ExtractOptions {
  model: string;
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
 * Opus 5 rejects `temperature` outright, and its thinking is on by default with
 * `max_tokens` capping thinking *plus* output. Hence the much larger budget. Thinking is
 * deliberately left on: disabling it on Opus 5 is documented to occasionally produce a
 * tool call as plain text, and `effort` is the supported way to bound spend instead.
 */
function paramsFor(model: string): Record<string, unknown> {
  if (model.startsWith('claude-opus-5') || model.startsWith('claude-sonnet-5')) {
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

function contentBlocks(text: string, pageImages: PageImage[] | undefined) {
  const blocks: unknown[] = [];

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

/** Coerce one field of the model's reply into a Claim, tolerating a missing key. */
function toClaim<T>(raw: unknown, kind: 'number' | 'string'): Claim<T> {
  if (raw === null || typeof raw !== 'object') return emptyClaim<T>();
  const o = raw as Record<string, unknown>;

  let value: unknown = o.value ?? null;
  if (value !== null) {
    if (kind === 'number') {
      const n = typeof value === 'number' ? value : Number.parseFloat(String(value));
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
  const out = {} as ExtractionClaims;
  for (const f of TEXT_FIELDS) out[f] = toClaim<string>(parsed[f], 'string');
  for (const f of NUMERIC_FIELDS) out[f] = toClaim<number>(parsed[f], 'number');
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
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: contentBlocks(documentText, opts.pageImages) }],
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

export { ALL_FIELDS };

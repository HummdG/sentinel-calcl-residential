// The field contract, expressed once as a strict tool schema.
//
// Every field is an object, not a bare number, because the value alone is not enough to
// act on: `page` and `evidence` are what let verify.ts prove the model read the figure
// rather than invented it. `strict: true` plus `additionalProperties: false` means the
// API guarantees the shape, which is why none of the old code-fence / arithmetic-
// expression / first-{...}-salvage regex repair from groq.ts survives here.

/** Numeric fields, in the order the form renders them. */
export const NUMERIC_FIELDS = [
  'pv_size',
  'battery_kwh',
  'inverter_kw',
  'annual_gen',
  'annual_usage',
  'system_cost',
  'solar_savings',
  'export_kwh',
  'export_pct',
  'os_payback',
  'os_25yr',
  'os_roi',
] as const;

export const TEXT_FIELDS = ['customer_name', 'customer_address'] as const;

export type NumericField = (typeof NUMERIC_FIELDS)[number];
export type TextField = (typeof TEXT_FIELDS)[number];
export type FieldName = NumericField | TextField;

export const ALL_FIELDS: readonly FieldName[] = [...TEXT_FIELDS, ...NUMERIC_FIELDS];

/**
 * `export_pct` is asked for but never reaches the form. It exists so the verifier can
 * cross-check `export_kwh` against `annual_gen x pct`, and so it can derive `export_kwh`
 * when a document states only the percentage.
 */
export const INTERNAL_ONLY: readonly FieldName[] = ['export_pct'];

/** One extracted field: the value, plus what the model read to get it. */
export interface Claim<T> {
  /** null means "not stated in this document". A correct answer, not a failure. */
  value: T | null;
  /** 1-based page number in the full proposal. */
  page: number | null;
  /** Verbatim span copied from that page. Checked against the source by verify.ts. */
  evidence: string | null;
}

export type ExtractionClaims = Record<NumericField, Claim<number>> &
  Record<TextField, Claim<string>> & {
    /**
     * The twelve monthly export figures behind export_kwh, as read off the table. The
     * model transcribes; verify.ts grounds each figure and does the addition, because a
     * model summing twelve four-digit numbers in its head is wrong often enough to matter
     * (Murray Road: 5,418 returned for a true 5,809). Empty when there is no such table.
     */
    export_monthly?: number[];
  };

/** One-line semantic definition per field. Full disambiguation lives in prompt.ts. */
const FIELD_DESCRIPTIONS: Record<FieldName, string> = {
  customer_name: 'The customer the proposal is addressed to, fullest form available.',
  customer_address:
    'House name/number and street of the installation address only: stop after the street name and drop the town, county and postcode that follow it ("22 Varey Road, Worthing, BN13 3SN" is "22 Varey Road").',
  pv_size: 'Total installed PV array capacity in kWp (DC panel rating, not inverter AC).',
  battery_kwh: 'Total rated battery storage for the whole system, in kWh.',
  inverter_kw: 'Total inverter rated AC power in kW.',
  annual_gen: 'Estimated annual solar generation for the whole system, kWh/year.',
  annual_usage: "The household's total annual electricity consumption, kWh/year.",
  system_cost: 'One-off total upfront cash price to buy the system outright, GBP.',
  solar_savings: 'Year-one annual bill saving, GBP.',
  export_kwh: 'Total annual electricity exported to the grid, kWh.',
  export_pct:
    'Export to grid as a percentage of generation, as a plain number. Can exceed 100 on a battery system ("327% Export to grid" is 327).',
  os_payback: 'Simple payback period in decimal years (not discounted payback).',
  os_25yr: 'Estimated NET savings over system lifetime, after system cost, GBP.',
  os_roi: 'Return on investment as a plain percentage number (11.9, not 0.119).',
};



/** The field definitions as a prompt list. They used to live in the schema itself. */
export function fieldDefinitions(): string {
  return ALL_FIELDS.map((f) => `- ${f}: ${FIELD_DESCRIPTIONS[f]}`).join('\n');
}

/**
 * The JSON Schema passed as `output_config.format`.
 *
 * Structured outputs rather than forced tool use: the docs confirm structured outputs are
 * compatible with extended thinking, which matters because thinking is on by default on
 * Opus 5 and cannot be turned off above `high` effort. Forced `tool_choice` carries no
 * such guarantee, and a turn that answers in prose instead of calling the tool would fail
 * open. Exactly the silent failure this rebuild exists to remove.
 *
 * The claims are ONE list of identically shaped entries, each naming its field, rather
 * than one object property per field. The API compiles the schema into a grammar and caps
 * its size: fourteen per-field objects (each with its own description and, originally, a
 * "number or null" union) compiled for Claude Haiku 4.5 but were rejected by Claude Opus 5
 * and Opus 5.5 ("The compiled grammar is too large"), so every escalation failed. A list
 * of one shape compiles small whatever the field count.
 *
 * In that shape:
 *   - `stated: false` is "not in this document", a real answer kept distinct from 0.
 *   - `value` is always a string; toClaim() in anthropic.ts parses the numeric fields.
 *   - `page` 0 and `evidence` "" are the sentinels for a field that is not stated.
 * The grammar cannot force one entry per field. toClaims() treats a missing entry as not
 * stated, which the verifier then reports as missing rather than inventing a value.
 */
export function extractionSchema() {
  return {
    type: 'json_schema' as const,
    schema: {
      type: 'object' as const,
      properties: {
        fields: {
          type: 'array',
          description: 'Exactly one entry for every field listed in the instructions.',
          items: {
            type: 'object',
            properties: {
              field: { type: 'string', enum: [...ALL_FIELDS] },
              stated: {
                type: 'boolean',
                description: 'false if the document does not state this figure. Never guess.',
              },
              value: {
                type: 'string',
                description:
                  'The figure as a plain number ("787", "7.42") or the text. Empty when stated is false.',
              },
              page: {
                type: 'integer',
                description: 'Page number in the full proposal it was read from. 0 when not stated.',
              },
              evidence: {
                type: 'string',
                description:
                  'Short verbatim quote from that page, including the label. Empty when not stated.',
              },
            },
            required: ['field', 'stated', 'value', 'page', 'evidence'],
            additionalProperties: false,
          },
        },
        export_monthly: {
          type: 'array',
          items: { type: 'number' },
          description:
            'The twelve monthly "exported to grid" figures, January to December, copied exactly from the monthly table. Empty array if the document has no such table.',
        },
      },
      required: ['fields', 'export_monthly'],
      additionalProperties: false,
    },
  };
}

/** An all-null claim set, used when a field is missing from the model's reply. */
export function emptyClaim<T>(): Claim<T> {
  return { value: null, page: null, evidence: null };
}

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
  /** 1-based page number matching the "=== PAGE n ===" tags. */
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

// Structured outputs cap a schema at 16 union-typed parameters, because each one
// multiplies compilation cost. Making all three properties of all 14 fields nullable
// comes to 42 and is rejected outright.
//
// Only `value` spends one of those slots: null there is a real answer ("not stated in
// this document") that has to be distinguishable from 0. `page` and `evidence` carry
// sentinels instead. 0 and "". Which toClaim() in anthropic.ts already normalises back
// to null. That is 14 unions, inside the limit, with no loss of meaning.
const nullableValue = (type: 'number' | 'string') => ({
  anyOf: [{ type }, { type: 'null' as const }],
  description:
    'The value, or null if the document does not state it. Never guess, and never substitute 0 for an absent value.',
});

function claimSchema(type: 'number' | 'string', description: string) {
  return {
    type: 'object',
    description,
    properties: {
      value: nullableValue(type),
      page: {
        type: 'integer',
        description:
          'Page number from the "=== PAGE n ===" tag this was read from. Use 0 when the value is null.',
      },
      evidence: {
        type: 'string',
        description:
          'Short verbatim quote from that page, copied exactly, including the label. Use an empty string when the value is null.',
      },
    },
    required: ['value', 'page', 'evidence'],
    additionalProperties: false,
  };
}

/** One-line semantic definition per field. Full disambiguation lives in prompt.ts. */
const FIELD_DESCRIPTIONS: Record<FieldName, string> = {
  customer_name: 'The customer the proposal is addressed to, fullest form available.',
  customer_address:
    'House name/number and street of the installation address only. No town, county or postcode.',
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



/**
 * The JSON Schema passed as `output_config.format`.
 *
 * Structured outputs rather than forced tool use: the docs confirm structured outputs are
 * compatible with extended thinking, which matters because thinking is on by default on
 * Opus 5 and cannot be turned off above `high` effort. Forced `tool_choice` carries no
 * such guarantee, and a turn that answers in prose instead of calling the tool would fail
 * open. Exactly the silent failure this rebuild exists to remove.
 */
export function extractionSchema() {
  const properties: Record<string, unknown> = {};
  for (const f of TEXT_FIELDS) properties[f] = claimSchema('string', FIELD_DESCRIPTIONS[f]);
  for (const f of NUMERIC_FIELDS) properties[f] = claimSchema('number', FIELD_DESCRIPTIONS[f]);
  // A plain array, not a nullable union, so it does not spend one of the 16 union slots.
  properties.export_monthly = {
    type: 'array',
    items: { type: 'number' },
    description:
      'The twelve monthly "exported to grid" figures, January to December, copied exactly from the monthly table. Empty array if the document has no such table.',
  };

  return {
    type: 'json_schema' as const,
    schema: {
      type: 'object' as const,
      properties,
      required: [...ALL_FIELDS, 'export_monthly'],
      additionalProperties: false,
    },
  };
}

/** An all-null claim set, used when a field is missing from the model's reply. */
export function emptyClaim<T>(): Claim<T> {
  return { value: null, page: null, evidence: null };
}

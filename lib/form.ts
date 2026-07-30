// Client form state, defaults, and helpers. No server-only imports, so this is
// safe to use in client components. Default seed values mirror templates/
// calculator-template.php.

import type { CalcInput, ExtractedFields, Tariff, Usage } from './types';

export interface FormState {
  customer_name: string;
  customer_address: string;
  pv_size: string;
  battery_kwh: string;
  inverter_kw: string;
  annual_gen: string;
  annual_usage: string;
  system_cost: string;
  solar_savings: string;
  export_kwh: string;
  os_payback: string;
  os_25yr: string;
  os_roi: string;
  std_import: string;
  dn_day: string;
  dn_night: string;
}

// Everything sourced from the customer's proposal starts EMPTY. It used to ship a demo
// dataset (14.62kWp / £23,867 / £3,733), which meant a failed extraction left a plausible
// wrong number in the field instead of an obvious gap — and £3,733 reached a
// customer-facing report as if it had come from the quote. Only the tariff rates keep
// defaults: they are surveyor assumptions, not figures read off the proposal.
export const DEFAULT_FORM: FormState = {
  customer_name: '',
  customer_address: '',
  pv_size: '',
  battery_kwh: '',
  inverter_kw: '',
  annual_gen: '',
  annual_usage: '',
  system_cost: '',
  solar_savings: '',
  export_kwh: '',
  os_payback: '',
  os_25yr: '',
  os_roi: '',
  std_import: '28',
  dn_day: '28',
  dn_night: '15',
};

// What must be supplied before a report can be produced. `zeroOk` fields are legitimately
// zero on some systems — no battery, no export — so they must be FILLED IN but are allowed
// to be 0; the rest must be positive.
export const REQUIRED_FIELDS: { id: keyof FormState; label: string; zeroOk?: boolean }[] = [
  { id: 'pv_size', label: 'Solar PV size' },
  { id: 'battery_kwh', label: 'Battery capacity', zeroOk: true },
  { id: 'inverter_kw', label: 'Inverter power rating', zeroOk: true },
  { id: 'annual_gen', label: 'Annual generation' },
  { id: 'annual_usage', label: 'Annual consumption' },
  { id: 'system_cost', label: 'Total system cost' },
  { id: 'solar_savings', label: 'Annual bill savings — yr 1' },
  { id: 'export_kwh', label: 'Annual export to grid', zeroOk: true },
  { id: 'os_payback', label: 'Payback period' },
  { id: 'os_25yr', label: '25-year cumulative return' },
];

// Labels of the required fields still blank or non-positive; empty when ready to calculate.
export function gateFailures(f: FormState): string[] {
  const out: string[] = [];
  for (const field of REQUIRED_FIELDS) {
    const raw = (f[field.id] || '').trim();
    if (raw === '') {
      out.push(field.label);
      continue;
    }
    const v = Number.parseFloat(raw);
    if (!Number.isFinite(v) || v < 0 || (!field.zeroOk && v <= 0)) out.push(field.label);
  }
  return out;
}

export const NUMERIC_FIELD_KEYS = [
  'pv_size',
  'battery_kwh',
  'inverter_kw',
  'annual_gen',
  'annual_usage',
  'system_cost',
  'solar_savings',
  'export_kwh',
  'os_payback',
  'os_25yr',
  'os_roi',
] as const;

export const TEXT_FIELD_KEYS = ['customer_name', 'customer_address'] as const;

function num(v: string): number {
  const f = Number.parseFloat(v);
  return Number.isFinite(f) ? f : 0;
}

export function buildCalcInput(
  f: FormState,
  tariff: Tariff,
  usage: Usage,
  inflation: number
): CalcInput {
  return {
    pv_size: num(f.pv_size),
    battery_kwh: num(f.battery_kwh),
    inverter_kw: num(f.inverter_kw),
    annual_gen: num(f.annual_gen),
    annual_usage: num(f.annual_usage),
    system_cost: num(f.system_cost),
    solar_savings: num(f.solar_savings),
    export_kwh: num(f.export_kwh),
    os_payback: num(f.os_payback),
    os_25yr: num(f.os_25yr),
    os_roi: num(f.os_roi),
    std_import: num(f.std_import),
    dn_day: num(f.dn_day),
    dn_night: num(f.dn_night),
    tariff,
    usage,
    inflation,
  };
}

// Populate fields the PDF provided (numeric > 0, text non-empty), preserving existing
// values for anything the PDF didn't contain. Mirrors the highlight logic in
// sentinelHandlePDF().
//
// `edited` holds keys the surveyor has typed into since the last extraction. Those win over
// a fresh extraction: re-dropping the same quote used to silently overwrite a hand-corrected
// figure, which is how a corrected system cost reverted to the mis-extracted one. Returns
// the keys it declined to overwrite so the UI can say so.
export function applyExtracted(
  prev: FormState,
  fields: ExtractedFields,
  missing: string[] = [],
  edited: Set<string> = new Set()
): {
  form: FormState;
  populated: Set<string>;
  missing: Set<string>;
  preserved: string[];
} {
  const next: FormState = { ...prev };
  const populated = new Set<string>();
  const preserved: string[] = [];

  const keep = (k: keyof FormState, incoming: string) =>
    edited.has(k) && (prev[k] || '').trim() !== '' && incoming !== (prev[k] || '').trim();

  for (const k of NUMERIC_FIELD_KEYS) {
    const v = fields[k];
    if (typeof v !== 'number' || !(v > 0)) continue;
    if (keep(k, String(v))) {
      preserved.push(k);
      continue;
    }
    next[k] = String(v);
    populated.add(k);
  }
  for (const k of TEXT_FIELD_KEYS) {
    const v = fields[k];
    if (!v) continue;
    if (keep(k, v)) {
      preserved.push(k);
      continue;
    }
    next[k] = v;
    populated.add(k);
  }

  // A field the extractor missed is only a visible gap while it is actually empty — if the
  // surveyor has already supplied it by hand there is nothing to flag.
  const missingSet = new Set(
    missing.filter((k) => ((next[k as keyof FormState] as string) || '').trim() === '')
  );

  return { form: next, populated, missing: missingSet, preserved };
}

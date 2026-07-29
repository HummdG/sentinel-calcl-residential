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

export const DEFAULT_FORM: FormState = {
  customer_name: '',
  customer_address: '',
  pv_size: '14.62',
  battery_kwh: '10',
  inverter_kw: '5',
  annual_gen: '13081',
  annual_usage: '4500',
  system_cost: '23867',
  solar_savings: '3733',
  export_kwh: '8449',
  os_payback: '5.83',
  os_25yr: '241633',
  os_roi: '',
  std_import: '28',
  dn_day: '28',
  dn_night: '15',
};

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

// Populate fields the PDF provided (numeric > 0, text non-empty), preserving
// existing values for anything the PDF didn't contain. Mirrors the highlight
// logic in sentinelHandlePDF().
export function applyExtracted(
  prev: FormState,
  fields: ExtractedFields
): { form: FormState; populated: Set<string> } {
  const next: FormState = { ...prev };
  const populated = new Set<string>();

  for (const k of NUMERIC_FIELD_KEYS) {
    const v = fields[k];
    if (typeof v === 'number' && v > 0) {
      next[k] = String(v);
      populated.add(k);
    }
  }
  for (const k of TEXT_FIELD_KEYS) {
    const v = fields[k];
    if (v) {
      next[k] = v;
      populated.add(k);
    }
  }

  return { form: next, populated };
}

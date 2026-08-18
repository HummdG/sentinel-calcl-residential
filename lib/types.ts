// Shared types for the Sentinel calculator (input, result, extracted PDF fields).

export type Tariff = 'standard' | 'daynight' | 'flux';
export type Usage = 'daytime' | 'balanced' | 'evening';

// What was sold. `battery_only` means the job genuinely has no solar, as opposed to a
// solar job whose PV figures simply haven't been entered yet. Keeping those two apart is
// the whole point of the selector: the form gate, the Flux arbitrage adjustment and the
// report all need to know which one they are looking at, and a bare 0 cannot tell them.
export type OrderType = 'solar_battery' | 'battery_only';

export interface CalcInput {
  pv_size: number;
  battery_kwh: number;
  inverter_kw: number;
  annual_gen: number;
  annual_usage: number;
  system_cost: number;
  solar_savings: number;
  export_kwh: number;
  os_payback: number;
  os_25yr: number;
  os_roi: number;
  std_import: number;
  dn_day: number;
  dn_night: number;
  tariff: Tariff;
  usage: Usage;
  inflation: number;
  // Optional so the frozen PHP-parity scenarios in test/golden.json stay valid: PHP has no
  // order type, and every one of those cases is a solar job. Absent means solar_battery.
  order_type?: OrderType;
}

export interface ChartSeries {
  labels: string[];
  solar: number[];
  sentinel: number[];
}

export interface CalcResult {
  extra_annual: number;
  payback_solar: number;
  payback_sentinel: number;
  payback_saving: number;

  solar_bill: number;
  solar_seg: number;
  solar_total: number;
  solar_payback: number;
  solar_25yr: number;

  sentinel_bill: number;
  sentinel_seg: number;
  sentinel_peak: number;
  sentinel_trade: number;
  sentinel_total_yr1: number;
  sentinel_payback: number;
  sentinel_25yr: number;

  roi_annualised_pct: number;
  // The customer's own OpenSolar RoI, echoed back so the report renders every cell from
  // one calculation snapshot instead of reading this one out of the live form.
  solar_roi: number;

  chart_cumulative: ChartSeries;
  chart_monthly: ChartSeries;

  pv_size: number;
  battery_kwh: number;
  inverter_kw: number;
  annual_gen: number;
  annual_usage: number;
  system_cost: number;
  inflation: number;
  export_kwh: number;
  // Echoed so ResultsReport branches off the calculation snapshot rather than live form
  // state, the same rule every other cell on the report follows.
  order_type: OrderType;

  flux_arbitrage_warning: boolean;
  arbitrage_kwh: number;
  grid_charging_cost: number;
}

// The 11 numeric + 2 text fields the extraction returns (export_pct is consumed
// internally by the verifier and dropped).
//
// Numerics are nullable, and the distinction is load-bearing: `null` means the document
// does not state the figure, `0` means it states zero. The previous shape used bare
// numbers, which forced null and zero to collapse together. So a system genuinely
// exporting 0 kWh (River House) could never be auto-filled, and the surveyor had to
// hand-type a zero the proposal had already stated.
export interface ExtractedFields {
  customer_name: string | null;
  customer_address: string | null;
  pv_size: number | null;
  battery_kwh: number | null;
  inverter_kw: number | null;
  annual_gen: number | null;
  annual_usage: number | null;
  system_cost: number | null;
  solar_savings: number | null;
  export_kwh: number | null;
  os_payback: number | null;
  os_25yr: number | null;
  os_roi: number | null;
}

/** Where one field's value came from, and whether it survived verification. */
export interface FieldProvenance {
  field: string;
  value: number | string | null;
  /** 1-based PDF page. */
  page: number | null;
  /** Verbatim source text the model quoted. */
  evidence: string | null;
  status: 'verified' | 'unverified' | 'absent';
  note?: string;
}

// What /api/parse-pdf and /api/parse-pdf/escalate return.
//
// `missing` names fields with no usable value. Either absent from the document or
// dropped by a verification gate. `provenance` covers every field including the ones that
// failed, so the surveyor can see what was proposed and why it was rejected rather than
// just finding a blank box. `warnings` are plausibility flags and never block Calculate.
export interface ParsedPdfResponse {
  fields: ExtractedFields;
  provenance: FieldProvenance[];
  missing: string[];
  warnings: string[];
  populated_count: number;
  message: string;
  /** Which model tier produced this. */
  tier: 'primary' | 'escalation';
  /** A verification gate failed; the client should call the escalation route. */
  escalate: boolean;
}

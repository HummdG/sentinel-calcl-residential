// Shared types for the Sentinel calculator (input, result, extracted PDF fields).

export type Tariff = 'standard' | 'daynight' | 'flux';
export type Usage = 'daytime' | 'balanced' | 'evening';

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

  flux_arbitrage_warning: boolean;
  arbitrage_kwh: number;
  grid_charging_cost: number;
}

// The 13 numeric + 2 text fields the AI extraction returns (export_pct is
// consumed internally and dropped, mirroring the WordPress parser).
export interface ExtractedFields {
  customer_name: string;
  customer_address: string;
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
}

// What /api/parse-pdf returns. `missing` names the keys the model could not find — a null
// becomes 0 by the time it reaches the client, which is indistinguishable from a genuine
// zero, so without this list a value left over in the field passes for an extracted one.
// `warnings` are cross-field plausibility failures for the surveyor to eyeball.
export interface ParsedPdfResponse {
  fields: ExtractedFields;
  missing: string[];
  warnings: string[];
  populated_count: number;
  message: string;
}

// Year-1 savings and the 25-year projection, exactly as the API brief defines them.

import { DEGRADATION, LIFETIME_YEARS } from './config';

export interface YearRow {
  year: number;
  saving: number;
  cumulative_saving: number;
  net_position: number;
}

export interface Lifetime {
  payback_years: number | null;
  saving_25yr: number;
  roi: number;
  net_roi: number;
  years: YearRow[];
}

/** inflationPct: 5 = 5%. Unrounded; the caller rounds for output. */
export function lifetime(savingYear1: number, systemCost: number, inflationPct: number): Lifetime {
  const g = 1 + inflationPct / 100;
  const d = 1 - DEGRADATION;
  const years: YearRow[] = [];
  let cum = 0;
  let payback: number | null = null;
  for (let n = 1; n <= LIFETIME_YEARS; n++) {
    const saving = savingYear1 * g ** (n - 1) * d ** (n - 1);
    const before = cum - systemCost;
    cum += saving;
    const net = cum - systemCost;
    if (payback === null && savingYear1 > 0 && net >= 0) {
      // Interpolate within the year the net position crosses zero.
      payback = n - 1 + (saving > 0 ? -before / saving : 0);
    }
    years.push({ year: n, saving, cumulative_saving: cum, net_position: net });
  }
  return {
    payback_years: payback,
    saving_25yr: cum,
    roi: cum / systemCost,
    net_roi: (cum - systemCost) / systemCost,
    years,
  };
}

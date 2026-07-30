// Faithful TypeScript port of includes/class-calculator.php (Sentinel_Calculator).
//
// SERVER-ONLY: keeps the formulas and constants off the client. Semantics match
// the PHP exactly, including the two hardenings the v7.4 reference HTML lacks:
//   1. net_factor clamped at 0 (fees summing > 100% can't produce negative revenue)
//   2. divide-by-zero guards on the peak/trade split (raw_combined > 0)

import type { CalcInput, CalcResult, ChartSeries, Tariff, Usage } from './types';
import type { Constants } from './config';

// AI Optimisation and market trading revenue are not fully additive: they share
// the same battery cycles and degradation budget. A 10% discount is applied to
// their combined total before it is split back into the two line items.
const NON_ADDITIVITY_DISCOUNT = 0.1;

// PHP round(): half away from zero. JS Math.round is half toward +Infinity, which
// differs for negative .5 values — mirror PHP so parity holds for every input.
function phpRound(value: number, precision = 0): number {
  const f = Math.pow(10, precision);
  const n = value * f;
  const r = n >= 0 ? Math.round(n) : -Math.round(-n);
  return r / f;
}

interface Uplift {
  base_seg: number;
  sent_bill: number;
  sent_seg: number;
  sent_peak: number;
  sent_trade: number;
  sent_total_yr1: number;
  sent_total_yr2: number;
  solar_total_annual: number;
  arbitrage_kwh: number;
  grid_charging_cost: number;
  flux_arbitrage_warning: boolean;
}

function sentinelUplift(
  c: Constants,
  battery: number,
  exportKwh: number,
  solarSavings: number,
  tariff: Tariff,
  usage: Usage,
  stdImportRate: number,
  dayRate: number,
  nightRate: number,
  annualConsumption: number,
  annualGen: number
): Uplift {
  // effective_import_rate must be in scope when the bill-savings cap is applied
  // below, so it is set inside every branch of this tariff block.
  let exportRateBase: number;
  let exportRateSentinel: number;
  let effectiveImportRate: number;
  if (tariff === 'standard') {
    exportRateBase = c.export_base_standard;
    exportRateSentinel = stdImportRate * 0.55;
    effectiveImportRate = stdImportRate;
  } else if (tariff === 'daynight') {
    exportRateBase = nightRate * 0.5;
    exportRateSentinel = dayRate * 0.65;
    effectiveImportRate = dayRate * 0.6 + nightRate * 0.4;
  } else {
    // flux
    exportRateBase = c.export_base_standard;
    exportRateSentinel = c.export_sentinel_flux;
    effectiveImportRate = dayRate; // proxy
  }

  const uFactor = c.um[usage];
  const tMult = c.tm[tariff];

  // Sentinel bill savings: conditional cap (only when the OpenSolar figure itself
  // exceeds the customer's total possible spend) + baseline floor.
  const totalPossibleSpend = annualConsumption * effectiveImportRate;
  const uncappedSentBill = solarSavings * (1 + c.bill_up[tariff]);
  const cappedSentBill =
    solarSavings > totalPossibleSpend
      ? Math.min(uncappedSentBill, totalPossibleSpend * 0.95)
      : uncappedSentBill;
  const sentBill = Math.max(cappedSentBill, solarSavings);

  const baseSeg = exportKwh * exportRateBase;
  let sentSeg = exportKwh * exportRateSentinel;

  // Flux arbitrage adjustment: export kWh above annual generation on a Flux tariff
  // represents grid-charged battery cycling, not solar export — net off its cost.
  let arbitrageKwh = 0;
  let gridChargingCost = 0;
  let fluxArbitrageWarning = false;
  if (tariff === 'flux' && annualGen > 0 && exportKwh > annualGen) {
    arbitrageKwh = exportKwh - annualGen;
    gridChargingCost = arbitrageKwh * c.flux_charge_rate;
    sentSeg = Math.max(0, sentSeg - gridChargingCost);
    fluxArbitrageWarning = true;
  }

  // Both the IEP fee (20%) and the Sentinel fee (20%) are levied on the combined
  // peak-shaving + trading gross (shared battery cycles), then a 10% non-additivity
  // discount, then split back proportionally so both line items display separately.
  const netFactor = Math.max(0, 1 - c.iep_fee - c.sentinel_fee);
  const sentPeakRaw = battery * c.peak_shaving_per_kwh * uFactor;
  const sentTradeRaw = battery * c.trading_per_kwh * tMult * uFactor;

  const rawCombined = sentPeakRaw + sentTradeRaw;
  const sentCombined = rawCombined * netFactor * (1 - NON_ADDITIVITY_DISCOUNT);
  const sentPeak = rawCombined > 0 ? sentCombined * (sentPeakRaw / rawCombined) : 0;
  const sentTrade = rawCombined > 0 ? sentCombined * (sentTradeRaw / rawCombined) : 0;

  const sentTotalYr1 = sentBill + sentSeg + sentPeak + sentTrade;
  const sentTotalYr2 = sentTotalYr1 - c.sub;

  return {
    base_seg: baseSeg,
    sent_bill: sentBill,
    sent_seg: sentSeg,
    sent_peak: sentPeak,
    sent_trade: sentTrade,
    sent_total_yr1: sentTotalYr1,
    sent_total_yr2: sentTotalYr2,
    solar_total_annual: solarSavings + baseSeg,
    arbitrage_kwh: arbitrageKwh,
    grid_charging_cost: gridChargingCost,
    flux_arbitrage_warning: fluxArbitrageWarning,
  };
}

function sentinelPayback(cost: number, yr1: number, yr2: number, inflationPct: number): number {
  let c = -cost;
  for (let y = 1; y <= 35; y++) {
    const b = y === 1 ? yr1 : yr2;
    const inflated = b * Math.pow(1 + inflationPct / 100, y - 1);
    if (c + inflated >= 0) {
      return y - 1 + -c / inflated;
    }
    c += inflated;
  }
  return 35.0;
}

function sentinelCumulative(
  osNYr: number,
  solarAnnual: number,
  yr1: number,
  yr2: number,
  n: number,
  inflationPct: number
): number {
  let upliftCum = 0;
  for (let y = 1; y <= n; y++) {
    const sentBenefit = y === 1 ? yr1 : yr2;
    upliftCum += (sentBenefit - solarAnnual) * Math.pow(1 + inflationPct / 100, y - 1);
  }
  return osNYr + upliftCum;
}

// Internal Rate of Return of the 25-year cash flows (bisection). Year 1 uses yr1
// (subscription-free); years 2–25 use yr2. Returns % or 0 when no positive IRR.
function calcIrr(yr1: number, yr2: number, cost: number, inflationPct: number): number {
  if (cost <= 0) return 0;

  const g = inflationPct / 100;
  const flows: number[] = [];
  for (let i = 0; i < 25; i++) {
    const benefit = i === 0 ? yr1 : yr2;
    flows.push(benefit * Math.pow(1 + g, i));
  }

  const npv = (r: number): number => {
    let sum = 0;
    for (let i = 0; i < flows.length; i++) {
      sum += flows[i] / Math.pow(1 + r, i + 1);
    }
    return sum - cost;
  };

  if (npv(0) <= 0) return 0;

  let lo = 0.0001;
  let hi = 5.0;
  for (let i = 0; i < 200; i++) {
    const mid = (lo + hi) / 2;
    if (npv(mid) > 0) {
      lo = mid;
    } else {
      hi = mid;
    }
    if (hi - lo < 0.0000001) break;
  }
  return ((lo + hi) / 2) * 100;
}

// Recovers the growth rate implied by OpenSolar's reported RoI so Sentinel's IRR is
// computed like-for-like. Returns % or null when implausible (outside -3%…30%).
function findOpenSolarGrowthRate(osRoiPct: number, yr1: number, cost: number): number | null {
  if (osRoiPct <= 0 || yr1 <= 0 || cost <= 0) return null;

  const targetIrr = osRoiPct / 100;
  let lo = -0.05;
  let hi = 0.5;
  for (let i = 0; i < 200; i++) {
    const mid = (lo + hi) / 2;
    const irr = calcIrr(yr1, yr1, cost, mid * 100) / 100;
    if (irr < targetIrr) {
      lo = mid;
    } else {
      hi = mid;
    }
    if (hi - lo < 0.0000001) break;
  }
  const g = (lo + hi) / 2;
  if (g < -0.03 || g > 0.3) return null;
  return g * 100;
}

function buildCumulativeChart(
  solarAnnual: number,
  sentYr1: number,
  sentYr2: number,
  inflationPct: number,
  os25yr: number
): ChartSeries {
  // Solar line proportionally scaled by inflation weights so year-25 lands exactly
  // on os_25yr; Sentinel line = solar point + cumulative uplift.
  let solarWeightTotal = 0;
  const solarWeights: number[] = [];
  for (let y = 1; y <= 25; y++) {
    const w = solarAnnual * Math.pow(1 + inflationPct / 100, y - 1);
    solarWeights.push(w);
    solarWeightTotal += w;
  }

  const solar: number[] = [0];
  const sentinel: number[] = [0];
  let solarCumW = 0;
  let upliftCum = 0;

  for (let y = 1; y <= 25; y++) {
    solarCumW += solarWeights[y - 1];
    const solarPt = solarWeightTotal > 0 ? phpRound(os25yr * (solarCumW / solarWeightTotal)) : 0;
    const benefit = y === 1 ? sentYr1 : sentYr2;
    upliftCum += (benefit - solarAnnual) * Math.pow(1 + inflationPct / 100, y - 1);
    solar.push(solarPt);
    sentinel.push(phpRound(solarPt + upliftCum));
  }

  const labels = ['Now'];
  for (let y = 1; y <= 25; y++) labels.push('Yr ' + y);

  return { labels, solar, sentinel };
}

function buildMonthlyChart(c: Constants, solarAnnual: number, sentYr2: number): ChartSeries {
  const solar: number[] = [];
  const sentinel: number[] = [];
  for (const weight of c.mw) {
    solar.push(phpRound(solarAnnual * weight));
    sentinel.push(phpRound(sentYr2 * weight));
  }
  return {
    labels: ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'],
    solar,
    sentinel,
  };
}

export function calculate(p: CalcInput, c: Constants): CalcResult {
  const up = sentinelUplift(
    c,
    p.battery_kwh,
    p.export_kwh,
    p.solar_savings,
    p.tariff,
    p.usage,
    p.std_import / 100,
    p.dn_day / 100,
    p.dn_night / 100,
    p.annual_usage,
    p.annual_gen
  );

  // Headline "extra annual benefit" uses year 1 (subscription-free).
  const extraAnnual = up.sent_total_yr1 - up.solar_total_annual;

  const sentPb = sentinelPayback(p.system_cost, up.sent_total_yr1, up.sent_total_yr2, p.inflation);
  const solarPb = sentinelPayback(
    p.system_cost,
    up.solar_total_annual,
    up.solar_total_annual,
    p.inflation
  );
  const pbSaving = solarPb - sentPb;

  const sent25 = sentinelCumulative(
    p.os_25yr,
    up.solar_total_annual,
    up.sent_total_yr1,
    up.sent_total_yr2,
    25,
    p.inflation
  );

  const chartCumulative = buildCumulativeChart(
    up.solar_total_annual,
    up.sent_total_yr1,
    up.sent_total_yr2,
    p.inflation,
    p.os_25yr
  );
  const chartMonthly = buildMonthlyChart(c, up.solar_total_annual, up.sent_total_yr2);

  // RoI (IRR) on the same growth basis as the customer's OpenSolar RoI.
  const osRoi = p.os_roi ?? 0;
  const osGrowth =
    osRoi > 0 ? findOpenSolarGrowthRate(osRoi, up.solar_total_annual, p.system_cost) : null;
  const sentRoiGrowth = osGrowth ?? p.inflation;
  const sentRoiIrr = calcIrr(up.sent_total_yr1, up.sent_total_yr2, p.system_cost, sentRoiGrowth);

  return {
    extra_annual: phpRound(extraAnnual),
    payback_solar: phpRound(solarPb, 2),
    payback_sentinel: phpRound(sentPb, 2),
    payback_saving: phpRound(pbSaving, 2),

    solar_bill: phpRound(p.solar_savings),
    solar_seg: phpRound(up.base_seg),
    solar_total: phpRound(up.solar_total_annual),
    solar_payback: p.os_payback,
    solar_25yr: phpRound(p.os_25yr),

    sentinel_bill: phpRound(up.sent_bill),
    sentinel_seg: phpRound(up.sent_seg),
    sentinel_peak: phpRound(up.sent_peak),
    sentinel_trade: phpRound(up.sent_trade),
    sentinel_total_yr1: phpRound(up.sent_total_yr1),
    sentinel_payback: phpRound(sentPb, 2),
    sentinel_25yr: phpRound(sent25),

    roi_annualised_pct: phpRound(sentRoiIrr, 2),
    // Echoed so the report renders every cell from one calculation snapshot rather than
    // reading this one out of the live form, where it could belong to a newer edit than
    // the figures beside it.
    solar_roi: p.os_roi,

    chart_cumulative: chartCumulative,
    chart_monthly: chartMonthly,

    pv_size: p.pv_size,
    battery_kwh: p.battery_kwh,
    inverter_kw: p.inverter_kw,
    annual_gen: p.annual_gen,
    annual_usage: p.annual_usage,
    system_cost: p.system_cost,
    inflation: p.inflation,
    export_kwh: p.export_kwh,

    flux_arbitrage_warning: up.flux_arbitrage_warning,
    arbitrage_kwh: phpRound(up.arbitrage_kwh),
    grid_charging_cost: phpRound(up.grid_charging_cost),
  };
}

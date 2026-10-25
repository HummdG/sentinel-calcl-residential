// The /api/v1/calc model: profiles -> dispatch simulation -> savings -> CalcResult.
// Pure and synchronous; input is assumed already validated by CalcRequestSchema.

import { BATTERY, CONFIG_VERSION, DEFAULTS, DEGRADATION, MONTHS } from './config';
import { lifetime } from './finance';
import { buildProfiles } from './profiles';
import type { CalcRequest, CalcResult } from './schema';
import { makeBattery, simulate } from './simulate';
import { slotRates } from './tariffs';

const r2 = (x: number) => Math.round(x * 100) / 100 + 0; // + 0 turns -0 into 0
const r3 = (x: number) => Math.round(x * 1000) / 1000 + 0;
const r0 = (x: number) => Math.round(x) + 0;
const r2n = (x: number | null) => (x === null ? null : r2(x));

export interface CalcOptions {
  detail?: boolean;
}

export function calculate(req: CalcRequest, opts: CalcOptions = {}): CalcResult {
  const tariff = req.tariff ?? DEFAULTS.tariff;
  const usage = req.usage ?? DEFAULTS.usage;
  const selfUseFraction = req.self_use_fraction ?? DEFAULTS.self_use_fraction;
  const stdImport = req.std_import ?? DEFAULTS.std_import;
  const inflation = req.inflation ?? DEFAULTS.inflation;
  const exportLimit = req.export_limit_kw ?? DEFAULTS.export_limit_kw;

  const rates = slotRates(tariff, {
    std_import: stdImport,
    dn_day: req.dn_day ?? DEFAULTS.dn_day,
    dn_night: req.dn_night ?? DEFAULTS.dn_night,
  });
  const profiles = buildProfiles(req.annual_usage, req.annual_gen, usage, selfUseFraction);
  const sim = simulate(profiles.days, rates, makeBattery(req.battery_kwh, req.inverter_kw), exportLimit);

  // Savings are taken from the rounded bills so the published figures reconcile exactly.
  const baseline = r2(req.annual_usage * stdImport);
  const billSelfUse = r2(sim.selfUse.cost);
  const billOptimised = r2(sim.optimised.cost);
  const savingTotal = r2(baseline - billOptimised);
  const savingTariffSolar = r2(baseline - billSelfUse);
  const savingOptimisation = r2(billSelfUse - billOptimised);

  const life = lifetime(savingTotal, req.system_cost, inflation);
  const lifeOut = {
    payback_years: r2n(life.payback_years),
    saving_25yr: r2(life.saving_25yr),
    roi: r3(life.roi),
    net_roi: r3(life.net_roi),
    years: life.years.map((y) => ({
      year: y.year,
      saving: r2(y.saving),
      cumulative_saving: r2(y.cumulative_saving),
      net_position: r2(y.net_position),
    })),
  };

  const result: CalcResult = {
    year1: {
      bill_self_use: billSelfUse,
      bill_optimised: billOptimised,
      saving_total: savingTotal,
      saving_tariff_and_solar: savingTariffSolar,
      saving_optimisation: savingOptimisation,
      optimisation_uplift: savingTariffSolar > 0 ? r3(savingOptimisation / savingTariffSolar) : null,
      monthly_saving: r2(savingTotal / 12),
      simple_payback_years: savingTotal > 0 ? r2(req.system_cost / savingTotal) : null,
    },
    energy: {
      grid_import_outside_cheap_kwh: r0(sim.optimised.importOutsideCheap),
      grid_charge_kwh: r0(sim.optimised.gridCharge),
      battery_export_kwh: r0(sim.optimised.batteryExport),
      curtailed_kwh: r0(sim.optimised.curtailed),
    },
    lifetime: lifeOut,
    meta: {
      tariff,
      usage,
      config_version: CONFIG_VERSION,
      assumptions: {
        bands: rates.bands.map((b) => ({ ...b })),
        battery_usable_fraction: BATTERY.usable_fraction,
        battery_round_trip_efficiency: BATTERY.round_trip_efficiency,
        degradation: DEGRADATION,
        inflation: inflation / 100,
        self_use_fraction_applied: r3(profiles.selfUseApplied),
        standing_charges: 'excluded',
      },
    },
  };

  const comparison: NonNullable<CalcResult['comparison']> = {};
  if (req.solar_savings != null) comparison.solar_savings_diff = r2(savingTotal - req.solar_savings);
  if (req.report_payback != null) {
    comparison.payback_diff =
      lifeOut.payback_years === null ? null : r2(lifeOut.payback_years - req.report_payback);
  }
  if (req.report_25yr != null) comparison.saving_25yr_diff = r2(lifeOut.saving_25yr - req.report_25yr);
  if (req.report_roi != null) comparison.roi_diff = r3(lifeOut.roi - req.report_roi);
  if (Object.keys(comparison).length > 0) result.comparison = comparison;

  if (opts.detail) {
    result.monthly = MONTHS.map((month, m) => ({
      month,
      bill_self_use: r2(sim.selfUse.monthlyCost[m]),
      bill_optimised: r2(sim.optimised.monthlyCost[m]),
    }));
  }
  return result;
}

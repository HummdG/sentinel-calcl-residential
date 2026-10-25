// The /api/v1/calc model: hand-checked figures, the brief's edge cases, and physical
// invariants of the half-hourly dispatch.

import { describe, expect, it } from 'vitest';
import { calculate } from '../../lib/v1/calc';
import { BATTERY, DEGRADATION, TARIFFS, USAGES } from '../../lib/v1/config';
import { lifetime } from '../../lib/v1/finance';
import { buildProfiles, directSelfUse } from '../../lib/v1/profiles';
import { CalcResultSchema, type CalcRequest } from '../../lib/v1/schema';
import { candidatePolicies, makeBattery, SELF_USE, steadyDay } from '../../lib/v1/simulate';
import { slotRates } from '../../lib/v1/tariffs';

const base: CalcRequest = {
  annual_usage: 3500,
  annual_gen: 4000,
  battery_kwh: 10,
  inverter_kw: 5,
  system_cost: 12000,
};

describe('hand-checked', () => {
  it('flat tariff, no battery: bills follow from self_use_fraction alone', () => {
    const r = calculate({ ...base, battery_kwh: 0, tariff: 'flat' });
    // 35% of 4000 kWh used directly = 1400. Import 3500 − 1400 = 2100 × £0.26 = £546.
    // Export 4000 − 1400 = 2600 × £0.12 Outgoing = £312. Bill £234. Baseline 3500 × 0.26 = £910.
    expect(r.year1.bill_self_use).toBe(234);
    expect(r.year1.bill_optimised).toBe(234);
    expect(r.year1.saving_total).toBe(676);
    expect(r.year1.saving_optimisation).toBe(0);
    expect(r.year1.monthly_saving).toBe(56.33);
    expect(r.year1.simple_payback_years).toBe(17.75); // 12000 / 676
    expect(r.energy.grid_import_outside_cheap_kwh).toBe(2100);
    expect(r.energy.grid_charge_kwh).toBe(0);
    expect(r.meta.assumptions.self_use_fraction_applied).toBe(0.35);
  });

  it('lifetime table follows the brief formula', () => {
    const life = lifetime(1000, 12000, 5);
    expect(life.years).toHaveLength(25);
    const y3 = 1000 * 1.05 ** 2 * (1 - DEGRADATION) ** 2;
    expect(life.years[2].saving).toBeCloseTo(y3, 9);
    expect(life.years[2].cumulative_saving).toBeCloseTo(
      1000 + 1000 * 1.05 * (1 - DEGRADATION) + y3,
      9,
    );
    expect(life.years[24].net_position).toBeCloseTo(life.saving_25yr - 12000, 9);
    expect(life.roi).toBeCloseTo(life.saving_25yr / 12000, 12);
    expect(life.net_roi).toBeCloseTo((life.saving_25yr - 12000) / 12000, 12);
  });

  it('payback is interpolated inside the crossing year', () => {
    // No growth, no degradation effect to speak of: £1000/yr against £2500 -> 2.5 years.
    const life = lifetime(1000, 2500, 0);
    const exact = 2 + (2500 - 1000 - 1000 * (1 - DEGRADATION)) / (1000 * (1 - DEGRADATION) ** 2);
    expect(life.payback_years).toBeCloseTo(exact, 9);
    const row = life.years.find((y) => y.net_position >= 0)!;
    expect(row.year).toBe(3);
  });
});

describe('edge cases from the brief', () => {
  it('no battery (battery_kwh = 0 or inverter_kw = 0) is valid and has no optimisation', () => {
    for (const r of [
      calculate({ ...base, battery_kwh: 0 }),
      calculate({ ...base, inverter_kw: 0 }),
    ]) {
      expect(r.year1.bill_optimised).toBe(r.year1.bill_self_use);
      expect(r.year1.saving_optimisation).toBe(0);
      expect(r.energy.grid_charge_kwh).toBe(0);
      expect(r.energy.battery_export_kwh).toBe(0);
    }
  });

  it('no PV (annual_gen = 0) is valid', () => {
    const r = calculate({ ...base, annual_gen: 0, tariff: 'go' });
    expect(r.meta.assumptions.self_use_fraction_applied).toBe(0);
    expect(r.year1.bill_self_use).toBeGreaterThan(0);
    // Battery-only on Go still saves by shifting load into the cheap window.
    expect(r.year1.saving_optimisation).toBeGreaterThan(0);
    expect(r.energy.grid_charge_kwh).toBeGreaterThan(0);
  });

  it('no PV and no battery on a flat tariff saves nothing', () => {
    const r = calculate({ ...base, annual_gen: 0, battery_kwh: 0, tariff: 'flat' });
    expect(r.year1.saving_total).toBe(0);
    expect(r.year1.simple_payback_years).toBeNull();
    expect(r.lifetime.payback_years).toBeNull();
    expect(r.year1.optimisation_uplift).toBeNull();
  });

  it('a negative bill is returned as-is', () => {
    const r = calculate({ ...base, annual_usage: 1500, annual_gen: 9000, tariff: 'flux' });
    expect(r.year1.bill_optimised).toBeLessThan(0);
    expect(() => CalcResultSchema.parse(r)).not.toThrow();
  });

  it('paybacks are null when the saving is not positive', () => {
    // Economy 7 with a punishing day rate and no system: the tariff switch alone costs money.
    const r = calculate({
      ...base,
      annual_gen: 0,
      battery_kwh: 0,
      tariff: 'economy7',
      dn_day: 0.5,
      dn_night: 0.3,
    });
    expect(r.year1.saving_total).toBeLessThan(0);
    expect(r.year1.saving_tariff_and_solar).toBeLessThan(0);
    expect(r.year1.simple_payback_years).toBeNull();
    expect(r.lifetime.payback_years).toBeNull();
    expect(r.year1.optimisation_uplift).toBeNull();
  });

  it('payback beyond 25 years is null', () => {
    const r = calculate({ ...base, system_cost: 1_000_000 });
    expect(r.year1.saving_total).toBeGreaterThan(0);
    expect(r.lifetime.payback_years).toBeNull();
    expect(r.year1.simple_payback_years).toBeGreaterThan(25);
  });
});

describe('output contract', () => {
  it('savings reconcile with the bills', () => {
    for (const tariff of TARIFFS) {
      const r = calculate({ ...base, tariff });
      const y = r.year1;
      const baseline = 3500 * 0.26;
      expect(y.saving_total).toBeCloseTo(baseline - y.bill_optimised, 2);
      expect(y.saving_tariff_and_solar).toBeCloseTo(baseline - y.bill_self_use, 2);
      expect(y.saving_optimisation).toBeCloseTo(y.bill_self_use - y.bill_optimised, 2);
      expect(y.saving_optimisation).toBeGreaterThanOrEqual(0);
    }
  });

  it('every tariff x usage combination matches the published response schema', () => {
    for (const tariff of TARIFFS) {
      for (const usage of USAGES) {
        const r = calculate({ ...base, tariff, usage }, { detail: true });
        expect(() => CalcResultSchema.parse(r)).not.toThrow();
        expect(r.meta).toMatchObject({ tariff, usage });
      }
    }
  });

  it('defaults are flux and half_day', () => {
    expect(calculate(base).meta).toMatchObject({ tariff: 'flux', usage: 'half_day' });
  });

  it('monthly bills sum to the annual ones within rounding', () => {
    const r = calculate({ ...base, tariff: 'flux' }, { detail: true });
    expect(r.monthly).toHaveLength(12);
    const sum = (k: 'bill_self_use' | 'bill_optimised') => r.monthly!.reduce((s, m) => s + m[k], 0);
    expect(Math.abs(sum('bill_self_use') - r.year1.bill_self_use)).toBeLessThan(0.07);
    expect(Math.abs(sum('bill_optimised') - r.year1.bill_optimised)).toBeLessThan(0.07);
    expect(calculate(base).monthly).toBeUndefined();
  });

  it('comparison carries only the diffs whose report figure was sent', () => {
    expect(calculate(base).comparison).toBeUndefined();
    const r = calculate({ ...base, solar_savings: 900, report_roi: 2 });
    expect(Object.keys(r.comparison!).sort()).toEqual(['roi_diff', 'solar_savings_diff']);
    expect(r.comparison!.solar_savings_diff).toBeCloseTo(r.year1.saving_total - 900, 2);
    expect(r.comparison!.roi_diff).toBeCloseTo(r.lifetime.roi - 2, 3);
    const full = calculate({ ...base, report_payback: 9, report_25yr: 30000 });
    expect(full.comparison!.payback_diff).toBeCloseTo(full.lifetime.payback_years! - 9, 2);
    expect(full.comparison!.saving_25yr_diff).toBeCloseTo(full.lifetime.saving_25yr - 30000, 2);
  });

  it('report figures never change the calculation', () => {
    const a = calculate(base);
    const b = calculate({ ...base, solar_savings: 1, report_payback: 1, report_25yr: 1, report_roi: 1 });
    expect(b.year1).toEqual(a.year1);
    expect(b.lifetime).toEqual(a.lifetime);
  });

  it('an export limit curtails PV and never raises the bill below the uncapped one', () => {
    const uncapped = calculate({ ...base, annual_gen: 8000, battery_kwh: 0 });
    const capped = calculate({ ...base, annual_gen: 8000, battery_kwh: 0, export_limit_kw: 1 });
    expect(uncapped.energy.curtailed_kwh).toBe(0);
    expect(capped.energy.curtailed_kwh).toBeGreaterThan(0);
    expect(capped.year1.bill_self_use).toBeGreaterThan(uncapped.year1.bill_self_use);
  });
});

describe('self_use_fraction calibration', () => {
  it('direct self-use matches the requested fraction', () => {
    for (const f of [0.1, 0.35, 0.6]) {
      for (const usage of USAGES) {
        const p = buildProfiles(3500, 4000, usage, f);
        expect(directSelfUse(p.days) / 4000).toBeCloseTo(f, 4);
        expect(p.selfUseApplied).toBeCloseTo(f, 4);
      }
    }
  });

  it('caps at what the load can absorb, and reports the applied figure', () => {
    const p = buildProfiles(1000, 8000, 'out_all_day', 1);
    expect(p.selfUseApplied).toBeLessThan(1);
    expect(p.selfUseApplied).toBeGreaterThan(0);
  });

  it('keeps each month’s consumption, only moving it within the day', () => {
    const p = buildProfiles(3500, 4000, 'half_day', 0.6);
    const total = p.days.reduce((s, d) => s + d.weight * d.load.reduce((a, b) => a + b, 0), 0);
    expect(total).toBeCloseTo(3500, 6);
  });
});

describe('dispatch invariants', () => {
  const eps = 1e-9;
  for (const tariff of TARIFFS) {
    it(`${tariff}: energy balances, state of charge and power limits hold in every slot`, () => {
      const rates = slotRates(tariff, { std_import: 0.26, dn_day: 0.3, dn_night: 0.15 });
      const batt = makeBattery(10, 3)!;
      const cap = 2 * 0.5; // 2 kW export limit
      const { days } = buildProfiles(4000, 6000, 'half_day', 0.35);
      for (const day of days) {
        for (const policy of candidatePolicies(day, rates, batt)) {
          const { trace } = steadyDay(day, rates, batt, policy, cap);
          for (const s of trace) {
            // Load is met by PV, battery and grid.
            expect(s.direct + s.discharge + (s.import - s.gridCharge)).toBeCloseTo(s.load, 9);
            // PV goes to the load, the battery, the grid, or is curtailed.
            expect(s.direct + s.pvCharge + s.pvExport + s.curtailed).toBeCloseTo(s.pv, 9);
            // Battery state moves by exactly what went in and out, after losses.
            const delta =
              (s.pvCharge + s.gridCharge) * batt.etaIn - (s.discharge + s.batteryExport) / batt.etaOut;
            expect(s.socEnd - s.socStart).toBeCloseTo(delta, 9);
            expect(s.socEnd).toBeGreaterThanOrEqual(-eps);
            expect(s.socEnd).toBeLessThanOrEqual(batt.capacity + eps);
            // The inverter limits throughput; the export limit caps PV + battery export.
            expect(s.pvCharge + s.gridCharge + s.discharge + s.batteryExport).toBeLessThanOrEqual(
              batt.maxPerSlot + eps,
            );
            expect(s.pvExport + s.batteryExport).toBeLessThanOrEqual(cap + eps);
            for (const v of [s.pvCharge, s.gridCharge, s.discharge, s.batteryExport, s.pvExport, s.curtailed, s.import]) {
              expect(v).toBeGreaterThanOrEqual(-eps);
            }
          }
        }
      }
    });
  }

  it('self-use never grid-charges or exports from the battery', () => {
    const rates = slotRates('flux', { std_import: 0.26, dn_day: 0.3, dn_night: 0.15 });
    const { days } = buildProfiles(3500, 4000, 'half_day', 0.35);
    for (const day of days) {
      const { totals } = steadyDay(day, rates, makeBattery(10, 5), SELF_USE, Infinity);
      expect(totals.gridCharge).toBe(0);
      expect(totals.batteryExport).toBe(0);
    }
  });

  it('usable capacity and efficiency come from config', () => {
    const b = makeBattery(10, 5)!;
    expect(b.capacity).toBeCloseTo(10 * BATTERY.usable_fraction, 12);
    expect(b.etaIn * b.etaOut).toBeCloseTo(BATTERY.round_trip_efficiency, 12);
    expect(b.maxPerSlot).toBe(2.5);
  });
});

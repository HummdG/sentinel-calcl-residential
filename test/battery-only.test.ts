// Battery-only orders: a job with storage and Sentinel but no solar.
//
// These cases have no PHP counterpart to generate a golden from, because the PHP
// calculator has no order type. That is also why they are safe: every behaviour asserted
// here is reachable only when order_type is 'battery_only', so the seven frozen parity
// scenarios in golden.json describe exactly the same calculation they always did. Each
// battery-only assertion below is paired with the solar equivalent for that reason.

import { describe, it, expect } from 'vitest';
import { calculate } from '../lib/calculator';
import { getConstants } from '../lib/config';
import { DEFAULT_FORM, buildCalcInput, type FormState } from '../lib/form';
import type { CalcInput } from '../lib/types';

const c = getConstants();

// A real battery retrofit: 10 kWh of storage, no panels, exporting on a Flux tariff.
const base: CalcInput = {
  pv_size: 0,
  battery_kwh: 10,
  inverter_kw: 5,
  annual_gen: 0,
  annual_usage: 4500,
  system_cost: 8000,
  solar_savings: 600,
  export_kwh: 2000,
  os_payback: 11,
  os_25yr: 21000,
  os_roi: 0,
  std_import: 28,
  dn_day: 28,
  dn_night: 15,
  tariff: 'flux',
  usage: 'balanced',
  inflation: 7,
};

describe('Flux arbitrage on a system with no solar', () => {
  it('charges every exported kWh as grid-charged cycling', () => {
    // With no panels there is no other source for the export, which is precisely the
    // cost flux_charge_rate exists to recover. Before the order type existed, the
    // annualGen > 0 guard suppressed this and credited all 2,000 kWh at the full
    // optimised export rate.
    const r = calculate({ ...base, order_type: 'battery_only' }, c);

    expect(r.flux_arbitrage_warning).toBe(true);
    expect(r.arbitrage_kwh).toBe(2000);
    expect(r.grid_charging_cost).toBe(Math.round(2000 * c.flux_charge_rate));
    expect(r.sentinel_seg).toBe(
      Math.round(2000 * c.export_sentinel_flux - 2000 * c.flux_charge_rate)
    );
  });

  it('leaves the solar path untouched, where a zero still means "not entered"', () => {
    // Same figures, declared as a solar job. A blank generation field must not be read as
    // a factual zero, so no deduction and no warning.
    const r = calculate({ ...base, order_type: 'solar_battery' }, c);

    expect(r.flux_arbitrage_warning).toBe(false);
    expect(r.arbitrage_kwh).toBe(0);
    expect(r.sentinel_seg).toBe(Math.round(2000 * c.export_sentinel_flux));
  });

  it('treats an absent order_type as solar, which is what the golden scenarios assume', () => {
    const r = calculate(base, c);
    expect(r.order_type).toBe('solar_battery');
    expect(r.flux_arbitrage_warning).toBe(false);
  });

  it('still only applies on Flux', () => {
    const r = calculate({ ...base, order_type: 'battery_only', tariff: 'standard' }, c);
    expect(r.flux_arbitrage_warning).toBe(false);
  });
});

describe('monthly chart seasonality', () => {
  it('spreads a battery-only year evenly', () => {
    // c.mw is an irradiance curve. A battery's peak-shaving and trading revenue does not
    // collapse in December, so drawing it with a summer hump would misrepresent the system.
    const r = calculate({ ...base, order_type: 'battery_only' }, c);

    expect(r.chart_monthly.sentinel).toHaveLength(12);
    expect(new Set(r.chart_monthly.sentinel).size).toBe(1);
    expect(new Set(r.chart_monthly.solar).size).toBe(1);
  });

  it('keeps the solar curve for a solar order', () => {
    const r = calculate({ ...base, order_type: 'solar_battery' }, c);
    const m = r.chart_monthly.sentinel;

    expect(new Set(m).size).toBeGreaterThan(1);
    expect(m[6]).toBeGreaterThan(m[0]); // July above January
  });
});

describe('what reaches the report', () => {
  it('echoes the order type and zeroed solar figures', () => {
    const r = calculate({ ...base, order_type: 'battery_only' }, c);
    expect(r.order_type).toBe('battery_only');
    expect(r.pv_size).toBe(0);
    expect(r.annual_gen).toBe(0);
  });
});

describe('buildCalcInput', () => {
  // The two solar inputs are hidden on a battery-only order but their state is not
  // cleared. Sending whatever was typed before the switch would put a PV size on a
  // report for a job that has no panels.
  const typedSolar: FormState = {
    ...DEFAULT_FORM,
    pv_size: '4.6',
    battery_kwh: '10',
    inverter_kw: '5',
    annual_gen: '3900',
    annual_usage: '4500',
    system_cost: '8000',
    solar_savings: '600',
    export_kwh: '2000',
    os_payback: '11',
    os_25yr: '21000',
  };

  it('pins pv_size and annual_gen to zero on a battery-only order', () => {
    const input = buildCalcInput(typedSolar, 'flux', 'balanced', 7, 'battery_only');
    expect(input.pv_size).toBe(0);
    expect(input.annual_gen).toBe(0);
    expect(input.battery_kwh).toBe(10);
    expect(input.order_type).toBe('battery_only');
  });

  it('sends both through unchanged on a solar order', () => {
    const input = buildCalcInput(typedSolar, 'flux', 'balanced', 7, 'solar_battery');
    expect(input.pv_size).toBe(4.6);
    expect(input.annual_gen).toBe(3900);
    expect(input.order_type).toBe('solar_battery');
  });
});

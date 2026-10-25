// Covers how an extraction is merged into the form: which fields it may overwrite, which
// gaps it reports, and the protection that stopped a re-upload from silently undoing a
// hand-corrected figure. Kept in step with sentinelHandlePDF() in
// assets/js/sentinel-frontend.js.

import { describe, it, expect } from 'vitest';
import {
  DEFAULT_FORM,
  applyExtracted,
  gateFailures,
  inferOrderType,
  type FormState,
} from '../lib/form';
import type { ExtractedFields } from '../lib/types';

// A quote where the model found the spec but missed the year-1 saving. The failure that
// let the old £3,733 demo default reach a customer-facing report.
//
// `solar_savings: null` is what "not found" now looks like. It used to be 0, which meant
// a genuine zero and a missing value were the same thing to this merge. See the
// legitimate-zero test at the bottom for the case that broke.
const extraction: ExtractedFields = {
  customer_name: 'Manish Shrestha',
  customer_address: '22 Varey Road',
  pv_size: 4.6,
  battery_kwh: 10.24,
  inverter_kw: 5,
  annual_gen: 4256,
  annual_usage: 2064,
  system_cost: 19198, // mis-read: this is the lifetime net-savings figure
  solar_savings: null, // not found
  export_kwh: 2382,
  os_payback: 13,
  os_25yr: 19198,
  os_roi: 8,
};

describe('applyExtracted', () => {
  it('fills what the quote provided and reports what it did not', () => {
    const { form, populated, missing } = applyExtracted(DEFAULT_FORM, extraction, [
      'solar_savings',
    ]);
    expect(form.system_cost).toBe('19198');
    expect(form.customer_name).toBe('Manish Shrestha');
    expect(populated.has('system_cost')).toBe(true);

    // The gap is reported rather than filled. And critically NOT marked as populated.
    expect(form.solar_savings).toBe('');
    expect(populated.has('solar_savings')).toBe(false);
    expect(missing.has('solar_savings')).toBe(true);
  });

  it('leaves the form incomplete when a required value was not found', () => {
    const { form } = applyExtracted(DEFAULT_FORM, extraction, ['solar_savings']);
    expect(gateFailures(form)).toEqual(['Annual bill savings (yr 1)']);
  });

  it('does not overwrite a figure the surveyor corrected by hand', () => {
    // The surveyor fixed the mis-extracted cost, then the quote was dropped again.
    const corrected: FormState = { ...DEFAULT_FORM, system_cost: '11319' };
    const { form, preserved, populated } = applyExtracted(
      corrected,
      extraction,
      [],
      new Set(['system_cost'])
    );
    expect(form.system_cost).toBe('11319');
    expect(preserved).toContain('system_cost');
    expect(populated.has('system_cost')).toBe(false);
    // Fields they did not touch still update.
    expect(form.annual_gen).toBe('4256');
  });

  it('re-applies an extraction that agrees with the manual value', () => {
    const same: FormState = { ...DEFAULT_FORM, system_cost: '19198' };
    const { preserved } = applyExtracted(same, extraction, [], new Set(['system_cost']));
    expect(preserved).not.toContain('system_cost');
  });

  it('does not flag a gap the surveyor has already filled in', () => {
    const filled: FormState = { ...DEFAULT_FORM, solar_savings: '787' };
    const { missing, form } = applyExtracted(filled, extraction, ['solar_savings']);
    expect(missing.has('solar_savings')).toBe(false);
    expect(form.solar_savings).toBe('787');
    expect(gateFailures(form)).toEqual([]);
  });

  it('fills a legitimate zero the proposal actually states', () => {
    // River House exports nothing: the proposal says "0% Export to grid" and every month
    // of the export column is 0. The old `v > 0` guard skipped that, leaving the surveyor
    // to hand-type a zero the document had already given them.
    const zeroExport: ExtractedFields = { ...extraction, export_kwh: 0, battery_kwh: 0 };
    const { form, populated, missing } = applyExtracted(DEFAULT_FORM, zeroExport, []);

    expect(form.export_kwh).toBe('0');
    expect(form.battery_kwh).toBe('0');
    expect(populated.has('export_kwh')).toBe(true);
    expect(populated.has('battery_kwh')).toBe(true);
    expect(missing.has('export_kwh')).toBe(false);
  });

  it('still leaves a null field blank rather than writing a zero into it', () => {
    // The other half of the same distinction: absent must not become 0, or an unstated
    // figure silently becomes a real one in the report.
    const { form, populated } = applyExtracted(DEFAULT_FORM, extraction, ['solar_savings']);
    expect(form.solar_savings).toBe('');
    expect(populated.has('solar_savings')).toBe(false);
  });
});

describe('gateFailures', () => {
  it('blocks a completely blank form and names every requirement', () => {
    expect(gateFailures(DEFAULT_FORM)).toHaveLength(10);
  });

  it('accepts a legitimate zero for battery and export, but not for cost', () => {
    const noBattery: FormState = {
      ...DEFAULT_FORM,
      pv_size: '4',
      battery_kwh: '0',
      inverter_kw: '3.68',
      annual_gen: '3600',
      annual_usage: '4200',
      system_cost: '7000',
      solar_savings: '600',
      export_kwh: '0',
      os_payback: '9.5',
      os_25yr: '12000',
    };
    expect(gateFailures(noBattery)).toEqual([]);
    expect(gateFailures({ ...noBattery, system_cost: '0' })).toEqual(['Total system cost']);
  });

  it('stops requiring the solar figures on a battery-only order', () => {
    // The surveyors' blocker: a storage retrofit has no PV size and no generation to
    // enter, so the gate could never clear and no report could be produced.
    const batteryOnly: FormState = {
      ...DEFAULT_FORM,
      pv_size: '',
      battery_kwh: '10',
      inverter_kw: '5',
      annual_gen: '',
      annual_usage: '4500',
      system_cost: '8000',
      solar_savings: '600',
      export_kwh: '2000',
      os_payback: '11',
      os_25yr: '21000',
    };

    expect(gateFailures(batteryOnly, 'battery_only')).toEqual([]);
    // Everything else still has to be there.
    expect(gateFailures({ ...batteryOnly, system_cost: '0' }, 'battery_only')).toEqual([
      'Total system cost',
    ]);
  });

  it('still requires them on a solar order, and by default', () => {
    // A blank PV size on a solar job is a mis-extraction, not a fact. Relaxing it there
    // is how "Solar PV: 0kWp" would reach a customer-facing report.
    const noSolarFigures: FormState = {
      ...DEFAULT_FORM,
      battery_kwh: '10',
      inverter_kw: '5',
      annual_usage: '4500',
      system_cost: '8000',
      solar_savings: '600',
      export_kwh: '2000',
      os_payback: '11',
      os_25yr: '21000',
    };

    expect(gateFailures(noSolarFigures, 'solar_battery')).toEqual([
      'Solar PV size',
      'Annual generation',
    ]);
    expect(gateFailures(noSolarFigures)).toEqual(['Solar PV size', 'Annual generation']);
  });
});

describe('inferOrderType', () => {
  // Same null-vs-zero distinction the merge above turns on: `null` is "the document does
  // not say", `0` is "the document says zero". Only the second is evidence of anything.
  const blank: ExtractedFields = {
    customer_name: null,
    customer_address: null,
    pv_size: null,
    battery_kwh: null,
    inverter_kw: null,
    annual_gen: null,
    annual_usage: null,
    system_cost: null,
    solar_savings: null,
    export_kwh: null,
    os_payback: null,
    os_25yr: null,
    os_roi: null,
  };

  it('reads a stated zero PV size and generation against a real battery as battery-only', () => {
    expect(inferOrderType({ ...blank, pv_size: 0, annual_gen: 0, battery_kwh: 10 })).toBe(
      'battery_only'
    );
  });

  it('leaves the choice alone when the document simply says nothing', () => {
    // A failed extraction must not silently switch the surveyor into battery-only and
    // waive the two requirements that would have caught it.
    expect(inferOrderType(blank)).toBeNull();
    expect(inferOrderType({ ...blank, battery_kwh: 10 })).toBeNull();
    expect(inferOrderType({ ...blank, pv_size: 0, annual_gen: null, battery_kwh: 10 })).toBeNull();
  });

  it('will not call a quote battery-only when it has no battery either', () => {
    expect(inferOrderType({ ...blank, pv_size: 0, annual_gen: 0, battery_kwh: 0 })).toBeNull();
  });

  it('switches back to solar on any positive solar figure', () => {
    // Otherwise battery-only sticks, and the next solar quote is reported with its PV
    // size and generation silently zeroed.
    expect(inferOrderType({ ...blank, pv_size: 4.6, annual_gen: 3900 })).toBe('solar_battery');
    expect(inferOrderType({ ...blank, pv_size: null, annual_gen: 3900 })).toBe('solar_battery');
  });
});

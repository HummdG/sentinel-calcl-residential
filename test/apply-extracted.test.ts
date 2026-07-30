// Covers how an extraction is merged into the form: which fields it may overwrite, which
// gaps it reports, and the protection that stopped a re-upload from silently undoing a
// hand-corrected figure. Kept in step with sentinelHandlePDF() in
// assets/js/sentinel-frontend.js.

import { describe, it, expect } from 'vitest';
import { DEFAULT_FORM, applyExtracted, gateFailures, type FormState } from '../lib/form';
import type { ExtractedFields } from '../lib/types';

// A quote where the model found the spec but missed the year-1 saving — the failure that
// let the old £3,733 demo default reach a customer-facing report.
const extraction: ExtractedFields = {
  customer_name: 'Manish Shrestha',
  customer_address: '22 Varey Road',
  pv_size: 4.6,
  battery_kwh: 10.24,
  inverter_kw: 5,
  annual_gen: 4256,
  annual_usage: 2064,
  system_cost: 19198, // mis-read: this is the lifetime net-savings figure
  solar_savings: 0, // not found
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

    // The gap is reported rather than filled — and critically NOT marked as populated.
    expect(form.solar_savings).toBe('');
    expect(populated.has('solar_savings')).toBe(false);
    expect(missing.has('solar_savings')).toBe(true);
  });

  it('leaves the form incomplete when a required value was not found', () => {
    const { form } = applyExtracted(DEFAULT_FORM, extraction, ['solar_savings']);
    expect(gateFailures(form)).toEqual(['Annual bill savings — yr 1']);
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
});

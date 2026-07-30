// Covers the extraction plausibility checks against the real 22 Varey Road failure that
// motivated them: a £19,198 lifetime-savings figure landing in system_cost on an £11,319
// system, and an annual_usage read off the grid-import column. Kept in step with
// Sentinel_PDF_Parser::sanity_warnings() in includes/class-pdf-parser.php.

import { describe, it, expect } from 'vitest';
import { sanityWarnings } from '../lib/groq';
import type { ExtractedFields } from '../lib/types';

const vareyRoad: ExtractedFields = {
  customer_name: 'Manish Shrestha',
  customer_address: '22 Varey Road',
  pv_size: 4.6,
  battery_kwh: 10.24,
  inverter_kw: 5,
  annual_gen: 4256,
  annual_usage: 3900, // true total household consumption
  system_cost: 11319, // "Total System Price"
  solar_savings: 787, // year-1 saving from the cashflow table
  export_kwh: 2382,
  os_payback: 13,
  os_25yr: 19198, // "Estimated Net Savings"
  os_roi: 8.0,
};

const on = (f: ExtractedFields) => sanityWarnings(f).join(' | ');

describe('extraction sanity warnings', () => {
  it('stays silent when every figure reconciles', () => {
    expect(sanityWarnings(vareyRoad)).toEqual([]);
  });

  it('catches system_cost mis-read as the lifetime net-savings figure', () => {
    // Exactly what the Updated report was built from.
    const out = on({ ...vareyRoad, system_cost: 19198, annual_usage: 2064 });
    expect(out).toContain('both read as £19,198');
    expect(out).toContain('imply a payback of about 20.9 years, but the proposal states 13.0');
  });

  it('catches an annual_usage that cannot support the stated saving', () => {
    // 2,064 kWh is the quote's grid-import column, not total household demand. Left
    // uncorrected, the calculator's bill-savings cap silently swallows the whole uplift.
    const out = on({ ...vareyRoad, annual_usage: 2064 });
    expect(out).toContain('2,064 kWh');
    expect(out).toContain('grid-import figure');
  });

  it('flags 25-year net savings that do not exceed the system cost', () => {
    expect(on({ ...vareyRoad, os_25yr: 9000 })).toContain('is not greater than the system cost');
  });

  it('stays quiet about payback when the year-1 saving is missing', () => {
    // solar_savings is already reported via `missing`; a payback derived from £0 is noise.
    expect(on({ ...vareyRoad, solar_savings: 0 })).not.toContain('imply a payback');
  });

  it('flags an implausible cost per kWp', () => {
    expect(on({ ...vareyRoad, system_cost: 30000 })).toContain('Cost per kWp');
  });

  it('flags an implausible yield for the array size', () => {
    expect(on({ ...vareyRoad, annual_gen: 12000 })).toContain('kWh per kWp');
  });

  it('flags export exceeding generation', () => {
    expect(on({ ...vareyRoad, export_kwh: 5000 })).toContain('exceeds annual generation');
  });
});

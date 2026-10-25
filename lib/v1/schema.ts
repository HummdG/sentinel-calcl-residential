// Request and response schemas for /api/v1/calc. The request schema is the validator; both
// feed the OpenAPI document, and the tests parse real responses through the response schema
// so the published docs can't drift from what the endpoint returns.

import { z } from 'zod';
import { DEFAULTS, TARIFFS, USAGES } from './config';

/** A finite JSON number. Strings such as "5" are rejected, not coerced. */
const num = () => z.number({ error: 'must be a number' });
const nonNeg = () => num().min(0, 'must not be negative');

/** Optional input: absent or null both mean "use the default". */
const opt = <T extends z.ZodType>(s: T) => s.nullish();

export const CalcRequestSchema = z
  .object({
    annual_usage: num().gt(0, 'must be greater than 0').max(200_000, 'must be at most 200000')
      .describe('Total household consumption, kWh/yr. Must be > 0.'),
    annual_gen: nonNeg().max(200_000, 'must be at most 200000')
      .describe('PV generation, kWh/yr. 0 = no solar.'),
    battery_kwh: nonNeg().max(1_000, 'must be at most 1000')
      .describe('Battery nameplate capacity, kWh. 0 = no battery.'),
    inverter_kw: nonNeg().max(1_000, 'must be at most 1000')
      .describe('Inverter rating, kW. Caps battery charge (incl. grid charging) and discharge per half-hour. 0 = no battery.'),
    system_cost: num().gt(0, 'must be greater than 0').max(10_000_000, 'must be at most 10000000')
      .describe('Installed system cost, £. Used for payback, 25-year and ROI.'),
    tariff: opt(z.enum(TARIFFS, { error: `must be one of ${TARIFFS.join(', ')}` })).describe(
      `Tariff for the self-use and optimised scenarios. Default ${DEFAULTS.tariff}.`,
    ),
    usage: opt(z.enum(USAGES, { error: `must be one of ${USAGES.join(', ')}` })).describe(
      `Occupancy load profile. Default ${DEFAULTS.usage}.`,
    ),
    self_use_fraction: opt(
      num().min(0, 'must be between 0 and 1').max(1, 'must be between 0 and 1'),
    ).describe(
      `Share of PV the home uses directly before any battery (from the OpenSolar report), 0-1. Default ${DEFAULTS.self_use_fraction}.`,
    ),
    std_import: opt(nonNeg()).describe(
      `Standard import rate, £/kWh: the no-system baseline and the flat tariff's rate. Default ${DEFAULTS.std_import}.`,
    ),
    dn_day: opt(nonNeg()).describe(`Economy 7 day rate, £/kWh. Default ${DEFAULTS.dn_day}.`),
    dn_night: opt(nonNeg()).describe(`Economy 7 night (cheap) rate, £/kWh. Default ${DEFAULTS.dn_night}.`),
    inflation: opt(
      num().min(-10, 'must be between -10 and 20').max(20, 'must be between -10 and 20'),
    ).describe(`Annual growth of savings, percent (5 = 5%). Default ${DEFAULTS.inflation}.`),
    export_limit_kw: opt(nonNeg()).describe(
      'DNO export cap, kW, applied to PV + battery export together. 0 = no limit (default).',
    ),
    solar_savings: opt(num()).describe('OpenSolar year-1 saving, £. Comparison only; never used in the calculation.'),
    report_payback: opt(nonNeg()).describe('OpenSolar payback, years. Comparison only.'),
    report_25yr: opt(num()).describe('OpenSolar 25-year saving, £. Comparison only.'),
    report_roi: opt(num()).describe('OpenSolar ROI as a ratio (saving_25yr ÷ system_cost). Comparison only.'),
  })
  .describe('Calculation request. Unknown fields are ignored.');

export type CalcRequest = z.output<typeof CalcRequestSchema>;

const money = () => z.number().describe('£, 2 dp');
const kwh = () => z.number().describe('kWh/yr, whole number');
const years = () => z.number().nullable().describe('Years, 2 dp');
const ratio = () => z.number().describe('Ratio, 3 dp');

export const CalcResultSchema = z.object({
  year1: z.object({
    bill_self_use: money().describe('Year-1 bill on the selected tariff, battery charged from spare solar only. £. May be negative.'),
    bill_optimised: money().describe('Year-1 bill on the selected tariff with the battery optimised (grid charging, timed discharge and export). £. May be negative.'),
    saving_total: money().describe('No-system bill (annual_usage × std_import) − bill_optimised. £.'),
    saving_tariff_and_solar: money().describe('No-system bill − bill_self_use: the tariff switch plus solar, no optimisation. £. May be negative.'),
    saving_optimisation: money().describe('bill_self_use − bill_optimised. £. Never negative.'),
    optimisation_uplift: z.number().nullable().describe('saving_optimisation ÷ saving_tariff_and_solar, 3 dp. null when saving_tariff_and_solar ≤ 0.'),
    monthly_saving: money().describe('saving_total ÷ 12. £.'),
    simple_payback_years: years().describe('system_cost ÷ saving_total, 2 dp. null when saving_total ≤ 0.'),
  }),
  energy: z.object({
    grid_import_outside_cheap_kwh: kwh().describe('Optimised scenario: grid import outside the tariff cheap window (all import on flat). kWh/yr.'),
    grid_charge_kwh: kwh().describe('Optimised scenario: grid energy put into the battery. kWh/yr.'),
    battery_export_kwh: kwh().describe('Optimised scenario: battery energy exported to the grid. kWh/yr.'),
    curtailed_kwh: kwh().describe('Optimised scenario: PV lost to export_limit_kw. 0 with no limit. kWh/yr.'),
  }),
  lifetime: z.object({
    payback_years: years().describe('Point where net_position reaches 0, interpolated within the year, 2 dp. null when not within 25 years or saving_total ≤ 0.'),
    saving_25yr: money().describe('Sum of the 25 yearly savings. £.'),
    roi: ratio().describe('saving_25yr ÷ system_cost (OpenSolar definition).'),
    net_roi: ratio().describe('(saving_25yr − system_cost) ÷ system_cost.'),
    years: z
      .array(
        z.object({
          year: z.number().int().describe('1..25'),
          saving: money().describe('saving_total × (1 + inflation)^(n−1) × (1 − degradation)^(n−1). £.'),
          cumulative_saving: money().describe('£'),
          net_position: money().describe('cumulative_saving − system_cost. £.'),
        }),
      )
      .length(25)
      .describe('25 entries, year 1 first.'),
  }),
  comparison: z
    .object({
      solar_savings_diff: money().optional().describe('saving_total − solar_savings. £.'),
      payback_diff: z.number().nullable().optional().describe('payback_years − report_payback, years. null when payback_years is null.'),
      saving_25yr_diff: money().optional().describe('saving_25yr − report_25yr. £.'),
      roi_diff: ratio().optional().describe('roi − report_roi.'),
    })
    .optional()
    .describe('Present only when at least one OpenSolar figure was sent; contains only the diffs for figures sent.'),
  meta: z.object({
    tariff: z.enum(TARIFFS),
    usage: z.enum(USAGES),
    config_version: z.string().describe('Version of the model assumptions used.'),
    assumptions: z
      .object({
        bands: z
          .array(
            z.object({
              start: z.string(),
              end: z.string(),
              import: z.number(),
              export: z.number(),
              cheap: z.boolean(),
            }),
          )
          .describe('Rate bands applied for the selected tariff, UK clock time, £/kWh.'),
        battery_usable_fraction: z.number(),
        battery_round_trip_efficiency: z.number(),
        degradation: z.number().describe('Annual fraction.'),
        inflation: z.number().describe('Annual fraction applied.'),
        self_use_fraction_applied: z
          .number()
          .describe('Direct self-use achieved. Lower than requested only when the load cannot absorb that much PV.'),
        standing_charges: z.literal('excluded'),
      })
      .describe('The assumptions behind this result, for audit.'),
  }),
  monthly: z
    .array(z.object({ month: z.string(), bill_self_use: money(), bill_optimised: money() }))
    .length(12)
    .optional()
    .describe('Per-month bills, Jan first. Only with ?detail=true. Months sum to the year-1 bills within rounding.'),
});

export type CalcResult = z.infer<typeof CalcResultSchema>;

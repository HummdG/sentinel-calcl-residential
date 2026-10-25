// Versioned model assumptions for the /api/v1/calc engine.
//
// Every number the calculation depends on that the caller cannot override lives here, and
// CONFIG_VERSION is echoed in every response. Change any value -> bump the version, so a
// partner comparing two results can tell whether the model or their inputs moved.

export const CONFIG_VERSION = '2026-10.1';

export const TARIFFS = ['flux', 'go', 'economy7', 'flat'] as const;
export type TariffCode = (typeof TARIFFS)[number];

export const USAGES = ['home_all_day', 'half_day', 'out_all_day'] as const;
export type UsageCode = (typeof USAGES)[number];

/** A clock-time band, UK local time, half-hour aligned. `end` may wrap past midnight. */
export interface Band {
  start: string; // "HH:MM"
  end: string; // "HH:MM", exclusive
  import: number; // £/kWh
  export: number; // £/kWh
  cheap?: boolean; // the window the optimiser grid-charges in
}

/**
 * Octopus Energy rates, pinned 2026-10-20 from the public products API
 * (api.octopus.energy/v1/products/<code>/electricity-tariffs/...), averaged across the 14
 * GB regions, direct debit, inc. VAT. The API reports UTC; windows below are UK clock time.
 *   FLUX-IMPORT-23-02-14 / FLUX-EXPORT-23-02-14: 16.0 / 26.5 / 37.0p, export 4.67 / 11.0 / 30.0p
 *   GO-VAR-22-10-14 (Intelligent Go): 8.81p 00:30-05:30, 29.19p otherwise
 *   OUTGOING-VAR-24-10-26 (Outgoing Octopus): 12.0p flat export
 * Economy 7 and flat import rates come from the request (dn_day / dn_night / std_import).
 */
export const OUTGOING_EXPORT = 0.12;

export const FLUX_BANDS: Band[] = [
  { start: '02:00', end: '05:00', import: 0.16, export: 0.0467, cheap: true },
  { start: '05:00', end: '16:00', import: 0.265, export: 0.11 },
  { start: '16:00', end: '19:00', import: 0.37, export: 0.3 },
  { start: '19:00', end: '02:00', import: 0.265, export: 0.11 },
];

export const GO_CHEAP = { start: '00:30', end: '05:30', import: 0.0881 };
export const GO_DAY_IMPORT = 0.2919;

/** Economy 7's 7-hour night. The exact window varies by meter and region; this is the common one. */
export const ECONOMY7_NIGHT = { start: '00:30', end: '07:30' };

export const BATTERY = {
  /** Share of nameplate kWh the inverter will actually cycle (depth of discharge). */
  usable_fraction: 0.9,
  /** Round-trip AC efficiency; the square root is applied on each of charge and discharge. */
  round_trip_efficiency: 0.9,
};

/** Annual drop in savings over the 25-year projection (panel + battery ageing). */
export const DEGRADATION = 0.005;

export const LIFETIME_YEARS = 25;

export const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export const DAYS_IN_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

/** Share of annual PV generation per month (UK, south-facing). Same weights as the calculator UI. */
export const PV_MONTHLY = [
  0.0348, 0.0487, 0.081, 0.1052, 0.1288, 0.1328, 0.1335, 0.117, 0.0886, 0.0626, 0.0382, 0.0294,
];

/** Share of annual household consumption per month (Elexon profile class 1 shape, rounded). */
export const USAGE_MONTHLY = [
  0.104, 0.092, 0.092, 0.08, 0.074, 0.068, 0.069, 0.071, 0.075, 0.086, 0.092, 0.097,
];

/**
 * Daylight per month for central England (~52.5N), UK clock time: [sunrise, sunset] in hours.
 * PV output follows a sine arch between the two, so the day's peak lands at solar noon.
 */
export const DAYLIGHT: Array<[number, number]> = [
  [8.1, 16.1], // Jan
  [7.4, 17.2], // Feb
  [6.3, 18.1], // Mar (mostly GMT)
  [6.3, 20.1], // Apr (BST)
  [5.3, 20.9], // May
  [4.8, 21.4], // Jun
  [5.1, 21.3], // Jul
  [5.9, 20.5], // Aug
  [6.8, 19.4], // Sep
  [7.6, 18.2], // Oct (mostly BST)
  [7.3, 16.3], // Nov
  [8.0, 15.9], // Dec
];

/**
 * Hourly household load shape per occupancy profile, hour 0 = 00:00-01:00. Relative weights;
 * normalised to the day's consumption. Each hour is split evenly across its two half-hours.
 */
export const LOAD_SHAPES: Record<UsageCode, number[]> = {
  //            0    1    2    3    4    5    6    7    8    9   10   11   12   13   14   15   16   17   18   19   20   21   22   23
  home_all_day: [0.3, 0.3, 0.3, 0.3, 0.3, 0.3, 0.5, 0.8, 0.8, 0.7, 0.7, 0.7, 0.8, 0.7, 0.7, 0.7, 0.9, 1.2, 1.3, 1.2, 1.1, 0.9, 0.6, 0.4],
  half_day:     [0.3, 0.3, 0.3, 0.3, 0.3, 0.3, 0.5, 0.9, 0.9, 0.4, 0.4, 0.4, 0.4, 0.6, 0.6, 0.6, 0.8, 1.3, 1.4, 1.3, 1.1, 0.9, 0.6, 0.4],
  out_all_day:  [0.3, 0.3, 0.3, 0.3, 0.3, 0.3, 0.6, 1.0, 0.8, 0.25, 0.25, 0.25, 0.25, 0.25, 0.25, 0.25, 0.5, 1.5, 1.6, 1.4, 1.2, 1.0, 0.7, 0.4],
};

export const DEFAULTS = {
  tariff: 'flux' as TariffCode,
  usage: 'half_day' as UsageCode,
  self_use_fraction: 0.35,
  std_import: 0.26,
  dn_day: 0.3,
  dn_night: 0.15,
  inflation: 5,
  export_limit_kw: 0,
};

export const SLOTS = 48;
export const SLOT_HOURS = 0.5;

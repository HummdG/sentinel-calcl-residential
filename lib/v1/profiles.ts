// Twelve representative days (one per month) of half-hourly load and PV, in kWh per slot.
//
// Load: annual_usage × the month's usage share ÷ days, spread by the occupancy shape.
// PV:   annual_gen × the month's PV share ÷ days, spread over a sine arch from sunrise to sunset.
//
// The caller's self_use_fraction (from the OpenSolar report) then fixes how much PV the home
// uses directly. The load's timing is blended toward the PV curve (more overlap) or toward
// the dark hours (less) until annual direct use = self_use_fraction × annual_gen. Each day's
// total consumption is unchanged, so the bills still rest on the caller's annual_usage; the
// blend only decides *when* in the day it happens.

import {
  DAYLIGHT,
  DAYS_IN_MONTH,
  LOAD_SHAPES,
  PV_MONTHLY,
  SLOTS,
  SLOT_HOURS,
  USAGE_MONTHLY,
  type UsageCode,
} from './config';

export interface Day {
  month: number; // 0..11
  weight: number; // days this representative day stands for
  load: number[]; // kWh per slot
  pv: number[]; // kWh per slot
}

export interface Profiles {
  days: Day[];
  /** Direct self-use actually achieved, as a share of annual_gen (0 when annual_gen = 0). */
  selfUseApplied: number;
}

const normalise = (xs: number[]) => {
  const s = xs.reduce((a, b) => a + b, 0);
  return s > 0 ? xs.map((x) => x / s) : xs.map(() => 0);
};

function occupancyShape(usage: UsageCode): number[] {
  const hourly = LOAD_SHAPES[usage];
  return normalise(Array.from({ length: SLOTS }, (_, i) => hourly[Math.floor(i / 2)]));
}

/** Share of a day's PV in each slot: sine arch, integrated over each half-hour. */
function pvShape(month: number): number[] {
  const [rise, set] = DAYLIGHT[month];
  const len = set - rise;
  const out = Array.from({ length: SLOTS }, (_, i) => {
    const a = Math.max(i * SLOT_HOURS, rise);
    const b = Math.min((i + 1) * SLOT_HOURS, set);
    if (b <= a) return 0;
    // ∫ sin(π(t−rise)/len) dt from a to b
    return (len / Math.PI) * (Math.cos((Math.PI * (a - rise)) / len) - Math.cos((Math.PI * (b - rise)) / len));
  });
  return normalise(out);
}

const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

/**
 * blend in [-1, 1]: 0 = pure occupancy shape, +1 = load follows the PV curve,
 * −1 = load sits entirely in the hours with no PV.
 */
function blendedLoad(occ: number[], pvShp: number[], blend: number): number[] {
  if (blend === 0) return occ;
  if (blend > 0) return occ.map((o, i) => (1 - blend) * o + blend * pvShp[i]);
  const dark = normalise(pvShp.map((p) => (p === 0 ? 1 : 0)));
  const w = -blend;
  return occ.map((o, i) => (1 - w) * o + w * dark[i]);
}

function buildDays(
  annualUsage: number,
  annualGen: number,
  usage: UsageCode,
  blend: number,
): Day[] {
  const occ = occupancyShape(usage);
  const usageW = normalise(USAGE_MONTHLY);
  const pvW = normalise(PV_MONTHLY);
  return DAYS_IN_MONTH.map((days, m) => {
    const pvShp = pvShape(m);
    const dayLoad = (annualUsage * usageW[m]) / days;
    const dayPv = (annualGen * pvW[m]) / days;
    const shape = blendedLoad(occ, pvShp, blend);
    return {
      month: m,
      weight: days,
      load: shape.map((s) => s * dayLoad),
      pv: pvShp.map((s) => s * dayPv),
    };
  });
}

/** Annual kWh of PV used directly by the load (no battery). */
export function directSelfUse(days: Day[]): number {
  return sum(days.map((d) => d.weight * sum(d.load.map((l, i) => Math.min(l, d.pv[i])))));
}

export function buildProfiles(
  annualUsage: number,
  annualGen: number,
  usage: UsageCode,
  selfUseFraction: number,
): Profiles {
  if (annualGen <= 0) {
    return { days: buildDays(annualUsage, 0, usage, 0), selfUseApplied: 0 };
  }
  const target = selfUseFraction * annualGen;
  const at = (b: number) => directSelfUse(buildDays(annualUsage, annualGen, usage, b));

  let lo = -1;
  let hi = 1;
  if (at(hi) <= target) lo = hi; // the load can't absorb that much PV: take the most it can
  else if (at(lo) >= target) hi = lo;
  else {
    for (let k = 0; k < 60; k++) {
      const mid = (lo + hi) / 2;
      if (at(mid) < target) lo = mid;
      else hi = mid;
    }
  }
  const days = buildDays(annualUsage, annualGen, usage, (lo + hi) / 2);
  return { days, selfUseApplied: directSelfUse(days) / annualGen };
}

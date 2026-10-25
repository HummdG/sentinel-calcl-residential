// Half-hourly battery dispatch over one representative day.
//
// Every slot, in order: PV meets the load directly; spare PV charges the battery; in the
// tariff's cheap window the optimiser may top the battery up from the grid; the battery
// covers any remaining load; spare PV is exported up to the export limit (the rest is
// curtailed); on a tariff whose export price varies, the battery may also export in the
// best-paid slots. Whatever load is left is imported.
//
// "Self-use" is one fixed policy (no grid charging, no battery export). "Optimised" tries a
// small set of policies per day and keeps the cheapest; self-use is one of them, so the
// optimised bill can never be worse.

import { BATTERY, SLOTS, SLOT_HOURS } from './config';
import type { Day } from './profiles';
import type { SlotRates } from './tariffs';

export interface Battery {
  capacity: number; // usable kWh
  maxPerSlot: number; // kWh the inverter moves per half-hour, each way
  etaIn: number;
  etaOut: number;
}

export function makeBattery(batteryKwh: number, inverterKw: number): Battery | null {
  if (batteryKwh <= 0 || inverterKw <= 0) return null;
  const eta = Math.sqrt(BATTERY.round_trip_efficiency);
  return {
    capacity: batteryKwh * BATTERY.usable_fraction,
    maxPerSlot: inverterKw * SLOT_HOURS,
    etaIn: eta,
    etaOut: eta,
  };
}

export interface Policy {
  /** State of charge (kWh) to grid-charge up to during cheap slots. 0 = never grid charge. */
  gridTarget: number;
  /** Don't discharge during cheap slots (grid power is cheaper than stored power). */
  holdInCheap: boolean;
  /** null = battery never exports. Otherwise the share of upcoming load to keep in reserve. */
  exportReserve: number | null;
}

export const SELF_USE: Policy = { gridTarget: 0, holdInCheap: false, exportReserve: null };

export interface SlotTrace {
  load: number;
  pv: number;
  direct: number;
  pvCharge: number;
  gridCharge: number;
  discharge: number; // AC kWh delivered to the load
  batteryExport: number; // AC kWh exported from the battery
  pvExport: number;
  curtailed: number;
  import: number;
  socStart: number;
  socEnd: number;
}

export interface DayTotals {
  cost: number; // £, import cost minus export income
  import: number;
  importOutsideCheap: number;
  gridCharge: number;
  batteryExport: number;
  pvExport: number;
  curtailed: number;
}

export interface DayRun {
  totals: DayTotals;
  socEnd: number;
  trace: SlotTrace[];
}

const zero = (): DayTotals => ({
  cost: 0,
  import: 0,
  importOutsideCheap: 0,
  gridCharge: 0,
  batteryExport: 0,
  pvExport: 0,
  curtailed: 0,
});

/** Load the battery should still cover after slot i, until the next cheap window (cyclic). */
function upcomingDeficit(day: Day, rates: SlotRates): number[] {
  const deficit = day.load.map((l, i) => Math.max(0, l - day.pv[i]));
  return deficit.map((_, i) => {
    let s = 0;
    for (let k = 1; k < SLOTS; k++) {
      const j = (i + k) % SLOTS;
      if (rates.cheap[j]) break;
      s += deficit[j];
    }
    return s;
  });
}

export function runDay(
  day: Day,
  rates: SlotRates,
  batt: Battery | null,
  policy: Policy,
  exportCapPerSlot: number,
  soc0: number,
): DayRun {
  const t = zero();
  const trace: SlotTrace[] = [];
  const maxExport = Math.max(...rates.export);
  const exportVaries = maxExport > Math.min(...rates.export);
  const ahead = policy.exportReserve !== null ? upcomingDeficit(day, rates) : null;
  let soc = batt ? Math.min(Math.max(soc0, 0), batt.capacity) : 0;

  for (let i = 0; i < SLOTS; i++) {
    const load = day.load[i];
    const pv = day.pv[i];
    const socStart = soc;
    const direct = Math.min(load, pv);
    let spare = pv - direct;
    let deficit = load - direct;
    let pvCharge = 0;
    let gridCharge = 0;
    let discharge = 0;
    let batteryExport = 0;

    if (batt) {
      let room = Math.min(batt.maxPerSlot, (batt.capacity - soc) / batt.etaIn);
      pvCharge = Math.min(spare, room);
      soc += pvCharge * batt.etaIn;
      spare -= pvCharge;
      room -= pvCharge;

      if (rates.cheap[i] && soc < policy.gridTarget) {
        gridCharge = Math.max(0, Math.min(room, (policy.gridTarget - soc) / batt.etaIn));
        soc += gridCharge * batt.etaIn;
      }

      const charging = pvCharge + gridCharge;
      if (!(rates.cheap[i] && policy.holdInCheap)) {
        discharge = Math.min(deficit, batt.maxPerSlot - charging, soc * batt.etaOut);
        discharge = Math.max(0, discharge);
        soc -= discharge / batt.etaOut;
        deficit -= discharge;
      }
    }

    let capLeft = exportCapPerSlot;
    const pvExport = Math.min(spare, capLeft);
    const curtailed = spare - pvExport;
    capLeft -= pvExport;

    if (batt && ahead && exportVaries && rates.export[i] === maxExport) {
      const reserve = ((policy.exportReserve ?? 0) * ahead[i]) / batt.etaOut;
      const usedPower = pvCharge + gridCharge + discharge;
      batteryExport = Math.min(
        batt.maxPerSlot - usedPower,
        Math.max(0, soc - reserve) * batt.etaOut,
        capLeft,
      );
      batteryExport = Math.max(0, batteryExport);
      soc -= batteryExport / batt.etaOut;
    }

    const imp = deficit + gridCharge;
    t.cost += imp * rates.import[i] - (pvExport + batteryExport) * rates.export[i];
    t.import += imp;
    if (!rates.cheap[i]) t.importOutsideCheap += imp;
    t.gridCharge += gridCharge;
    t.batteryExport += batteryExport;
    t.pvExport += pvExport;
    t.curtailed += curtailed;
    trace.push({
      load,
      pv,
      direct,
      pvCharge,
      gridCharge,
      discharge,
      batteryExport,
      pvExport,
      curtailed,
      import: imp,
      socStart,
      socEnd: soc,
    });
  }
  return { totals: t, socEnd: soc, trace };
}

/**
 * Runs the day until the battery's start and end state agree, so a representative day stands
 * for a run of identical days rather than starting from an arbitrary charge.
 */
export function steadyDay(
  day: Day,
  rates: SlotRates,
  batt: Battery | null,
  policy: Policy,
  exportCapPerSlot: number,
): DayRun {
  let run = runDay(day, rates, batt, policy, exportCapPerSlot, 0);
  for (let k = 0; k < 20 && batt; k++) {
    const next = runDay(day, rates, batt, policy, exportCapPerSlot, run.socEnd);
    const settled = Math.abs(next.socEnd - run.socEnd) < 1e-9;
    run = next;
    if (settled) break;
  }
  return run;
}

/** The policies the optimiser considers for one day. Self-use is always among them. */
export function candidatePolicies(day: Day, rates: SlotRates, batt: Battery | null): Policy[] {
  const out: Policy[] = [SELF_USE];
  if (!batt) return out;
  const hasCheap = rates.cheap.some(Boolean);
  const exportVaries = Math.max(...rates.export) > Math.min(...rates.export);
  const reserves: Array<number | null> = exportVaries ? [null, 1, 0] : [null];

  // Grid-charge targets: fixed fractions of capacity, plus "fill only what today's spare PV
  // won't", which avoids buying grid power the sun would have supplied for free.
  const targets: number[] = [0];
  if (hasCheap) {
    const spare = day.pv.reduce((s, p, i) => s + Math.max(0, p - day.load[i]), 0);
    for (const f of [0.25, 0.5, 0.75, 1]) targets.push(f * batt.capacity);
    targets.push(Math.max(0, batt.capacity - spare * batt.etaIn));
  }

  for (const gridTarget of targets) {
    for (const exportReserve of reserves) {
      out.push({ gridTarget, holdInCheap: hasCheap, exportReserve });
    }
  }
  return out;
}

export interface ScenarioTotals extends DayTotals {
  monthlyCost: number[]; // £ per month
}

export interface Simulation {
  selfUse: ScenarioTotals;
  optimised: ScenarioTotals;
}

function accumulate(acc: ScenarioTotals, d: DayTotals, weight: number, month: number) {
  acc.cost += d.cost * weight;
  acc.import += d.import * weight;
  acc.importOutsideCheap += d.importOutsideCheap * weight;
  acc.gridCharge += d.gridCharge * weight;
  acc.batteryExport += d.batteryExport * weight;
  acc.pvExport += d.pvExport * weight;
  acc.curtailed += d.curtailed * weight;
  acc.monthlyCost[month] += d.cost * weight;
}

export function simulate(
  days: Day[],
  rates: SlotRates,
  batt: Battery | null,
  exportLimitKw: number,
): Simulation {
  const cap = exportLimitKw > 0 ? exportLimitKw * SLOT_HOURS : Infinity;
  const blank = (): ScenarioTotals => ({ ...zero(), monthlyCost: new Array(12).fill(0) });
  const selfUse = blank();
  const optimised = blank();

  for (const day of days) {
    const base = steadyDay(day, rates, batt, SELF_USE, cap);
    accumulate(selfUse, base.totals, day.weight, day.month);

    let best = base;
    for (const p of candidatePolicies(day, rates, batt).slice(1)) {
      const run = steadyDay(day, rates, batt, p, cap);
      if (run.totals.cost < best.totals.cost - 1e-9) best = run;
    }
    accumulate(optimised, best.totals, day.weight, day.month);
  }
  return { selfUse, optimised };
}

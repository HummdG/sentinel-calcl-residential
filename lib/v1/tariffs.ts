// Turns a tariff code plus the request's rates into per-half-hour price arrays.

import {
  ECONOMY7_NIGHT,
  FLUX_BANDS,
  GO_CHEAP,
  GO_DAY_IMPORT,
  OUTGOING_EXPORT,
  SLOTS,
  type Band,
  type TariffCode,
} from './config';

export interface SlotRates {
  /** The bands actually applied, echoed in meta.assumptions. */
  bands: Required<Band>[];
  import: number[]; // £/kWh per slot
  export: number[]; // £/kWh per slot
  cheap: boolean[]; // slot is in the grid-charging window
}

function slotOf(hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 2 + (m >= 30 ? 1 : 0);
}

/** Expands bands (which may wrap midnight) into 48 slots. Later bands win on overlap. */
function expand(bands: Required<Band>[]): SlotRates {
  const imp = new Array<number>(SLOTS).fill(NaN);
  const exp = new Array<number>(SLOTS).fill(NaN);
  const cheap = new Array<boolean>(SLOTS).fill(false);
  for (const b of bands) {
    const s = slotOf(b.start);
    const e = slotOf(b.end);
    const n = e > s ? e - s : SLOTS - s + e;
    for (let k = 0; k < n; k++) {
      const i = (s + k) % SLOTS;
      imp[i] = b.import;
      exp[i] = b.export;
      cheap[i] = b.cheap;
    }
  }
  if (imp.some(Number.isNaN)) throw new Error('tariff bands do not cover the whole day');
  return { bands, import: imp, export: exp, cheap };
}

export interface RateInputs {
  std_import: number;
  dn_day: number;
  dn_night: number;
}

export function slotRates(tariff: TariffCode, r: RateInputs): SlotRates {
  switch (tariff) {
    case 'flat':
      return expand([
        { start: '00:00', end: '00:00', import: r.std_import, export: OUTGOING_EXPORT, cheap: false },
      ]);
    case 'economy7':
      return expand([
        { start: ECONOMY7_NIGHT.end, end: ECONOMY7_NIGHT.start, import: r.dn_day, export: OUTGOING_EXPORT, cheap: false },
        { start: ECONOMY7_NIGHT.start, end: ECONOMY7_NIGHT.end, import: r.dn_night, export: OUTGOING_EXPORT, cheap: true },
      ]);
    case 'go':
      return expand([
        { start: GO_CHEAP.end, end: GO_CHEAP.start, import: GO_DAY_IMPORT, export: OUTGOING_EXPORT, cheap: false },
        { start: GO_CHEAP.start, end: GO_CHEAP.end, import: GO_CHEAP.import, export: OUTGOING_EXPORT, cheap: true },
      ]);
    case 'flux':
      return expand(FLUX_BANDS.map((b) => ({ ...b, cheap: b.cheap ?? false })));
  }
}

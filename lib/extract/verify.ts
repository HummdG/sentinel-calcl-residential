// Deterministic verification of a model's extraction. No model involved.
//
// Two independent gates:
//
//   1. Evidence grounding. The quoted span must actually appear on the page the model
//      cited. This is what stops a figure being lifted off a manufacturer datasheet and
//      presented as the installed system's rating.
//   2. Cross-field arithmetic. The figures must be consistent with each other.
//
// GATE vs WARN is a deliberate split, and it was calibrated against the four verified
// fixtures rather than guessed:
//
//   Gates are arithmetic identities that cannot be false on a correct reading, so a
//   failure means at least one figure is wrong and the fields it implicates are dropped.
//
//   Warnings are plausibility heuristics. They flag for the surveyor but never drop a
//   value, because a heuristic that fires on a correct document would do real damage.
//
// The old sanityWarnings() check "annual_usage x 0.28 < solar_savings" is the reason that
// split exists. It FAILS on the verified-correct Varey Road figures (2,064 kWh x 0.28 =
// £578 against a true £787 saving) because that system is on Octopus Flux, where savings
// come from export credit and peak/off-peak arbitrage rather than avoided import alone.
// Promoted to a gate as originally planned, it would have deleted a correct annual_usage
// on every export-heavy tariff. It is now a loose warning.

import { splitTaggedPages } from '../pdf-text';
import {
  INTERNAL_ONLY,
  NUMERIC_FIELDS,
  TEXT_FIELDS,
  type ExtractionClaims,
  type FieldName,
} from './schema';

export type FieldStatus = 'verified' | 'unverified' | 'absent';

export interface FieldProvenance {
  field: FieldName;
  value: number | string | null;
  page: number | null;
  evidence: string | null;
  status: FieldStatus;
  /** Why it is unverified, shown to the surveyor. */
  note?: string;
}

export interface VerifiedExtraction {
  values: Record<string, number | string | null>;
  provenance: FieldProvenance[];
  /** Fields with no usable value. Absent from the document or dropped by a gate. */
  missing: FieldName[];
  /** Advisory, never blocking. */
  warnings: string[];
  /** A gate failed: the caller should retry on the stronger tier. */
  escalate: boolean;
}

/** Assumed SEG export rate, £/kWh, for the payback identity only. */
const SEG_RATE = 0.055;

/**
 * Payback gate tolerance.
 *
 * River House legitimately diverges by 25.9% (a commercial system whose stated 11-year
 * payback reflects tariff detail the simple identity cannot see), so the gate must sit
 * well above that. A transposed cost. Reading £19,198 lifetime savings as the system
 * cost on Varey Road. Lands at 61%, so 50% separates the two with margin either side.
 */
const PAYBACK_GATE_PCT = 50;

function norm(s: string): string {
  return s
    .toLowerCase()
    .replace(/[£$,]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Does the model's quote actually appear on the page it cited?
 *
 * Three outcomes, and the distinction between the last two is load-bearing:
 *
 *   held         the quote is in the document.
 *   refuted      the page HAS text and the quote is not in it. The model invented it.
 *   unverifiable there is no text to check against, because the page was read as an
 *                image. Says nothing either way about the value.
 *
 * Collapsing `unverifiable` into `refuted` silently disabled the entire vision tier: a
 * scanned proposal has no text layer, so every quote failed, every value was dropped, and
 * the escalation call always returned an empty form despite the model having read the
 * pages correctly. Absence of a means to check is not evidence of a fault.
 */
type Grounding = { state: 'held' | 'refuted' | 'unverifiable'; note?: string };

function evidenceHolds(
  evidence: string | null,
  page: number | null,
  pages: Map<number, string>
): Grounding {
  // No text layer anywhere: this extraction came from page images.
  if (pages.size === 0) {
    return { state: 'unverifiable', note: 'read from the page image; no text layer to cross-check' };
  }
  if (!evidence) return { state: 'refuted', note: 'no source text quoted' };
  if (page === null) return { state: 'refuted', note: 'no page cited' };

  const body = pages.get(page);
  if (body === undefined) {
    // A page with no text inside a document that otherwise has one: a scanned insert, or
    // a page that is entirely artwork. Unverifiable rather than wrong.
    return {
      state: 'unverifiable',
      note: `page ${page} has no text layer; value read from the page image`,
    };
  }

  if (norm(body).includes(norm(evidence))) return { state: 'held' };

  // Fall back to a whole-document search: pdf.js sometimes splits a visually single row
  // across a page boundary, so an otherwise sound quote can cite the neighbouring page.
  for (const [n, text] of pages) {
    if (n !== page && norm(text).includes(norm(evidence))) {
      return { state: 'held', note: `quote found on page ${n}, not the cited page ${page}` };
    }
  }

  return { state: 'refuted', note: 'quoted text not found in the document' };
}

const num = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) ? v : null;

export function verifyExtraction(
  claims: ExtractionClaims,
  documentText: string
): VerifiedExtraction {
  const pages = splitTaggedPages(documentText);
  const provenance: FieldProvenance[] = [];
  const values: Record<string, number | string | null> = {};
  const warnings: string[] = [];

  // --- Pass 1: evidence grounding ------------------------------------------------
  for (const field of [...TEXT_FIELDS, ...NUMERIC_FIELDS] as FieldName[]) {
    const claim = claims[field];
    const raw = claim?.value ?? null;

    if (raw === null) {
      values[field] = null;
      provenance.push({
        field,
        value: null,
        page: null,
        evidence: null,
        status: 'absent',
        note: 'not stated in this document',
      });
      continue;
    }

    const check = evidenceHolds(claim.evidence, claim.page, pages);

    if (check.state === 'refuted') {
      // Keep it visible in the provenance panel so the surveyor can see what was proposed
      // and why it was rejected, but do not put it in the form.
      values[field] = null;
      provenance.push({
        field,
        value: raw,
        page: claim.page,
        evidence: claim.evidence,
        status: 'unverified',
        note: check.note,
      });
      continue;
    }

    // 'held' or 'unverifiable'. Both keep the value; the note distinguishes them, and the
    // arithmetic gates below apply either way, which is what carries the vision tier.
    values[field] = raw;
    provenance.push({
      field,
      value: raw,
      page: claim.page,
      evidence: claim.evidence,
      status: 'verified',
      note: check.note,
    });
  }

  // --- Pass 2: cross-field arithmetic --------------------------------------------
  const pv = num(values.pv_size);
  const gen = num(values.annual_gen);
  const usage = num(values.annual_usage);
  const cost = num(values.system_cost);
  const savings = num(values.solar_savings);
  const exportKwh = num(values.export_kwh);
  const exportPct = num(values.export_pct);
  const payback = num(values.os_payback);
  const lifetime = num(values.os_25yr);

  const drop = (fields: FieldName[], why: string) => {
    warnings.push(why);
    for (const f of fields) {
      values[f] = null;
      const p = provenance.find((x) => x.field === f);
      if (p && p.status === 'verified') {
        p.status = 'unverified';
        p.note = why;
      }
    }
  };

  // export_kwh is the one field that is normally a SUM rather than a printed figure: the
  // annual total appears nowhere, so the model adds up a twelve-row monthly column. Its
  // evidence is therefore a reconstruction of that column ("Jan 1, Feb 3, Mar 116, ...")
  // rather than a verbatim span, and grounding rejects it even when the total is exactly
  // right. For a computed value, agreement with an INDEPENDENT figure is stronger proof
  // than a quote anyway, so the stated export percentage is used to corroborate it.
  //
  // This ordering matters. Deriving first and asking questions later silently replaced a
  // correct 2,384 with 2,383 on Varey Road, because the percentage is rounded to a whole
  // number and cannot be more accurate than the sum it is standing in for.
  // Named for what it is, not for what it was mistaken for. The percentage on the page is
  // rounded to a whole number: Varey Road's true 2,384 kWh is 56.0150% of generation and
  // prints as "56%", which reconstructs to 2,383. Worse, "56%" could be anything from
  // 55.5% to 56.5%, a spread of 2,362-2,405 kWh. So this locates the answer to about
  // +/-1%; it is a yardstick to check a sum against, never a better source than the sum.
  // Calling it `expectedExport` is what made it look authoritative enough to substitute.
  const claimedExport = num(claims.export_kwh?.value ?? null);
  const pctUsable = exportPct !== null && gen !== null && exportPct >= 0 && exportPct <= 100;
  const pctImpliedExport = pctUsable ? (gen! * exportPct!) / 100 : null;

  if (exportKwh === null && claimedExport !== null && pctImpliedExport !== null) {
    // The model gave a total that failed grounding. Reinstate it if the percentage agrees.
    const agrees =
      pctImpliedExport === 0
        ? claimedExport === 0
        : Math.abs(claimedExport - pctImpliedExport) / pctImpliedExport <= 0.15;

    if (agrees) {
      values.export_kwh = claimedExport;
      const p = provenance.find((x) => x.field === 'export_kwh');
      if (p) {
        p.value = claimedExport;
        p.status = 'verified';
        p.note = `summed from the monthly table; corroborated by the stated ${exportPct}% export`;
      }
    }
  } else if (exportKwh === null && pctImpliedExport !== null) {
    // Nothing usable from the model: fall back to the percentage. Less accurate, and the
    // provenance says so rather than presenting it as something read off the page.
    const derived = Math.round(pctImpliedExport);
    if (derived >= 0 && derived <= gen!) {
      values.export_kwh = derived;
      const p = provenance.find((x) => x.field === 'export_kwh');
      if (p) {
        p.value = derived;
        p.status = 'verified';
        p.page = claims.export_pct?.page ?? null;
        p.evidence = claims.export_pct?.evidence ?? null;
        p.note = `estimated from the stated ${exportPct}% of ${gen} kWh generation, not read directly`;
      }
    }
  }

  // GATE: the same number read twice for two different things.
  if (cost !== null && lifetime !== null && cost > 0 && Math.abs(cost - lifetime) / cost < 0.01) {
    drop(
      ['system_cost', 'os_25yr'],
      'System cost and lifetime savings came back as the same number. One of them is misread.'
    );
  }
  // GATE: lifetime NET savings below the cost would mean the system never pays back,
  // which contradicts any stated payback period.
  else if (cost !== null && lifetime !== null && lifetime <= cost && payback !== null) {
    drop(
      ['system_cost', 'os_25yr'],
      `Lifetime net savings (£${lifetime.toLocaleString()}) are not above the system cost (£${cost.toLocaleString()}), which contradicts the stated ${payback}-year payback.`
    );
  }

  // GATE: export cannot exceed generation.
  const exp = num(values.export_kwh);
  if (exp !== null && gen !== null && exp > gen) {
    drop(
      ['export_kwh'],
      `Export to grid (${exp.toLocaleString()} kWh) exceeds total generation (${gen.toLocaleString()} kWh).`
    );
  }

  // GATE: export must agree with the stated export percentage.
  const exp2 = num(values.export_kwh);
  if (exp2 !== null && exportPct !== null && gen !== null && exportPct > 0) {
    const expected = (gen * exportPct) / 100;
    if (expected > 0 && Math.abs(exp2 - expected) / expected > 0.15) {
      drop(
        ['export_kwh'],
        `Export of ${exp2.toLocaleString()} kWh disagrees with the stated ${exportPct}% of ${gen.toLocaleString()} kWh generation (${Math.round(expected).toLocaleString()} kWh).`
      );
    }
  }

  // GATE: cost divided by annual benefit should land near the stated payback.
  if (cost !== null && savings !== null && payback !== null && payback > 0) {
    const benefit = savings + (num(values.export_kwh) ?? 0) * SEG_RATE;
    if (benefit > 0) {
      const implied = cost / benefit;
      const dev = (Math.abs(implied - payback) / payback) * 100;
      if (dev > PAYBACK_GATE_PCT) {
        drop(
          ['system_cost', 'solar_savings'],
          `System cost and year-1 saving imply a ${implied.toFixed(1)}-year payback, but the document states ${payback} years (${dev.toFixed(0)}% out). At least one is misread.`
        );
      }
    }
  }

  // --- Warnings: plausibility only, never dropped --------------------------------
  if (pv !== null && gen !== null && pv > 0) {
    const yieldPerKwp = gen / pv;
    if (yieldPerKwp < 600 || yieldPerKwp > 1300) {
      warnings.push(
        `Yield is ${Math.round(yieldPerKwp)} kWh per kWp, outside the usual UK range of 600-1300. Check PV size and annual generation.`
      );
    }
  }

  if (pv !== null && cost !== null && pv > 0) {
    const perKwp = cost / pv;
    if (perKwp < 900 || perKwp > 4500) {
      warnings.push(
        `System cost works out at £${Math.round(perKwp).toLocaleString()} per kWp, outside the usual £900-£4,500 range.`
      );
    }
  }

  // Deliberately loose. See the header note on Octopus Flux. Only a gross mismatch, of
  // the kind produced by reading grid-import-after-solar as total consumption, trips it.
  if (usage !== null && savings !== null && usage * 0.28 < savings * 0.5) {
    warnings.push(
      `Annual consumption of ${usage.toLocaleString()} kWh looks low against a £${savings.toLocaleString()} year-1 saving. Check it is total household usage, not grid import after solar.`
    );
  }

  // --- Assemble -------------------------------------------------------------------
  for (const f of INTERNAL_ONLY) delete values[f];
  const visible = provenance.filter((p) => !INTERNAL_ONLY.includes(p.field));

  const missing = visible
    .filter((p) => values[p.field] === null || values[p.field] === undefined)
    .map((p) => p.field);

  // Derived from final state rather than tracked as a flag during the passes. A flag set
  // in pass 1 stayed true even after the export_kwh derivation below had rescued the very
  // field that set it, so three of four fixtures asked for a paid escalation they did not
  // need. Reading the end state cannot go stale that way.
  const escalate = visible.some((p) => p.status === 'unverified');

  return { values, provenance: visible, missing, warnings, escalate };
}

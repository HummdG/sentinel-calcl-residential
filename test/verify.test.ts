// Verifier calibration and behaviour.
//
// The most important test here is "no gate fires on correct data". A gate that drops a
// correct value is worse than no gate at all: it sends the surveyor to type a figure the
// extractor had already read properly, and it triggers a paid escalation call for nothing.
// Every threshold in verify.ts is justified by these four documents.

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { verifyExtraction } from '../lib/extract/verify';
import { NUMERIC_FIELDS, TEXT_FIELDS, emptyClaim, type ExtractionClaims } from '../lib/extract/schema';
import { splitTaggedPages } from '../lib/pdf-text';

const FIXTURES = join(__dirname, 'fixtures');

interface Fixture {
  slug: string;
  text: string;
  expected: Record<string, number | string | null>;
  meta: Record<string, unknown>;
}

function loadFixtures(): Fixture[] {
  return readdirSync(FIXTURES)
    .filter((f) => f.endsWith('.expected.json'))
    .map((f) => {
      const slug = f.replace('.expected.json', '');
      const parsed = JSON.parse(readFileSync(join(FIXTURES, f), 'utf8'));
      return {
        slug,
        text: readFileSync(join(FIXTURES, `${slug}.txt`), 'utf8'),
        expected: parsed.fields,
        meta: parsed._meta,
      };
    });
}

const norm = (s: string) => s.toLowerCase().replace(/[£$,]/g, '').replace(/\s+/g, ' ').trim();

/**
 * Find a real span of the document containing `value`, so the synthetic claims below are
 * grounded the same way a real extraction would be.
 *
 * Not every correct answer appears verbatim, which is the point of grounding the EVIDENCE
 * rather than the value:
 *
 *   - `customer_address` is transformed. The document reads `"April Cottage", Beech Hill,
 *     Headley Down, GU35 8EQ` and the answer strips the quotes, town and postcode.
 *   - `export_kwh` is computed. 2,384 is the sum of twelve monthly rows and appears
 *     nowhere in the text.
 *
 * For those, grounding proves the model read real source text; the arithmetic gates are
 * what prove the derived number is right. The prefix fallback and the anchor map below
 * reproduce that split rather than papering over it.
 */
const EVIDENCE_ANCHORS: Partial<Record<string, RegExp>> = {
  // Summed from twelve monthly rows; the total is never printed.
  export_kwh: /^(Jan)\s+[\d,]+\s+[\d,]+/m,
  // Unit-converted: "Payback 7 years, 5 months" -> 7.42 decimal years.
  os_payback: /Payback\s+\d+\s*years?(?:,\s*\d+\s*months?)?/i,
};

function findEvidence(
  text: string,
  value: number | string,
  field?: string
): { page: number; quote: string } | null {
  const pages = splitTaggedPages(text);

  const candidates: string[] =
    typeof value === 'string'
      ? // Full value, then progressively shorter prefixes, for transformed text fields.
        [value, value.split(',')[0], value.split(/[\s,]+/).slice(0, 2).join(' '), value.split(/[\s,]+/)[0]]
      : [
          String(value),
          value.toLocaleString('en-GB'),
          // "8.0%" in the document vs a value of 8. String(8) is "8", too short to
          // match on safely, so the one-decimal form is what actually locates it.
          value.toFixed(1),
          value.toFixed(2),
          String(Math.round(value)),
          Math.round(value).toLocaleString('en-GB'),
        ];

  for (const [page, body] of pages) {
    const hay = norm(body);
    for (const c of candidates) {
      const needle = norm(c ?? '');
      if (needle.length < 2) continue;
      const i = hay.indexOf(needle);
      if (i >= 0) {
        return { page, quote: hay.slice(Math.max(0, i - 30), i + needle.length + 30) };
      }
    }
  }

  // A battery total summed from several equipment lines. Quote each line, joined by an
  // ellipsis, which is how the model quotes a sum of separate spans.
  if (field === 'battery_kwh') {
    for (const [page, body] of pages) {
      const lines = body.match(/[\d.]+\s*kWh of Battery Storage/g);
      if (lines && lines.length > 1) return { page, quote: lines.join(' ... ') };
    }
  }

  // Computed values never appear verbatim. Quote the rows they were derived from.
  const anchor = field ? EVIDENCE_ANCHORS[field] : undefined;
  if (anchor) {
    for (const [page, body] of pages) {
      const m = body.match(anchor);
      if (m) return { page, quote: m[0] };
    }
  }

  return null;
}

/** Build the claim set a perfect extraction would produce for this fixture. */
function perfectClaims(fx: Fixture): ExtractionClaims {
  const claims = {} as ExtractionClaims;
  for (const f of [...TEXT_FIELDS, ...NUMERIC_FIELDS]) {
    const v = fx.expected[f];
    if (v === null || v === undefined) {
      claims[f] = emptyClaim() as never;
      continue;
    }
    const found = findEvidence(fx.text, v, f);
    claims[f] = {
      value: v,
      page: found?.page ?? null,
      evidence: found?.quote ?? null,
    } as never;
  }
  return claims;
}

const fixtures = loadFixtures();

describe('fixture suite', () => {
  it('has fixtures to verify against', () => {
    expect(fixtures.length).toBeGreaterThanOrEqual(4);
  });
});

describe('no arithmetic gate fires on verified-correct data', () => {
  for (const fx of fixtures) {
    it(`${fx.slug} (${fx.meta.type}) produces no gate failure`, () => {
      const result = verifyExtraction(perfectClaims(fx), fx.text);

      // Any dropped field means a gate rejected a value we know to be right.
      const wronglyDropped = result.provenance.filter(
        (p) => p.status === 'unverified' && fx.expected[p.field] !== null
      );

      expect(
        wronglyDropped.map((p) => `${p.field}: ${p.note}`),
        `gates must not reject correct values in ${fx.slug}`
      ).toEqual([]);
    });
  }
});

describe('genuinely absent fields stay absent', () => {
  it('Varey Road reports inverter_kw as absent, not guessed', () => {
    const fx = fixtures.find((f) => f.slug.includes('varey-road'))!;
    const result = verifyExtraction(perfectClaims(fx), fx.text);
    const p = result.provenance.find((x) => x.field === 'inverter_kw')!;
    expect(p.status).toBe('absent');
    expect(result.missing).toContain('inverter_kw');
    expect(result.values.inverter_kw).toBeNull();
  });

  it('River House reports os_roi as absent', () => {
    const fx = fixtures.find((f) => f.slug.includes('river-house'))!;
    const result = verifyExtraction(perfectClaims(fx), fx.text);
    expect(result.provenance.find((x) => x.field === 'os_roi')!.status).toBe('absent');
  });
});

describe('a genuine zero survives as zero', () => {
  it('River House keeps export_kwh at 0 rather than treating it as missing', () => {
    const fx = fixtures.find((f) => f.slug.includes('river-house'))!;
    const result = verifyExtraction(perfectClaims(fx), fx.text);
    expect(result.values.export_kwh).toBe(0);
    expect(result.missing).not.toContain('export_kwh');
  });
});

describe('values that are computed rather than quoted', () => {
  it('accepts a summed export figure whose total appears nowhere in the document', () => {
    // Varey Road's 2,384 kWh is the sum of twelve monthly rows. Grounding proves the
    // model read the table; the export_pct cross-check proves the sum is right.
    const fx = fixtures.find((f) => f.slug.includes('varey-road'))!;
    expect(fx.text).not.toContain('2384');
    expect(fx.text).not.toContain('2,384');

    const result = verifyExtraction(perfectClaims(fx), fx.text);
    expect(result.values.export_kwh).toBe(2384);
    expect(result.provenance.find((p) => p.field === 'export_kwh')!.status).toBe('verified');
  });

  it('keeps a correct sum whose quote is a reconstruction, rather than substituting the percentage', () => {
    // The regression this exists for: Haiku returns export_kwh = 2384 (exactly right) but
    // quotes the monthly column as "Jan 1, Feb 3, Mar 116, ..." rather than the row-wise
    // form the document actually stores. Grounding rejected the quote, and the fallback
    // then replaced a correct 2,384 with 2,383 derived from a percentage rounded to a
    // whole number. The verifier was degrading a correct extraction.
    const fx = fixtures.find((f) => f.slug.includes('varey-road'))!;
    const claims = perfectClaims(fx);
    claims.export_kwh = {
      value: 2384,
      page: 9,
      evidence: 'Electricity Exported after new system (kWh): Jan 1, Feb 3, Mar 116, Apr 273',
    } as never;

    const result = verifyExtraction(claims, fx.text);

    expect(result.values.export_kwh).toBe(2384);
    const p = result.provenance.find((x) => x.field === 'export_kwh')!;
    expect(p.status).toBe('verified');
    expect(p.note).toMatch(/corroborated by the stated 56%/);
    expect(result.escalate).toBe(false);
  });

  it('falls back to the percentage only when the model supplies no total at all', () => {
    const fx = fixtures.find((f) => f.slug.includes('varey-road'))!;
    const claims = perfectClaims(fx);
    claims.export_kwh = { value: null, page: 0, evidence: '' } as never;

    const result = verifyExtraction(claims, fx.text);

    // 56% of 4,256 kWh. Close to the true 2,384 but not equal, so the provenance must say
    // it was estimated rather than read.
    expect(result.values.export_kwh).toBe(2383);
    const p = result.provenance.find((x) => x.field === 'export_kwh')!;
    expect(p.note).toMatch(/estimated from the stated 56%/);
    expect(p.note).toMatch(/not read directly/);
  });

  it('rejects a summed export figure that contradicts the stated export percentage', () => {
    const fx = fixtures.find((f) => f.slug.includes('varey-road'))!;
    const claims = perfectClaims(fx);
    // 56% of 4,256 kWh is ~2,383. Claiming 1,200 is a plausible-looking mis-sum.
    claims.export_kwh = { ...claims.export_kwh, value: 1200 } as never;

    const result = verifyExtraction(claims, fx.text);
    expect(result.values.export_kwh).toBeNull();
    expect(result.escalate).toBe(true);
    expect(result.warnings.join(' ')).toMatch(/disagrees with the stated 56%/);
  });
});

describe('evidence grounding', () => {
  const fx = () => fixtures.find((f) => f.slug.includes('varey-road'))!;

  it('rejects a value whose quote is not in the document', () => {
    const claims = perfectClaims(fx());
    claims.inverter_kw = { value: 10, page: 18, evidence: '10 kW of Inverter Power' } as never;

    const result = verifyExtraction(claims, fx().text);
    const p = result.provenance.find((x) => x.field === 'inverter_kw')!;
    expect(p.status).toBe('unverified');
    expect(result.values.inverter_kw).toBeNull();
    expect(result.escalate).toBe(true);
  });

  it('rejects a value with no quote at all', () => {
    const claims = perfectClaims(fx());
    claims.inverter_kw = { value: 5, page: null, evidence: null } as never;

    const result = verifyExtraction(claims, fx().text);
    expect(result.provenance.find((x) => x.field === 'inverter_kw')!.status).toBe('unverified');
    expect(result.escalate).toBe(true);
  });
});

describe('the vision tier, where there is no text to ground against', () => {
  // The regression this exists for: a scanned proposal has no text layer, so every quote
  // failed grounding, every value was dropped, and the escalation call returned an empty
  // form despite Opus having read the pages correctly. Measured 1/13 before the fix and
  // 13/13 after, on this document rendered to images with the text layer withheld.
  const fx = () => fixtures.find((f) => f.slug.includes('varey-road'))!;

  it('keeps values when the document has no text layer at all', () => {
    const claims = perfectClaims(fx());
    const result = verifyExtraction(claims, ''); // images only: nothing to check against

    expect(result.values.pv_size).toBe(4.6);
    expect(result.values.system_cost).toBe(11319.3);
    expect(result.values.customer_name).toBe('Manish Shrestha');
    expect(result.missing).not.toContain('pv_size');
  });

  it('says plainly that the value could not be cross-checked', () => {
    const result = verifyExtraction(perfectClaims(fx()), '');
    const p = result.provenance.find((x) => x.field === 'pv_size')!;
    expect(p.status).toBe('verified');
    expect(p.note).toMatch(/no text layer to cross-check/);
  });

  it('does not ask for an escalation it has already had', () => {
    // Escalation is derived from rejected fields. If a missing text layer counted as a
    // rejection, the vision tier would loop asking to escalate to itself.
    expect(verifyExtraction(perfectClaims(fx()), '').escalate).toBe(false);
  });

  it('still refutes an invented value when the page DOES have text', () => {
    // The distinction must not leak: unverifiable is not a licence to accept anything.
    const claims = perfectClaims(fx());
    claims.inverter_kw = { value: 10, page: 18, evidence: '10 kW of Inverter Power' } as never;

    const result = verifyExtraction(claims, fx().text);
    expect(result.values.inverter_kw).toBeNull();
    expect(result.provenance.find((x) => x.field === 'inverter_kw')!.note).toMatch(
      /not found in the document/
    );
  });
});

describe('arithmetic gates catch the real historical failures', () => {
  const fx = () => fixtures.find((f) => f.slug.includes('varey-road'))!;

  it('catches lifetime savings read as the system cost', () => {
    // The documented incident: £19,198 "Estimated net savings" landing in system_cost on
    // an £11,319 system, from the "A - B = C" block on page 11.
    const claims = perfectClaims(fx());
    const swapped = findEvidence(fx().text, 19198)!;
    claims.system_cost = { value: 19198, page: swapped.page, evidence: swapped.quote } as never;

    const result = verifyExtraction(claims, fx().text);
    expect(result.escalate).toBe(true);
    expect(result.values.system_cost).toBeNull();
    expect(result.warnings.join(' ')).toMatch(/payback/i);
  });

  it('catches the same number appearing as both cost and lifetime savings', () => {
    const claims = perfectClaims(fx());
    const ev = findEvidence(fx().text, 19198)!;
    claims.system_cost = { value: 19198, page: ev.page, evidence: ev.quote } as never;
    claims.os_25yr = { value: 19198, page: ev.page, evidence: ev.quote } as never;

    const result = verifyExtraction(claims, fx().text);
    expect(result.escalate).toBe(true);
    expect(result.warnings.join(' ')).toMatch(/same number/i);
  });

  it('catches export exceeding generation', () => {
    const claims = perfectClaims(fx());
    const ev = findEvidence(fx().text, 4256)!;
    claims.export_kwh = { value: 99999, page: ev.page, evidence: ev.quote } as never;

    const result = verifyExtraction(claims, fx().text);
    expect(result.values.export_kwh).toBeNull();
    expect(result.escalate).toBe(true);
  });

  it('does not treat export without generation as a contradiction', () => {
    // A battery-only quote states no generation and a real export figure from
    // grid-charged discharge. "Export exceeds generation" is an arithmetic identity only
    // where there is generation to exceed; applied to zero it deleted a correctly read
    // export on every such document and billed an escalation to re-read it.
    //
    // The gate above still fires whenever generation is genuinely stated, which is the
    // case it was written for.
    const claims = perfectClaims(fx());
    claims.annual_gen = { ...claims.annual_gen, value: 0 } as never;
    claims.pv_size = { ...claims.pv_size, value: 0 } as never;

    const result = verifyExtraction(claims, fx().text);

    expect(result.values.export_kwh).toBe(2384);
    expect(result.provenance.find((p) => p.field === 'export_kwh')!.status).toBe('verified');
    expect(result.missing).not.toContain('export_kwh');
    expect(result.escalate).toBe(false);
  });
});

describe('Murray Road: a large battery on Flux', () => {
  const fx = () => fixtures.find((f) => f.slug.includes('murray-road'))!;

  it('accepts a battery total summed from two lines and quoted with an ellipsis', () => {
    // The model read 27.96 correctly (23.3 + 4.66) and quoted both lines joined by "...".
    // Grounding used to look for that joined string as one span and rejected it.
    const claims = perfectClaims(fx());
    claims.battery_kwh = {
      value: 27.96,
      page: 4,
      evidence: '23.3kWh of Battery Storage ... 4.66kWh of Battery Storage',
    } as never;

    const result = verifyExtraction(claims, fx().text);
    expect(result.values.battery_kwh).toBe(27.96);
    expect(result.provenance.find((p) => p.field === 'battery_kwh')!.status).toBe('verified');
  });

  it('still refutes an ellipsis quote when one fragment is invented', () => {
    const claims = perfectClaims(fx());
    claims.battery_kwh = {
      value: 33.3,
      page: 4,
      evidence: '23.3kWh of Battery Storage ... 10kWh of Battery Storage',
    } as never;

    const result = verifyExtraction(claims, fx().text);
    expect(result.values.battery_kwh).toBeNull();
  });

  it('keeps an export above generation when the stated percentage says so', () => {
    // 5,809 kWh exported from 1,777 kWh generated, and the proposal prints "327% Export
    // to grid". The battery exports grid-charged energy; it is not a misread column.
    const result = verifyExtraction(perfectClaims(fx()), fx().text);

    expect(result.values.export_kwh).toBe(5809);
    expect(result.provenance.find((p) => p.field === 'export_kwh')!.status).toBe('verified');
    expect(result.warnings.join(' ')).toMatch(/as the proposal states \(327%\)/);
    expect(result.escalate).toBe(false);
  });

  it('sums the monthly export figures itself rather than trusting the model addition', () => {
    // Haiku transcribed the column but returned 5,418 as its total. Each monthly figure is
    // in the document, so their sum, 5,809, replaces it.
    const claims = perfectClaims(fx());
    claims.export_kwh = { ...claims.export_kwh, value: 5418 } as never;
    claims.export_monthly = [362, 332, 429, 482, 612, 615, 650, 626, 516, 447, 380, 358];

    const result = verifyExtraction(claims, fx().text);
    expect(result.values.export_kwh).toBe(5809);
    expect(result.provenance.find((p) => p.field === 'export_kwh')!.note).toMatch(
      /model's own total was 5,418/
    );
  });

  it('ignores monthly figures that are not in the document', () => {
    const claims = perfectClaims(fx());
    claims.export_monthly = [999, 332, 429, 482, 612, 615, 650, 626, 516, 447, 380, 358];

    const result = verifyExtraction(claims, fx().text);
    expect(result.values.export_kwh).toBe(5809); // the model's own (correct) total stands
    expect(result.provenance.find((p) => p.field === 'export_kwh')!.note ?? '').not.toMatch(
      /summed from the twelve/
    );
  });

  it('still drops an export above generation that nothing corroborates', () => {
    const claims = perfectClaims(fx());
    claims.export_pct = { value: null, page: 0, evidence: '' } as never;

    const result = verifyExtraction(claims, fx().text);
    expect(result.values.export_kwh).toBeNull();
    expect(result.escalate).toBe(true);
  });
});

describe('the Octopus Flux regression', () => {
  it('does not drop annual_usage on an export-heavy tariff', () => {
    // Varey Road: usage 2,064 kWh x 28p = £578 against a true £787 saving. The original
    // sanityWarnings check treated that as an error; it is normal on Flux, where export
    // credit and peak/off-peak arbitrage make up the difference.
    const fx = fixtures.find((f) => f.slug.includes('varey-road'))!;
    const result = verifyExtraction(perfectClaims(fx), fx.text);

    expect(result.values.annual_usage).toBe(2064);
    expect(result.values.solar_savings).toBe(787);
    expect(result.provenance.find((p) => p.field === 'annual_usage')!.status).toBe('verified');
  });
});

describe('quotes from a model reading the PDF as laid out', () => {
  // When the model reads the PDF itself it quotes the page in visual order. A tile that
  // pdf.js linearises as "£79,441" above "Estimated Net Savings" is quoted label-first,
  // and "33.75 kW" comes back as "33.75kW". These are the quotes Claude Haiku 4.5 gave
  // on the real proposals, and all of them were rejected before grounding allowed for it.
  const ground = (slug: string, field: keyof ExtractionClaims, value: number, page: number, evidence: string) => {
    const fx = fixtures.find((f) => f.slug.includes(slug))!;
    const claims = perfectClaims(fx);
    claims[field] = { value, page, evidence } as never;
    return verifyExtraction(claims, fx.text).provenance.find((p) => p.field === field)!;
  };

  it('accepts a label quoted before a value printed above it', () => {
    expect(ground('april-cottage', 'os_25yr', 79441, 11, 'Estimated Net Savings £79,441').status).toBe('verified');
    expect(ground('april-cottage', 'os_roi', 15.3, 11, 'Rate of Return on Investment 15.3%').status).toBe('verified');
  });

  it('accepts a figure quoted without the space pdf.js puts before its unit', () => {
    expect(ground('river-house', 'pv_size', 33.75, 3, '33.75kW\nSystem Size').status).toBe('verified');
    expect(ground('river-house', 'annual_gen', 28087, 3, '28,087kWh\nEstimated Annual\nSolar Generation').status).toBe('verified');
  });

  it('still refutes a figure that is not on the page', () => {
    expect(ground('april-cottage', 'os_25yr', 97441, 11, 'Estimated Net Savings £97,441').status).toBe('unverified');
    expect(ground('river-house', 'pv_size', 43.75, 3, '43.75kW\nSystem Size').status).toBe('unverified');
  });

  it('does not ground a figure on the tail of a longer one', () => {
    // "3.75" is inside "33.75" on that page; it must not count as printed.
    expect(ground('river-house', 'pv_size', 3.75, 3, '3.75kW System Size').status).toBe('unverified');
  });
});

describe('quotes of a cashflow-table cell', () => {
  it('accepts year, column header and value quoted together', () => {
    // pdf.js breaks the header over four lines and prints the row as bare numbers.
    const fx = fixtures.find((f) => f.slug.includes('blackberry'))!;
    const claims = perfectClaims(fx);
    claims.solar_savings = {
      value: 1443,
      page: 11,
      evidence: '2026 Annual Savings (from new system) (£) 1,443',
    } as never;
    const p = verifyExtraction(claims, fx.text).provenance.find((x) => x.field === 'solar_savings')!;
    expect(p.status).toBe('verified');
  });

  it('does not ground a figure by gluing neighbouring cells together', () => {
    // The row reads "-229 1,443". Joined up that would contain "2291443", so "2291" must
    // not be found just because spacing was ignored.
    const fx = fixtures.find((f) => f.slug.includes('blackberry'))!;
    const claims = perfectClaims(fx);
    claims.solar_savings = { value: 2291, page: 11, evidence: 'Annual Savings 2,291' } as never;
    const p = verifyExtraction(claims, fx.text).provenance.find((x) => x.field === 'solar_savings')!;
    expect(p.status).toBe('unverified');
  });
});

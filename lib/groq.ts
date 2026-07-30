// SERVER-ONLY. Ports includes/class-pdf-parser.php's Groq integration:
// prompt, prepare_prompt_text (head+tail fit), the Groq call, response cleanup,
// and validate_fields. PDF text is extracted client-side (see lib/pdf-extract.ts)
// and page-tagged "=== PAGE n ===", so this module receives text, never a binary.

import { getGroqConfig } from './config';
import type { ExtractedFields } from './types';

const GROQ_ENDPOINT = 'https://api.groq.com/openai/v1/chat/completions';

const NUMERIC_FIELDS = [
  'pv_size',
  'battery_kwh',
  'inverter_kw',
  'annual_gen',
  'annual_usage',
  'system_cost',
  'solar_savings',
  'export_kwh',
  'export_pct',
  'os_payback',
  'os_25yr',
  'os_roi',
] as const;

const TEXT_FIELDS = ['customer_name', 'customer_address'] as const;

const PROMPT = `You are extracting structured data from a UK residential solar PV and battery system proposal or quote. It may have been produced by OpenSolar, EasyPV, or another vendor's software, so the layout, section names, wording and which figures are shown all vary from document to document. Do not assume any specific template.

Return ONLY a single valid JSON object with exactly these keys and no others. No markdown, no code fences, no explanation, no backticks.

{"customer_name":null,"customer_address":null,"pv_size":null,"battery_kwh":null,"inverter_kw":null,"annual_gen":null,"annual_usage":null,"system_cost":null,"solar_savings":null,"export_kwh":null,"export_pct":null,"os_payback":null,"os_25yr":null,"os_roi":null}

General rules:
- Identify each value by what it MEANS, not by matching an exact label. The example labels below are common phrasings only — they are NOT exhaustive; the document may use different wording or place the figure anywhere.
- If a value is genuinely not present in the document, or you are not confident, return null for that key. Never guess, never substitute 0, and never invent a value.
- Numeric fields must be plain numbers: no currency symbols, no thousands separators, no units, no % sign. A percentage like "11.9%" becomes 11.9 (not 0.119). If a value is written as a sum or as a monthly series, add it up yourself and return the single resulting number.
- LABEL/VALUE ORDER IS NOT RELIABLE. The text you receive is a linearisation of a graphical page, and many vendors (OpenSolar especially) render a big number ABOVE its caption. So the text can read "£19,198 / Estimated Net Savings / £11,319 / Total System Price", where each number belongs to the label BELOW it, not above it. Never assume the number after a label belongs to it. For every field, look at the number immediately BEFORE the label as well as the one immediately AFTER, and choose the one that is consistent with the rest of the document. The SAME document may use value-above-label in summary tiles and label-then-value in price tables — resolve each occurrence independently on its own evidence.
- SANITY-CHECK YOURSELF BEFORE ANSWERING. system_cost divided by (solar_savings plus any export/SEG income) should land near os_payback. If your candidate numbers imply a payback wildly different from the payback the document states, you have mis-assigned at least one of them — go back and re-read that part of the document.

Field definitions:
- customer_name: the customer/homeowner the proposal is addressed to. Usually near the top after "For:", "Prepared for:", "Client:", or in a "Proposal for <name>" heading. Use the fullest form of the name available. null if absent.
- customer_address: the house name/number and street of the installation address only — exclude town, county and postcode. E.g. from "1 Blackberry Drive, Haywards Heath, RH16 2GF" return "1 Blackberry Drive". If the property has a name keep it, e.g. from "April Cottage, Beech Hill, Headley Down, GU35 8EQ" return "April Cottage, Beech Hill". null if absent.
- pv_size: total installed solar PV array capacity in kWp (the DC panel/module rating, NOT the inverter AC rating). Example labels: "System Size", "kWp", "Total Module Power", "Installed capacity of PV system", "Array size". If given only in watts-peak (e.g. 4400 Wp) convert to kWp (4.4). null if absent.
- battery_kwh: the TOTAL rated/installed battery storage capacity of the WHOLE system in kWh. If the document states a system total (e.g. "32.62kWh of Battery Storage", "20.48kWh of Battery Storage", "kWh Total"), that total IS the answer — return it as-is and do NOT also add the individual modules to it. Only when no total is stated anywhere should you multiply the module count by the per-module capacity yourself (e.g. "7 x FE-HV-EQS-4800" where each module is 4.66kWh -> 32.62). These documents also contain SMALLER battery-related figures, and none of them is the answer: (a) "Assumed usable capacity of electricity energy storage device" / "usable capacity" — a derated MCS figure, always less than the rated total; (b) a per-module capacity printed on a product datasheet page (e.g. "4.66kWh capacity" describing ONE module of seven) — never mistake one module for the system; (c) "EESS capacity not used for self-consumption"; (d) product-range marketing such as "Scalable from 64.28kWh to 241.05 kWh". When several candidates remain, prefer the one explicitly described as the installed system's storage, not a component or a derated figure. null only if the system genuinely has no battery.
- inverter_kw: total inverter rated AC power in kW. Example labels: "kW of Inverter Power", "Inverter Power Rating", or an inverter product name followed by a kW figure (e.g. "SolarEdge SE5K" -> 5.0, "Solis 3.6kW" -> 3.6, "GivEnergy 5.0kW" -> 5.0), or an "Inverter" row in an equipment/components table. If multiple inverters are listed, sum their rated outputs. null if absent.
- annual_gen: estimated annual solar generation/output for the whole system in kWh per year. Example labels: "Estimated annual output", "Estimated Annual Solar Generation", "kWh per year", "Annual yield". null if absent.
- annual_usage: the household's TOTAL annual electricity consumption in kWh per year — everything the home uses, however it is supplied. This is NOT what the system generates, and it is NOT the reduced amount still bought from the grid after solar. Ignore columns/labels meaning grid import after solar ("Electricity purchased from grid", "Grid import", "Energy bought"), which are smaller than total consumption. Example labels: "Assumed annual electricity consumption", "Annual consumption", "Current usage", "Household demand". null if absent.
- system_cost: the one-off total upfront cash price to purchase the whole system outright, in GBP. Never a monthly/financed instalment or a deposit. If both a cash price and a finance total are shown, use the cash price. If shown both excluding and including VAT, use the headline total price. Example labels: "Total System Price", "Cash Price", "Purchase Price", "Net System Cost", "Total Investment", "You pay". This is a PRICE YOU PAY — it must never be a savings, benefit or return figure. Beware the common "Net Financial Impact" block of the form "Utility Bill Savings − Net System Cost = Estimated Net Savings": there the system cost is the SUBTRAHEND (the middle number, the one being taken away), never the result on the right. If two candidates remain, the system cost is the SMALLER of a cost-vs-lifetime-savings pair. null if absent.
- solar_savings: the year-1 (first year) annual bill saving in GBP. In a year-by-year financial table use ONLY the first data row (earliest year, e.g. 2026), the annual-saving column — NOT a cumulative total and NOT a later year. Such tables often lose their headers in linearisation (a header like "Annual Savings (from new system) (£)" may be shredded across many separate lines, far from the data). When that happens, identify the annual-saving column by magnitude and behaviour instead: in the first data row it is a modest positive number, it grows only gradually in later rows, and it is far smaller than the cumulative-cashflow columns (which start large and negative, often shown in brackets, and climb across the table). Never take a cumulative, a bracketed/negative cashflow, or a kWh column. Example labels: "Annual Savings (from new system)", "Estimated Annual Electricity Bill Savings", "Year 1 saving". null if absent.
- export_kwh: total annual electricity exported to the grid in kWh. If only monthly "Electricity Exported" values are given, sum them into one annual integer (return e.g. 5926, not "708+1060+..."). If a precomputed annual total exists, use it. null if absent.
- export_pct: the percentage of generation exported to the grid, as a plain number (e.g. "52% Export to grid" -> 52, "Export to Grid: 48%" -> 48). null if absent.
- os_payback: the SIMPLE payback period in decimal years (NOT the discounted payback, which is longer). Convert "X years, Y months" to decimal (9 years 8 months -> 9.67; 7 years -> 7.0). Example labels: "Payback", "Payback period". null if absent.
- os_25yr: the estimated NET savings over the whole system lifetime (typically 25 years) in GBP — i.e. total lifetime bill savings AFTER the system cost has been subtracted. When a document shows both a gross/total bill-savings figure and a net figure, choose the NET (smaller) one. It may appear as the result of "lifetime bill savings - system cost", or as the final-year "Cumulative" value of a lifetime cashflow table. Example labels: "Estimated Net Savings", "Estimated net savings over system lifetime", "Net lifetime benefit". Do NOT use "Total Bill Savings" or "Lifetime Bill Savings" (the larger, gross figure). null if absent.
- os_roi: the return on investment as a plain percentage number (e.g. "11.9%" -> 11.9, not 0.119). Example labels: "Rate of Return", "Rate of Return on Investment", "Annual Return", "Return on Investment", "ROI". null if absent.

Return only the JSON object, nothing else.

Document text:`;

export async function extractFields(pdfText: string): Promise<ValidatedExtraction> {
  const cfg = getGroqConfig();
  if (!cfg.apiKey) {
    throw new Error('Groq API key is not configured (set GROQ_API_KEY).');
  }

  const promptText = preparePromptText(pdfText, cfg.maxChars);

  const body = {
    model: cfg.model,
    messages: [{ role: 'user', content: PROMPT + '\n\n' + promptText }],
    temperature: 0,
    max_tokens: 1024,
  };

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 55000);
  let response: Response;
  try {
    response = await fetch(GROQ_ENDPOINT, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + cfg.apiKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (e) {
    throw new Error(
      'Groq API request failed: ' + (e instanceof Error ? e.message : String(e))
    );
  } finally {
    clearTimeout(timeout);
  }

  if (response.status !== 200) {
    const raw = await response.text();
    let msg = raw.slice(0, 200);
    try {
      const err = JSON.parse(raw);
      msg = err?.error?.message ?? msg;
    } catch {
      /* keep raw slice */
    }
    throw new Error('Groq API returned HTTP ' + response.status + ': ' + msg);
  }

  const decoded = (await response.json()) as {
    choices?: { message?: { content?: string } }[];
  };
  const content = decoded?.choices?.[0]?.message?.content;
  if (typeof content !== 'string') {
    throw new Error('Unexpected Groq API response structure.');
  }

  const parsed = parseModelJson(content);
  return validateFields(parsed);
}

// Fit the extracted text within the character budget: documents shorter than the
// cap are sent whole; longer ones keep a head (early spec pages) and tail (late
// financial pages), dropping the middle, preferring "=== PAGE n ===" boundaries.
function preparePromptText(text: string, maxChars: number): string {
  const len = text.length;
  if (len <= maxChars) return text;

  const marker = '\n\n=== [middle pages omitted to fit length limit] ===\n\n';
  const headBudget = Math.floor(maxChars * 0.7);
  let tailBudget = maxChars - headBudget - marker.length;
  if (tailBudget < 0) tailBudget = 0;

  // Split into page blocks, keeping each "=== PAGE n ===" marker with its page.
  const blocks = text.split(/(?=^=== PAGE \d+ ===$)/m).filter((b) => b !== '');

  if (blocks.length < 2) {
    return text.slice(0, headBudget) + marker + text.slice(len - tailBudget);
  }

  const count = blocks.length;

  let head = '';
  let i = 0;
  for (; i < count; i++) {
    if (head !== '' && head.length + blocks[i].length > headBudget) break;
    head += blocks[i];
  }

  let tail = '';
  for (let j = count - 1; j >= i; j--) {
    if (tail !== '' && tail.length + blocks[j].length > tailBudget) break;
    tail = blocks[j] + tail;
  }

  return head.replace(/\s+$/, '') + marker + tail.replace(/^\s+/, '');
}

function parseModelJson(raw: string): Record<string, unknown> {
  let content = raw.trim();

  // Strip markdown code fences in all common forms.
  content = content.replace(/^```(?:json)?\s*\n?/i, '');
  content = content.replace(/\n?```\s*$/i, '');
  content = content.trim();

  // Evaluate any "a+b+c" sums the LLM emitted instead of a computed number.
  content = content.replace(/(:\s*)([\d.]+(?:\s*\+\s*[\d.]+)+)/g, (_m, p1, p2) => {
    const sum = String(p2)
      .split(/\s*\+\s*/)
      .reduce((acc: number, n: string) => acc + (Number.parseFloat(n) || 0), 0);
    return p1 + sum;
  });

  let parsed: unknown = null;
  try {
    parsed = JSON.parse(content);
  } catch {
    parsed = null;
  }

  // If still not valid JSON, extract the first {...} block.
  if (parsed === null || typeof parsed !== 'object') {
    const match = content.match(/\{[\s\S]*\}/);
    if (match) {
      try {
        parsed = JSON.parse(match[0]);
      } catch {
        parsed = null;
      }
    }
  }

  if (parsed === null || typeof parsed !== 'object') {
    throw new Error('LLM returned invalid JSON: ' + content.slice(0, 300));
  }

  return parsed as Record<string, unknown>;
}

function sanitizeText(value: unknown): string {
  return String(value ?? '')
    .replace(/<[^>]*>/g, '')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function parsePayback(raw: unknown): number {
  if (typeof raw === 'number' && Number.isFinite(raw)) return Math.max(0, raw);
  const s = String(raw ?? '');
  const m = s.match(/(\d+(?:\.\d+)?)\s*years?\s*(?:(\d+(?:\.\d+)?)\s*months?)?/i);
  if (m) {
    return Number.parseFloat(m[1]) + (m[2] ? Number.parseFloat(m[2]) / 12 : 0);
  }
  const n = Number.parseFloat(s);
  return Number.isFinite(n) ? Math.max(0, n) : 0;
}

export interface ValidatedExtraction {
  fields: ExtractedFields;
  missing: string[];
  warnings: string[];
}

function validateFields(raw: Record<string, unknown>): ValidatedExtraction {
  const fields: Record<string, number | string> = {};
  let missing: string[] = [];

  for (const key of NUMERIC_FIELDS) {
    const rawVal = raw[key] ?? null;
    let val: number;
    if (key === 'os_payback') {
      val = parsePayback(rawVal);
    } else {
      const n = Number.parseFloat(String(rawVal));
      val = Number.isFinite(n) ? n : 0;
    }
    fields[key] = val >= 0 ? val : 0;

    // The prompt asks for null when the model can't find a value, and null coerces to 0 —
    // indistinguishable downstream from a genuine zero. Recording the difference is what
    // lets the UI mark the field as "not found" rather than leave whatever was in it
    // (which is how the demo default £3,733 reached a customer-facing report).
    if (rawVal === null || rawVal === '' || (fields[key] as number) <= 0) {
      missing.push(key);
    }
  }

  for (const key of TEXT_FIELDS) {
    fields[key] = raw[key] != null ? sanitizeText(raw[key]) : '';
    if (fields[key] === '') missing.push(key);
  }

  // Derive annual export kWh from an export percentage when the kWh is absent.
  if (
    (fields.export_kwh as number) <= 0 &&
    (fields.export_pct as number) > 0 &&
    (fields.export_pct as number) <= 100 &&
    (fields.annual_gen as number) > 0
  ) {
    const derived = Math.round(
      ((fields.annual_gen as number) * (fields.export_pct as number)) / 100
    );
    if (derived > 0 && derived < (fields.annual_gen as number)) {
      fields.export_kwh = derived;
      missing = missing.filter((k) => k !== 'export_kwh');
    }
  }
  missing = missing.filter((k) => k !== 'export_pct');

  const out: ExtractedFields = {
    customer_name: fields.customer_name as string,
    customer_address: fields.customer_address as string,
    pv_size: fields.pv_size as number,
    battery_kwh: fields.battery_kwh as number,
    inverter_kw: fields.inverter_kw as number,
    annual_gen: fields.annual_gen as number,
    annual_usage: fields.annual_usage as number,
    system_cost: fields.system_cost as number,
    solar_savings: fields.solar_savings as number,
    export_kwh: fields.export_kwh as number,
    os_payback: fields.os_payback as number,
    os_25yr: fields.os_25yr as number,
    os_roi: fields.os_roi as number,
  };

  return { fields: out, missing, warnings: sanityWarnings(out) };
}

const gb = (n: number) => Math.round(n).toLocaleString('en-GB');

/**
 * Cross-field plausibility checks on the extracted values.
 *
 * These FLAG, they never rewrite. An earlier version silently transposed system_cost and
 * os_25yr when system_cost exceeded £100k, which both mis-fired on genuinely expensive
 * installs and — because it only triggered above £100k — sailed straight past the
 * real-world failure it was meant to catch: a £19,198 lifetime-savings figure landing in
 * system_cost on an £11,319 system. Silently rewriting a number the surveyor never sees is
 * worse than telling them to look at it.
 */
export function sanityWarnings(f: ExtractedFields): string[] {
  const w: string[] = [];
  const { system_cost: cost, os_25yr: net25, solar_savings: saving } = f;
  const { os_payback: payback, pv_size: pv, annual_gen: gen } = f;
  const { annual_usage: usage, export_kwh: exportKwh } = f;

  // 1. The same number for both is the signature of a value/label mis-pairing in a
  //    "savings − cost = net savings" block.
  if (cost > 0 && net25 > 0 && Math.abs(cost - net25) <= Math.max(1, cost * 0.01)) {
    w.push(
      `System cost and 25-year net savings were both read as £${gb(cost)} — one of them is wrong. Check the proposal: in a "bill savings − system cost = net savings" block the system cost is the middle figure, not the result.`
    );
  } else if (cost > 0 && net25 > 0 && net25 <= cost) {
    // 2. A proposal a customer would be shown essentially always nets out positive over
    //    25 years; the reverse suggests one of the two figures is mis-read.
    w.push(
      `25-year net savings (£${gb(net25)}) is not greater than the system cost (£${gb(cost)}) — check both figures.`
    );
  }

  // 3. The proposal states its own payback. If the extracted numbers imply a very
  //    different one, at least one of cost/saving/payback is mis-assigned. Needs a real
  //    saving to be meaningful — a missing one is already reported as such.
  const annualBenefit = saving + exportKwh * 0.055; // SEG baseline, cross-check only
  if (cost > 0 && payback > 0 && saving > 0) {
    const implied = cost / annualBenefit;
    if (Math.abs(implied - payback) > payback * 0.4) {
      w.push(
        `The extracted figures imply a payback of about ${implied.toFixed(1)} years, but the proposal states ${payback.toFixed(1)} years. Check the system cost (£${gb(cost)}) and the year-1 saving (£${gb(saving)}).`
      );
    }
  }

  // 4. Cost per kWp — wide band, because a large battery legitimately pushes it up.
  if (cost > 0 && pv > 0) {
    const perKwp = cost / pv;
    if (perKwp < 900 || perKwp > 4500) {
      w.push(
        `Cost per kWp works out at £${gb(perKwp)} (£${gb(cost)} over ${pv.toFixed(2)}kWp), which is outside the normal range — check the system cost and PV size.`
      );
    }
  }

  // 5. Total consumption must be able to support the claimed saving. When it can't, the
  //    extracted figure is usually grid import after solar rather than total household
  //    demand — and the bill-savings cap in the calculator will silently swallow the
  //    Sentinel uplift, making the report look wrong for no visible reason. 28p is the
  //    standard-tariff default.
  if (usage > 0 && saving > 0 && usage * 0.28 < saving) {
    w.push(
      `Annual consumption (${gb(usage)} kWh) implies a total electricity bill of about £${gb(usage * 0.28)}, which is below the stated year-1 saving of £${gb(saving)}. This is usually a grid-import figure rather than TOTAL household consumption — correct it, or the Sentinel bill uplift will be capped away.`
    );
  }

  // 6. UK residential yield sits roughly 600–1,300 kWh per kWp installed.
  if (gen > 0 && pv > 0) {
    const yieldPerKwp = gen / pv;
    if (yieldPerKwp < 600 || yieldPerKwp > 1300) {
      w.push(
        `Annual generation of ${gb(gen)} kWh from ${pv.toFixed(2)}kWp is ${gb(yieldPerKwp)} kWh per kWp, which is implausible for a UK install — check both figures.`
      );
    }
  }

  // 7. Export cannot exceed generation on a non-arbitrage system.
  if (exportKwh > 0 && gen > 0 && exportKwh > gen) {
    w.push(
      `Annual export (${gb(exportKwh)} kWh) exceeds annual generation (${gb(gen)} kWh). On a Flux tariff this is battery arbitrage and is handled; otherwise one of the two figures is wrong.`
    );
  }

  return w;
}

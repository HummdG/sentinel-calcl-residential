// The extraction prompt.
//
// Deliberately about a third the length of the Groq-era prompt it replaces. That prompt
// had grown to ~1,500 words by appending a prose warning for every mistake ever observed
// ("the number may be ABOVE its label", "the cost is the SUBTRAHEND", "never take a
// cumulative column"), which made it worse on small models rather than better.
//
// Two things replace that bulk:
//
//   1. The evidence requirement. Forcing a verbatim quote plus a page number for every
//      value is a stronger constraint than any amount of prose, because a value read off
//      the wrong row cannot produce a quote that survives verify.ts.
//   2. The arithmetic cross-checks in verify.ts, which catch transposed cost/savings and
//      mis-picked columns after the fact.
//
// What stays here is only what neither of those can catch: semantic distinctions between
// figures that are all individually well-formed and quotable. A derated battery capacity
// vs the system total, discounted vs simple payback, rate of return vs total return. Those
// are judgement calls the model has to get right, so they keep their sentence.

export const SYSTEM_PROMPT = `You extract structured data from UK solar PV and battery proposals. These are produced by OpenSolar, EasyPV and other vendor software, so layout, section names and wording vary. Identify each value by what it MEANS, not by matching a label you expect.

The document is supplied as text with "=== PAGE n ===" markers. It is a linearisation of a graphical page, so reading order is unreliable: a figure is often rendered ABOVE its caption rather than after it, and table headers are frequently separated from their data.

Return every field as an object with three properties:
  value:    the figure, or null if the document does not state it
  page:     the page number you read it from, or 0 when the value is null
  evidence: a short verbatim quote from that page, copied exactly, including the label

Rules:
- Quote before you answer. If you cannot copy an exact span of text that the value comes from, the value is null. Never guess, never substitute 0 for an absent value, and never infer a figure from a product name or a datasheet.
- Numbers are plain: no currency symbols, thousands separators, units or % signs. "11.9%" is 11.9, not 0.119. "£11,319.30" is 11319.3.
- Some answers are derived rather than printed. When you convert units ("7 years, 5 months" to 7.42), sum a monthly series into an annual total, or trim an address down to house and street, quote the SOURCE text you worked from: the "Payback 7 years, 5 months" line, one of the monthly rows, or the full address line. The quote must be text that appears in the document; it does not have to contain the final number.
- 0 is a real answer when the document states zero (e.g. "0% Export to grid"). Use 0 then, and null only when the figure is genuinely absent.`;

export const FIELD_GUIDANCE = `Field notes. These cover cases where several figures in the document are each plausible:

- battery_kwh: the TOTAL rated storage of the installed system. Documents also state a derated "assumed usable capacity" (always smaller), a per-module capacity on a datasheet page, and marketing ranges like "scalable from 64.28kWh to 241.05kWh". If a system total is stated, that IS the answer. Do not also add the modules to it. Only multiply module count by per-module capacity when no total appears anywhere.

- inverter_kw: total inverter rated AC power. Take it only from a statement about THIS system ("20 kW of Inverter Power", an inverter row in the equipment list). A manufacturer datasheet listing a product range is not a statement about this system. If the proposal never states the installed inverter rating, return null.

- annual_usage: the household's TOTAL annual consumption, however supplied. Not the reduced amount still bought from the grid after solar ("Electricity purchased from grid", "Grid import"), which is smaller.

- system_cost: the one-off cash price to buy the system outright. Never a monthly instalment or deposit; if both cash and finance totals appear, use cash. This is a price paid, so it is never a savings or benefit figure.

- solar_savings: the YEAR ONE annual bill saving. In a year-by-year table use only the first data row's annual-saving column. Not a cumulative total, not a later year, not a bracketed negative cashflow.

- export_kwh: the annual total exported to the grid. These documents rarely print that total. It is usually only available as a monthly table with an "Electricity Exported after new system" column. Add that column up across all twelve months and return the total. Quote one of the rows as your evidence. Fall back to null only if there is no such table and no annual figure anywhere.

- os_payback: the SIMPLE payback in decimal years. A "discounted payback period" is a different, longer figure. Do not use it. Convert "7 years, 5 months" to 7.42.

- os_25yr: NET savings over the system lifetime, i.e. after the system cost has been subtracted. Where a document shows both a gross "lifetime bill savings" and a net figure, take the NET (smaller) one.

- os_roi: the rate of return as a percentage. A "total return on investment" (often 150-200%) is a different figure. Do not use it.

- customer_address: house name/number and street only. From "1 Blackberry Drive, Haywards Heath, RH16 2GF" return "1 Blackberry Drive". From "April Cottage, Beech Hill, Headley Down, GU35 8EQ" return "April Cottage, Beech Hill".`;

export function buildUserPrompt(documentText: string): string {
  return `${FIELD_GUIDANCE}\n\nDocument:\n\n${documentText}`;
}

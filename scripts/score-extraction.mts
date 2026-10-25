// Score a model against the verified fixtures.
//
// This is the go/no-go for the two-tier design. Blended cost is roughly
// `haiku + escalation_rate x opus`, so the escalation rate this reports decides whether
// tiering is cheaper than simply running Opus 5 on everything:
//
//   escalation < ~20%   tiering clearly wins
//   escalation ~20-50%  roughly break-even; prefer single-tier for the simpler code path
//   escalation > ~50%   tiering costs MORE than Opus-only. Collapse it
//
//   ANTHROPIC_API_KEY=sk-... node scripts/score-extraction.ts
//   ANTHROPIC_API_KEY=sk-... node scripts/score-extraction.ts --model claude-opus-5
//   ANTHROPIC_API_KEY=sk-... node scripts/score-extraction.ts --only varey
//
// Requires Node >= 22 (runs TypeScript directly via type stripping).

import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractFields } from '../lib/extract/anthropic';
import { verifyExtraction } from '../lib/extract/verify';
import { ALL_FIELDS, INTERNAL_ONLY, type FieldName } from '../lib/extract/schema';

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(here, '..', 'test', 'fixtures');

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const MODEL = arg('model', 'claude-haiku-4-5')!;
const ONLY = arg('only');

// Per-field comparison tolerance. Money and kWh are integers in the source documents, so
// they must match exactly once rounded; ratings and rates carry a decimal.
const TOLERANCE: Partial<Record<FieldName, number>> = {
  pv_size: 0.05,
  battery_kwh: 0.05,
  inverter_kw: 0.05,
  os_roi: 0.05,
  os_payback: 0.1,
  system_cost: 1,
  os_25yr: 1,
  solar_savings: 1,
  annual_gen: 1,
  annual_usage: 1,
  export_kwh: 1,
  export_pct: 0.5,
};

type Verdict = 'correct' | 'wrong' | 'missed' | 'hallucinated';

function judge(
  field: FieldName,
  got: number | string | null | undefined,
  want: number | string | null
): Verdict {
  const g = got ?? null;
  if (want === null) return g === null ? 'correct' : 'hallucinated';
  if (g === null) return 'missed';

  if (typeof want === 'number') {
    if (typeof g !== 'number') return 'wrong';
    return Math.abs(g - want) <= (TOLERANCE[field] ?? 0.01) ? 'correct' : 'wrong';
  }

  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  return norm(String(g)) === norm(want) ? 'correct' : 'wrong';
}

const MARK: Record<Verdict, string> = {
  correct: 'ok  ',
  wrong: 'WRONG',
  missed: 'miss',
  hallucinated: 'HALLUC',
};

const fixtures = readdirSync(FIXTURES)
  .filter((f) => f.endsWith('.expected.json'))
  .map((f) => f.replace('.expected.json', ''))
  .filter((slug) => !ONLY || slug.includes(ONLY))
  .sort();

if (fixtures.length === 0) {
  console.error(`No fixtures matched${ONLY ? ` --only ${ONLY}` : ''}.`);
  process.exit(1);
}

const scored: FieldName[] = ALL_FIELDS.filter((f) => !INTERNAL_ONLY.includes(f));

console.log(`\nModel: ${MODEL}`);
console.log(`Fixtures: ${fixtures.length}\n`);

let totalCorrect = 0;
let totalFields = 0;
let totalCost = 0;
let escalated = 0;
const failuresByField = new Map<FieldName, number>();

for (const slug of fixtures) {
  const text = readFileSync(join(FIXTURES, `${slug}.txt`), 'utf8');
  const { fields: want, _meta } = JSON.parse(
    readFileSync(join(FIXTURES, `${slug}.expected.json`), 'utf8')
  );

  process.stdout.write(`${slug} (${_meta.type}) ... `);

  let result;
  try {
    result = await extractFields(text, { model: MODEL });
  } catch (e) {
    console.log(`FAILED: ${e instanceof Error ? e.message : String(e)}`);
    continue;
  }

  const verified = verifyExtraction(result.claims, text);
  totalCost += result.costUsd;
  if (verified.escalate) escalated++;

  const rows: string[] = [];
  let correct = 0;

  for (const f of scored) {
    const verdict = judge(f, verified.values[f], want[f] ?? null);
    if (verdict === 'correct') correct++;
    else {
      failuresByField.set(f, (failuresByField.get(f) ?? 0) + 1);
      const p = verified.provenance.find((x) => x.field === f);
      rows.push(
        `      ${MARK[verdict].padEnd(7)} ${f.padEnd(17)} got ${JSON.stringify(verified.values[f] ?? null)}  want ${JSON.stringify(want[f] ?? null)}${p?.note ? `   [${p.note}]` : ''}`
      );
    }
  }

  totalCorrect += correct;
  totalFields += scored.length;

  console.log(
    `${correct}/${scored.length}  ${verified.escalate ? 'ESCALATE' : 'clean   '}  $${result.costUsd.toFixed(4)}  (${result.usage.input} in / ${result.usage.output} out)`
  );
  rows.forEach((r) => console.log(r));

  // Rejections drive the escalation decision, so show them even when the field still
  // scored correct. A value dropped for bad evidence that happened to be absent anyway
  // is a false-positive escalation, and that is what makes tiering expensive.
  verified.provenance
    .filter((p) => p.status === 'unverified')
    .forEach((p) =>
      console.log(`      rejected ${p.field.padEnd(17)} ${JSON.stringify(p.value)}  [${p.note}]`)
    );

  if (verified.warnings.length) {
    verified.warnings.forEach((w) => console.log(`      ~ ${w}`));
  }
}

const pct = totalFields ? ((totalCorrect / totalFields) * 100).toFixed(1) : '0.0';
const escPct = fixtures.length ? ((escalated / fixtures.length) * 100).toFixed(0) : '0';

console.log(`\n${'-'.repeat(64)}`);
console.log(`Field accuracy   ${totalCorrect}/${totalFields}  (${pct}%)`);
console.log(`Escalation rate  ${escalated}/${fixtures.length}  (${escPct}%)`);
console.log(`Cost this run    $${totalCost.toFixed(4)}  ($${(totalCost / Math.max(1, fixtures.length)).toFixed(4)} per document)`);

if (failuresByField.size) {
  console.log(`\nWeakest fields:`);
  [...failuresByField.entries()]
    .sort((a, b) => b[1] - a[1])
    .forEach(([f, n]) => console.log(`  ${f.padEnd(18)} ${n}/${fixtures.length} documents`));
}

// The decision this script exists to inform.
const rate = escalated / Math.max(1, fixtures.length);
console.log(`\nVerdict:`);
if (rate < 0.2) {
  console.log(`  Escalation ${escPct}%. Tiering pays for itself. Keep Haiku as tier 1.`);
} else if (rate <= 0.5) {
  console.log(
    `  Escalation ${escPct}%. Roughly break-even against Opus-only. Prefer single-tier Opus 5 for the simpler code path unless volume is high.`
  );
} else {
  console.log(
    `  Escalation ${escPct}%. Tiering costs MORE than running Opus 5 directly. Collapse to single-tier.`
  );
}
console.log('');

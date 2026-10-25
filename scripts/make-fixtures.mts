// Regenerate cached PDF-text fixtures.
//
// The scoring harness must see exactly what the browser sends, so this shares tagPages()
// with lib/pdf-extract.ts rather than reimplementing it. Caching the text lets
// score-extraction.ts run offline, and lets a prompt change be re-scored without
// re-parsing 20 MB of PDFs each time.
//
//   node scripts/make-fixtures.ts            # every PDF in the repo root
//   node scripts/make-fixtures.ts foo.pdf    # one file
//
// Requires Node >= 22 (runs TypeScript directly via type stripping).

import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import { join, basename, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tagPages } from '../lib/pdf-text';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..');
const fixtureDir = join(here, '..', 'test', 'fixtures');

async function extractPdfText(bytes: Uint8Array): Promise<string> {
  const { getDocumentProxy, extractText } = await import('unpdf');
  const pdf = await getDocumentProxy(bytes);
  const { text } = await extractText(pdf, { mergePages: false });
  return tagPages(Array.isArray(text) ? text : [text]);
}

/** "OS_Quote_Proposal_22_Varey_Road.pdf" -> "os-quote-proposal-22-varey-road" */
export function slugify(filename: string): string {
  return basename(filename, '.pdf')
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase();
}

const arg = process.argv[2];
const files = arg
  ? [arg]
  : (await readdir(repoRoot)).filter((f) => f.toLowerCase().endsWith('.pdf'));

if (files.length === 0) {
  console.error('No PDFs found in', repoRoot);
  process.exit(1);
}

await mkdir(fixtureDir, { recursive: true });

for (const file of files.sort()) {
  const slug = slugify(file);
  try {
    const bytes = await readFile(join(repoRoot, file));
    const text = await extractPdfText(new Uint8Array(bytes));
    const pageCount = (text.match(/^=== PAGE \d+ ===$/gm) ?? []).length;

    if (text.trim() === '') {
      // No text layer at all. The Sentinel-Report-*.pdf files are the calculator's own
      // html2canvas/jsPDF output, not vendor proposals, so they are not extraction
      // fixtures. But a genuinely scanned proposal would land here too, and that is the
      // case which must route straight to the vision tier instead of failing outright.
      console.warn(`! ${slug}: no text layer, skipped (image-only PDF)`);
      continue;
    }

    await writeFile(join(fixtureDir, `${slug}.txt`), text, 'utf8');
    console.log(
      `  ${slug}: ${pageCount} pages, ${text.length} chars -> test/fixtures/${slug}.txt`
    );
  } catch (e) {
    console.error(`x ${slug}: ${e instanceof Error ? e.message : String(e)}`);
  }
}

import { NextResponse } from 'next/server';
import { extractFields } from '@/lib/groq';
import type { ExtractedFields } from '@/lib/types';

export const runtime = 'nodejs';
// Groq extraction can take a few seconds; allow up to 60s (Vercel Hobby cap).
export const maxDuration = 60;

// Count how many fields the model actually populated, to report back to the UI.
function countPopulated(fields: ExtractedFields): number {
  const numericKeys: (keyof ExtractedFields)[] = [
    'pv_size',
    'battery_kwh',
    'inverter_kw',
    'annual_gen',
    'annual_usage',
    'system_cost',
    'solar_savings',
    'export_kwh',
    'os_payback',
    'os_25yr',
    'os_roi',
  ];
  const textKeys: (keyof ExtractedFields)[] = ['customer_name', 'customer_address'];
  let count = 0;
  for (const k of numericKeys) if ((fields[k] as number) > 0) count++;
  for (const k of textKeys) if ((fields[k] as string) !== '') count++;
  return count;
}

export async function POST(req: Request) {
  let text: unknown;
  try {
    ({ text } = await req.json());
  } catch {
    return NextResponse.json({ error: 'Invalid request body.' }, { status: 400 });
  }

  if (typeof text !== 'string' || text.trim() === '') {
    return NextResponse.json(
      { error: 'Could not read any text from the PDF. Please enter values manually.' },
      { status: 400 }
    );
  }

  try {
    const fields = await extractFields(text);
    const populated = countPopulated(fields);
    return NextResponse.json({
      fields,
      populated_count: populated,
      message: `✓ Extracted ${populated} values. Review and adjust if needed, then click Calculate.`,
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : 'Extraction failed.';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

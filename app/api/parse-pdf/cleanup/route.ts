// Delete uploaded proposal parts once the browser is done with them.
//
// The extraction routes already delete on their own terminal path, but a run can also end
// early: an error, a fallback to the text pipeline, a second tier that never ran. The
// browser calls this from a finally so the customer's proposal does not stay on the Files
// API in any of those cases. Body: { fileIds: string[] }.

import { NextResponse } from 'next/server';
import { guard } from '@/lib/extract/route-handler';
import { deleteFiles } from '@/lib/extract/anthropic';

export const runtime = 'nodejs';

export async function POST(req: Request) {
  const stop = guard(req, 'cleanup', 3);
  if (stop) return stop;

  let ids: unknown;
  try {
    ids = ((await req.json()) as { fileIds?: unknown }).fileIds;
  } catch {
    return NextResponse.json({ error: 'Invalid request body.' }, { status: 400 });
  }
  if (!Array.isArray(ids) || ids.length > 10) {
    return NextResponse.json({ error: 'fileIds must be a short array.' }, { status: 400 });
  }

  // deleteFiles ignores anything that is not a well-formed file ID.
  await deleteFiles(ids.filter((id): id is string => typeof id === 'string'));
  return NextResponse.json({ ok: true });
}

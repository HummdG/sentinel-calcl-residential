import { handleCalc } from '@/lib/v1/handler';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export function POST(req: Request) {
  return handleCalc(req);
}

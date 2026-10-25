import { openApiDocument } from '@/lib/v1/openapi';

export const runtime = 'nodejs';

export function GET() {
  return Response.json(openApiDocument());
}

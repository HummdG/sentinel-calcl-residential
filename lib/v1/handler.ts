// Framework-light request handling for POST /api/v1/calc, kept apart from the Next route so
// tests can drive it with plain Request objects.

import { randomUUID } from 'node:crypto';
import { authenticate, loadClients, RateLimiter, type ApiClient } from './auth';
import { calculate } from './calc';
import { CalcRequestSchema } from './schema';

const limiter = new RateLimiter();

type ErrorCode = 'invalid_request' | 'unauthorized' | 'rate_limited' | 'internal_error';

function json(body: unknown, status: number, requestId: string, extra: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'x-request-id': requestId, ...extra },
  });
}

function error(
  code: ErrorCode,
  message: string,
  status: number,
  requestId: string,
  more: Record<string, unknown> = {},
  headers: Record<string, string> = {},
) {
  return json({ error: { code, message, request_id: requestId, ...more } }, status, requestId, headers);
}

export interface HandlerDeps {
  clients?: ApiClient[];
  limiter?: RateLimiter;
}

export async function handleCalc(req: Request, deps: HandlerDeps = {}): Promise<Response> {
  const requestId = randomUUID();
  try {
    const client = authenticate(req.headers.get('authorization'), deps.clients ?? loadClients());
    if (!client) {
      return error('unauthorized', 'Missing or invalid API key. Send Authorization: Bearer <key>.', 401, requestId, {}, {
        'www-authenticate': 'Bearer',
      });
    }

    const wait = (deps.limiter ?? limiter).check(client);
    if (wait > 0) {
      return error('rate_limited', `Rate limit exceeded. Retry in ${wait}s.`, 429, requestId, {}, {
        'retry-after': String(wait),
      });
    }

    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return error('invalid_request', 'Request body must be a JSON object.', 400, requestId, {
        fields: [{ field: '(body)', issue: 'not valid JSON' }],
      });
    }
    if (body === null || typeof body !== 'object' || Array.isArray(body)) {
      return error('invalid_request', 'Request body must be a JSON object.', 400, requestId, {
        fields: [{ field: '(body)', issue: 'must be a JSON object' }],
      });
    }

    const parsed = CalcRequestSchema.safeParse(body);
    if (!parsed.success) {
      const sent = body as Record<string, unknown>;
      const fields = parsed.error.issues.map((i) => {
        const field = i.path.join('.') || '(body)';
        const missing = i.code === 'invalid_type' && sent[field] === undefined;
        return { field, issue: missing ? 'is required' : i.message };
      });
      return error('invalid_request', 'One or more fields are invalid.', 400, requestId, { fields });
    }

    const detail = ['true', '1'].includes(new URL(req.url).searchParams.get('detail') ?? '');
    return json(calculate(parsed.data, { detail }), 200, requestId);
  } catch (e) {
    console.error(`[api/v1/calc] ${requestId}`, e);
    return error('internal_error', 'Unexpected error. Quote the request_id if you contact us.', 500, requestId);
  }
}

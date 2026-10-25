// HTTP behaviour of POST /api/v1/calc: authentication, rate limiting, and every 400 rule in
// the API brief.

import { describe, expect, it } from 'vitest';
import { authenticate, hashKey, loadClients, RateLimiter, type ApiClient } from '../../lib/v1/auth';
import { handleCalc } from '../../lib/v1/handler';
import { openApiDocument } from '../../lib/v1/openapi';
import { CalcRequestSchema, CalcResultSchema } from '../../lib/v1/schema';

const KEY = 'scalc_live_testkeytestkeytestkeytestkey12';
const clients: ApiClient[] = [{ id: 'acme', name: 'Acme', sha256: hashKey(KEY) }];

const valid = { annual_usage: 3500, annual_gen: 4000, battery_kwh: 10, inverter_kw: 5, system_cost: 12000 };

function call(body: unknown, opts: { key?: string | null; query?: string; raw?: string; limiter?: RateLimiter } = {}) {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  const key = opts.key === undefined ? KEY : opts.key;
  if (key) headers.authorization = `Bearer ${key}`;
  const req = new Request(`http://localhost/api/v1/calc${opts.query ?? ''}`, {
    method: 'POST',
    headers,
    body: opts.raw ?? JSON.stringify(body),
  });
  return handleCalc(req, { clients, limiter: opts.limiter ?? new RateLimiter() });
}

async function fieldsOf(res: Response) {
  const j = await res.json();
  return j.error.fields as Array<{ field: string; issue: string }>;
}

describe('authentication', () => {
  it('401 without a key, with a wrong key, or with a malformed header', async () => {
    for (const key of [null, 'scalc_live_wrong', '']) {
      const res = await call(valid, { key });
      expect(res.status).toBe(401);
      expect(res.headers.get('www-authenticate')).toBe('Bearer');
      expect((await res.json()).error.code).toBe('unauthorized');
    }
  });

  it('accepts a valid key and sets X-Request-Id', async () => {
    const res = await call(valid);
    expect(res.status).toBe(200);
    expect(res.headers.get('x-request-id')).toMatch(/^[0-9a-f-]{36}$/);
    const body = await res.json();
    expect(() => CalcResultSchema.parse(body)).not.toThrow();
  });

  it('authenticate matches on hash only', () => {
    expect(authenticate(`Bearer ${KEY}`, clients)?.id).toBe('acme');
    expect(authenticate(`bearer ${KEY}`, clients)?.id).toBe('acme');
    expect(authenticate(KEY, clients)).toBeNull();
    expect(authenticate(`Bearer ${KEY}x`, clients)).toBeNull();
  });

  it('loadClients ignores bad JSON and malformed entries', () => {
    expect(loadClients(undefined)).toEqual([]);
    expect(loadClients('not json')).toEqual([]);
    expect(loadClients(JSON.stringify([{ id: 'x', sha256: 'short' }, clients[0]]))).toEqual(clients);
  });

  it('429 with Retry-After once a client exceeds its per-minute limit', async () => {
    const limiter = new RateLimiter();
    const tight: ApiClient = { ...clients[0], rate_per_min: 2 };
    const t0 = 1_000_000;
    expect(limiter.check(tight, t0)).toBe(0);
    expect(limiter.check(tight, t0 + 1)).toBe(0);
    expect(limiter.check(tight, t0 + 2)).toBe(60);
    expect(limiter.check(tight, t0 + 60_001)).toBe(0);

    const shared = new RateLimiter();
    const many = [];
    for (let i = 0; i < 61; i++) many.push(await call(valid, { limiter: shared }));
    const last = many[60];
    expect(last.status).toBe(429);
    expect(Number(last.headers.get('retry-after'))).toBeGreaterThan(0);
    expect((await last.json()).error.code).toBe('rate_limited');
  });
});

describe('validation (400)', () => {
  it('a missing required field', async () => {
    for (const f of Object.keys(valid)) {
      const body: Record<string, unknown> = { ...valid };
      delete body[f];
      const res = await call(body);
      expect(res.status).toBe(400);
      expect(await fieldsOf(res)).toContainEqual({ field: f, issue: 'is required' });
    }
  });

  it('a negative required field', async () => {
    for (const f of Object.keys(valid)) {
      const res = await call({ ...valid, [f]: -1 });
      expect(res.status).toBe(400);
      expect((await fieldsOf(res)).map((x) => x.field)).toContain(f);
    }
  });

  it('annual_usage = 0', async () => {
    const res = await call({ ...valid, annual_usage: 0 });
    expect(res.status).toBe(400);
    expect(await fieldsOf(res)).toContainEqual({ field: 'annual_usage', issue: 'must be greater than 0' });
  });

  it('unknown tariff or usage', async () => {
    for (const [f, v] of [['tariff', 'agile'], ['usage', 'night_owl']]) {
      const res = await call({ ...valid, [f]: v });
      expect(res.status).toBe(400);
      expect((await fieldsOf(res))[0].field).toBe(f);
    }
  });

  it('self_use_fraction outside 0-1 and inflation outside -10..20', async () => {
    for (const [f, v] of [
      ['self_use_fraction', 1.01],
      ['self_use_fraction', -0.01],
      ['inflation', 20.5],
      ['inflation', -10.5],
    ] as const) {
      const res = await call({ ...valid, [f]: v });
      expect(res.status, `${f}=${v}`).toBe(400);
    }
    for (const [f, v] of [['self_use_fraction', 0], ['self_use_fraction', 1], ['inflation', -10], ['inflation', 20]] as const) {
      expect((await call({ ...valid, [f]: v })).status, `${f}=${v}`).toBe(200);
    }
  });

  it('negative optional rates and export limit', async () => {
    for (const f of ['std_import', 'dn_day', 'dn_night', 'export_limit_kw', 'report_payback']) {
      expect((await call({ ...valid, [f]: -0.1 })).status, f).toBe(400);
    }
  });

  it('system_cost = 0 (would divide by zero)', async () => {
    expect((await call({ ...valid, system_cost: 0 })).status).toBe(400);
  });

  it('numbers sent as strings are rejected, not coerced', async () => {
    const res = await call({ ...valid, annual_usage: '3500' });
    expect(res.status).toBe(400);
    expect(await fieldsOf(res)).toContainEqual({ field: 'annual_usage', issue: 'must be a number' });
  });

  it('a body that is not a JSON object', async () => {
    expect((await call(null, { raw: '{bad json' })).status).toBe(400);
    expect((await call([valid])).status).toBe(400);
  });

  it('reports every failing field at once', async () => {
    const res = await call({ annual_usage: 0, tariff: 'x', inflation: 50 });
    const fields = (await fieldsOf(res)).map((f) => f.field).sort();
    expect(fields).toEqual(
      ['annual_gen', 'annual_usage', 'battery_kwh', 'inflation', 'inverter_kw', 'system_cost', 'tariff'].sort(),
    );
  });
});

describe('valid requests (200)', () => {
  it('no battery and no PV are valid', async () => {
    expect((await call({ ...valid, battery_kwh: 0 })).status).toBe(200);
    expect((await call({ ...valid, inverter_kw: 0 })).status).toBe(200);
    expect((await call({ ...valid, annual_gen: 0 })).status).toBe(200);
  });

  it('null optional fields fall back to the defaults; unknown fields are ignored', async () => {
    const a = await (await call(valid)).json();
    const b = await (await call({ ...valid, tariff: null, usage: null, inflation: null, extra: 'x' })).json();
    expect(b.year1).toEqual(a.year1);
  });

  it('?detail=true adds the monthly array', async () => {
    const plain = await (await call(valid)).json();
    const detail = await (await call(valid, { query: '?detail=true' })).json();
    expect(plain.monthly).toBeUndefined();
    expect(detail.monthly).toHaveLength(12);
    expect(CalcResultSchema.parse(detail)).toBeTruthy();
  });
});

describe('OpenAPI document', () => {
  it('describes every request field and the response shape', () => {
    const doc = openApiDocument();
    const req = doc.components.schemas.CalcRequest as {
      properties: Record<string, { description?: string }>;
      required: string[];
    };
    expect(Object.keys(req.properties).sort()).toEqual(Object.keys(CalcRequestSchema.shape).sort());
    expect(req.required.sort()).toEqual(['annual_gen', 'annual_usage', 'battery_kwh', 'inverter_kw', 'system_cost']);
    for (const [k, v] of Object.entries(req.properties)) expect(v.description, k).toBeTruthy();
    const res = doc.components.schemas.CalcResult as { properties: Record<string, unknown> };
    expect(Object.keys(res.properties).sort()).toEqual(
      ['comparison', 'energy', 'lifetime', 'meta', 'monthly', 'year1'].sort(),
    );
  });
});

// API-key authentication and per-key rate limiting for /api/v1.
//
// Keys look like `scalc_live_<32 base62 chars>` and are sent as `Authorization: Bearer <key>`.
// Only their SHA-256 is stored, in the CALC_API_KEYS env var:
//   [{"id":"acme","name":"Acme Solar","sha256":"<hex>","rate_per_min":60}]
// Generate one with `npm run api-key -- <id> "<name>"`. Revoke by deleting the entry and redeploying.

import { createHash, timingSafeEqual } from 'node:crypto';

export interface ApiClient {
  id: string;
  name: string;
  sha256: string;
  rate_per_min?: number;
}

export const DEFAULT_RATE_PER_MIN = 60;
export const KEY_PREFIX = 'scalc_live_';

export function hashKey(key: string): string {
  return createHash('sha256').update(key, 'utf8').digest('hex');
}

export function loadClients(raw = process.env.CALC_API_KEYS): ApiClient[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) throw new Error('not an array');
    return parsed.filter(
      (c): c is ApiClient =>
        typeof c?.id === 'string' && typeof c?.sha256 === 'string' && /^[0-9a-f]{64}$/.test(c.sha256),
    );
  } catch (e) {
    console.error('[api/v1] CALC_API_KEYS is not valid JSON; every request will be refused.', e);
    return [];
  }
}

/** The client a request's bearer key belongs to, or null. Constant-time per stored key. */
export function authenticate(header: string | null, clients: ApiClient[]): ApiClient | null {
  const m = header?.match(/^Bearer\s+(\S+)\s*$/i);
  if (!m) return null;
  const presented = Buffer.from(hashKey(m[1]), 'hex');
  let found: ApiClient | null = null;
  for (const c of clients) {
    const stored = Buffer.from(c.sha256, 'hex');
    if (stored.length === presented.length && timingSafeEqual(stored, presented)) found = c;
  }
  return found;
}

/**
 * Sliding one-minute window per client. In-memory, so on serverless each instance counts
 * separately: a ceiling against runaway loops, not a billing-grade quota.
 */
export class RateLimiter {
  private hits = new Map<string, number[]>();

  /** Seconds until the next request is allowed, or 0 if this one may proceed (and is counted). */
  check(client: ApiClient, now = Date.now()): number {
    const limit = client.rate_per_min ?? DEFAULT_RATE_PER_MIN;
    const windowStart = now - 60_000;
    const recent = (this.hits.get(client.id) ?? []).filter((t) => t > windowStart);
    if (recent.length >= limit) {
      this.hits.set(client.id, recent);
      return Math.max(1, Math.ceil((recent[0] + 60_000 - now) / 1000));
    }
    recent.push(now);
    this.hits.set(client.id, recent);
    return 0;
  }
}

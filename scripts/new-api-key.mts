// Issues an API key for /api/v1.
//   npm run api-key -- <client-id> "<Client name>" [rate_per_min]
// Prints the key (give it to the client once; it can't be recovered) and the entry to add to
// the CALC_API_KEYS JSON array in Vercel / .env.local.

import { randomBytes } from 'node:crypto';
import { hashKey, KEY_PREFIX } from '../lib/v1/auth';

const [id, name, rate] = process.argv.slice(2);
if (!id || !/^[a-z0-9-]+$/.test(id)) {
  console.error('usage: npm run api-key -- <client-id: a-z 0-9 -> "<Client name>" [rate_per_min]');
  process.exit(1);
}

const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
// 256 values onto 62 symbols: reject the top of the range so every symbol is equally likely.
let body = '';
while (body.length < 32) {
  for (const b of randomBytes(64)) {
    if (b < 248 && body.length < 32) body += alphabet[b % 62];
  }
}
const key = KEY_PREFIX + body;

const entry: Record<string, unknown> = { id, name: name ?? id, sha256: hashKey(key) };
if (rate) entry.rate_per_min = Number(rate);

console.log(`API key for ${entry.name} (shown once):\n\n  ${key}\n`);
console.log('Add this object to the CALC_API_KEYS JSON array:\n');
console.log(`  ${JSON.stringify(entry)}\n`);

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';

const dir = new URL('../../db/migrations/', import.meta.url);
const files = readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();

// Prefixes that were handed out twice before this check existed. Verified
// order-independent (same schema in either order); no new entries allowed:
// a new migration takes the next free number.
const LEGACY_DUPLICATE_PREFIXES = new Set(['026', '033', '034', '085', '086', '090', '091', '092']);

test('migration file names are NNN_snake_case.sql', () => {
  for (const f of files) assert.match(f, /^\d{3}_[a-z0-9_]+\.sql$/, f);
});

test('no new duplicate migration prefixes', () => {
  const byPrefix = new Map();
  for (const f of files) {
    const prefix = f.slice(0, 3);
    byPrefix.set(prefix, [...(byPrefix.get(prefix) ?? []), f]);
  }
  const unexpected = [...byPrefix].filter(([prefix, list]) => list.length > 1 && !LEGACY_DUPLICATE_PREFIXES.has(prefix));
  assert.deepEqual(unexpected, [], 'use the next free migration number');
  for (const prefix of LEGACY_DUPLICATE_PREFIXES) {
    assert.ok(byPrefix.get(prefix)?.length > 1, `legacy prefix ${prefix} is no longer duplicated; remove it from the allowlist`);
  }
});

test('migration numbers have no gaps', () => {
  const numbers = [...new Set(files.map((f) => Number(f.slice(0, 3))))];
  numbers.forEach((n, i) => assert.equal(n, numbers[0] + i, `gap before ${String(n).padStart(3, '0')}`));
});

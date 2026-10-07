import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { withTestServer } from '../testServer.js';

process.env.DATABASE_URL = process.env.TEST_DATABASE_URL
  || 'postgres://app:app@localhost:5433/pakyrion_test';
process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'a'.repeat(64);
delete process.env.SMTP_HOST;

const { runMigrations } = await import('../../db/migrate.js');
await runMigrations();

const { seedGroups } = await import('../../db/seedGroups.js');
await seedGroups();

const { query, closePool } = await import('../../backend/db.js');
const { createSession } = await import('../../backend/auth/sessions.js');

const TAG = `rules-${crypto.randomUUID().slice(0, 6)}`;

test('pricing.groupRules: validated, stored per group, dropped for removed groups', async () => {
  const { rows } = await query(
    "INSERT INTO users (email, first_name, last_name, group_id, email_verified) VALUES ($1, 'Regel', 'Admin', (SELECT id FROM groups WHERE key = 'admin'), true) RETURNING id",
    [`${TAG}-admin@example.com`]
  );
  const cookie = `session=${(await createSession(rows[0].id)).token}`;
  await withTestServer(async (port) => {
    const create = (pricing) => fetch(`http://localhost:${port}/events`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ name: `${TAG} Event`, eventDate: '2099-08-01', pricing }),
    });
    const tiers = [{ name: 'Standard', until: null, amounts: { Kinder: 1000, Spieler: 2000 } }];
    const base = { groups: ['Kinder', 'Spieler'], tiers };

    for (const groupRules of [
      { Unbekannt: { source: 'account', field: 'birthdate', op: 'gte', value: 12 } },
      { Kinder: { source: 'nirgends', field: 'birthdate', op: 'gte', value: 12 } },
      { Kinder: { source: 'account', field: 'birthdate', op: 'zwischen', value: 12 } },
      { Kinder: { source: 'account', field: 'birthdate', op: 'gte', value: 'zwölf' } },
      { Kinder: { source: 'account', field: 'birthdate', op: 'between', value: 12, value2: 6 } },
      { Kinder: { source: 'account', field: '', op: 'filled' } },
    ]) {
      assert.equal((await create({ ...base, groupRules })).status, 400, JSON.stringify(groupRules));
    }

    const res = await create({
      ...base,
      groupRules: {
        Kinder: { source: 'account', field: 'birthdate', op: 'between', value: 6, value2: 11 },
        Spieler: { source: 'account', field: 'birthdate', op: 'gte', value: 12 },
      },
    });
    assert.equal(res.status, 201);
    const event = await res.json();
    assert.deepEqual(event.pricing.groupRules.Kinder, { source: 'account', field: 'birthdate', op: 'between', value: 6, value2: 11 });
    assert.equal(event.pricing.groupRules.Spieler.op, 'gte');

    // A group without a rule stays without one; rules of groups that no longer exist are dropped.
    const update = await fetch(`http://localhost:${port}/events/${event.id}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ pricing: { groups: ['Kinder'], tiers: [{ name: 'Standard', until: null, amounts: { Kinder: 1000 } }], groupRules: { Kinder: { source: 'registration', field: 'alter', op: 'lt', value: 12 } } } }),
    });
    assert.equal(update.status, 200);
    assert.deepEqual(Object.keys((await update.json()).pricing.groupRules), ['Kinder']);
  });
});

test.after(async () => {
  await query('DELETE FROM events WHERE name LIKE $1', [`${TAG}%`]);
  await query('DELETE FROM users WHERE email LIKE $1', [`${TAG}-%`]);
  await closePool();
});

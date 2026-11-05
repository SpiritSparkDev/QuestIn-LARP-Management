import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

process.env.DATABASE_URL = process.env.TEST_DATABASE_URL
  || 'postgres://app:app@localhost:5433/pakyrion_test';
process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'a'.repeat(64);

const { runMigrations } = await import('../../db/migrate.js');
await runMigrations();
const { seedGroups } = await import('../../db/seedGroups.js');
await seedGroups();
const { query, closePool } = await import('../../backend/db.js');
const { createSession } = await import('../../backend/auth/sessions.js');
const { withTestServer } = await import('../testServer.js');

process.env.APP_MODE = 'offline';

test('offline: group online payment routes answer 409 and create no group payment', async () => {
  const tag = crypto.randomUUID().slice(0, 8);
  const { rows: ev } = await query("INSERT INTO events (name, event_date, is_active, payments_open, code) VALUES ('Group Offline Con', '2027-10-01', true, true, 'GOF1/2027') RETURNING id");
  const eventId = ev[0].id;
  const { rows: u } = await query(
    "INSERT INTO users (email, first_name, last_name, group_id, email_verified) VALUES ($1, 'Off', 'Line', (SELECT id FROM groups WHERE key = 'mitglied'), true) RETURNING id",
    [`group-off-${tag}@example.com`]
  );
  const userId = u[0].id;
  await query("INSERT INTO registrations (user_id, event_id, con_role, status, amount_due_cents) VALUES ($1, $2, 'helfer', 'confirmed', 1000)", [userId, eventId]);
  const cookie = `session=${(await createSession(userId)).token}`;
  await withTestServer(async (port) => {
    const cases = [
      ['checkout-session', { userIds: [userId], method: 'card' }],
      ['checkout-session', { userIds: [userId], method: 'auto' }],
      ['paypal-order', { userIds: [userId] }],
    ];
    for (const [path, body] of cases) {
      const res = await fetch(`http://localhost:${port}/events/${eventId}/group-payment/${path}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: JSON.stringify(body),
      });
      assert.equal(res.status, 409, path);
      assert.match((await res.json()).error, /Offline-Modus/);
    }
  });
  const { rows } = await query('SELECT 1 FROM group_payments WHERE event_id = $1', [eventId]);
  assert.equal(rows.length, 0);
});

test('offline: single online payment routes answer 409 too (explicit method included)', async () => {
  const tag = crypto.randomUUID().slice(0, 8);
  const { rows: ev } = await query("INSERT INTO events (name, event_date, is_active, payments_open, code) VALUES ('Single Offline Con', '2027-10-02', true, true, 'SOF1/2027') RETURNING id");
  const eventId = ev[0].id;
  const { rows: u } = await query(
    "INSERT INTO users (email, first_name, last_name, group_id, email_verified) VALUES ($1, 'Off', 'Single', (SELECT id FROM groups WHERE key = 'mitglied'), true) RETURNING id",
    [`single-off-${tag}@example.com`]
  );
  const userId = u[0].id;
  const token = `offtoken-${tag}`;
  await query("INSERT INTO registrations (user_id, event_id, con_role, status, amount_due_cents, payment_token, payment_token_expires_at) VALUES ($1, $2, 'helfer', 'confirmed', 1000, $3, now() + interval '1 day')", [userId, eventId, token]);
  const cookie = `session=${(await createSession(userId)).token}`;
  await withTestServer(async (port) => {
    const post = (path, body, headers = {}) => fetch(`http://localhost:${port}${path}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body),
    });
    const cases = [
      [`/events/${eventId}/registrations/${userId}/checkout-session`, { method: 'card' }, { Cookie: cookie }],
      [`/events/${eventId}/registrations/${userId}/checkout-session`, { method: 'auto' }, { Cookie: cookie }],
      [`/events/${eventId}/registrations/${userId}/paypal-order`, {}, { Cookie: cookie }],
      [`/public/registrations/${token}/checkout-session`, { method: 'card' }, {}],
    ];
    for (const [path, body, headers] of cases) {
      const res = await post(path, body, headers);
      assert.equal(res.status, 409, path);
      assert.match((await res.json()).error, /Offline-Modus/, path);
    }
  });
});

test.after(async () => { await closePool(); });

import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { withTestServer } from '../testServer.js';

process.env.DATABASE_URL = process.env.TEST_DATABASE_URL
  || 'postgres://app:app@localhost:5433/pakyrion_test';
process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'a'.repeat(64);
process.env.SMTP_HOST = 'smtp.offline-test.invalid';

const { runMigrations } = await import('../../db/migrate.js');
await runMigrations();
const { query, closePool } = await import('../../backend/db.js');

// Any outgoing connection other than the local database is a failure.
const dbPort = String(new URL(process.env.DATABASE_URL).port || 5432);
const outgoing = [];
const realConnect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) {
  const opt = typeof args[0] === 'object' ? args[0] : { port: args[0] };
  if (String(opt.port) !== dbPort) outgoing.push(opt);
  return realConnect.apply(this, args);
};
const realFetch = globalThis.fetch;
globalThis.fetch = (url, ...rest) => (String(url).startsWith('http://localhost') ? realFetch(url, ...rest) : (outgoing.push({ url }), Promise.reject(new Error('blocked'))));

process.env.APP_MODE = 'offline';
const { sendVerificationEmail } = await import('../../backend/auth/mailer.js');
const { getStripeClient } = await import('../../backend/payments/stripeClient.js');
const { startBackgroundJobs } = await import('../../backend/server.js');
const { warnIfWrongDatabase } = await import('../../backend/appMode.js');

test('offline: mail lands in the outbox, no connection is made', async () => {
  const to = `offline-${Date.now()}@example.com`;
  await sendVerificationEmail(to, 'tok');
  const { rows } = await query('SELECT * FROM mail_outbox WHERE to_address = $1', [to]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].sent_at, null);
  assert.deepEqual(outgoing, []);
});

test('offline: no Stripe client, no background jobs', async () => {
  assert.equal(await getStripeClient(), null);
  assert.deepEqual(startBackgroundJobs(), []);
  assert.deepEqual(outgoing, []);
});

test('/app-config reports the mode', async () => {
  await withTestServer(async (port) => {
    const res = await realFetch(`http://localhost:${port}/app-config`);
    assert.equal((await res.json()).mode, 'offline');
  });
});

test('online start on an offline copy warns', async () => {
  const { rows } = await query("INSERT INTO events (name, event_date, is_active) VALUES ('Warn Con', '2027-09-01', true) RETURNING id");
  await query("INSERT INTO instance_authority (event_id, role) VALUES ($1, 'offline_primary')", [rows[0].id]);
  process.env.APP_MODE = 'online';
  assert.equal(await warnIfWrongDatabase(), 'offline_primary');
  await query('DELETE FROM instance_authority WHERE event_id = $1', [rows[0].id]);
  assert.equal(await warnIfWrongDatabase(), null);
  process.env.APP_MODE = 'offline';
});

test.after(closePool);

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

async function makeEvent({ code, pricing, isActive = true } = {}) {
  const { rows } = await query(
    `INSERT INTO events (name, event_date, is_active, code, pricing)
     VALUES ('Guest Reg Test Con', '2027-09-01', $1, $2, $3) RETURNING id`,
    [isActive, code ?? null, JSON.stringify(pricing ?? { groups: [], tiers: [] })]
  );
  return rows[0].id;
}

function guestPayload(overrides = {}) {
  return {
    email: `guest-reg-${crypto.randomUUID()}@example.com`,
    firstName: 'Guest',
    lastName: 'Buyer',
    ...overrides,
  };
}

test('GET /public/events/:code returns a price teaser for an active event', async () => {
  await withTestServer(async (port) => {
    const code = `PUB-${crypto.randomUUID().slice(0, 8)}`;
    await makeEvent({
      code,
      pricing: { groups: ['Erwachsene'], tiers: [{ name: 'Standard', until: null, amounts: { Erwachsene: 4200 } }] },
    });

    const res = await fetch(`http://localhost:${port}/public/events/${code}`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.name, 'Guest Reg Test Con');
    assert.deepEqual(body.priceGroups, ['Erwachsene']);
    assert.equal(body.prices.Erwachsene, 4200);
  });
});

test('GET /public/events/:code returns 404 for an unknown code', async () => {
  await withTestServer(async (port) => {
    const res = await fetch(`http://localhost:${port}/public/events/does-not-exist`);
    assert.equal(res.status, 404);
  });
});

test('GET /public/events/:code returns 409 for an inactive event', async () => {
  await withTestServer(async (port) => {
    const code = `PUB-${crypto.randomUUID().slice(0, 8)}`;
    await makeEvent({ code, isActive: false });

    const res = await fetch(`http://localhost:${port}/public/events/${code}`);
    assert.equal(res.status, 409);
  });
});

test('POST guest-registration on a free event creates a guest user and confirms without a payment step', async () => {
  await withTestServer(async (port) => {
    const eventId = await makeEvent();
    const payload = guestPayload();

    const res = await fetch(`http://localhost:${port}/public/events/${eventId}/guest-registration`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
    });
    assert.equal(res.status, 201);
    const body = await res.json();
    assert.equal(body.status, 'confirmed');
    assert.equal(body.paymentUrl, undefined);

    const { rows } = await query('SELECT is_guest, password_hash FROM users WHERE email = $1', [payload.email]);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].is_guest, true);
    assert.equal(rows[0].password_hash, null);

    const { rows: regRows } = await query(
      "SELECT con_role, payment_token FROM registrations WHERE event_id = $1 AND user_id = (SELECT id FROM users WHERE email = $2)",
      [eventId, payload.email]
    );
    assert.equal(regRows[0].con_role, 'ticket');
    assert.equal(regRows[0].payment_token, null);
  });
});

test('POST guest-registration on a priced event returns a paymentUrl and sets a payment token', async () => {
  await withTestServer(async (port) => {
    const eventId = await makeEvent({
      pricing: { groups: ['Erwachsene'], tiers: [{ name: 'Standard', until: null, amounts: { Erwachsene: 3000 } }] },
    });
    const payload = guestPayload({ priceGroup: 'Erwachsene' });

    const res = await fetch(`http://localhost:${port}/public/events/${eventId}/guest-registration`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
    });
    assert.equal(res.status, 201);
    const body = await res.json();
    assert.equal(body.status, 'registered');
    assert.match(body.paymentUrl, /^\/guest-payment\.html\?token=/);

    const { rows } = await query(
      "SELECT amount_due_cents, payment_token, payment_token_expires_at FROM registrations WHERE event_id = $1 AND user_id = (SELECT id FROM users WHERE email = $2)",
      [eventId, payload.email]
    );
    assert.equal(rows[0].amount_due_cents, 3000);
    assert.ok(rows[0].payment_token);
    assert.ok(new Date(rows[0].payment_token_expires_at) > new Date());
  });
});

test('POST guest-registration rejects a second submission with the same email for the same event', async () => {
  await withTestServer(async (port) => {
    const eventId = await makeEvent();
    const payload = guestPayload();

    const first = await fetch(`http://localhost:${port}/public/events/${eventId}/guest-registration`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
    });
    assert.equal(first.status, 201);

    const second = await fetch(`http://localhost:${port}/public/events/${eventId}/guest-registration`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
    });
    assert.equal(second.status, 409);

    const { rows } = await query('SELECT count(*)::int AS count FROM users WHERE email = $1', [payload.email]);
    assert.equal(rows[0].count, 1);
  });
});

test('POST guest-registration rejects an email that already belongs to a full (non-guest) account', async () => {
  await withTestServer(async (port) => {
    const eventId = await makeEvent();
    const email = `guest-reg-existing-${crypto.randomUUID()}@example.com`;
    await query(
      "INSERT INTO users (email, first_name, last_name, group_id, email_verified, password_hash) VALUES ($1, 'Real', 'Member', (SELECT id FROM groups WHERE key = 'mitglied'), true, 'x')",
      [email]
    );

    const res = await fetch(`http://localhost:${port}/public/events/${eventId}/guest-registration`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(guestPayload({ email })),
    });
    assert.equal(res.status, 409);
  });
});

test('POST guest-registration for an inactive event fails and cleans up the freshly-created guest row', async () => {
  await withTestServer(async (port) => {
    const eventId = await makeEvent({ isActive: false });
    const payload = guestPayload();

    const res = await fetch(`http://localhost:${port}/public/events/${eventId}/guest-registration`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
    });
    assert.equal(res.status, 409);

    const { rows } = await query('SELECT count(*)::int AS count FROM users WHERE email = $1', [payload.email]);
    assert.equal(rows[0].count, 0);
  });
});

test('GET /public/registrations/:token returns 404 for an unknown token', async () => {
  await withTestServer(async (port) => {
    const res = await fetch(`http://localhost:${port}/public/registrations/not-a-real-token`);
    assert.equal(res.status, 404);
  });
});

test('GET /public/registrations/:token returns 410 for an expired token', async () => {
  await withTestServer(async (port) => {
    const eventId = await makeEvent();
    const payload = guestPayload();
    await fetch(`http://localhost:${port}/public/events/${eventId}/guest-registration`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
    });
    const userId = (await query('SELECT id FROM users WHERE email = $1', [payload.email])).rows[0].id;
    const token = crypto.randomBytes(16).toString('hex');
    await query(
      'UPDATE registrations SET payment_token = $3, payment_token_expires_at = now() - interval \'1 day\' WHERE event_id = $1 AND user_id = $2',
      [eventId, userId, token]
    );

    const res = await fetch(`http://localhost:${port}/public/registrations/${token}`);
    assert.equal(res.status, 410);
  });
});

test('GET /public/registrations/:token returns amount due and unpaid status for a valid token', async () => {
  await withTestServer(async (port) => {
    const eventId = await makeEvent({
      pricing: { groups: ['Erwachsene'], tiers: [{ name: 'Standard', until: null, amounts: { Erwachsene: 2500 } }] },
    });
    const payload = guestPayload({ priceGroup: 'Erwachsene' });
    const regRes = await fetch(`http://localhost:${port}/public/events/${eventId}/guest-registration`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
    });
    const { paymentUrl } = await regRes.json();
    const token = new URLSearchParams(paymentUrl.split('?')[1]).get('token');

    const res = await fetch(`http://localhost:${port}/public/registrations/${token}`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.amountDueCents, 2500);
    assert.equal(body.paid, false);
  });
});

test('POST guest-registration is rejected without waiverAccepted once a waiver is configured, and succeeds with it', async () => {
  await withTestServer(async (port) => {
    const eventId = await makeEvent();
    const { rows: adminRows } = await query(
      "INSERT INTO users (email, first_name, last_name, group_id, email_verified) VALUES ($1, 'Guest', 'Admin', (SELECT id FROM groups WHERE key = 'admin'), true) RETURNING id",
      [`guest-reg-admin-${crypto.randomUUID()}@example.com`]
    );
    const { createSession } = await import('../../backend/auth/sessions.js');
    const adminCookie = `session=${(await createSession(adminRows[0].id)).token}`;
    const putRes = await fetch(`http://localhost:${port}/app-settings`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
      body: JSON.stringify({ waiverText: 'Ich nehme auf eigene Gefahr teil.' }),
    });
    const { waiverVersion } = await putRes.json();

    try {
      const payload = guestPayload();
      const rejected = await fetch(`http://localhost:${port}/public/events/${eventId}/guest-registration`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
      });
      assert.equal(rejected.status, 400);

      const accepted = await fetch(`http://localhost:${port}/public/events/${eventId}/guest-registration`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...payload, waiverAccepted: true }),
      });
      assert.equal(accepted.status, 201);

      const { rows } = await query(
        "SELECT waiver_version_accepted, waiver_accepted_at FROM registrations WHERE event_id = $1 AND user_id = (SELECT id FROM users WHERE email = $2)",
        [eventId, payload.email]
      );
      assert.equal(rows[0].waiver_version_accepted, waiverVersion);
      assert.ok(rows[0].waiver_accepted_at);
    } finally {
      await fetch(`http://localhost:${port}/app-settings`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
        body: JSON.stringify({ waiverText: '' }),
      });
    }
  });
});

test.after(async () => {
  await query("DELETE FROM users WHERE email LIKE 'guest-reg-%'");
  await query("DELETE FROM events WHERE name = 'Guest Reg Test Con'");
  await query("DELETE FROM app_settings");
  await closePool();
});

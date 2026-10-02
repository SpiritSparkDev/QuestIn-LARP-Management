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
const { sendComingSoonReminders } = await import('../../backend/comingSoon/notify.js');

async function makeAdmin() {
  const { rows } = await query(
    "INSERT INTO users (email, first_name, last_name, group_id, email_verified) VALUES ($1, 'Admin', 'Person', (SELECT id FROM groups WHERE key = 'admin'), true) RETURNING id",
    [`admin-${crypto.randomUUID()}@example.com`]
  );
  return rows[0].id;
}

async function makeAdminSession() {
  const adminId = await makeAdmin();
  const session = await createSession(adminId);
  return `session=${session.token}`;
}

function reminderPayload(overrides = {}) {
  return {
    email: `remind-${crypto.randomUUID()}@example.com`,
    firstName: 'Erika',
    lastName: 'Musterfrau',
    ...overrides,
  };
}

test('POST /public/coming-soon/remind-me creates a guest user marked for a reminder', async () => {
  await withTestServer(async (port) => {
    const payload = reminderPayload();
    const res = await fetch(`http://localhost:${port}/public/coming-soon/remind-me`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
    });
    assert.equal(res.status, 201);
    assert.deepEqual(await res.json(), { status: 'registered' });

    const { rows } = await query(
      'SELECT is_guest, password_hash, coming_soon_reminder_requested_at FROM users WHERE email = $1',
      [payload.email]
    );
    assert.equal(rows.length, 1);
    assert.equal(rows[0].is_guest, true);
    assert.equal(rows[0].password_hash, null);
    assert.notEqual(rows[0].coming_soon_reminder_requested_at, null);
  });
});

test('POST /public/coming-soon/remind-me rejects a second signup with the same email', async () => {
  await withTestServer(async (port) => {
    const payload = reminderPayload();
    await fetch(`http://localhost:${port}/public/coming-soon/remind-me`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
    });

    const res = await fetch(`http://localhost:${port}/public/coming-soon/remind-me`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
    });
    assert.equal(res.status, 409);
  });
});

test('POST /public/coming-soon/remind-me rejects an email that already belongs to a real account', async () => {
  await withTestServer(async (port) => {
    const email = `member-${crypto.randomUUID()}@example.com`;
    await query(
      "INSERT INTO users (email, first_name, last_name, group_id, email_verified) VALUES ($1, 'Real', 'Member', (SELECT id FROM groups WHERE key = 'mitglied'), true)",
      [email]
    );

    const res = await fetch(`http://localhost:${port}/public/coming-soon/remind-me`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(reminderPayload({ email })),
    });
    assert.equal(res.status, 409);
  });
});

test('POST /public/coming-soon/remind-me reuses an existing (e.g. ticket) guest row instead of duplicating it', async () => {
  await withTestServer(async (port) => {
    const email = `remind-${crypto.randomUUID()}@example.com`;
    const { rows } = await query(
      `INSERT INTO users (email, group_id, first_name, last_name, is_guest, email_verified)
       VALUES ($1, (SELECT id FROM groups WHERE key = 'mitglied'), 'Guest', 'Buyer', true, false) RETURNING id`,
      [email]
    );
    const existingUserId = rows[0].id;

    const res = await fetch(`http://localhost:${port}/public/coming-soon/remind-me`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(reminderPayload({ email })),
    });
    assert.equal(res.status, 201);

    const { rows: afterRows } = await query('SELECT id, coming_soon_reminder_requested_at FROM users WHERE email = $1', [email]);
    assert.equal(afterRows.length, 1);
    assert.equal(afterRows[0].id, existingUserId);
    assert.notEqual(afterRows[0].coming_soon_reminder_requested_at, null);
  });
});

test('POST /public/coming-soon/remind-me validates required fields and email format', async () => {
  await withTestServer(async (port) => {
    const missing = await fetch(`http://localhost:${port}/public/coming-soon/remind-me`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'a@b.com' }),
    });
    assert.equal(missing.status, 400);

    const invalid = await fetch(`http://localhost:${port}/public/coming-soon/remind-me`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(reminderPayload({ email: 'not-an-email' })),
    });
    assert.equal(invalid.status, 400);
  });
});

test('sendComingSoonReminders turns every marked guest into an invitation and clears the marker', async () => {
  const adminId = await makeAdmin();
  const email = `remind-${crypto.randomUUID()}@example.com`;
  const { rows } = await query(
    `INSERT INTO users (email, group_id, first_name, last_name, is_guest, email_verified, coming_soon_reminder_requested_at)
     VALUES ($1, (SELECT id FROM groups WHERE key = 'mitglied'), 'Erika', 'Musterfrau', true, false, now()) RETURNING id`,
    [email]
  );
  const userId = rows[0].id;

  await sendComingSoonReminders(adminId);

  const { rows: userRows } = await query('SELECT coming_soon_reminder_requested_at FROM users WHERE id = $1', [userId]);
  assert.equal(userRows[0].coming_soon_reminder_requested_at, null);

  const { rows: invitationRows } = await query('SELECT user_id, invited_by, email FROM invitations WHERE user_id = $1', [userId]);
  assert.equal(invitationRows.length, 1);
  assert.equal(invitationRows[0].invited_by, adminId);
  assert.equal(invitationRows[0].email, email);
});

test('sendComingSoonReminders does nothing when no one is waiting for a reminder', async () => {
  const adminId = await makeAdmin();
  await sendComingSoonReminders(adminId);
});

test('disabling coming-soon via PUT /app-settings sends out the pending reminders', async () => {
  await withTestServer(async (port) => {
    const cookie = await makeAdminSession();
    const email = `remind-${crypto.randomUUID()}@example.com`;
    const { rows } = await query(
      `INSERT INTO users (email, group_id, first_name, last_name, is_guest, email_verified, coming_soon_reminder_requested_at)
       VALUES ($1, (SELECT id FROM groups WHERE key = 'mitglied'), 'Erika', 'Musterfrau', true, false, now()) RETURNING id`,
      [email]
    );
    const userId = rows[0].id;

    await fetch(`http://localhost:${port}/app-settings`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ comingSoonEnabled: true }),
    });
    const res = await fetch(`http://localhost:${port}/app-settings`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ comingSoonEnabled: false }),
    });
    assert.equal(res.status, 200);

    // sendComingSoonReminders is fire-and-forget -- give it a moment to
    // finish its DB round trips before asserting on the rows it writes.
    await new Promise((resolve) => setTimeout(resolve, 100));

    const { rows: userRows } = await query('SELECT coming_soon_reminder_requested_at FROM users WHERE id = $1', [userId]);
    assert.equal(userRows[0].coming_soon_reminder_requested_at, null);
    const { rows: invitationRows } = await query('SELECT id FROM invitations WHERE user_id = $1', [userId]);
    assert.equal(invitationRows.length, 1);
  });
});

test('enabling coming-soon via PUT /app-settings does not send reminders', async () => {
  await withTestServer(async (port) => {
    const cookie = await makeAdminSession();
    const email = `remind-${crypto.randomUUID()}@example.com`;
    const { rows } = await query(
      `INSERT INTO users (email, group_id, first_name, last_name, is_guest, email_verified, coming_soon_reminder_requested_at)
       VALUES ($1, (SELECT id FROM groups WHERE key = 'mitglied'), 'Erika', 'Musterfrau', true, false, now()) RETURNING id`,
      [email]
    );
    const userId = rows[0].id;

    const res = await fetch(`http://localhost:${port}/app-settings`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ comingSoonEnabled: true }),
    });
    assert.equal(res.status, 200);
    await new Promise((resolve) => setTimeout(resolve, 100));

    const { rows: userRows } = await query('SELECT coming_soon_reminder_requested_at FROM users WHERE id = $1', [userId]);
    assert.notEqual(userRows[0].coming_soon_reminder_requested_at, null);

    // app_settings is a single shared row across the whole test DB -- reset
    // it directly (not via another PUT) so this test doesn't leak
    // comingSoonEnabled:true into other files, without triggering a second
    // fire-and-forget sendComingSoonReminders that could still be running
    // when the test ends and the DB pool closes.
    await query('UPDATE app_settings SET coming_soon_enabled = false');
  });
});

test.after(async () => {
  await closePool();
});

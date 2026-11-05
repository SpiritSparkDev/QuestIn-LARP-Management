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
const { createServer } = await import('../../backend/server.js');
const { setPaymentSettings } = await import('../../backend/paymentSettings/repository.js');

const tag = crypto.randomUUID().slice(0, 6).toUpperCase();
const CODE = `BR${tag}/2027`;

async function makeUser(first, last, groupKey = 'mitglied', extra = {}) {
  const { rows } = await query(
    `INSERT INTO users (email, first_name, last_name, group_id, email_verified, managed_by_user_id)
     VALUES ($1, $2, $3, (SELECT id FROM groups WHERE key = $4), true, $5) RETURNING id`,
    [`bank-${tag}-${crypto.randomUUID()}@example.com`, first, last, groupKey, extra.managedBy ?? null]
  );
  return rows[0].id;
}
const cookieFor = async (userId) => `session=${(await createSession(userId)).token}`;

async function setup() {
  await setPaymentSettings({ bankIban: 'DE02100100100006820101', bankBic: 'PBNKDEFF', bankAccountHolder: 'Pakyrion e.V.', bankEnabled: true, bankReferenceTemplate: '', bankGroupReferenceTemplate: '' });
  const { rows } = await query(
    "INSERT INTO events (name, event_date, is_active, payments_open, code) VALUES ('Bank Con', '2027-08-01', true, true, $1) RETURNING id", [CODE]);
  const eventId = rows[0].id;
  const reg = async (userId, cents) => query(
    "INSERT INTO registrations (user_id, event_id, con_role, status, amount_due_cents) VALUES ($1, $2, 'helfer', 'confirmed', $3)", [userId, eventId, cents]);
  const fiona = await makeUser('Fiona', `Fantasie${tag}`);
  const gerda = await makeUser('Gerda', `Test${tag}`);
  const boss = await makeUser('Boss', `Bande${tag}`);
  const lena = await makeUser('Lena', 'Kind', 'mitglied', { managedBy: boss });
  const tom = await makeUser('Tom', 'Kind', 'mitglied', { managedBy: boss });
  await reg(fiona, 6000); await reg(gerda, 2000); await reg(lena, 3000); await reg(tom, 3000);
  const admin = await makeUser('Ad', 'Min', 'admin');
  return { eventId, fiona, gerda, boss, lena, tom, adminCookie: await cookieFor(admin), memberCookie: await cookieFor(await makeUser('Mit', 'Glied')), bossCookie: await cookieFor(boss) };
}

async function withServer(fn) {
  const server = createServer().listen(0);
  try {
    const base = `http://localhost:${server.address().port}`;
    await fn((path, cookie, body) => fetch(base + path, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: JSON.stringify(body),
    }));
  } finally {
    server.close();
  }
}

const csv = (rows) => ['Buchungstag;Verwendungszweck;Beguenstigter;Betrag', ...rows.map(([t, a]) => `03.11.2026;"${t}";Fantasie;${a}`)].join('\n');

test('preview matches entries and writes nothing; book books and is idempotent', async () => {
  const s = await setup();
  await withServer(async (call) => {
    const content = csv([
      [`${CODE} Fiona-Fantasie${tag}`, '60,00'], // match
      [`${CODE} Gerda-Test${tag}`, '19,00'], // amount mismatch
      ['Spende ohne Bezug', '5,00'], // unmatched
      [`${CODE} Fiona-Fantasie${tag}`, '60,00'], // duplicate
    ]);
    const res = await call('/admin/bank-reconcile/preview', s.adminCookie, { content });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(body.summary, { total: 4, match: 1, amountMismatch: 1, ambiguous: 0, unmatched: 1, duplicate: 1 });
    const cand = body.entries[0].candidates[0];
    assert.deepEqual([cand.kind, cand.userIds], ['registration', [s.fiona]]);
    assert.equal((await query('SELECT count(*)::int AS n FROM payments WHERE event_id = $1', [s.eventId])).rows[0].n, 0);

    const item = { eventId: s.eventId, userIds: [s.fiona], amountCents: 6000 };
    const booked = await (await call('/admin/bank-reconcile/book', s.adminCookie, { items: [item] })).json();
    assert.deepEqual(booked, { booked: 1, skipped: [] });
    const { rows } = await query("SELECT method, amount_cents FROM payments WHERE event_id = $1 AND user_id = $2", [s.eventId, s.fiona]);
    assert.deepEqual(rows, [{ method: 'bank_transfer', amount_cents: 6000 }]);
    assert.ok((await query('SELECT paid_at FROM registrations WHERE event_id = $1 AND user_id = $2', [s.eventId, s.fiona])).rows[0].paid_at);

    const again = await (await call('/admin/bank-reconcile/book', s.adminCookie, { items: [item] })).json();
    assert.deepEqual(again, { booked: 0, skipped: [{ eventId: s.eventId, userId: s.fiona, reason: 'already_paid', name: `Fiona Fantasie${tag}` }] });

    const wrong = await (await call('/admin/bank-reconcile/book', s.adminCookie, { items: [{ eventId: s.eventId, userIds: [s.gerda], amountCents: 1900 }] })).json();
    assert.deepEqual(wrong, { booked: 0, skipped: [{ eventId: s.eventId, userId: s.gerda, reason: 'amount_mismatch', name: `Gerda Test${tag}` }] });
    assert.equal((await query('SELECT count(*)::int AS n FROM payments WHERE event_id = $1 AND user_id = $2', [s.eventId, s.gerda])).rows[0].n, 0);
  });
});

test('preview rejects unreadable content; plain members get 403', async () => {
  const s = await setup();
  await withServer(async (call) => {
    assert.equal((await call('/admin/bank-reconcile/preview', s.adminCookie, { content: 'nonsense' })).status, 400);
    assert.equal((await call('/admin/bank-reconcile/preview', s.adminCookie, {})).status, 400);
    assert.equal((await call('/admin/bank-reconcile/preview', s.memberCookie, { content: csv([]) })).status, 403);
    assert.equal((await call('/admin/bank-reconcile/book', s.memberCookie, { items: [] })).status, 403);
    assert.equal((await call('/admin/bank-reconcile/book', s.adminCookie, { items: [{ eventId: 'x' }] })).status, 400);
  });
});

test('group transfer notice persists the reference once; the group entry matches and books everybody', async () => {
  const s = await setup();
  await withServer(async (call) => {
    const sel = { userIds: [s.lena, s.tom] };
    for (let i = 0; i < 2; i++) assert.equal((await call(`/events/${s.eventId}/group-payment/transfer-notice`, s.bossCookie, sel)).status, 200);
    const { rows } = await query("SELECT reference, kind FROM group_payments WHERE event_id = $1", [s.eventId]);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].kind, 'bank');
    assert.match(rows[0].reference, new RegExp(`^${CODE} Boss-Bande${tag}: Lena, Tom$`));

    const content = csv([[`Sammel ${rows[0].reference} danke`, '60,00']]);
    const preview = await (await call('/admin/bank-reconcile/preview', s.adminCookie, { content })).json();
    assert.equal(preview.summary.match, 1);
    const c = preview.entries[0].candidates[0];
    assert.equal(c.kind, 'group');
    assert.deepEqual([...c.userIds].sort(), [s.lena, s.tom].sort());

    const res = await (await call('/admin/bank-reconcile/book', s.adminCookie, { items: [{ eventId: c.eventId, userIds: c.userIds, amountCents: c.amountCents }] })).json();
    assert.equal(res.booked, 2);
    const { rows: paid } = await query('SELECT count(*)::int AS n FROM registrations WHERE event_id = $1 AND user_id = ANY($2) AND paid_at IS NOT NULL', [s.eventId, [s.lena, s.tom]]);
    assert.equal(paid[0].n, 2);
  });
});

test('MT940 statement with a mid-word wrapped purpose matches; book-skipped carries the name', async () => {
  const s = await setup();
  const code = `MT${tag}/2027`; // own code: other tests' events share CODE and would make the reference ambiguous
  await query('UPDATE events SET code = $1 WHERE id = $2', [code, s.eventId]);
  await withServer(async (call) => {
    const mt = [
      ':20:STARTUMS', ':25:10010010/0006820101', ':60F:C261102EUR0,00',
      ':61:2611031103C60,00NTRFNONREF',
      `:86:166?00Gutschrift?20${code.slice(0, 5)}?21${code.slice(5)} Fiona-Fant?22asie${tag}?32Hans Ueberweiser`,
      ':61:2611031103D60,00NTRFNONREF', `:86:166?20${code} Gerda-Test${tag}`,
      ':62F:C261103EUR0,00', '-',
    ].join('\n');
    const preview = await (await call('/admin/bank-reconcile/preview', s.adminCookie, { content: mt })).json();
    assert.equal(preview.summary.total, 1);
    assert.equal(preview.summary.match, 1);
    assert.deepEqual(preview.entries[0].candidates[0].userIds, [s.fiona]);

    const bad = await (await call('/admin/bank-reconcile/book', s.adminCookie, { items: [{ eventId: s.eventId, userIds: [s.gerda], amountCents: 1900 }] })).json();
    assert.equal(bad.skipped.length, 1);
    assert.equal(bad.skipped[0].name, `Gerda Test${tag}`);
  });
});

test('closePool', async () => { await closePool(); });

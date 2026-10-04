import { test, after } from 'node:test';
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

after(async () => {
  await query("UPDATE users SET group_id = (SELECT id FROM groups WHERE key = 'mitglied') WHERE group_id IN (SELECT id FROM groups WHERE key LIKE 'export\\_test\\_%')");
  await query("DELETE FROM groups WHERE key LIKE 'export\\_test\\_%'");
  await closePool();
});

async function makeUser(groupKey, { first = 'Export', last = 'Test' } = {}) {
  const { rows } = await query(
    "INSERT INTO users (email, first_name, last_name, group_id, email_verified) VALUES ($1, $2, $3, (SELECT id FROM groups WHERE key = $4), true) RETURNING id",
    [`export-${groupKey}-${crypto.randomUUID()}@example.com`, first, last, groupKey]
  );
  const { createSession } = await import('../../backend/auth/sessions.js');
  const session = await createSession(rows[0].id);
  return { userId: rows[0].id, cookie: `session=${session.token}` };
}

async function makeGroup({ canExport, accountFields = [] }) {
  const key = `export_test_${crypto.randomUUID().slice(0, 8)}`;
  await query(
    `INSERT INTO groups (key, name, visible_menus, account_fields, can_edit_characters, can_override_checkin_status, can_export_members)
     VALUES ($1, $1, '["mitglieder"]', $2, false, false, $3)`,
    [key, JSON.stringify(accountFields), canExport]
  );
  return key;
}

const exportCsv = (port, cookie, body) => fetch(`http://localhost:${port}/members/export`, {
  method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: JSON.stringify(body ?? {}),
});

test('seeded admin and moderator may export, members may not; the flag shows up in /account', async () => {
  await withTestServer(async (port) => {
    const flag = async (groupKey) => {
      const u = await makeUser(groupKey);
      return (await (await fetch(`http://localhost:${port}/account`, { headers: { Cookie: u.cookie } })).json()).canExportMembers;
    };
    assert.equal(await flag('admin'), true);
    assert.equal(await flag('moderator'), true);
    assert.equal(await flag('mitglied'), false);
  });
});

test('POST /members/export needs the export permission, not just the Mitglieder menu', async () => {
  await withTestServer(async (port) => {
    const denied = await makeUser(await makeGroup({ canExport: false }));
    const res = await exportCsv(port, denied.cookie);
    assert.equal(res.status, 403);

    const plain = await makeUser('mitglied');
    assert.equal((await exportCsv(port, plain.cookie)).status, 403);

    const allowed = await makeUser(await makeGroup({ canExport: true }));
    assert.equal((await exportCsv(port, allowed.cookie)).status, 200);
  });
});

test('the export is a ;-separated UTF-8 CSV of the requested members in the requested order', async () => {
  await withTestServer(async (port) => {
    const admin = await makeUser('admin');
    const a = await makeUser('mitglied', { first: 'Zoe', last: 'Zimmer' });
    const b = await makeUser('mitglied', { first: 'Amy', last: 'Abel' });

    const res = await exportCsv(port, admin.cookie, { ids: [a.userId, b.userId] });
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /text\/csv/);
    assert.match(res.headers.get('content-disposition'), /attachment; filename="mitglieder-\d{4}-\d{2}-\d{2}\.csv"/);
    // fetch's text() strips a leading BOM, so check the raw bytes for it.
    const bytes = Buffer.from(await res.arrayBuffer());
    assert.deepEqual([...bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf]);
    const text = bytes.toString('utf8').slice(1);
    assert.ok(text.startsWith('Nachname;Vorname;Rufname;Anzeigename;E-Mail;Gruppe;Status;Kontoart'));
    const lines = text.trim().split('\r\n');
    assert.equal(lines.length, 3);
    assert.ok(lines[1].startsWith('Zimmer;Zoe;'));
    assert.ok(lines[2].startsWith('Abel;Amy;'));

    assert.equal((await exportCsv(port, admin.cookie, { ids: 'nope' })).status, 400);
    assert.equal((await exportCsv(port, admin.cookie, { eventId: '00000000-0000-4000-8000-000000000000' })).status, 404);
  });
});

test('account fields in the export are limited to what the exporting group may see', async () => {
  await withTestServer(async (port) => {
    const limited = await makeUser(await makeGroup({ canExport: true, accountFields: ['phone'] }));
    const target = await makeUser('mitglied');
    const text = await (await exportCsv(port, limited.cookie, { ids: [target.userId] })).text();
    const header = text.split('\r\n')[0];
    assert.ok(header.includes('Telefon'));
    assert.ok(!header.includes('Adresse'));
    assert.ok(!header.includes('Gesundheitshinweise'));

    const admin = await makeUser('admin');
    const adminHeader = (await (await exportCsv(port, admin.cookie, { ids: [target.userId] })).text()).split('\r\n')[0];
    assert.ok(adminHeader.includes('Adresse'));
  });
});

test('with an event the export gets a registration column, and cells that look like formulas are defused', async () => {
  await withTestServer(async (port) => {
    const admin = await makeUser('admin');
    const person = await makeUser('mitglied', { first: '=cmd', last: 'Evil' });
    const { rows: ev } = await query("INSERT INTO events (name, event_date) VALUES ('Export-Con', '2027-09-09') RETURNING id");
    await query("INSERT INTO registrations (user_id, event_id, con_role, status) VALUES ($1, $2, 'helfer', 'checked_in')", [person.userId, ev[0].id]);

    const text = await (await exportCsv(port, admin.cookie, { ids: [person.userId], eventId: ev[0].id })).text();
    const [header, row] = text.trim().split('\r\n');
    assert.ok(header.includes('Anmeldung: Export-Con'));
    assert.ok(row.includes("'=cmd"));
    assert.ok(row.includes('Eingecheckt'));
  });
});

test('PUT /groups can grant and revoke the export permission', async () => {
  await withTestServer(async (port) => {
    const admin = await makeUser('admin');
    const key = await makeGroup({ canExport: false });
    const { rows } = await query('SELECT id FROM groups WHERE key = $1', [key]);
    const headers = { 'Content-Type': 'application/json', Cookie: admin.cookie };
    const on = await fetch(`http://localhost:${port}/groups/${rows[0].id}`, { method: 'PUT', headers, body: JSON.stringify({ canExportMembers: true }) });
    assert.equal((await on.json()).can_export_members, true);
    const off = await fetch(`http://localhost:${port}/groups/${rows[0].id}`, { method: 'PUT', headers, body: JSON.stringify({ canExportMembers: false }) });
    assert.equal((await off.json()).can_export_members, false);
  });
});

test('without an event filter the export gets one registration column per event the exported members are registered for', async () => {
  await withTestServer(async (port) => {
    const admin = await makeUser('admin');
    const person = await makeUser('mitglied', { first: 'Viel', last: 'Angemeldet' });
    const { rows: first } = await query("INSERT INTO events (name, event_date) VALUES ('Frühcon', '2027-03-01') RETURNING id");
    const { rows: second } = await query("INSERT INTO events (name, event_date) VALUES ('Spätcon', '2027-10-01') RETURNING id");
    await query("INSERT INTO events (name, event_date) VALUES ('Unbeteiligt-Con', '2027-12-01')");
    await query("INSERT INTO registrations (user_id, event_id, con_role, status) VALUES ($1, $2, 'helfer', 'waitlisted'), ($1, $3, 'helfer', 'confirmed')", [person.userId, second[0].id, first[0].id]);
    const none = await makeUser('mitglied');

    const text = await (await exportCsv(port, admin.cookie, { ids: [person.userId, none.userId] })).text();
    const [header, row, emptyRow] = text.trim().split('\r\n');
    const columns = header.split(';');
    // One column per event with a registration among the exported members, oldest event first.
    assert.deepEqual(columns.filter((c) => c.startsWith('Anmeldung')), ['Anmeldung: Frühcon', 'Anmeldung: Spätcon']);
    assert.ok(!header.includes('Unbeteiligt-Con'));
    const cells = row.split(';');
    assert.equal(cells[columns.indexOf('Anmeldung: Frühcon')], 'Angemeldet');
    assert.equal(cells[columns.indexOf('Anmeldung: Spätcon')], 'Warteliste');
    const emptyCells = emptyRow.split(';');
    assert.equal(emptyCells[columns.indexOf('Anmeldung: Frühcon')], 'Nicht angemeldet');
  });
});

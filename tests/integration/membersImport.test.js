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
after(closePool);

async function makeUser(groupKey) {
  const { rows } = await query(
    "INSERT INTO users (email, first_name, last_name, group_id, email_verified) VALUES ($1, 'Imp', 'Test', (SELECT id FROM groups WHERE key = $2), true) RETURNING id",
    [`imp-${groupKey}-${crypto.randomUUID()}@example.com`, groupKey]
  );
  const { createSession } = await import('../../backend/auth/sessions.js');
  return `session=${(await createSession(rows[0].id)).token}`;
}

const post = (port, cookie, body) => fetch(`http://localhost:${port}/members/import`, {
  method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: JSON.stringify(body),
});
const mail = () => `imp-${crypto.randomUUID()}@example.com`;
const count = async (email) => (await query('SELECT (SELECT count(*) FROM users WHERE email = $1) AS u, (SELECT count(*) FROM invitations WHERE email = $1) AS i', [email])).rows[0];

test('import is admin only', async () => {
  await withTestServer(async (port) => {
    assert.equal((await post(port, await makeUser('moderator'), { csv: 'E-Mail\na@b.de' })).status, 403);
    assert.equal((await post(port, await makeUser('mitglied'), { csv: 'E-Mail\na@b.de' })).status, 403);
  });
});

test('preview classifies new, update and error rows without writing', async () => {
  await withTestServer(async (port) => {
    const admin = await makeUser('admin');
    const fresh = mail();
    const existing = mail();
    await query("INSERT INTO users (email, first_name, last_name, group_id, email_verified) VALUES ($1, 'Alt', 'Name', (SELECT id FROM groups WHERE key = 'mitglied'), true)", [existing]);
    const csv = `Nachname;Vorname;E-Mail;Rolle;Unbekannt\r\nNeu;Nina;${fresh};;x\r\nGeaendert;Alt;${existing};;x\r\nOhne;Mail;;;x\r\nKaputt;Mail;nomail;;x\r\nGrp;Falsch;${mail()};gibtsnicht;x\r\nNeu2;Dup;${fresh};;x\r\n`;
    const res = await post(port, admin, { csv });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(body.rows.map((r) => r.status), ['new', 'update', 'error', 'error', 'error', 'error']);
    assert.equal(body.rows[2].line, 4);
    assert.match(body.rows[2].message, /E-Mail/);
    assert.deepEqual(body.ignoredColumns.map((c) => c.column), ['Unbekannt']);
    assert.deepEqual(body.summary, { new: 1, update: 1, error: 4 });
    assert.deepEqual(await count(fresh), { u: '0', i: '0' });
    assert.equal((await query('SELECT last_name FROM users WHERE email = $1', [existing])).rows[0].last_name, 'Name');
  });
});

test('apply creates invitations, updates by email, blank cells keep values, comma delimiter works', async () => {
  await withTestServer(async (port) => {
    const admin = await makeUser('admin');
    const fresh = mail();
    const existing = mail();
    await query("INSERT INTO users (email, first_name, last_name, nickname, group_id, email_verified) VALUES ($1, 'Alt', 'Name', 'Rufi', (SELECT id FROM groups WHERE key = 'mitglied'), true)", [existing]);
    const csv = `Nachname,Vorname,E-Mail,Rolle\n"Neu, mit Komma",Nina,${fresh.toUpperCase()},\nGeaendert,,${existing},moderator\n`;
    const res = await post(port, admin, { csv, apply: true });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(body.summary, { new: 1, update: 1, error: 0 });
    assert.equal(body.applied, true);
    const inv = (await query("SELECT last_name, (SELECT key FROM groups WHERE id = group_id) AS g FROM invitations WHERE email = $1", [fresh])).rows;
    assert.deepEqual(inv, [{ last_name: 'Neu, mit Komma', g: 'mitglied' }]);
    const u = (await query("SELECT last_name, first_name, nickname, (SELECT key FROM groups WHERE id = group_id) AS g FROM users WHERE email = $1", [existing])).rows[0];
    assert.deepEqual(u, { last_name: 'Geaendert', first_name: 'Alt', nickname: 'Rufi', g: 'moderator' });
    assert.equal((await query("SELECT count(*)::int AS n FROM audit_log WHERE action = 'members.import' AND actor_id IS NOT NULL")).rows[0].n >= 1, true);
  });
});

test('apply with any error row writes nothing', async () => {
  await withTestServer(async (port) => {
    const admin = await makeUser('admin');
    const fresh = mail();
    const res = await post(port, admin, { csv: `Nachname;Vorname;E-Mail\nA;B;${fresh}\nA;B;kaputt\n`, apply: true });
    assert.equal(res.status, 409);
    assert.deepEqual(await count(fresh), { u: '0', i: '0' });
  });
});

test('a database failure mid-apply rolls everything back', async () => {
  await withTestServer(async (port) => {
    const admin = await makeUser('admin');
    const first = mail();
    const huge = 'x'.repeat(300); // nickname is varchar-limited? fall back: NUL byte makes postgres reject the text
    const res = await post(port, admin, { csv: `Nachname;Vorname;E-Mail;Rufname\nA;B;${first};ok\nC;D;${mail()};bad\u0000${huge}\n`, apply: true });
    assert.notEqual(res.status, 200);
    assert.deepEqual(await count(first), { u: '0', i: '0' });
  });
});

test('formula cells stay plain text, an export apostrophe is stripped', async () => {
  await withTestServer(async (port) => {
    const admin = await makeUser('admin');
    const a = mail();
    const b = mail();
    const res = await post(port, admin, { csv: `Nachname;Vorname;E-Mail\n=1+1;@x;${a}\n'=2+2;-y;${b}\n`, apply: true });
    assert.equal(res.status, 200);
    const names = async (e) => (await query('SELECT last_name, first_name FROM invitations WHERE email = $1', [e])).rows[0];
    assert.deepEqual(await names(a), { last_name: '=1+1', first_name: '@x' });
    assert.deepEqual(await names(b), { last_name: '=2+2', first_name: '-y' });
  });
});

test('size limits', async () => {
  await withTestServer(async (port) => {
    const admin = await makeUser('admin');
    const rows = Array.from({ length: 5001 }, (_, i) => `A;B;r${i}@example.com`).join('\n');
    assert.equal((await post(port, admin, { csv: `Nachname;Vorname;E-Mail\n${rows}` })).status, 413);
    assert.equal((await post(port, admin, {})).status, 400);
  });
});

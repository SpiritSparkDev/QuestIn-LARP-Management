import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { PDFDocument } from 'pdf-lib';
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
  // Leave app_settings as other test files expect to find it.
  await query('UPDATE app_settings SET pdf_import_enabled = false');
  await closePool();
});

async function makeUserAndSession(groupKey = 'mitglied') {
  const { rows } = await query(
    "INSERT INTO users (email, first_name, last_name, group_id, email_verified) VALUES ($1, 'Pdf', 'Test', (SELECT id FROM groups WHERE key = $2), true) RETURNING id",
    [`pdf-${groupKey}-${crypto.randomUUID()}@example.com`, groupKey]
  );
  const { createSession } = await import('../../backend/auth/sessions.js');
  const session = await createSession(rows[0].id);
  return { userId: rows[0].id, cookie: `session=${session.token}` };
}

async function makeFilledPdf(values) {
  const doc = await PDFDocument.create();
  const page = doc.addPage();
  const form = doc.getForm();
  const name = form.createTextField('Name');
  name.addToPage(page, { x: 10, y: 700 });
  name.setText(values.name);
  const email = form.createTextField('Email');
  email.addToPage(page, { x: 10, y: 650 });
  email.setText(values.email);
  return Buffer.from(await doc.save()).toString('base64');
}

test('PDF import: disabled add-on 404s, then template -> mapping -> submission -> list works', async () => {
  await withTestServer(async (port) => {
    const admin = await makeUserAndSession('admin');
    const member = await makeUserAndSession('mitglied');
    const headers = { 'Content-Type': 'application/json', Cookie: admin.cookie };
    const base = `http://localhost:${port}`;

    // The config row survives between runs (and test files) -- start without a template.
    await query("UPDATE pdf_import_config SET template_filename = NULL, pdf_fields = '[]', mapping = '{}'");
    await query('UPDATE app_settings SET pdf_import_enabled = false');
    const off = await fetch(`${base}/pdf-import/config`, { headers });
    assert.equal(off.status, 404);

    const on = await fetch(`${base}/app-settings`, { method: 'PUT', headers, body: JSON.stringify({ pdfImportEnabled: true }) });
    assert.equal(on.status, 200);
    assert.equal((await on.json()).pdfImportEnabled, true);

    const denied = await fetch(`${base}/pdf-import/config`, { headers: { Cookie: member.cookie } });
    assert.equal(denied.status, 403);

    const templateRes = await fetch(`${base}/pdf-import/template`, {
      method: 'POST', headers,
      body: JSON.stringify({ filename: 'vorlage.pdf', dataBase64: await makeFilledPdf({ name: '', email: '' }) }),
    });
    assert.equal(templateRes.status, 200);
    const { config, targets } = await templateRes.json();
    assert.deepEqual(config.pdfFields.map((f) => f.name).sort(), ['Email', 'Name']);
    assert.ok(targets.some((t) => t.value === 'sender:email'));

    const noMapping = await fetch(`${base}/pdf-import/submissions`, {
      method: 'POST', headers,
      body: JSON.stringify({ filename: 'a.pdf', dataBase64: await makeFilledPdf({ name: 'Busch', email: 'busch@example.com' }) }),
    });
    assert.equal(noMapping.status, 409);

    const badTarget = await fetch(`${base}/pdf-import/config`, {
      method: 'PUT', headers, body: JSON.stringify({ mapping: { Name: { target: 'bogus:thing' } } }),
    });
    assert.equal(badTarget.status, 400);

    const saved = await fetch(`${base}/pdf-import/config`, {
      method: 'PUT', headers,
      body: JSON.stringify({ mapping: { Name: { target: 'account:lastName' }, Email: { target: 'sender:email' } }, emailEnabled: true }),
    });
    assert.equal(saved.status, 200);

    const uploaded = await fetch(`${base}/pdf-import/submissions`, {
      method: 'POST', headers,
      body: JSON.stringify({ filename: 'a.pdf', dataBase64: await makeFilledPdf({ name: 'Busch', email: 'busch@example.com' }), sendEmail: true }),
    });
    assert.equal(uploaded.status, 201);
    const { import: record, email } = await uploaded.json();
    assert.equal(record.mapped.account.lastName, 'Busch');
    assert.equal(record.mapped.sender.email, 'busch@example.com');
    assert.equal(email.sent, true);

    const list = await (await fetch(`${base}/pdf-import/submissions`, { headers })).json();
    assert.ok(list.some((r) => r.id === record.id && r.emailSentAt));

    const notPdf = await fetch(`${base}/pdf-import/submissions`, {
      method: 'POST', headers,
      body: JSON.stringify({ filename: 'x.pdf', dataBase64: Buffer.from('nope').toString('base64') }),
    });
    assert.equal(notPdf.status, 400);

    const del = await fetch(`${base}/pdf-import/submissions/${record.id}`, { method: 'DELETE', headers });
    assert.equal(del.status, 200);
  });
});

test('PDF import: DELETE /pdf-import/config clears template and mapping but keeps imports and the e-mail option', async () => {
  await withTestServer(async (port) => {
    const admin = await makeUserAndSession('admin');
    const headers = { 'Content-Type': 'application/json', Cookie: admin.cookie };
    const base = `http://localhost:${port}`;
    await query('UPDATE app_settings SET pdf_import_enabled = true');
    await fetch(`${base}/pdf-import/template`, {
      method: 'POST', headers,
      body: JSON.stringify({ filename: 'vorlage.pdf', dataBase64: await makeFilledPdf({ name: '', email: '' }) }),
    });
    await fetch(`${base}/pdf-import/config`, {
      method: 'PUT', headers,
      body: JSON.stringify({ mapping: { Name: { target: 'account:lastName' } }, emailEnabled: true }),
    });
    const uploaded = await fetch(`${base}/pdf-import/submissions`, {
      method: 'POST', headers, body: JSON.stringify({ filename: 'a.pdf', dataBase64: await makeFilledPdf({ name: 'Busch', email: 'busch@example.com' }) }),
    });
    const { import: record } = await uploaded.json();

    const cleared = await fetch(`${base}/pdf-import/config`, { method: 'DELETE', headers });
    assert.equal(cleared.status, 200);
    const { config } = await cleared.json();
    assert.equal(config.templateFilename, null);
    assert.deepEqual(config.pdfFields, []);
    assert.deepEqual(config.mapping, {});
    assert.equal(config.emailEnabled, true);

    const list = await (await fetch(`${base}/pdf-import/submissions`, { headers })).json();
    assert.ok(list.some((r) => r.id === record.id));
  });
});

test('PDF import: an import with an event becomes a registered guest account; a full account\'s e-mail is refused', async () => {
  await withTestServer(async (port) => {
    const admin = await makeUserAndSession('admin');
    const headers = { 'Content-Type': 'application/json', Cookie: admin.cookie };
    const base = `http://localhost:${port}`;
    await fetch(`${base}/app-settings`, { method: 'PUT', headers, body: JSON.stringify({ pdfImportEnabled: true, waiverText: '' }) });

    const { rows: eventRows } = await query(
      "INSERT INTO events (name, event_date, is_active) VALUES ('PDF Gast Event', '2027-08-01', true) RETURNING id"
    );
    const eventId = eventRows[0].id;

    await fetch(`${base}/pdf-import/template`, {
      method: 'POST', headers,
      body: JSON.stringify({ filename: 'vorlage.pdf', dataBase64: await makeFilledPdf({ name: '', email: '' }) }),
    });
    await fetch(`${base}/pdf-import/config`, {
      method: 'PUT', headers,
      body: JSON.stringify({ mapping: { Name: { target: 'account:lastName' }, Email: { target: 'sender:email' } } }),
    });

    const guestEmail = `pdf-guest-${crypto.randomUUID()}@example.com`;
    const res = await fetch(`${base}/pdf-import/submissions`, {
      method: 'POST', headers,
      body: JSON.stringify({ filename: 'g.pdf', dataBase64: await makeFilledPdf({ name: 'Gastmann', email: guestEmail }), eventId }),
    });
    assert.equal(res.status, 201);
    const { import: record, adoption } = await res.json();
    assert.equal(adoption.adopted, true);
    assert.ok(record.userId);

    const { rows: users } = await query('SELECT is_guest, password_hash FROM users WHERE id = $1', [record.userId]);
    assert.equal(users[0].is_guest, true);
    assert.equal(users[0].password_hash, null);
    const { rows: regs } = await query('SELECT con_role FROM registrations WHERE user_id = $1 AND event_id = $2', [record.userId, eventId]);
    assert.equal(regs[0].con_role, 'ticket'); // no character in the PDF -> plain guest ticket

    // Same guest, same event again -> reported, not duplicated.
    const again = await fetch(`${base}/pdf-import/submissions`, {
      method: 'POST', headers,
      body: JSON.stringify({ filename: 'g2.pdf', dataBase64: await makeFilledPdf({ name: 'Gastmann', email: guestEmail }), eventId }),
    });
    assert.equal((await again.json()).adoption.adopted, false);

    // An e-mail that belongs to a real account is never touched.
    const { rows: member } = await query("SELECT email FROM users WHERE id = $1", [admin.userId]);
    const conflict = await fetch(`${base}/pdf-import/submissions`, {
      method: 'POST', headers,
      body: JSON.stringify({ filename: 'c.pdf', dataBase64: await makeFilledPdf({ name: 'X', email: member[0].email }), eventId }),
    });
    const conflictBody = await conflict.json();
    assert.equal(conflictBody.adoption.adopted, false);
    assert.ok(conflictBody.import.adoptError);
  });
});

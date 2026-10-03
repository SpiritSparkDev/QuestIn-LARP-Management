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

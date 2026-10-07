import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { withTestServer } from '../testServer.js';

process.env.DATABASE_URL = process.env.TEST_DATABASE_URL
  || 'postgres://app:app@localhost:5433/pakyrion_test';
process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'a'.repeat(64);

const { runMigrations } = await import('../../db/migrate.js');
await runMigrations();

const { seedGroups } = await import('../../db/seedGroups.js');
await seedGroups();

const { query, closePool } = await import('../../backend/db.js');
const { createSession } = await import('../../backend/auth/sessions.js');

async function makeUserAndSession(groupKey) {
  const { rows } = await query(
    "INSERT INTO users (email, first_name, last_name, group_id, email_verified) VALUES ($1, 'Branding', 'Test', (SELECT id FROM groups WHERE key = $2), true) RETURNING id",
    [`app-settings-${groupKey}-${crypto.randomUUID()}@example.com`, groupKey]
  );
  const session = await createSession(rows[0].id);
  return `session=${session.token}`;
}

test('GET /app-settings requires no authentication and returns nulls when unset', async () => {
  await withTestServer(async (port) => {
    const res = await fetch(`http://localhost:${port}/app-settings`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(body, { logoUrl: null, appTitle: null, eventName: null, quotaMbPerCharacter: 100, invitationTtlDays: 3, characterBrowsingEnabled: false, waitlistAutoPromote: true, waiverText: '', waiverVersion: 1, baseUrl: null, effectiveBaseUrl: 'http://localhost:3000', comingSoonEnabled: false, comingSoonMessage: '', comingSoonUntil: null, themeMode: 'light', colorScheme: 'sahara', customColors: null, pdfImportEnabled: false, pdfExportEnabled: false, tavernEnabled: false, lodgingEnabled: false, backgroundPreset: 'grunge', backgroundOpacity: 20, unpaidReminderDays: [], hasUploadedLogo: false, hasUploadedTicketBackground: false, hasUploadedBackgroundImage: false });
  });
});

test('backgroundPreset: valid presets are saved, unknown ones and "custom" without an upload are rejected, an upload selects "custom", removing it resets', async () => {
  await withTestServer(async (port) => {
    const cookie = await makeUserAndSession('admin');
    const headers = { 'Content-Type': 'application/json', Cookie: cookie };
    const put = (body) => fetch(`http://localhost:${port}/app-settings`, { method: 'PUT', headers, body: JSON.stringify(body) });
    assert.equal((await put({ backgroundPreset: 'nope' })).status, 400);
    assert.equal((await put({ backgroundPreset: 'custom' })).status, 400);
    const saved = await put({ backgroundPreset: 'marmor' });
    assert.equal(saved.status, 200);
    assert.equal((await saved.json()).backgroundPreset, 'marmor');
    assert.equal((await (await put({ backgroundPreset: 'none' })).json()).backgroundPreset, 'none');

    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64').toString('base64');
    const upload = await fetch(`http://localhost:${port}/app-settings/background-image`, { method: 'PUT', headers, body: JSON.stringify({ dataBase64: png, mimeType: 'image/png' }) });
    assert.equal(upload.status, 200);
    assert.equal((await upload.json()).backgroundPreset, 'custom');
    assert.equal((await (await put({ backgroundPreset: 'holz' })).json()).backgroundPreset, 'holz');
    assert.equal((await (await put({ backgroundPreset: 'custom' })).json()).backgroundPreset, 'custom');
    const removed = await fetch(`http://localhost:${port}/app-settings/background-image`, { method: 'DELETE', headers });
    assert.equal((await removed.json()).backgroundPreset, 'grunge');
  });
});

test('unpaidReminderDays accepts up to 3 whole days and rejects everything else', async () => {
  await withTestServer(async (port) => {
    const cookie = await makeUserAndSession('admin');
    const put = (body) => fetch(`http://localhost:${port}/app-settings`, { method: 'PUT', headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: JSON.stringify(body) });
    for (const bad of [[0], [1, 2, 3, 4], ['3'], [1.5], [400], 5]) assert.equal((await put({ unpaidReminderDays: bad })).status, 400);
    assert.deepEqual((await (await put({ unpaidReminderDays: [3, 7, 14] })).json()).unpaidReminderDays, [3, 7, 14]);
    assert.deepEqual((await (await put({ unpaidReminderDays: [] })).json()).unpaidReminderDays, []);
  });
});

test('backgroundOpacity accepts 0 to 100 and rejects everything else', async () => {
  await withTestServer(async (port) => {
    const cookie = await makeUserAndSession('admin');
    const put = (body) => fetch(`http://localhost:${port}/app-settings`, { method: 'PUT', headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: JSON.stringify(body) });
    for (const bad of [-1, 101, 12.5, '20']) assert.equal((await put({ backgroundOpacity: bad })).status, 400);
    assert.equal((await (await put({ backgroundOpacity: 0 })).json()).backgroundOpacity, 0);
    assert.equal((await (await put({ backgroundOpacity: 35 })).json()).backgroundOpacity, 35);
    assert.equal((await (await put({ backgroundOpacity: 20 })).json()).backgroundOpacity, 20);
  });
});

test('PUT /app-settings saves and GET reflects it back, then update overwrites', async () => {
  await withTestServer(async (port) => {
    const cookie = await makeUserAndSession('admin');

    const putRes = await fetch(`http://localhost:${port}/app-settings`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ logoUrl: 'https://example.com/logo.png', appTitle: 'P17 Check-In', eventName: 'P17/2027' }),
    });
    assert.equal(putRes.status, 200);
    const putBody = await putRes.json();
    assert.equal(putBody.appTitle, 'P17 Check-In');

    const getRes = await fetch(`http://localhost:${port}/app-settings`);
    const getBody = await getRes.json();
    assert.deepEqual(getBody, { logoUrl: 'https://example.com/logo.png', appTitle: 'P17 Check-In', eventName: 'P17/2027', quotaMbPerCharacter: 100, invitationTtlDays: 3, characterBrowsingEnabled: false, waitlistAutoPromote: true, waiverText: '', waiverVersion: 1, baseUrl: null, effectiveBaseUrl: 'http://localhost:3000', comingSoonEnabled: false, comingSoonMessage: '', comingSoonUntil: null, themeMode: 'light', colorScheme: 'sahara', customColors: null, pdfImportEnabled: false, pdfExportEnabled: false, tavernEnabled: false, lodgingEnabled: false, backgroundPreset: 'grunge', backgroundOpacity: 20, unpaidReminderDays: [], hasUploadedLogo: false, hasUploadedTicketBackground: false, hasUploadedBackgroundImage: false });

    // Second PUT overwrites the same row rather than inserting a new one.
    await fetch(`http://localhost:${port}/app-settings`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ logoUrl: null, appTitle: 'Renamed', eventName: 'P17/2027' }),
    });
    const { rows } = await query('SELECT count(*)::int FROM app_settings');
    assert.equal(rows[0].count, 1);
  });
});

test('PUT /app-settings rejects a non-admin group and an unauthenticated request', async () => {
  await withTestServer(async (port) => {
    const cookie = await makeUserAndSession('mitglied');
    const asMember = await fetch(`http://localhost:${port}/app-settings`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ appTitle: 'Hijacked' }),
    });
    assert.equal(asMember.status, 403);

    const anonymous = await fetch(`http://localhost:${port}/app-settings`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ appTitle: 'Hijacked' }),
    });
    assert.equal(anonymous.status, 401);
  });
});

test('PUT /app-settings validates and saves quotaMbPerCharacter; defaults to 100', async () => {
  await withTestServer(async (port) => {
    const res = await fetch(`http://localhost:${port}/app-settings`);
    assert.equal((await res.json()).quotaMbPerCharacter, 100);

    const cookie = await makeUserAndSession('admin');
    const badRes = await fetch(`http://localhost:${port}/app-settings`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ quotaMbPerCharacter: -5 }),
    });
    assert.equal(badRes.status, 400);

    const goodRes = await fetch(`http://localhost:${port}/app-settings`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ quotaMbPerCharacter: 250 }),
    });
    assert.equal(goodRes.status, 200);
    assert.equal((await goodRes.json()).quotaMbPerCharacter, 250);
  });
});

test('PUT /app-settings validates and saves invitationTtlDays; defaults to 3', async () => {
  await withTestServer(async (port) => {
    const res = await fetch(`http://localhost:${port}/app-settings`);
    assert.equal((await res.json()).invitationTtlDays, 3);

    const cookie = await makeUserAndSession('admin');
    const badRes = await fetch(`http://localhost:${port}/app-settings`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ invitationTtlDays: 0 }),
    });
    assert.equal(badRes.status, 400);

    const nonIntRes = await fetch(`http://localhost:${port}/app-settings`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ invitationTtlDays: 1.5 }),
    });
    assert.equal(nonIntRes.status, 400);

    const goodRes = await fetch(`http://localhost:${port}/app-settings`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ invitationTtlDays: 5 }),
    });
    assert.equal(goodRes.status, 200);
    assert.equal((await goodRes.json()).invitationTtlDays, 5);

    // Set logoUrl/eventName so the next step can prove a partial update
    // (like the settings.html invitation-TTL card, which only ever sends
    // invitationTtlDays) doesn't null out unrelated columns.
    await fetch(`http://localhost:${port}/app-settings`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ logoUrl: 'https://example.com/logo.png', eventName: 'P17/2027' }),
    });

    // A subsequent partial update that omits invitationTtlDays, logoUrl, and
    // eventName must not clobber any of them.
    const partialRes = await fetch(`http://localhost:${port}/app-settings`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ appTitle: 'Still 5 days' }),
    });
    const partialBody = await partialRes.json();
    assert.equal(partialBody.invitationTtlDays, 5);
    assert.equal(partialBody.appTitle, 'Still 5 days');
    assert.equal(partialBody.logoUrl, 'https://example.com/logo.png');
    assert.equal(partialBody.eventName, 'P17/2027');
  });
});

test('PUT/GET/DELETE /app-settings/logo round-trips, validates, and clears', async () => {
  await withTestServer(async (port) => {
    const cookie = await makeUserAndSession('admin');
    const tinyPngBase64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';

    const beforeRes = await fetch(`http://localhost:${port}/app-settings`);
    assert.equal((await beforeRes.json()).hasUploadedLogo, false);

    const badMimeRes = await fetch(`http://localhost:${port}/app-settings/logo`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ dataBase64: tinyPngBase64, mimeType: 'application/pdf' }),
    });
    assert.equal(badMimeRes.status, 400);

    const nonStringRes = await fetch(`http://localhost:${port}/app-settings/logo`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ dataBase64: { length: 999999 }, mimeType: 'image/png' }),
    });
    assert.equal(nonStringRes.status, 400);

    const uploadRes = await fetch(`http://localhost:${port}/app-settings/logo`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ dataBase64: tinyPngBase64, mimeType: 'image/png' }),
    });
    assert.equal(uploadRes.status, 200);
    assert.equal((await uploadRes.json()).hasUploadedLogo, true);

    const getRes = await fetch(`http://localhost:${port}/app-settings/logo`);
    assert.equal(getRes.status, 200);
    assert.equal(getRes.headers.get('content-type'), 'image/png');
    const bytes = Buffer.from(await getRes.arrayBuffer());
    assert.deepEqual(bytes, Buffer.from(tinyPngBase64, 'base64'));

    const deleteRes = await fetch(`http://localhost:${port}/app-settings/logo`, { method: 'DELETE', headers: { Cookie: cookie } });
    assert.equal(deleteRes.status, 200);
    assert.equal((await deleteRes.json()).hasUploadedLogo, false);

    const afterDeleteRes = await fetch(`http://localhost:${port}/app-settings/logo`);
    assert.equal(afterDeleteRes.status, 404);
  });
});

test('PUT /app-settings/logo rejects a non-admin group and an unauthenticated request', async () => {
  await withTestServer(async (port) => {
    const memberCookie = await makeUserAndSession('mitglied');
    const asMember = await fetch(`http://localhost:${port}/app-settings/logo`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json', Cookie: memberCookie },
      body: JSON.stringify({ dataBase64: 'x', mimeType: 'image/png' }),
    });
    assert.equal(asMember.status, 403);

    const anonymous = await fetch(`http://localhost:${port}/app-settings/logo`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ dataBase64: 'x', mimeType: 'image/png' }),
    });
    assert.equal(anonymous.status, 401);
  });
});

test('PUT/GET/DELETE /app-settings/ticket-background round-trips, validates, and clears', async () => {
  await withTestServer(async (port) => {
    const cookie = await makeUserAndSession('admin');
    const tinyPngBase64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';

    const beforeRes = await fetch(`http://localhost:${port}/app-settings`);
    assert.equal((await beforeRes.json()).hasUploadedTicketBackground, false);

    const badMimeRes = await fetch(`http://localhost:${port}/app-settings/ticket-background`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ dataBase64: tinyPngBase64, mimeType: 'application/pdf' }),
    });
    assert.equal(badMimeRes.status, 400);

    const uploadRes = await fetch(`http://localhost:${port}/app-settings/ticket-background`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ dataBase64: tinyPngBase64, mimeType: 'image/png' }),
    });
    assert.equal(uploadRes.status, 200);
    assert.equal((await uploadRes.json()).hasUploadedTicketBackground, true);

    const getRes = await fetch(`http://localhost:${port}/app-settings/ticket-background`);
    assert.equal(getRes.status, 200);
    assert.equal(getRes.headers.get('content-type'), 'image/png');
    const bytes = Buffer.from(await getRes.arrayBuffer());
    assert.deepEqual(bytes, Buffer.from(tinyPngBase64, 'base64'));

    const deleteRes = await fetch(`http://localhost:${port}/app-settings/ticket-background`, { method: 'DELETE', headers: { Cookie: cookie } });
    assert.equal(deleteRes.status, 200);
    assert.equal((await deleteRes.json()).hasUploadedTicketBackground, false);

    const afterDeleteRes = await fetch(`http://localhost:${port}/app-settings/ticket-background`);
    assert.equal(afterDeleteRes.status, 404);
  });
});

test('PUT /app-settings/ticket-background rejects a non-admin group and an unauthenticated request', async () => {
  await withTestServer(async (port) => {
    const memberCookie = await makeUserAndSession('mitglied');
    const asMember = await fetch(`http://localhost:${port}/app-settings/ticket-background`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json', Cookie: memberCookie },
      body: JSON.stringify({ dataBase64: 'x', mimeType: 'image/png' }),
    });
    assert.equal(asMember.status, 403);

    const anonymous = await fetch(`http://localhost:${port}/app-settings/ticket-background`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ dataBase64: 'x', mimeType: 'image/png' }),
    });
    assert.equal(anonymous.status, 401);
  });
});

test('PUT /app-settings can change characterBrowsingEnabled independently of other fields', async () => {
  await withTestServer(async (port) => {
    const cookie = await makeUserAndSession('admin');

    const enableRes = await fetch(`http://localhost:${port}/app-settings`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ characterBrowsingEnabled: true }),
    });
    assert.equal(enableRes.status, 200);
    assert.equal((await enableRes.json()).characterBrowsingEnabled, true);

    // Restore the default (off) so this doesn't leak enabled state into
    // later tests/files sharing the same single-row app_settings table.
    const disableRes = await fetch(`http://localhost:${port}/app-settings`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ characterBrowsingEnabled: false }),
    });
    assert.equal((await disableRes.json()).characterBrowsingEnabled, false);
  });
});

test('PUT /app-settings sets waitlistAutoPromote without touching unrelated fields (COALESCE regression)', async () => {
  await withTestServer(async (port) => {
    const cookie = await makeUserAndSession('admin');

    await fetch(`http://localhost:${port}/app-settings`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ appTitle: 'Vor der Änderung', eventName: 'P17/2027' }),
    });

    const putRes = await fetch(`http://localhost:${port}/app-settings`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ waitlistAutoPromote: false }),
    });
    assert.equal(putRes.status, 200);
    const body = await putRes.json();
    assert.equal(body.waitlistAutoPromote, false);
    // The unrelated fields from the earlier PUT must survive untouched.
    assert.equal(body.appTitle, 'Vor der Änderung');
    assert.equal(body.eventName, 'P17/2027');
  });
});

test('PUT /app-settings rejects a non-boolean waitlistAutoPromote', async () => {
  await withTestServer(async (port) => {
    const cookie = await makeUserAndSession('admin');
    const res = await fetch(`http://localhost:${port}/app-settings`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ waitlistAutoPromote: 'yes' }),
    });
    assert.equal(res.status, 400);
  });
});

test('PUT /app-settings auto-bumps waiverVersion only when the text actually changes', async () => {
  await withTestServer(async (port) => {
    const cookie = await makeUserAndSession('admin');

    const first = await fetch(`http://localhost:${port}/app-settings`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ waiverText: 'Ich nehme auf eigene Gefahr teil.' }),
    });
    const firstBody = await first.json();
    assert.equal(firstBody.waiverText, 'Ich nehme auf eigene Gefahr teil.');
    assert.equal(firstBody.waiverVersion, 2);

    // Saving something else entirely must not re-bump the version.
    const unrelated = await fetch(`http://localhost:${port}/app-settings`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ appTitle: 'Unrelated change' }),
    });
    assert.equal((await unrelated.json()).waiverVersion, 2);

    // Saving the identical text again must not re-bump the version either.
    const sameText = await fetch(`http://localhost:${port}/app-settings`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ waiverText: 'Ich nehme auf eigene Gefahr teil.' }),
    });
    assert.equal((await sameText.json()).waiverVersion, 2);

    // A real wording change bumps it again.
    const changed = await fetch(`http://localhost:${port}/app-settings`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ waiverText: 'Neuer Text.' }),
    });
    assert.equal((await changed.json()).waiverVersion, 3);
  });
});

test('PUT /app-settings rejects a non-string waiverText', async () => {
  await withTestServer(async (port) => {
    const cookie = await makeUserAndSession('admin');
    const res = await fetch(`http://localhost:${port}/app-settings`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ waiverText: 42 }),
    });
    assert.equal(res.status, 400);
  });
});

test('PUT /app-settings saves comingSoonEnabled/comingSoonMessage/comingSoonUntil and GET reflects it back', async () => {
  await withTestServer(async (port) => {
    const cookie = await makeUserAndSession('admin');
    const until = new Date(Date.now() + 86400000).toISOString();

    const putRes = await fetch(`http://localhost:${port}/app-settings`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ comingSoonEnabled: true, comingSoonMessage: '<p>Bald geht es los!</p>', comingSoonUntil: until }),
    });
    assert.equal(putRes.status, 200);
    const body = await putRes.json();
    assert.equal(body.comingSoonEnabled, true);
    assert.equal(body.comingSoonMessage, '<p>Bald geht es los!</p>');
    assert.equal(new Date(body.comingSoonUntil).toISOString(), until);

    const getBody = await (await fetch(`http://localhost:${port}/app-settings`)).json();
    assert.equal(getBody.comingSoonEnabled, true);
    assert.equal(getBody.comingSoonMessage, '<p>Bald geht es los!</p>');
    assert.equal(new Date(getBody.comingSoonUntil).toISOString(), until);
  });
});

test('PUT /app-settings clears comingSoonUntil with an empty string, independently of comingSoonEnabled', async () => {
  await withTestServer(async (port) => {
    const cookie = await makeUserAndSession('admin');
    await fetch(`http://localhost:${port}/app-settings`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ comingSoonEnabled: true, comingSoonUntil: new Date(Date.now() + 1000).toISOString() }),
    });

    const res = await fetch(`http://localhost:${port}/app-settings`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ comingSoonUntil: '' }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.comingSoonUntil, null);
    assert.equal(body.comingSoonEnabled, true);
  });
});

test('PUT /app-settings rejects a non-boolean comingSoonEnabled, a non-string comingSoonMessage, and an invalid comingSoonUntil', async () => {
  await withTestServer(async (port) => {
    const cookie = await makeUserAndSession('admin');

    const badEnabled = await fetch(`http://localhost:${port}/app-settings`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ comingSoonEnabled: 'yes' }),
    });
    assert.equal(badEnabled.status, 400);

    const badMessage = await fetch(`http://localhost:${port}/app-settings`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ comingSoonMessage: 42 }),
    });
    assert.equal(badMessage.status, 400);

    const badUntil = await fetch(`http://localhost:${port}/app-settings`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ comingSoonUntil: 'not-a-date' }),
    });
    assert.equal(badUntil.status, 400);
  });
});

test('PUT/GET/DELETE /app-settings/background-image round-trips, validates, and clears', async () => {
  await withTestServer(async (port) => {
    const cookie = await makeUserAndSession('admin');
    const tinyPngBase64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';

    const beforeRes = await fetch(`http://localhost:${port}/app-settings`);
    assert.equal((await beforeRes.json()).hasUploadedBackgroundImage, false);

    const badMimeRes = await fetch(`http://localhost:${port}/app-settings/background-image`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ dataBase64: tinyPngBase64, mimeType: 'application/pdf' }),
    });
    assert.equal(badMimeRes.status, 400);

    const uploadRes = await fetch(`http://localhost:${port}/app-settings/background-image`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ dataBase64: tinyPngBase64, mimeType: 'image/png' }),
    });
    assert.equal(uploadRes.status, 200);
    assert.equal((await uploadRes.json()).hasUploadedBackgroundImage, true);

    const getRes = await fetch(`http://localhost:${port}/app-settings/background-image`);
    assert.equal(getRes.status, 200);
    assert.equal(getRes.headers.get('content-type'), 'image/png');
    const bytes = Buffer.from(await getRes.arrayBuffer());
    assert.deepEqual(bytes, Buffer.from(tinyPngBase64, 'base64'));

    const deleteRes = await fetch(`http://localhost:${port}/app-settings/background-image`, { method: 'DELETE', headers: { Cookie: cookie } });
    assert.equal(deleteRes.status, 200);
    assert.equal((await deleteRes.json()).hasUploadedBackgroundImage, false);

    const afterDeleteRes = await fetch(`http://localhost:${port}/app-settings/background-image`);
    assert.equal(afterDeleteRes.status, 404);
  });
});

test('PUT /app-settings/background-image rejects a non-admin group and an unauthenticated request', async () => {
  await withTestServer(async (port) => {
    const memberCookie = await makeUserAndSession('mitglied');
    const asMember = await fetch(`http://localhost:${port}/app-settings/background-image`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json', Cookie: memberCookie },
      body: JSON.stringify({ dataBase64: 'x', mimeType: 'image/png' }),
    });
    assert.equal(asMember.status, 403);

    const anonymous = await fetch(`http://localhost:${port}/app-settings/background-image`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ dataBase64: 'x', mimeType: 'image/png' }),
    });
    assert.equal(anonymous.status, 401);
  });
});

test('PUT /app-settings saves themeMode and colorScheme, rejecting unknown values', async () => {
  await withTestServer(async (port) => {
    const cookie = await makeUserAndSession('admin');

    const badTheme = await fetch(`http://localhost:${port}/app-settings`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ themeMode: 'blue' }),
    });
    assert.equal(badTheme.status, 400);

    const badScheme = await fetch(`http://localhost:${port}/app-settings`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ colorScheme: 'space' }),
    });
    assert.equal(badScheme.status, 400);

    const goodRes = await fetch(`http://localhost:${port}/app-settings`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ themeMode: 'dark', colorScheme: 'ozean' }),
    });
    assert.equal(goodRes.status, 200);
    const body = await goodRes.json();
    assert.equal(body.themeMode, 'dark');
    assert.equal(body.colorScheme, 'ozean');

    const getBody = await (await fetch(`http://localhost:${port}/app-settings`)).json();
    assert.equal(getBody.themeMode, 'dark');
    assert.equal(getBody.colorScheme, 'ozean');

    const intenseRes = await fetch(`http://localhost:${port}/app-settings`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ colorScheme: 'horror-intensiv' }),
    });
    assert.equal(intenseRes.status, 200);
    assert.equal((await intenseRes.json()).colorScheme, 'horror-intensiv');

    // Reset so this doesn't leak into later tests/files sharing the same row.
    await fetch(`http://localhost:${port}/app-settings`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ themeMode: 'light', colorScheme: 'sahara' }),
    });
  });
});

test('PUT /app-settings saves and clears customColors, rejecting unknown keys and non-hex values', async () => {
  await withTestServer(async (port) => {
    const cookie = await makeUserAndSession('admin');

    const unknownKeyRes = await fetch(`http://localhost:${port}/app-settings`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ customColors: { background: '#112233' } }),
    });
    assert.equal(unknownKeyRes.status, 400);

    const badHexRes = await fetch(`http://localhost:${port}/app-settings`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ customColors: { primary: 'orange' } }),
    });
    assert.equal(badHexRes.status, 400);

    const goodRes = await fetch(`http://localhost:${port}/app-settings`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ colorScheme: 'custom', customColors: { primary: '#112233', 'on-primary': '#ffffff' } }),
    });
    assert.equal(goodRes.status, 200);
    const body = await goodRes.json();
    assert.deepEqual(body.customColors, { primary: '#112233', 'on-primary': '#ffffff' });

    // A later PUT that omits customColors must not clear the stored palette.
    const untouchedRes = await fetch(`http://localhost:${port}/app-settings`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ appTitle: 'Still custom' }),
    });
    assert.deepEqual((await untouchedRes.json()).customColors, { primary: '#112233', 'on-primary': '#ffffff' });

    // Explicit null clears it back out.
    const clearedRes = await fetch(`http://localhost:${port}/app-settings`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ colorScheme: 'sahara', customColors: null }),
    });
    assert.equal((await clearedRes.json()).customColors, null);
  });
});

test.after(async () => {
  await query("DELETE FROM users WHERE email LIKE 'app-settings-%'");
  await query('DELETE FROM app_settings');
  await closePool();
});

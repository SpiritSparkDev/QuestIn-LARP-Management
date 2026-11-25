import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { withTestServer } from '../testServer.js';

process.env.DATABASE_URL = process.env.TEST_DATABASE_URL
  || 'postgres://app:app@localhost:5433/pakyrion_test';
process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'a'.repeat(64);
delete process.env.SMTP_HOST;
delete process.env.APP_MODE;

const { runMigrations } = await import('../../db/migrate.js');
await runMigrations();
const { seedGroups } = await import('../../db/seedGroups.js');
await seedGroups();
const { query, closePool } = await import('../../backend/db.js');
const { refreshHubDirectory, sanitizeDirectory } = await import('../../backend/hubDirectory/client.js');

after(() => closePool());

async function makeUserAndSession(groupKey) {
  const { rows } = await query(
    "INSERT INTO users (email, first_name, last_name, group_id, email_verified) VALUES ($1, 'Hub', 'Test', (SELECT id FROM groups WHERE key = $2), true) RETURNING id",
    [`hub-${groupKey}-${crypto.randomUUID()}@example.com`, groupKey]
  );
  const { createSession } = await import('../../backend/auth/sessions.js');
  const session = await createSession(rows[0].id);
  return `session=${session.token}`;
}

const fakeFetch = (handler) => async (url, init) => {
  const { status = 200, body = '' } = await handler(url, init);
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });
};

test('only published, non-test, not ended, upcoming events appear in the public feed', async () => {
  await withTestServer(async (port) => {
    const admin = await makeUserAndSession('admin');
    const tag = crypto.randomUUID().slice(0, 8);
    const create = async (name, eventDate, extra = {}) => {
      const res = await fetch(`http://localhost:${port}/events`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: admin },
        body: JSON.stringify({ name: `${name} ${tag}`, eventDate, color: '#aa5500', ...extra }),
      });
      assert.equal(res.status, 201);
      return res.json();
    };
    const published = await create('Veröffentlicht', '2099-05-01', { directoryPublished: true, endDate: '2099-05-03', address: 'Geheimer Hof 1' });
    assert.equal(published.directory_published, true);
    await create('Nicht veröffentlicht', '2099-05-02');
    await create('Vergangen', '2000-01-01', { directoryPublished: true });
    const test = await create('Testevent', '2099-05-04', { directoryPublished: true });
    await query('UPDATE events SET is_test = true WHERE id = $1', [test.id]);
    const ended = await create('Beendet', '2099-05-05', { directoryPublished: true });
    await query('UPDATE events SET ended_at = now() WHERE id = $1', [ended.id]);

    const bad = await fetch(`http://localhost:${port}/events/${published.id}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json', Cookie: admin }, body: JSON.stringify({ directoryPublished: 'ja' }),
    });
    assert.equal(bad.status, 400);

    const res = await fetch(`http://localhost:${port}/public/directory/events.json`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('access-control-allow-origin'), '*');
    const feed = await res.json();
    assert.equal(feed.version, 1);
    const mine = feed.events.filter((e) => e.name.endsWith(tag));
    assert.deepEqual(mine.map((e) => e.name), [`Veröffentlicht ${tag}`]);
    assert.equal(mine[0].endDate, '2099-05-03');
    assert.equal(mine[0].color, '#aa5500');
    assert.equal(mine[0].location, null, 'address must not be published');
    assert.match(mine[0].url, /^https?:\/\/[^/]+\/$/);

    // Unpublishing removes it again.
    const put = await fetch(`http://localhost:${port}/events/${published.id}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json', Cookie: admin }, body: JSON.stringify({ directoryPublished: false }),
    });
    assert.equal(put.status, 200);
    assert.equal((await put.json()).directory_published, false);
    const after = await (await fetch(`http://localhost:${port}/public/directory/events.json`)).json();
    assert.equal(after.events.filter((e) => e.name.endsWith(tag)).length, 0);
  });
});

test('feed v1.1: Region, Genres, Anmeldestart, Platzstatus und Preis ab', async () => {
  await withTestServer(async (port) => {
    const admin = await makeUserAndSession('admin');
    const tag = crypto.randomUUID().slice(0, 8);
    const headers = { 'Content-Type': 'application/json', Cookie: admin };
    const post = (body) => fetch(`http://localhost:${port}/events`, { method: 'POST', headers, body: JSON.stringify({ eventDate: '2099-06-01', directoryPublished: true, ...body }) });
    const pricing = { groups: ['Normal', 'Ermäßigt'], tiers: [{ name: 'Früh', until: null, amounts: { Normal: 9000, 'Ermäßigt': 6500 } }] };

    assert.equal((await post({ name: `X ${tag}`, directoryRegion: 'DE-XX' })).status, 400);
    assert.equal((await post({ name: `X ${tag}`, directoryGenres: ['fantasy', 'krimi'] })).status, 400);
    assert.equal((await post({ name: `X ${tag}`, directoryGenres: ['fantasy', 'horror', 'endzeit', 'scifi'] })).status, 400);
    assert.equal((await post({ name: `X ${tag}`, registrationOpensAt: 'morgen' })).status, 400);

    const open = await (await post({ name: `Offen ${tag}`, directoryRegion: 'DE-NW', directoryGenres: ['fantasy', 'mittelalter'], pricing })).json();
    assert.equal(open.directory_region, 'DE-NW');
    const soon = await (await post({ name: `Bald ${tag}`, registrationOpensAt: '2099-01-01T18:00:00.000Z', capacity: 10 })).json();
    const full = await (await post({ name: `Voll ${tag}`, capacity: 1 })).json();
    const { rows: [u] } = await query("INSERT INTO users (email, first_name, last_name, group_id) VALUES ($1, 'V', 'Oll', (SELECT id FROM groups WHERE key = 'mitglied')) RETURNING id", [`voll-${tag}@example.com`]);
    await query("INSERT INTO registrations (user_id, event_id, con_role, status) VALUES ($1, $2, 'ticket', 'confirmed')", [u.id, full.id]);

    const feed = await (await fetch(`http://localhost:${port}/public/directory/events.json`)).json();
    const byName = Object.fromEntries(feed.events.filter((e) => e.name.endsWith(tag)).map((e) => [e.name.split(' ')[0], e]));
    assert.equal(byName.Offen.region, 'DE-NW');
    assert.deepEqual(byName.Offen.genres, ['fantasy', 'mittelalter']);
    assert.equal(byName.Offen.priceFromCents, 6500);
    assert.equal(byName.Offen.availability, 'open');
    assert.equal(byName.Offen.registrationOpensAt, null);
    assert.equal(byName.Bald.availability, 'closed');
    assert.equal(byName.Bald.registrationOpensAt, '2099-01-01T18:00:00.000Z');
    assert.equal(byName.Voll.availability, 'waitlist');
    assert.equal(byName.Voll.priceFromCents, null);

    // Zurücksetzen per PUT.
    const put = await fetch(`http://localhost:${port}/events/${open.id}`, { method: 'PUT', headers, body: JSON.stringify({ directoryRegion: null, directoryGenres: [] }) });
    assert.equal(put.status, 200);
    const after = await put.json();
    assert.equal(after.directory_region, null);
    assert.deepEqual(after.directory_genres, []);
    assert.equal(soon.registration_opens_at !== null, true);
  });
});

test('feed v1.2: Kurzbeschreibung und Titelbild', async () => {
  await withTestServer(async (port) => {
    const base = `http://localhost:${port}`;
    const admin = await makeUserAndSession('admin');
    const member = await makeUserAndSession('mitglied');
    const tag = crypto.randomUUID().slice(0, 8);
    const headers = { 'Content-Type': 'application/json', Cookie: admin };
    const post = (body) => fetch(`${base}/events`, { method: 'POST', headers, body: JSON.stringify({ eventDate: '2099-07-01', ...body }) });
    assert.equal((await post({ name: `X ${tag}`, directoryTeaser: 'x'.repeat(301) })).status, 400);
    const ev = await (await post({ name: `Schau ${tag}`, directoryPublished: true, directoryTeaser: '  Drei Tage Nebel.  ' })).json();
    assert.equal(ev.directory_teaser, 'Drei Tage Nebel.');
    assert.equal(ev.has_directory_image, false);

    const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), crypto.randomBytes(64)]);
    const upload = (cookie, data) => fetch(`${base}/events/${ev.id}/directory-image`, { method: 'PUT', headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: JSON.stringify({ dataBase64: data.toString('base64') }) });
    assert.equal((await upload(member, png)).status, 403);
    assert.equal((await upload(admin, Buffer.from('<svg onload="x"/>'))).status, 400, 'no SVG');
    assert.equal((await upload(admin, Buffer.concat([png, Buffer.alloc(1024 * 1024)]))).status, 413);
    const saved = await upload(admin, png);
    assert.equal(saved.status, 200);
    assert.equal((await saved.json()).has_directory_image, true);

    let feed = (await (await fetch(`${base}/public/directory/events.json`)).json()).events.find((e) => e.id === ev.id);
    assert.equal(feed.teaser, 'Drei Tage Nebel.');
    const url = new URL(feed.imageUrl);
    assert.match(url.pathname, new RegExp(`/public/directory/events/${ev.id}/image$`));
    assert.match(url.search, /^\?v=\d+$/);
    const img = await fetch(`${base}${url.pathname}${url.search}`);
    assert.equal(img.headers.get('content-type'), 'image/png');
    assert.deepEqual(Buffer.from(await img.arrayBuffer()), png);

    // Nicht veröffentlicht: kein öffentliches Bild, Vorschau nur für das Event-Team.
    await fetch(`${base}/events/${ev.id}`, { method: 'PUT', headers, body: JSON.stringify({ directoryPublished: false }) });
    assert.equal((await fetch(`${base}/public/directory/events/${ev.id}/image`)).status, 404);
    assert.equal((await fetch(`${base}/events/${ev.id}/directory-image`, { headers: { Cookie: admin } })).status, 200);
    assert.notEqual((await fetch(`${base}/events/${ev.id}/directory-image`, { headers: { Cookie: member } })).status, 200);
    await fetch(`${base}/events/${ev.id}`, { method: 'PUT', headers, body: JSON.stringify({ directoryPublished: true }) });

    const removed = await fetch(`${base}/events/${ev.id}/directory-image`, { method: 'DELETE', headers: { Cookie: admin } });
    assert.equal((await removed.json()).has_directory_image, false);
    feed = (await (await fetch(`${base}/public/directory/events.json`)).json()).events.find((e) => e.id === ev.id);
    assert.equal(feed.imageUrl, null);
  });
});

test('sanitizeDirectory drops own and malformed events', () => {
  const events = sanitizeDirectory({ version: 1, events: [
    { org: 'Orga B', name: 'Con', startDate: '2099-01-01', url: 'https://b.questin.de/', color: '#123456' },
    { org: 'Wir', name: 'Eigene', startDate: '2099-01-01', url: 'https://a.questin.de/' },
    { org: 'X', name: 'Böse', startDate: '2099-01-01', url: 'javascript:alert(1)' },
    { org: 'X', name: 'Ohne Datum', url: 'https://x.example/' },
    { org: 'X', name: 'Farbe', startDate: '2099-01-01', url: 'https://x.example/', color: 'red;background:url(x)' },
  ] }, 'https://a.questin.de');
  assert.deepEqual(events.map((e) => e.name), ['Con', 'Farbe']);
  assert.equal(events[1].color, null);
  assert.throws(() => sanitizeDirectory({ version: 2, events: [] }, null));
});

test('hub directory is cached, kept on errors and only shown when HUB_URL is set', async () => {
  await withTestServer(async (port) => {
    const member = await makeUserAndSession('mitglied');
    const get = async () => (await fetch(`http://localhost:${port}/hub-directory`, { headers: { Cookie: member } })).json();

    delete process.env.HUB_URL;
    assert.deepEqual(await get(), { enabled: false, events: [] });
    assert.deepEqual(await refreshHubDirectory(), { skipped: true });

    process.env.HUB_URL = 'https://questin.de';
    try {
      let calledUrl;
      const ok = await refreshHubDirectory(fakeFetch((url) => {
        calledUrl = url;
        return { body: { version: 1, events: [
          { org: 'Orga B', name: 'Zukunft', startDate: '2099-03-01', url: 'https://b.questin.de/' },
          { org: 'Orga B', name: 'Vorbei', startDate: '2000-03-01', url: 'https://b.questin.de/' },
        ] } };
      }));
      assert.equal(calledUrl, 'https://questin.de/directory.json');
      assert.deepEqual(ok, { ok: true, count: 2 });
      let data = await get();
      assert.equal(data.enabled, true);
      assert.deepEqual(data.events.map((e) => e.name), ['Zukunft'], 'past events are filtered when read');
      assert.ok(data.updatedAt);

      const failed = await refreshHubDirectory(fakeFetch(() => ({ status: 502 })));
      assert.equal(failed.ok, false);
      data = await get();
      assert.deepEqual(data.events.map((e) => e.name), ['Zukunft'], 'last good state is kept');

      const anon = await fetch(`http://localhost:${port}/hub-directory`);
      assert.equal(anon.status, 401);
    } finally {
      delete process.env.HUB_URL;
    }
  });
});

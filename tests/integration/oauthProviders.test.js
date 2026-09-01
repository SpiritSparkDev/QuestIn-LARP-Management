import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withTestServer } from '../testServer.js';

process.env.DATABASE_URL = process.env.TEST_DATABASE_URL
  || 'postgres://app:app@localhost:5433/pakyrion_test';
process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'a'.repeat(64);
process.env.GOOGLE_CLIENT_ID = 'test-google-client-id';
process.env.GOOGLE_CLIENT_SECRET = 'test-google-client-secret';
process.env.FACEBOOK_CLIENT_ID = 'test-facebook-client-id';
delete process.env.FACEBOOK_CLIENT_SECRET;
delete process.env.DISCORD_CLIENT_ID;
delete process.env.DISCORD_CLIENT_SECRET;
delete process.env.SMTP_HOST;

const { runMigrations } = await import('../../db/migrate.js');
await runMigrations();

const { seedGroups } = await import('../../db/seedGroups.js');
await seedGroups();

const { closePool } = await import('../../backend/db.js');

test('GET /auth/oauth/providers reports which providers are configured, without leaking secrets', async () => {
  await withTestServer(async (port) => {
    const res = await fetch(`http://localhost:${port}/auth/oauth/providers`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.google, true);
    assert.equal(body.facebook, false, 'facebook has only a client id, no secret — must still report unconfigured');
    assert.equal(body.discord, false);
    assert.ok(!JSON.stringify(body).includes('test-google-client-id'));
    assert.ok(!JSON.stringify(body).includes('test-google-client-secret'));
    assert.ok(!JSON.stringify(body).includes('test-facebook-client-id'));
  });
});

test('GET /auth/oauth/providers requires no authentication', async () => {
  await withTestServer(async (port) => {
    // No Cookie header at all — must still succeed, since the login page
    // itself calls this before any session exists.
    const res = await fetch(`http://localhost:${port}/auth/oauth/providers`);
    assert.equal(res.status, 200);
  });
});

test.after(async () => {
  await closePool();
});

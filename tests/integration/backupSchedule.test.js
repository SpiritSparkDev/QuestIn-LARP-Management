import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
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
const { open } = await import('../../backend/offlinePackage/container.js');
const { isDue, runScheduledBackupIfDue, pruneLocal } = await import('../../backend/backup/schedule.js');
const { getBackupSettings, getBackupSettingsForUse, setBackupSettings, saveScheduleState } = await import('../../backend/backup/targets.js');

after(async () => {
  await query('DELETE FROM backup_settings');
  await closePool();
});

async function makeSession(groupKey) {
  const { rows } = await query(
    "INSERT INTO users (email, first_name, last_name, group_id, email_verified) VALUES ($1, 'Sched', 'Test', (SELECT id FROM groups WHERE key = $2), true) RETURNING id",
    [`backup-sched-${crypto.randomUUID()}@example.com`, groupKey]
  );
  return { cookie: `session=${(await createSession(rows[0].id)).token}` };
}

// 2027-03-10 is a Wednesday; Berlin is UTC+1 then, so 03:00 Berlin = 02:00 UTC.
const at = (iso) => new Date(iso);
const base = { enabled: true, passphrase: 'geheim-1234', targets: ['local'], every: 'day', time: '03:00' };

test('isDue: daily at the chosen time (Berlin), once per day; weekly only on the chosen weekday; off without passphrase/targets', () => {
  assert.equal(isDue({ ...base, lastRunAt: null }, at('2027-03-10T01:30:00Z')), false); // 02:30 Berlin, too early
  assert.equal(isDue({ ...base, lastRunAt: null }, at('2027-03-10T02:00:00Z')), true);
  assert.equal(isDue({ ...base, lastRunAt: '2027-03-10T02:00:30Z' }, at('2027-03-10T10:00:00Z')), false); // already ran today
  assert.equal(isDue({ ...base, lastRunAt: '2027-03-09T02:00:00Z' }, at('2027-03-10T02:00:00Z')), true);

  const weekly = { ...base, every: 'week', weekday: 3, lastRunAt: '2027-03-03T02:00:00Z' }; // Wednesday
  assert.equal(isDue(weekly, at('2027-03-10T02:00:00Z')), true);
  assert.equal(isDue(weekly, at('2027-03-11T02:00:00Z')), false); // Thursday

  assert.equal(isDue({ ...base, enabled: false }, at('2027-03-10T05:00:00Z')), false);
  assert.equal(isDue({ ...base, passphrase: '' }, at('2027-03-10T05:00:00Z')), false);
  assert.equal(isDue({ ...base, targets: [] }, at('2027-03-10T05:00:00Z')), false);
});

test('schedule settings: admin only, validated, passphrase is never returned', async () => {
  await query('DELETE FROM backup_settings');
  await withTestServer(async (port) => {
    const url = `http://localhost:${port}/backup/settings`;
    const admin = await makeSession('admin');
    const member = await makeSession('mitglied');
    const put = (cookie, schedule) => fetch(url, { method: 'PUT', headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: JSON.stringify({ schedule }) });

    assert.equal((await put(member.cookie, { enabled: false })).status, 403);
    assert.equal((await put(admin.cookie, { enabled: true, targets: ['local'] })).status, 400); // needs a passphrase
    assert.equal((await put(admin.cookie, { passphrase: 'kurz' })).status, 400);
    assert.equal((await put(admin.cookie, { time: '25:99' })).status, 400);
    assert.equal((await put(admin.cookie, { targets: ['ftp'] })).status, 400);
    assert.equal((await put(admin.cookie, { scope: 'nope' })).status, 400);

    const ok = await put(admin.cookie, { enabled: true, every: 'day', time: '04:30', scope: 'all', targets: ['local'], keep: 5, passphrase: 'geheim-1234' });
    assert.equal(ok.status, 200);
    const shown = (await ok.json()).schedule;
    assert.equal(shown.enabled, true);
    assert.equal(shown.time, '04:30');
    assert.equal(shown.hasPassphrase, true);
    assert.equal(JSON.stringify(shown).includes('geheim-1234'), false);
    // switched on just now: not due until the next slot
    assert.ok(shown.lastRunAt);

    // a blank passphrase keeps the stored one
    await put(admin.cookie, { time: '05:00', passphrase: '' });
    assert.equal((await getBackupSettingsForUse()).schedule.passphrase, 'geheim-1234');
    assert.equal((await getBackupSettings()).schedule.time, '05:00');
  });
});

test('a due schedule writes an encrypted backup to the server folder, logs it, prunes old files, and runs only once a day', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qsched-'));
  process.env.BACKUP_LOCAL_DIR = dir;
  try {
    await query('DELETE FROM backup_settings');
    await setBackupSettings({ schedule: { enabled: true, every: 'day', time: '03:00', scope: 'events', targets: ['local'], keep: 2, passphrase: 'geheim-1234' } });
    // pretend the schedule was switched on a few days ago and old files exist
    await saveScheduleState({ lastRunAt: '2027-03-01T02:00:00Z' });
    for (const stamp of ['202601010300', '202601020300', '202601030300']) fs.writeFileSync(path.join(dir, `questin-backup-events-${stamp}.qbak`), 'old');

    const first = await runScheduledBackupIfDue(at('2027-03-10T03:00:00Z'));
    assert.equal(first.lastStatus, 'ok');
    const files = fs.readdirSync(dir).filter((n) => n.endsWith('.qbak'));
    assert.equal(files.length, 2); // newest 2 kept: the old ones are pruned
    const newest = files.sort().pop();
    const { manifest } = open(fs.readFileSync(path.join(dir, newest)), 'geheim-1234');
    assert.equal(manifest.kind, 'backup');

    const { rows } = await query("SELECT details FROM audit_log WHERE action = 'backup.created' ORDER BY created_at DESC LIMIT 1");
    assert.equal(rows[0].details.scheduled, true);
    assert.equal((await getBackupSettings()).schedule.lastStatus, 'ok');

    // the same day: nothing again
    assert.equal(await runScheduledBackupIfDue(at('2027-03-10T09:00:00Z')), null);
    assert.equal(await pruneLocal('events', 100), 0);
  } finally {
    delete process.env.BACKUP_LOCAL_DIR;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a failing target is reported, not thrown, and the run is still recorded', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qsched-'));
  process.env.BACKUP_LOCAL_DIR = dir;
  try {
    await query('DELETE FROM backup_settings');
    await setBackupSettings({ schedule: { enabled: true, every: 'day', time: '03:00', scope: 'events', targets: ['sftp'], passphrase: 'geheim-1234' } });
    await saveScheduleState({ lastRunAt: '2027-03-01T02:00:00Z' });
    const result = await runScheduledBackupIfDue(at('2027-03-10T03:00:00Z'));
    assert.equal(result.lastStatus, 'partial'); // SFTP is not set up
    assert.match(result.lastError, /sftp/);
  } finally {
    delete process.env.BACKUP_LOCAL_DIR;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

import fs from 'node:fs/promises';
import path from 'node:path';
import { buildBackup } from './dump.js';
import { seal } from '../offlinePackage/container.js';
import { TARGETS, deliver, localDir, getBackupSettingsForUse, saveScheduleState } from './targets.js';
import { logAudit } from '../audit/repository.js';
import { logger } from '../logger.js';

const TIME_ZONE = 'Europe/Berlin';

// Wall-clock parts in the organisers' time zone (the server itself runs in UTC).
export function berlinParts(date) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', {
    timeZone: TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23', weekday: 'short',
  }).formatToParts(date).map((p) => [p.type, p.value]));
  const weekday = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(parts.weekday);
  return { dateKey: `${parts.year}-${parts.month}-${parts.day}`, minutes: Number(parts.hour) * 60 + Number(parts.minute), weekday };
}

// Is a scheduled backup due at `now`? Once per calendar day (or on the chosen weekday) at/after the chosen time.
// A day that was missed completely (server down) is not caught up; the next slot simply runs.
export function isDue(schedule, now = new Date()) {
  if (!schedule?.enabled || !schedule.passphrase || !(schedule.targets ?? []).length) return false;
  const [hour, minute] = String(schedule.time ?? '03:00').split(':').map(Number);
  const here = berlinParts(now);
  if (here.minutes < hour * 60 + minute) return false;
  if (schedule.every === 'week' && here.weekday !== Number(schedule.weekday ?? 1)) return false;
  if (!schedule.lastRunAt) return true;
  return berlinParts(new Date(schedule.lastRunAt)).dateKey < here.dateKey;
}

// Creates one backup, seals it with the passphrase and hands it to the targets (one failing target does not stop
// the others). Used by the manual export and the schedule.
export async function createAndDeliver({ scope, passphrase, targets }) {
  const backup = await buildBackup(scope);
  const file = seal(backup, passphrase);
  const stamp = backup.manifest.createdAt.slice(0, 16).replace(/[-:T]/g, '');
  const filename = `questin-backup-${scope}-${stamp}.qbak`;
  const results = [];
  for (const target of targets.filter((t) => t !== 'download')) {
    try {
      results.push({ target, ok: true, detail: await deliver(target, filename, file) });
    } catch (err) {
      logger.error('backup delivery failed', { target, error: err.message });
      results.push({ target, ok: false, detail: err.message });
    }
  }
  return { backup, file, filename, results };
}

// Keep only the newest `keep` scheduled files of this scope in the server folder (other targets keep theirs).
export async function pruneLocal(scope, keep) {
  const dir = localDir();
  const prefix = `questin-backup-${scope}-`;
  let names;
  try {
    names = (await fs.readdir(dir)).filter((n) => n.startsWith(prefix) && n.endsWith('.qbak')).sort();
  } catch {
    return 0;
  }
  const old = names.slice(0, Math.max(names.length - keep, 0));
  for (const name of old) await fs.rm(path.join(dir, name), { force: true });
  return old.length;
}

let running = false;

// Called every minute: runs the schedule if it is due. Never throws.
export async function runScheduledBackupIfDue(now = new Date()) {
  if (running) return null;
  running = true;
  try {
    const { schedule } = await getBackupSettingsForUse();
    if (!isDue(schedule, now)) return null;
    const targets = schedule.targets.filter((t) => TARGETS.includes(t));
    // Mark the slot as taken first: a crash during the run must not make it start over every minute.
    await saveScheduleState({ lastRunAt: now.toISOString(), lastStatus: 'running', lastError: null });
    let outcome;
    try {
      const { backup, results } = await createAndDeliver({ scope: schedule.scope ?? 'all', passphrase: schedule.passphrase, targets });
      const failed = results.filter((r) => !r.ok);
      if (targets.includes('local') && !failed.some((r) => r.target === 'local')) await pruneLocal(schedule.scope ?? 'all', Math.max(Number(schedule.keep) || 14, 1));
      await logAudit({ actorId: null, action: 'backup.created', details: { scope: schedule.scope ?? 'all', counts: backup.manifest.counts, targets, scheduled: true, failed: failed.map((r) => r.target) } });
      outcome = failed.length ? { lastStatus: 'partial', lastError: failed.map((r) => `${r.target}: ${r.detail}`).join('; ') } : { lastStatus: 'ok', lastError: null };
    } catch (err) {
      logger.error('scheduled backup failed', { error: err.message });
      outcome = { lastStatus: 'error', lastError: err.message };
    }
    await saveScheduleState(outcome);
    return outcome;
  } catch (err) {
    logger.error('scheduled backup check failed', { error: err.message });
    return null;
  } finally {
    running = false;
  }
}

export function startBackupScheduler() {
  return setInterval(() => { runScheduledBackupIfDue(); }, 60_000).unref();
}

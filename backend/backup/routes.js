import { router } from '../routes.js';
import { requireAuth } from '../middleware/authenticate.js';
import { requireAdminGroup } from '../middleware/authorize.js';
import { readJsonBody } from '../httpBody.js';
import { query } from '../db.js';
import { open } from '../offlinePackage/container.js';
import { logAudit } from '../audit/repository.js';
import { logger } from '../logger.js';
import { describeBackup, restoreBackup } from './dump.js';
import { TARGETS, testTarget, getBackupSettings, setBackupSettings } from './targets.js';
import { createAndDeliver } from './schedule.js';

const MIN_PASSPHRASE = 8;
const MAX_RESTORE_BODY_BYTES = 300 * 1024 * 1024;

router.get('/backup/history', requireAuth(requireAdminGroup(async () => {
  const { rows } = await query(
    `SELECT a.created_at, a.action, a.details, concat_ws(' ', u.first_name, u.last_name) AS actor_name
     FROM audit_log a LEFT JOIN users u ON u.id = a.actor_id
     WHERE a.action IN ('backup.created', 'backup.restored') ORDER BY a.created_at DESC LIMIT 10`
  );
  return { status: 200, body: rows.map((r) => ({ createdAt: r.created_at, action: r.action, actorName: r.actor_name || null, details: r.details })) };
})));

router.get('/backup/settings', requireAuth(requireAdminGroup(async () => ({ status: 200, body: await getBackupSettings() }))));

router.put('/backup/settings', requireAuth(requireAdminGroup(async ({ req, user }) => {
  const body = await readJsonBody(req);
  if (body === null) return { status: 400, body: { error: 'invalid JSON' } };
  try {
    await setBackupSettings(body);
  } catch (err) {
    return { status: 400, body: { error: err.message } };
  }
  await logAudit({ actorId: user.id, action: 'backup.settings_changed', details: {} });
  return { status: 200, body: await getBackupSettings() };
})));

router.post('/backup/settings/test', requireAuth(requireAdminGroup(async ({ req }) => {
  const body = await readJsonBody(req);
  if (!TARGETS.includes(body?.target)) return { status: 400, body: { error: 'unknown target' } };
  try {
    await testTarget(body.target);
    return { status: 200, body: { ok: true } };
  } catch (err) {
    return { status: 200, body: { ok: false, error: err.message } };
  }
})));

// Creates the backup once and hands it to every chosen recipient: "download"
// (the response itself) and/or the server targets local / s3 / sftp. Results
// of the server targets are listed per target; one failing target does not
// stop the others. With "download" the file is the response body and the
// results travel in the X-Backup-Results header.
router.post('/backup/export', requireAuth(requireAdminGroup(async ({ req, user }) => {
  const body = await readJsonBody(req);
  if (body === null) return { status: 400, body: { error: 'invalid JSON' } };
  if (!['participants', 'events', 'all'].includes(body.scope)) return { status: 400, body: { error: 'scope must be participants, events or all' } };
  if (typeof body.passphrase !== 'string' || body.passphrase.length < MIN_PASSPHRASE) {
    return { status: 400, body: { error: `Bitte ein Passwort mit mindestens ${MIN_PASSPHRASE} Zeichen wählen – die Datei enthält personenbezogene Daten.` } };
  }
  const requested = Array.isArray(body.targets) && body.targets.length ? body.targets : ['download'];
  if (requested.some((t) => t !== 'download' && !TARGETS.includes(t))) return { status: 400, body: { error: 'unknown target' } };

  const { backup, file, filename, results } = await createAndDeliver({ scope: body.scope, passphrase: body.passphrase, targets: requested });
  await logAudit({ actorId: user.id, action: 'backup.created', details: { scope: body.scope, counts: backup.manifest.counts, targets: requested, failed: results.filter((r) => !r.ok).map((r) => r.target) } });

  if (!requested.includes('download')) return { status: 200, body: { filename, results } };
  return {
    status: 200,
    isBinary: true,
    body: file,
    headers: {
      'Content-Type': 'application/octet-stream',
      'Content-Disposition': `attachment; filename="${filename}"`,
      'X-Backup-Results': encodeURIComponent(JSON.stringify(results)),
    },
  };
})));

function openUpload(body) {
  if (typeof body?.fileBase64 !== 'string' || typeof body?.passphrase !== 'string') return { error: 'Datei und Passwort sind erforderlich.' };
  try {
    return { pkg: open(Buffer.from(body.fileBase64, 'base64'), body.passphrase) };
  } catch (err) {
    return { error: err.code === 'BAD_FORMAT' ? err.message : 'Die Datei lässt sich mit diesem Passwort nicht öffnen (falsches Passwort oder beschädigte Datei).' };
  }
}

// Step 1: look into a backup file without changing anything.
router.post('/backup/inspect', requireAuth(requireAdminGroup(async ({ req }) => {
  const body = await readJsonBody(req, MAX_RESTORE_BODY_BYTES);
  if (body === null) return { status: 400, body: { error: 'invalid JSON' } };
  const { pkg, error } = openUpload(body);
  if (error) return { status: 400, body: { error } };
  if (pkg.manifest.kind !== 'backup') return { status: 400, body: { error: 'Das ist keine Backup-Datei.' } };
  return { status: 200, body: await describeBackup(pkg) };
})));

// Step 2: merge the chosen parts of the backup into the live database.
router.post('/backup/restore', requireAuth(requireAdminGroup(async ({ req, user }) => {
  const body = await readJsonBody(req, MAX_RESTORE_BODY_BYTES);
  if (body === null) return { status: 400, body: { error: 'invalid JSON' } };
  if (body.confirm !== true) return { status: 400, body: { error: 'Bitte das Einspielen ausdrücklich bestätigen.' } };
  const { pkg, error } = openUpload(body);
  if (error) return { status: 400, body: { error } };
  const parts = Array.isArray(body.parts) ? body.parts.filter((p) => p === 'participants' || p === 'events') : [];
  try {
    const restored = await restoreBackup(pkg, parts);
    await logAudit({ actorId: user.id, action: 'backup.restored', details: { parts, backupCreatedAt: pkg.manifest.createdAt, counts: restored } });
    return { status: 200, body: { restored } };
  } catch (err) {
    if (['WRONG_KIND', 'SCHEMA_MISMATCH', 'NOTHING_TO_RESTORE'].includes(err.code)) return { status: 409, body: { error: err.message } };
    logger.error('backup restore failed', { error: err.message });
    return { status: 409, body: { error: `Einspielen fehlgeschlagen, es wurde nichts verändert: ${err.message}` } };
  }
})));

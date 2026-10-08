import { router } from '../routes.js';
import { requireAuth } from '../middleware/authenticate.js';
import { requireAdminGroup } from '../middleware/authorize.js';
import { readJsonBody } from '../httpBody.js';
import { query } from '../db.js';
import { seal } from '../offlinePackage/container.js';
import { logAudit } from '../audit/repository.js';
import { APP_VERSION } from '../../frontend/js/version.js';

// What a backup holds. Table names are fixed here (never from the request).
// Columns that look like credentials (password hashes, access/payment tokens)
// are dropped; encrypted personal-data blobs stay encrypted (base64) and need
// the server's ENCRYPTION_KEY to be read after a restore.
const SCOPES = {
  participants: ['users', 'characters', 'registrations', 'payments', 'account_files', 'character_files'],
  events: ['events', 'event_lodgings', 'event_mailings', 'sc_character_schema', 'nsc_profile_schema', 'account_field_schema', 'registration_field_schema'],
};
const SECRET_COLUMN = /(password|token)/i;
const MIN_PASSPHRASE = 8;

async function dumpTable(table) {
  const { rows } = await query(`SELECT * FROM ${table}`);
  return rows.map((row) => Object.fromEntries(Object.entries(row)
    .filter(([column]) => !SECRET_COLUMN.test(column))
    .map(([column, value]) => [column, Buffer.isBuffer(value) ? { $base64: value.toString('base64') } : value])));
}

// Per event: its own metadata plus how many registrations per status, so a
// backup can be read without restoring it.
async function eventMetadata() {
  const { rows: events } = await query('SELECT id, name, event_date, end_date, code, is_active, created_at FROM events ORDER BY event_date DESC');
  const { rows: counts } = await query('SELECT event_id, status, COUNT(*)::int AS n FROM registrations GROUP BY event_id, status');
  return events.map((e) => {
    const byStatus = Object.fromEntries(counts.filter((c) => c.event_id === e.id).map((c) => [c.status, c.n]));
    return { ...e, registrations: Object.values(byStatus).reduce((sum, n) => sum + n, 0), registrationsByStatus: byStatus };
  });
}

export async function buildBackup(scope) {
  const scopes = scope === 'all' ? Object.keys(SCOPES) : [scope];
  const data = {};
  const counts = {};
  for (const name of scopes) {
    data[name] = {};
    for (const table of SCOPES[name]) {
      data[name][table] = await dumpTable(table);
      counts[table] = data[name][table].length;
    }
  }
  if (scopes.includes('events')) data.events.metadata = await eventMetadata();
  const { rows: [migration] } = await query('SELECT filename FROM schema_migrations ORDER BY filename DESC LIMIT 1');
  return {
    manifest: { kind: 'backup', scope, createdAt: new Date().toISOString(), appVersion: APP_VERSION, schemaVersion: migration?.filename ?? null, counts },
    data,
  };
}

router.get('/backup/history', requireAuth(requireAdminGroup(async () => {
  const { rows } = await query(
    `SELECT a.created_at, a.details, concat_ws(' ', u.first_name, u.last_name) AS actor_name
     FROM audit_log a LEFT JOIN users u ON u.id = a.actor_id
     WHERE a.action = 'backup.created' ORDER BY a.created_at DESC LIMIT 10`
  );
  return { status: 200, body: rows.map((r) => ({ createdAt: r.created_at, actorName: r.actor_name || null, details: r.details })) };
})));

router.post('/backup/export', requireAuth(requireAdminGroup(async ({ req, user }) => {
  const body = await readJsonBody(req);
  if (body === null) return { status: 400, body: { error: 'invalid JSON' } };
  if (!['participants', 'events', 'all'].includes(body.scope)) return { status: 400, body: { error: 'scope must be participants, events or all' } };
  if (typeof body.passphrase !== 'string' || body.passphrase.length < MIN_PASSPHRASE) {
    return { status: 400, body: { error: `Bitte ein Passwort mit mindestens ${MIN_PASSPHRASE} Zeichen wählen – die Datei enthält personenbezogene Daten.` } };
  }
  const backup = await buildBackup(body.scope);
  await logAudit({ actorId: user.id, action: 'backup.created', details: { scope: body.scope, counts: backup.manifest.counts } });
  const stamp = backup.manifest.createdAt.slice(0, 16).replace(/[-:T]/g, '');
  return {
    status: 200,
    isBinary: true,
    body: seal(backup, body.passphrase),
    headers: {
      'Content-Type': 'application/octet-stream',
      'Content-Disposition': `attachment; filename="questin-backup-${body.scope}-${stamp}.qbak"`,
    },
  };
})));

import { query, withTransaction } from '../db.js';
import { APP_VERSION } from '../../frontend/js/version.js';

// What a backup holds. Table names are fixed here (never from a request).
// Columns that look like credentials (password hashes, access/payment tokens)
// are dropped; encrypted personal-data blobs stay encrypted (base64) and need
// the server's ENCRYPTION_KEY to be read after a restore.
export const SCOPES = {
  participants: ['users', 'characters', 'registrations', 'payments', 'account_files', 'character_files'],
  events: ['events', 'event_lodgings', 'event_mailings', 'sc_character_schema', 'nsc_profile_schema', 'account_field_schema', 'registration_field_schema'],
};
// Parent rows first. Restoring a part that references rows of the other part
// (e.g. registrations -> events) requires those to exist already.
const RESTORE_ORDER = [
  'users', 'events', 'event_lodgings', 'event_mailings',
  'sc_character_schema', 'nsc_profile_schema', 'account_field_schema', 'registration_field_schema',
  'characters', 'registrations', 'payments', 'account_files', 'character_files',
];
const SELF_REFERENCES = { users: ['group_parent_id', 'managed_by_user_id'] };
const SECRET_COLUMN = /(password|token)/i;

async function columnsOf(table) {
  const { rows } = await query(
    `SELECT column_name AS name, data_type AS type FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = $1 AND is_generated = 'NEVER' ORDER BY ordinal_position`,
    [table]
  );
  return rows;
}

async function primaryKeyOf(table) {
  const { rows } = await query(
    `SELECT a.attname AS name FROM pg_index i JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
     WHERE i.indrelid = $1::regclass AND i.indisprimary`,
    [table]
  );
  return rows.map((r) => r.name);
}

async function dumpTable(table) {
  const columns = (await columnsOf(table)).filter((c) => !SECRET_COLUMN.test(c.name));
  // `date` columns as plain text: node-pg would turn them into local-midnight Dates and shift the day.
  const select = columns.map((c) => (c.type === 'date' ? `to_char("${c.name}", 'YYYY-MM-DD') AS "${c.name}"` : `"${c.name}"`));
  // The group is identified by its key, so a restore on a fresh server finds the right group.
  const sql = table === 'users'
    ? `SELECT ${select.map((s) => `users.${s}`).join(', ')}, g.key AS group_key FROM users LEFT JOIN groups g ON g.id = users.group_id`
    : `SELECT ${select.join(', ')} FROM ${table}`;
  const { rows } = await query(sql);
  return rows.map((row) => Object.fromEntries(Object.entries(row)
    .map(([column, value]) => [column, Buffer.isBuffer(value) ? { $base64: value.toString('base64') } : value])));
}

// Per event: its own metadata plus how many registrations per status, so a
// backup can be read without restoring it.
async function eventMetadata() {
  const { rows: events } = await query("SELECT id, name, to_char(event_date, 'YYYY-MM-DD') AS event_date, to_char(end_date, 'YYYY-MM-DD') AS end_date, code, is_active, created_at FROM events ORDER BY events.event_date DESC");
  const { rows: counts } = await query('SELECT event_id, status, COUNT(*)::int AS n FROM registrations GROUP BY event_id, status');
  return events.map((e) => {
    const byStatus = Object.fromEntries(counts.filter((c) => c.event_id === e.id).map((c) => [c.status, c.n]));
    return { ...e, registrations: Object.values(byStatus).reduce((sum, n) => sum + n, 0), registrationsByStatus: byStatus };
  });
}

async function schemaVersion() {
  const { rows } = await query('SELECT filename FROM schema_migrations ORDER BY filename DESC LIMIT 1');
  return rows[0]?.filename ?? null;
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
  return {
    manifest: { kind: 'backup', scope, createdAt: new Date().toISOString(), appVersion: APP_VERSION, schemaVersion: await schemaVersion(), counts },
    data,
  };
}

// Plain summary of a opened backup (nothing is written).
export async function describeBackup(pkg) {
  const local = await schemaVersion();
  return {
    manifest: pkg.manifest,
    parts: Object.keys(pkg.data),
    compatible: pkg.manifest.schemaVersion === local,
    localSchemaVersion: local,
  };
}

function fail(code, message) {
  return Object.assign(new Error(message), { code });
}

function toDbValue(value, type) {
  if (value && typeof value === 'object' && !Array.isArray(value) && '$base64' in value) return Buffer.from(value.$base64, 'base64');
  if ((type === 'json' || type === 'jsonb') && value !== null) return JSON.stringify(value);
  return value;
}

// Merges a backup into the live database: rows are inserted or, when the same
// id exists, overwritten with the backup's values. Nothing is deleted, and
// columns the backup leaves out (password hashes, tokens) keep their value.
// All or nothing: any error rolls the whole restore back.
export async function restoreBackup(pkg, parts) {
  if (pkg.manifest.kind !== 'backup') throw fail('WRONG_KIND', 'Das ist keine Backup-Datei.');
  const local = await schemaVersion();
  if (pkg.manifest.schemaVersion !== local) {
    throw fail('SCHEMA_MISMATCH', `App-Version passt nicht (Backup ${pkg.manifest.schemaVersion}, hier ${local}). Bitte mit der passenden App-Version einspielen.`);
  }
  const selected = parts.filter((part) => pkg.data[part]);
  if (selected.length === 0) throw fail('NOTHING_TO_RESTORE', 'Die Datei enthält nichts von der gewählten Auswahl.');
  const wanted = new Set(selected.flatMap((part) => SCOPES[part]));
  const restored = {};

  await withTransaction(async (client) => {
    const { rows: groups } = await client.query('SELECT id, key FROM groups');
    const groupIdByKey = new Map(groups.map((g) => [g.key, g.id]));
    const fallbackGroupId = groupIdByKey.get('mitglied');

    for (const table of RESTORE_ORDER.filter((t) => wanted.has(t))) {
      const part = selected.find((p) => SCOPES[p].includes(table));
      const rows = pkg.data[part][table] ?? [];
      const columns = await columnsOf(table);
      const types = new Map(columns.map((c) => [c.name, c.type]));
      const pk = await primaryKeyOf(table);
      const deferred = SELF_REFERENCES[table] ?? [];
      const pending = [];

      for (const source of rows) {
        const row = { ...source };
        if (table === 'users') row.group_id = groupIdByKey.get(row.group_key) ?? fallbackGroupId;
        const names = Object.keys(row).filter((name) => types.has(name) && !SECRET_COLUMN.test(name));
        const later = names.filter((name) => deferred.includes(name) && row[name] != null);
        const now = names.filter((name) => !later.includes(name));
        const update = now.filter((name) => !pk.includes(name));
        await client.query(
          `INSERT INTO ${table} (${now.map((n) => `"${n}"`).join(', ')}) VALUES (${now.map((_, i) => `$${i + 1}`).join(', ')})
           ON CONFLICT (${pk.map((n) => `"${n}"`).join(', ')}) ${update.length ? `DO UPDATE SET ${update.map((n) => `"${n}" = EXCLUDED."${n}"`).join(', ')}` : 'DO NOTHING'}`,
          now.map((n) => toDbValue(row[n], types.get(n)))
        );
        if (later.length) pending.push({ row, later });
      }
      // Self-references (a group's parent, a managed person's manager) once all users exist.
      for (const { row, later } of pending) {
        await client.query(
          `UPDATE ${table} SET ${later.map((n, i) => `"${n}" = $${i + 2}`).join(', ')} WHERE id = $1`,
          [row.id, ...later.map((n) => row[n])]
        );
      }
      restored[table] = rows.length;
    }
  });
  return restored;
}

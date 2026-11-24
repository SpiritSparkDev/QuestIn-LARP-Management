import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { query, withTransaction } from '../db.js';
import { getStorage } from '../storage/index.js';
import { getStorageSettingsForUse } from '../storageSettings/repository.js';
import { storageKeyFor } from '../characterFiles/repository.js';
import { seedGroups } from '../../db/seedGroups.js';
import { seedNscProfileSchema } from '../../db/seedNscProfileSchema.js';
import { logger } from '../logger.js';

const MIGRATIONS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'db', 'migrations');

// Every table in the database belongs to exactly one of these lists
// (tests/integration/instanceReset.test.js fails for a new, unlisted table).

// Wiped on every reset, in this order (children before parents). The env
// admin's own account row survives; see KEPT_FOR_ADMIN.
export const DATA_TABLES = [
  'tavern_transactions', 'tavern_accounts', 'tavern_items',
  'paypal_orders', 'payments', 'group_payments', 'nsc_dialog_messages',
  'character_change_reviews', 'character_files',
  'invitations', 'group_invitations', 'group_join_codes',
  'registrations', 'characters', 'event_lodgings', 'event_mailings',
  'pdf_imports', 'snapshot_log', 'offline_merges', 'sync_conflicts',
  'events', 'email_log', 'mail_outbox', 'audit_log',
];

// Only the env admin's rows stay.
export const KEPT_FOR_ADMIN = ['users', 'sessions', 'oauth_accounts', 'account_files'];

// Configuration. Kept unless the reset includes the settings; then it goes
// back to what a fresh install has (same migrations and seeds). Order: parents
// before children for the insert, reversed for the delete.
export const SETTINGS_TABLES = [
  'app_settings', 'account_field_schema', 'registration_field_schema', 'child_field_schema',
  'group_field_schema', 'sc_character_schema', 'nsc_profile_schema', 'email_templates',
  'email_slot_assignments', 'payment_settings', 'smtp_settings', 'storage_settings',
  'backup_settings', 'pdf_import_config', 'groups',
];

// Never touched: bookkeeping of the installation itself.
// instance_authority keeps only its instance-wide row (event_id IS NULL).
export const SYSTEM_TABLES = ['schema_migrations', 'instance_authority'];

function resetError(message, code) {
  return Object.assign(new Error(message), { code });
}

// The admin named in ADMINUSER (the one seeded on startup) -- the only one who
// may reset the instance and the only account that survives it.
export function envAdminEmail() {
  const email = process.env.ADMINUSER?.trim().toLowerCase();
  return email || null;
}

export function isEnvAdmin(user) {
  const email = envAdminEmail();
  return Boolean(email && user?.email && user.email.toLowerCase() === email && user.group?.key === 'admin');
}

// What has to be typed to confirm: the host this instance runs on
// (e.g. anmeldung.pakyrion.de), so a reset can't hit the wrong instance by habit.
export async function getInstanceName(hostHeader) {
  const candidates = [process.env.APP_BASE_URL];
  try {
    const { rows } = await query('SELECT base_url FROM app_settings LIMIT 1');
    candidates.push(rows[0]?.base_url);
  } catch {
    // table missing is not a reason to fail the preview
  }
  for (const url of candidates) {
    if (!url) continue;
    try {
      return new URL(url).host.toLowerCase();
    } catch {
      // not a URL, try the next one
    }
  }
  return String(hostHeader ?? '').toLowerCase() || 'questin';
}

export async function getResetPreview() {
  const { rows } = await query(
    `SELECT (SELECT COUNT(*)::int FROM users WHERE lower(email) IS DISTINCT FROM $1) AS users,
            (SELECT COUNT(*)::int FROM events) AS events,
            (SELECT COUNT(*)::int FROM registrations) AS registrations,
            (SELECT COUNT(*)::int FROM characters) AS characters,
            (SELECT COUNT(*)::int FROM payments) AS payments,
            (SELECT COUNT(*)::int FROM account_files) + (SELECT COUNT(*)::int FROM character_files) AS files`,
    [envAdminEmail()]
  );
  return rows[0];
}

async function columnsOf(client, schema, table) {
  const { rows } = await client.query(
    `SELECT column_name FROM information_schema.columns WHERE table_schema = $1 AND table_name = $2 ORDER BY ordinal_position`,
    [schema, table]
  );
  return rows.map((r) => r.column_name);
}

// Builds a fresh install's configuration in a scratch schema (all migrations
// plus the startup seeds) and copies it over the live configuration tables.
async function resetSettings(client) {
  const scratch = `questin_factory_${crypto.randomBytes(6).toString('hex')}`;
  await client.query(`CREATE SCHEMA ${scratch}`);
  await client.query(`SET LOCAL search_path TO ${scratch}`);
  const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith('.sql')).sort();
  for (const file of files) await client.query(await readFile(path.join(MIGRATIONS_DIR, file), 'utf8'));
  await seedGroups(client);
  await seedNscProfileSchema(client);
  await client.query('SET LOCAL search_path TO public');

  const plain = SETTINGS_TABLES.filter((t) => t !== 'groups');
  for (const table of [...plain].reverse()) await client.query(`DELETE FROM public.${table}`);
  for (const table of plain) {
    const live = await columnsOf(client, 'public', table);
    const fresh = new Set(await columnsOf(client, scratch, table));
    const cols = live.filter((c) => fresh.has(c)).map((c) => `"${c}"`).join(', ');
    await client.query(`INSERT INTO public.${table} (${cols}) SELECT ${cols} FROM ${scratch}.${table}`);
  }

  // Groups: the admin's own group row has to stay (users.group_id points at
  // it), so it is updated in place; every other group is replaced.
  const groupCols = (await columnsOf(client, 'public', 'groups')).filter((c) => c !== 'id' && c !== 'key');
  await client.query(`DELETE FROM public.groups WHERE key <> 'admin'`);
  const allCols = ['key', ...groupCols].map((c) => `"${c}"`).join(', ');
  await client.query(`INSERT INTO public.groups (${allCols}) SELECT ${allCols} FROM ${scratch}.groups WHERE key <> 'admin'`);
  await client.query(
    `UPDATE public.groups g SET (${groupCols.map((c) => `"${c}"`).join(', ')}) = (SELECT ${groupCols.map((c) => `f."${c}"`).join(', ')} FROM ${scratch}.groups f WHERE f.key = 'admin')
     WHERE g.key = 'admin' AND EXISTS (SELECT 1 FROM ${scratch}.groups WHERE key = 'admin')`
  );

  await client.query(`DROP SCHEMA ${scratch} CASCADE`);
}

// Deletes everything except the env admin's account; with `includeSettings`
// the configuration goes back to a fresh install too. One transaction: if
// anything fails, nothing is deleted. Uploaded files are removed afterwards
// (best effort, a leftover file is unreachable once its row is gone).
export async function resetInstance({ actor, includeSettings = false }) {
  const adminEmail = envAdminEmail();
  if (!adminEmail || !isEnvAdmin(actor)) throw resetError('Nur der Admin aus ADMINUSER darf die Instanz zurücksetzen.', 'FORBIDDEN');

  const counts = await getResetPreview();
  const storageSettings = await getStorageSettingsForUse();
  const { rows: accountFiles } = await query('SELECT storage_backend, storage_key FROM account_files WHERE user_id <> $1', [actor.id]);
  const { rows: characterFiles } = await query('SELECT id, storage_backend, storage_key FROM character_files');

  await withTransaction(async (client) => {
    for (const table of DATA_TABLES) await client.query(`DELETE FROM ${table}`);
    await client.query('DELETE FROM instance_authority WHERE event_id IS NOT NULL');
    for (const table of ['account_files', 'oauth_accounts', 'sessions']) {
      await client.query(`DELETE FROM ${table} WHERE user_id <> $1`, [actor.id]);
    }
    await client.query('DELETE FROM users WHERE id <> $1', [actor.id]);
    await client.query(`SELECT setval('users_member_number_seq', COALESCE((SELECT max(member_number) FROM users), 0) + 1, false)`);
    if (includeSettings) await resetSettings(client);
    else await client.query('UPDATE app_settings SET test_mode_enabled = false');
    await client.query(
      `INSERT INTO audit_log (actor_id, action, details) VALUES ($1, 'instance.reset', $2)`,
      [actor.id, JSON.stringify({ includeSettings, counts })]
    );
  });
  logger.warn('instance reset', { actor: actor.email, includeSettings, counts });

  let filesFailed = 0;
  const files = [
    ...accountFiles.map((f) => ({ backend: f.storage_backend, key: f.storage_key })),
    ...characterFiles.map((f) => ({ backend: f.storage_backend, key: storageKeyFor(f) })),
  ];
  for (const file of files) {
    try {
      await getStorage(file.backend, storageSettings).remove(file.key);
    } catch {
      filesFailed += 1;
    }
  }
  if (filesFailed) logger.warn('instance reset: some uploaded files could not be removed', { filesFailed });

  return { counts, includeSettings, filesFailed };
}

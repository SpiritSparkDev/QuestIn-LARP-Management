import { withTransaction } from '../db.js';
import { encryptFieldBlob, decryptFieldBlob } from '../accountFields.js';

// Merging two accounts of the same person: everything of `dropId` moves to `keepId`, then `dropId` is deleted.
// The kept account keeps its email, password, group and own account fields; its empty account fields are filled
// from the other one. Both accounts having a registration for the same event cannot be merged automatically
// (two registrations, payments and places would collide): the admin has to cancel/remove one of them first.

const SESSION_TABLES = new Set(['sessions', 'email_verification_tokens', 'password_reset_tokens']);

const isEmpty = (v) => v === null || v === undefined || v === '' || (Array.isArray(v) && v.length === 0);

async function loadUser(client, id) {
  const { rows } = await client.query(
    'SELECT id, email, first_name, last_name, account_data_enc, is_guest FROM users WHERE id = $1 FOR UPDATE', [id]);
  return rows[0] ?? null;
}

async function findConflicts(client, keepId, dropId) {
  const { rows } = await client.query(
    `SELECT e.name, d.status AS drop_status,
            (SELECT count(*) FROM payments p WHERE p.user_id = d.user_id AND p.event_id = d.event_id)::int AS drop_payments
       FROM registrations d
       JOIN registrations k ON k.event_id = d.event_id AND k.user_id = $1
       JOIN events e ON e.id = d.event_id
      WHERE d.user_id = $2`, [keepId, dropId]);
  // A cancelled registration without payments carries nothing worth keeping: it is simply dropped.
  return rows.filter((r) => !(r.drop_status === 'cancelled' && r.drop_payments === 0)).map((r) => r.name);
}

// What would move, without changing anything (for the confirmation dialog).
export async function previewMerge(keepId, dropId) {
  return withTransaction(async (client) => {
    const [keep, drop] = [await loadUser(client, keepId), await loadUser(client, dropId)];
    if (!keep || !drop) return null;
    const count = async (sql) => (await client.query(sql, [dropId])).rows[0].n;
    return {
      keep: { id: keep.id, name: `${keep.first_name} ${keep.last_name}`.trim(), email: keep.email },
      drop: { id: drop.id, name: `${drop.first_name} ${drop.last_name}`.trim(), email: drop.email },
      registrations: await count('SELECT count(*)::int AS n FROM registrations WHERE user_id = $1'),
      characters: await count('SELECT count(*)::int AS n FROM characters WHERE user_id = $1'),
      files: await count('SELECT count(*)::int AS n FROM account_files WHERE user_id = $1'),
      payments: await count('SELECT count(*)::int AS n FROM payments WHERE user_id = $1'),
      conflicts: await findConflicts(client, keepId, dropId),
    };
  });
}

// Returns { error, status } for a refused merge, otherwise { merged: {...} }.
export async function mergeAccounts(keepId, dropId) {
  if (keepId === dropId) return { status: 400, error: 'Es müssen zwei verschiedene Konten gewählt werden.' };
  return withTransaction(async (client) => {
    // Lock in a stable order so two concurrent merges cannot deadlock.
    const [a, b] = [keepId, dropId].sort();
    await loadUser(client, a);
    await loadUser(client, b);
    const keep = await loadUser(client, keepId);
    const drop = await loadUser(client, dropId);
    if (!keep || !drop) return { status: 404, error: 'Konto nicht gefunden.' };
    const conflicts = await findConflicts(client, keepId, dropId);
    if (conflicts.length) {
      return { status: 409, error: `Beide Konten sind für dasselbe Event angemeldet (${conflicts.join(', ')}). Bitte zuerst eine der Anmeldungen entfernen.` };
    }

    // Registrations: payments and PayPal orders hang on (user, event), so copy the row first, repoint, then drop the old one.
    const { rows: cols } = await client.query(
      `SELECT column_name FROM information_schema.columns WHERE table_name = 'registrations' AND column_name <> 'user_id'`);
    const colList = cols.map((c) => `"${c.column_name}"`).join(', ');
    const { rows: moved } = await client.query(
      `SELECT event_id FROM registrations WHERE user_id = $2 AND event_id NOT IN (SELECT event_id FROM registrations WHERE user_id = $1)`,
      [keepId, dropId]);
    await client.query(
      `INSERT INTO registrations (user_id, ${colList})
       SELECT $1, ${colList} FROM registrations WHERE user_id = $2 AND event_id = ANY($3::uuid[])`,
      [keepId, dropId, moved.map((r) => r.event_id)]);
    for (const table of ['payments', 'paypal_orders', 'nsc_dialog_messages']) {
      await client.query(`UPDATE ${table} SET user_id = $1 WHERE user_id = $2 AND event_id = ANY($3::uuid[])`, [keepId, dropId, moved.map((r) => r.event_id)]);
    }
    await client.query('DELETE FROM registrations WHERE user_id = $1', [dropId]);

    // Everything else that points at the account (characters, files, audit trail, group links, ...): found through
    // the foreign keys so new tables are covered automatically. A row that would collide with one the kept account
    // already has (unique index) stays behind and is removed/detached by deleting the account below.
    const { rows: refs } = await client.query(
      `SELECT c.conrelid::regclass::text AS tbl, a.attname AS col
         FROM pg_constraint c
         JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = c.conkey[1]
        WHERE c.contype = 'f' AND c.confrelid = 'users'::regclass AND array_length(c.conkey, 1) = 1`);
    for (const { tbl, col } of refs) {
      if (SESSION_TABLES.has(tbl) || tbl === 'users' && col === 'id') continue;
      await client.query('SAVEPOINT ref');
      try {
        await client.query(`UPDATE ${tbl} SET "${col}" = $1 WHERE "${col}" = $2`, [keepId, dropId]);
        await client.query('RELEASE SAVEPOINT ref');
      } catch (err) {
        if (err.code !== '23505' && err.code !== '23514') throw err;
        await client.query('ROLLBACK TO SAVEPOINT ref');
      }
    }
    // A group manager cannot manage themselves.
    await client.query('UPDATE users SET managed_by_user_id = NULL WHERE id = $1 AND managed_by_user_id = id', [keepId]);
    await client.query('UPDATE users SET group_parent_id = NULL WHERE id = $1 AND group_parent_id = id', [keepId]);

    // Fill the kept account's empty account fields from the other one.
    const keepData = decryptFieldBlob(keep.account_data_enc);
    const dropData = decryptFieldBlob(drop.account_data_enc);
    for (const [key, value] of Object.entries(dropData)) if (isEmpty(keepData[key]) && !isEmpty(value)) keepData[key] = value;
    await client.query('UPDATE users SET account_data_enc = $2 WHERE id = $1', [keepId, encryptFieldBlob(keepData)]);

    await client.query('DELETE FROM users WHERE id = $1', [dropId]);
    return { merged: { keepId, dropEmail: drop.email, dropName: `${drop.first_name} ${drop.last_name}`.trim(), registrations: moved.length } };
  });
}

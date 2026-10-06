import { query } from '../db.js';
import { displayName } from '../displayName.js';
import { getAccountFieldSchema } from '../accountFieldSchema/repository.js';
import { encryptFieldBlob, decryptFieldBlob } from '../accountFields.js';
import { sanitizeFieldValue } from '../richText.js';

// A person can be deleted unless a registration is already binding: paid, or
// confirmed/checked in. Open registrations (pending, waitlisted, ...) are
// removed together with the person (ON DELETE CASCADE).
const BINDING_REGISTRATION = "(registrations.paid_at IS NOT NULL OR registrations.status IN ('confirmed', 'checked_in', 'checked_out'))";

const SELECT_COLUMNS = `
  id, email, first_name, last_name, nickname, account_data_enc,
  NOT EXISTS (SELECT 1 FROM registrations WHERE registrations.user_id = users.id AND ${BINDING_REGISTRATION}) AS can_delete
`;

function decryptManagedPerson(row) {
  return {
    id: row.id,
    email: row.email,
    firstName: row.first_name,
    lastName: row.last_name,
    nickname: row.nickname,
    name: displayName({ firstName: row.first_name, lastName: row.last_name, nickname: row.nickname }),
    canDelete: row.can_delete,
    ...decryptFieldBlob(row.account_data_enc),
  };
}

// True only for an existing managed person owned by ownerId -- NOT true
// for ownerId itself (callers that also need to allow "acting on your own
// id" check that separately, matching the existing isOwner pattern in
// characters/routes.js and payments/routes.js).
export async function isManagedBy(targetUserId, ownerId) {
  const { rows } = await query(
    'SELECT 1 FROM users WHERE id = $1 AND managed_by_user_id = $2',
    [targetUserId, ownerId]
  );
  return rows.length > 0;
}

export async function listManagedPersons(ownerId) {
  const { rows } = await query(
    `SELECT ${SELECT_COLUMNS} FROM users WHERE managed_by_user_id = $1 ORDER BY first_name, last_name`,
    [ownerId]
  );
  return rows.map(decryptManagedPerson);
}

export async function getManagedPerson(id, ownerId) {
  const { rows } = await query(
    `SELECT ${SELECT_COLUMNS} FROM users WHERE id = $1 AND managed_by_user_id = $2`,
    [id, ownerId]
  );
  return rows[0] ? decryptManagedPerson(rows[0]) : null;
}

export async function createManagedPerson({ ownerId, groupId, email, firstName, lastName, nickname, ...otFields }) {
  const schema = await getAccountFieldSchema();
  const data = {};
  for (const field of schema) {
    if (otFields[field.key] !== undefined) data[field.key] = sanitizeFieldValue(field, otFields[field.key]);
  }
  try {
    const { rows } = await query(
      `INSERT INTO users (email, first_name, last_name, nickname, group_id, is_guest, email_verified, account_data_enc, managed_by_user_id)
       VALUES ($1, $2, $3, $4, $5, true, false, $6, $7)
       RETURNING id`,
      [email || null, firstName, lastName, nickname || null, groupId, encryptFieldBlob(data), ownerId]
    );
    return getManagedPerson(rows[0].id, ownerId);
  } catch (err) {
    if (err.code === '23505') {
      const dup = new Error('Zu dieser E-Mail-Adresse gibt es schon einen Account. Lade die Person stattdessen unter „Gruppenstruktur“ per E-Mail ein oder löse ihren Beitrittscode ein.');
      dup.code = 'EMAIL_TAKEN';
      throw dup;
    }
    throw err;
  }
}

export async function updateManagedPerson(id, ownerId, fields) {
  const schema = await getAccountFieldSchema();
  const { rows: currentRows } = await query(
    'SELECT account_data_enc FROM users WHERE id = $1 AND managed_by_user_id = $2',
    [id, ownerId]
  );
  if (currentRows.length === 0) return null;
  const nextData = decryptFieldBlob(currentRows[0].account_data_enc);
  for (const field of schema) {
    if (fields[field.key] !== undefined) nextData[field.key] = sanitizeFieldValue(field, fields[field.key]);
  }

  try {
    const { rows } = await query(
      `UPDATE users SET
         first_name = COALESCE($3, first_name),
         last_name = COALESCE($4, last_name),
         nickname = COALESCE($5, nickname),
         email = COALESCE($6, email),
         account_data_enc = $7
       WHERE id = $1 AND managed_by_user_id = $2
       RETURNING id`,
      [
        id, ownerId,
        fields.firstName ?? null,
        fields.lastName ?? null,
        fields.nickname ?? null,
        fields.email || null,
        encryptFieldBlob(nextData),
      ]
    );
    if (rows.length === 0) return null;
    return getManagedPerson(id, ownerId);
  } catch (err) {
    if (err.code === '23505') {
      const dup = new Error('Zu dieser E-Mail-Adresse gibt es schon einen Account. Lade die Person stattdessen unter „Gruppenstruktur“ per E-Mail ein oder löse ihren Beitrittscode ein.');
      dup.code = 'EMAIL_TAKEN';
      throw dup;
    }
    throw err;
  }
}

export async function deleteManagedPerson(id, ownerId, { force = false } = {}) {
  const { rows: regRows } = force ? { rows: [] } : await query(
    `SELECT 1 FROM registrations r JOIN users u ON u.id = r.user_id
     WHERE r.user_id = $1 AND u.managed_by_user_id = $2
       AND (r.paid_at IS NOT NULL OR r.status IN ('confirmed', 'checked_in', 'checked_out'))`,
    [id, ownerId]
  );
  if (regRows.length > 0) {
    const err = new Error('Diese Person hat bereits bestätigte oder bezahlte Event-Anmeldungen und kann nicht gelöscht werden.');
    err.code = 'HAS_REGISTRATIONS';
    throw err;
  }
  const { rows } = await query(
    'DELETE FROM users WHERE id = $1 AND managed_by_user_id = $2 RETURNING id',
    [id, ownerId]
  );
  return rows.length > 0;
}

// "Hold an existing person into my group": guest accounts (no login -- e.g.
// from the PDF import or the ticket widget) that nobody manages yet. Full
// accounts with their own login are never offered. Only name and a masked
// e-mail are returned, and an e-mail only matches when typed in full.
function maskEmail(email) {
  if (!email) return null;
  const [local, domain] = email.split('@');
  return `${local.slice(0, 1)}***@${domain}`;
}

export async function searchClaimablePersons(term, ownerId) {
  const pattern = `%${term.toLowerCase().replace(/[\\%_]/g, '\\$&')}%`;
  const { rows } = await query(
    `SELECT id, email, first_name, last_name, nickname FROM users
     WHERE is_guest AND managed_by_user_id IS NULL AND deactivated_at IS NULL AND id <> $1
       AND (lower(first_name || ' ' || last_name) LIKE $2 OR lower(coalesce(nickname, '')) LIKE $2 OR lower(email) = lower($3))
     ORDER BY last_name, first_name LIMIT 20`,
    [ownerId, pattern, term]
  );
  return rows.map((r) => ({
    id: r.id,
    name: displayName({ firstName: r.first_name, lastName: r.last_name, nickname: r.nickname }),
    emailHint: maskEmail(r.email),
  }));
}

export async function claimPerson(id, ownerId) {
  const { rows } = await query(
    `UPDATE users SET managed_by_user_id = $2
     WHERE id = $1 AND is_guest AND managed_by_user_id IS NULL AND deactivated_at IS NULL AND id <> $2
     RETURNING id`,
    [id, ownerId]
  );
  return rows.length > 0 ? getManagedPerson(id, ownerId) : null;
}

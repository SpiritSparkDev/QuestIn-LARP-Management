import { query } from '../db.js';
import { displayName } from '../displayName.js';
import { getAccountFieldSchema } from '../accountFieldSchema/repository.js';
import { encryptFieldBlob, decryptFieldBlob } from '../accountFields.js';
import { sanitizeFieldValue } from '../richText.js';
import { isGroupAncestorOf } from '../groupTree/repository.js';

const SELECT_COLUMNS = `
  id, email, first_name, last_name, nickname, is_child, account_data_enc
`;

function decryptManagedPerson(row) {
  return {
    id: row.id,
    email: row.email,
    firstName: row.first_name,
    lastName: row.last_name,
    nickname: row.nickname,
    name: displayName({ firstName: row.first_name, lastName: row.last_name, nickname: row.nickname }),
    // Add-on "Kinder": the manager is the parent/guardian (backend/registrations/children.js).
    isChild: row.is_child,
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

// Event registration (sign up, extras, lodging, payment) is open to the
// person's manager AND to group managers above them in the group tree --
// including the managers of the subgroups themselves, who agreed to that when
// they accepted the invitation.
export async function canRegisterFor(targetUserId, actorId) {
  return (await isManagedBy(targetUserId, actorId)) || isGroupAncestorOf(actorId, targetUserId);
}

// Like getManagedPerson, but for a group manager above the owner only the
// name is returned (no e-mail, no OT data).
export async function getManagedPersonForRegistration(id, actorId) {
  const own = await getManagedPerson(id, actorId);
  if (own || !(await canRegisterFor(id, actorId))) return own;
  const { rows } = await query('SELECT id, first_name, last_name, nickname, is_child FROM users WHERE id = $1', [id]);
  const r = rows[0];
  return { id: r.id, email: null, firstName: r.first_name, lastName: r.last_name, nickname: r.nickname,
    name: displayName({ firstName: r.first_name, lastName: r.last_name, nickname: r.nickname }), isChild: r.is_child, groupView: true };
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

export async function createManagedPerson({ ownerId, groupId, email, firstName, lastName, nickname, isChild = false, ...otFields }) {
  const schema = await getAccountFieldSchema();
  const data = {};
  for (const field of schema) {
    if (otFields[field.key] !== undefined) data[field.key] = sanitizeFieldValue(field, otFields[field.key]);
  }
  try {
    const { rows } = await query(
      `INSERT INTO users (email, first_name, last_name, nickname, group_id, is_guest, email_verified, account_data_enc, managed_by_user_id, is_child)
       VALUES ($1, $2, $3, $4, $5, true, false, $6, $7, $8)
       RETURNING id`,
      [email || null, firstName, lastName, nickname || null, groupId, encryptFieldBlob(data), ownerId, isChild === true]
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
         account_data_enc = $7,
         is_child = COALESCE($8, is_child)
       WHERE id = $1 AND managed_by_user_id = $2
       RETURNING id`,
      [
        id, ownerId,
        fields.firstName ?? null,
        fields.lastName ?? null,
        fields.nickname ?? null,
        fields.email || null,
        encryptFieldBlob(nextData),
        typeof fields.isChild === 'boolean' ? fields.isChild : null,
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
  const pattern = `%${term.toLowerCase().replace(/[\%_]/g, '\$&')}%`;
  const NAME_MATCH = `(lower(first_name || ' ' || last_name) LIKE $2 OR lower(coalesce(nickname, '')) LIKE $2
       OR EXISTS (SELECT 1 FROM characters c WHERE c.user_id = users.id AND lower(c.name) LIKE $2))`;
  // Guests without a login can be claimed directly (also found by part of the e-mail).
  const { rows: guests } = await query(
    `SELECT id, email, first_name, last_name, nickname FROM users
     WHERE is_guest AND managed_by_user_id IS NULL AND deactivated_at IS NULL AND id <> $1
       AND (${NAME_MATCH} OR lower(email) LIKE $2)
     ORDER BY last_name, first_name LIMIT 20`,
    [ownerId, pattern]
  );
  // Full accounts can't be taken over; they can only be invited as a sub-group.
  // Matched by name only, so the search can't be used to harvest e-mail addresses.
  const { rows: accounts } = await query(
    `SELECT id, first_name, last_name, nickname FROM users
     WHERE NOT is_guest AND group_parent_id IS NULL AND deactivated_at IS NULL AND id <> $1
       AND ${NAME_MATCH}
     ORDER BY last_name, first_name LIMIT 20`,
    [ownerId, pattern]
  );
  const name = (r) => displayName({ firstName: r.first_name, lastName: r.last_name, nickname: r.nickname });
  return [
    ...guests.map((r) => ({ id: r.id, kind: 'claim', name: name(r), emailHint: maskEmail(r.email) })),
    ...accounts.map((r) => ({ id: r.id, kind: 'invite', name: name(r) })),
  ];
}

// The inverse of claimPerson: the person stays in the system (with registrations and
// characters), the manager just no longer manages them. A child always has a
// guardian, so without a manager the person is no longer marked as one.
export async function releasePerson(id, ownerId) {
  const { rowCount } = await query('UPDATE users SET managed_by_user_id = NULL, is_child = false WHERE id = $1 AND managed_by_user_id = $2', [id, ownerId]);
  return rowCount > 0;
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

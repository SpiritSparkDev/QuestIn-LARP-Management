import crypto from 'node:crypto';
import { query, withTransaction } from '../db.js';
import { displayName } from '../displayName.js';
import { getGroupFieldSchema } from '../groupSchema/repository.js';
import { sanitizeFieldValue } from '../richText.js';
import { sendGroupInvitationEmail } from '../auth/mailer.js';
import { logger } from '../logger.js';

const MAX_DEPTH = 8;
const nameOf = (r) => displayName({ firstName: r.first_name, lastName: r.last_name, nickname: r.nickname });
// A group with a name reads "Drachenbande (Anna Muster)".
const labelOf = (r) => (r.group_name ? `${r.group_name} (${nameOf(r)})` : nameOf(r));

export async function setGroupFields(userId, values) {
  const schema = await getGroupFieldSchema();
  const data = {};
  for (const field of schema) {
    if (values?.[field.key] !== undefined) data[field.key] = sanitizeFieldValue(field, values[field.key]);
  }
  const { rows } = await query('SELECT group_data FROM users WHERE id = $1', [userId]);
  await query('UPDATE users SET group_data = $2 WHERE id = $1', [userId, JSON.stringify({ ...rows[0]?.group_data, ...data })]);
}

export async function setGroupName(userId, name) {
  await query('UPDATE users SET group_name = $2 WHERE id = $1', [userId, name || null]);
}

// Is `ancestorId` a group manager above `targetUserId`? The target counts as
// belonging to the group of whoever manages them (a managed person) or to
// their own (a manager who joined a parent group). A person's direct manager
// is NOT their ancestor -- that is plain ownership, handled elsewhere.
export async function isGroupAncestorOf(ancestorId, targetUserId) {
  const { rows } = await query(
    `WITH RECURSIVE chain(id) AS (
       SELECT group_parent_id FROM users WHERE id = (SELECT COALESCE(managed_by_user_id, id) FROM users WHERE id = $2)
       UNION
       SELECT u.group_parent_id FROM users u JOIN chain c ON u.id = c.id WHERE u.group_parent_id IS NOT NULL
     )
     SELECT 1 FROM chain WHERE id = $1 LIMIT 1`,
    [ancestorId, targetUserId]
  );
  return rows.length > 0;
}

async function canJoin(parentId, childId) {
  if (parentId === childId) return false;
  const { rows } = await query('SELECT group_parent_id FROM users WHERE id = $1 AND NOT is_guest AND deactivated_at IS NULL', [childId]);
  if (rows.length === 0 || rows[0].group_parent_id) return false;
  // The child must not be above the parent already (no cycles).
  return !(await isGroupAncestorOf(childId, parentId));
}

// Deliberately answers the same whether or not the account exists, so it
// can't be used to find out who has an account.
export async function inviteByEmail(parentId, email) {
  const { rows } = await query('SELECT id FROM users WHERE lower(email) = lower($1) AND NOT is_guest AND deactivated_at IS NULL', [email]);
  if (rows.length > 0) return inviteById(parentId, rows[0].id);
  await inviteNewPerson(parentId, email);
}

export async function inviteById(parentId, childId) {
  if (!(await canJoin(parentId, childId))) return;
  const { rowCount } = await query(
    'INSERT INTO group_invitations (parent_user_id, child_user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
    [parentId, childId]
  );
  if (rowCount > 0) await notifyInvited(parentId, childId);
}

const EMAIL_INVITE_TTL_DAYS = 7;

// No account yet: remember the invitation and mail a sign-up link (join-group.html).
// Inviting the same address again refreshes the token.
async function inviteNewPerson(parentId, email) {
  const token = crypto.randomBytes(32).toString('hex');
  await query(
    `INSERT INTO group_invitations (parent_user_id, email, token, expires_at)
     VALUES ($1, $2, $3, now() + make_interval(days => $4))
     ON CONFLICT (parent_user_id, lower(email)) WHERE email IS NOT NULL
     DO UPDATE SET token = EXCLUDED.token, expires_at = EXCLUDED.expires_at`,
    [parentId, email, token, EMAIL_INVITE_TTL_DAYS]
  );
  await notifyInvited(parentId, null, email, token);
}

// A failed mail must not fail the invitation -- it is still visible in the account.
// `email` is given for people without an account (childId null).
async function notifyInvited(parentId, childId, email, token) {
  try {
    const { rows } = await query(
      `SELECT p.first_name, p.last_name, p.nickname, p.group_name, (SELECT email FROM users WHERE id = $2) AS child_email
       FROM users p WHERE p.id = $1`,
      [parentId, childId]
    );
    const to = email ?? rows[0]?.child_email;
    if (!to) return;
    await sendGroupInvitationEmail(to, { parentName: labelOf(rows[0]), userId: childId ?? undefined, token });
  } catch (err) {
    logger.error('failed to send group invitation email', { error: err.message });
  }
}

export async function listIncoming(userId) {
  const { rows } = await query(
    `SELECT gi.id, u.first_name, u.last_name, u.nickname, u.group_name FROM group_invitations gi
     JOIN users u ON u.id = gi.parent_user_id WHERE gi.child_user_id = $1 ORDER BY gi.created_at`,
    [userId]
  );
  return rows.map((r) => ({ id: r.id, parentName: labelOf(r) }));
}

export async function listOutgoing(userId) {
  const { rows } = await query(
    `SELECT gi.id, gi.email, u.first_name, u.last_name, u.nickname, u.group_name FROM group_invitations gi
     LEFT JOIN users u ON u.id = gi.child_user_id WHERE gi.parent_user_id = $1 ORDER BY gi.created_at`,
    [userId]
  );
  return rows.map((r) => ({ id: r.id, name: r.email ?? labelOf(r) }));
}

export async function getEmailInvitation(token) {
  const { rows } = await query(
    `SELECT gi.id, gi.email, gi.parent_user_id, p.first_name, p.last_name, p.nickname, p.group_name
     FROM group_invitations gi JOIN users p ON p.id = gi.parent_user_id
     WHERE gi.token = $1 AND gi.expires_at > now() AND p.deactivated_at IS NULL`,
    [token]
  );
  return rows[0] ? { id: rows[0].id, email: rows[0].email, parentId: rows[0].parent_user_id, parentName: labelOf(rows[0]) } : null;
}

export async function acceptInvitation(id, userId) {
  return withTransaction(async (client) => {
    const { rows } = await client.query('SELECT parent_user_id FROM group_invitations WHERE id = $1 AND child_user_id = $2', [id, userId]);
    if (rows.length === 0) return false;
    if (!(await canJoin(rows[0].parent_user_id, userId))) {
      await client.query('DELETE FROM group_invitations WHERE id = $1', [id]);
      return false;
    }
    await client.query('UPDATE users SET group_parent_id = $2 WHERE id = $1', [userId, rows[0].parent_user_id]);
    await client.query('DELETE FROM group_invitations WHERE child_user_id = $1', [userId]);
    return true;
  });
}

export async function declineInvitation(id, userId) {
  const { rowCount } = await query('DELETE FROM group_invitations WHERE id = $1 AND child_user_id = $2', [id, userId]);
  return rowCount > 0;
}

export async function cancelInvitation(id, parentId) {
  const { rowCount } = await query('DELETE FROM group_invitations WHERE id = $1 AND parent_user_id = $2', [id, parentId]);
  return rowCount > 0;
}

export async function leaveParentGroup(userId) {
  await query('UPDATE users SET group_parent_id = NULL WHERE id = $1', [userId]);
}

export async function removeChild(parentId, childId) {
  const { rowCount } = await query('UPDATE users SET group_parent_id = NULL WHERE id = $2 AND group_parent_id = $1', [parentId, childId]);
  return rowCount > 0;
}

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CODE_TTL_DAYS = 7;
const hashCode = (code) => crypto.createHash('sha256').update(code).digest('hex');
const normalizeCode = (code) => String(code ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');

// A code the manager sends to the manager above them (12 characters, shown as
// XXXX-XXXX-XXXX). Replaces any earlier code of theirs.
export async function createJoinCode(userId) {
  const raw = Array.from(crypto.randomBytes(12), (b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join('');
  const expiresAt = new Date(Date.now() + CODE_TTL_DAYS * 24 * 60 * 60 * 1000);
  await query(
    `INSERT INTO group_join_codes (child_user_id, code_hash, expires_at) VALUES ($1, $2, $3)
     ON CONFLICT (child_user_id) DO UPDATE SET code_hash = EXCLUDED.code_hash, expires_at = EXCLUDED.expires_at`,
    [userId, hashCode(raw), expiresAt]
  );
  return { code: raw.match(/.{4}/g).join('-'), expiresAt };
}

// Adds the manager who created the code to `parentId`'s group, without a
// further confirmation. Returns the added manager's name, or null for an
// unknown, expired or no longer usable code.
export async function redeemJoinCode(parentId, code) {
  const normalized = normalizeCode(code);
  if (normalized.length !== 12) return null;
  return withTransaction(async (client) => {
    const { rows } = await client.query(
      `SELECT c.child_user_id, u.first_name, u.last_name, u.nickname FROM group_join_codes c
       JOIN users u ON u.id = c.child_user_id WHERE c.code_hash = $1 AND c.expires_at > now()`,
      [hashCode(normalized)]
    );
    if (rows.length === 0) return null;
    const childId = rows[0].child_user_id;
    await client.query('DELETE FROM group_join_codes WHERE child_user_id = $1', [childId]);
    if (!(await canJoin(parentId, childId))) return null;
    await client.query('UPDATE users SET group_parent_id = $2 WHERE id = $1', [childId, parentId]);
    await client.query('DELETE FROM group_invitations WHERE child_user_id = $1', [childId]);
    return nameOf(rows[0]);
  });
}

async function buildNode(userId, depth) {
  const { rows: self } = await query('SELECT first_name, last_name, nickname, group_name, group_data FROM users WHERE id = $1', [userId]);
  const { rows: persons } = await query(
    'SELECT id, first_name, last_name, nickname FROM users WHERE managed_by_user_id = $1 ORDER BY last_name, first_name',
    [userId]
  );
  const { rows: children } = depth >= MAX_DEPTH ? { rows: [] } : await query(
    'SELECT id FROM users WHERE group_parent_id = $1 AND deactivated_at IS NULL ORDER BY last_name, first_name',
    [userId]
  );
  return {
    id: userId,
    name: labelOf(self[0]),
    groupData: self[0].group_data ?? {},
    persons: persons.map((p) => ({ id: p.id, name: nameOf(p) })),
    children: await Promise.all(children.map((c) => buildNode(c.id, depth + 1))),
  };
}

// My group: who I belong to (if anyone), my own persons and the groups below me.
export async function getGroupTree(userId) {
  const { rows } = await query(
    `SELECT p.id, p.first_name, p.last_name, p.nickname, p.group_name FROM users u JOIN users p ON p.id = u.group_parent_id WHERE u.id = $1`,
    [userId]
  );
  return {
    parent: rows[0] ? { id: rows[0].id, name: labelOf(rows[0]) } : null,
    groupName: (await query('SELECT group_name FROM users WHERE id = $1', [userId])).rows[0]?.group_name ?? '',
    groupData: (await query('SELECT group_data FROM users WHERE id = $1', [userId])).rows[0]?.group_data ?? {},
    node: await buildNode(userId, 0),
    incoming: await listIncoming(userId),
    outgoing: await listOutgoing(userId),
  };
}

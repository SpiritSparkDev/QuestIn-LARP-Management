import crypto from 'node:crypto';
import { query, withTransaction } from '../db.js';
import { displayName } from '../displayName.js';
import { getGroupFieldSchema } from '../groupSchema/repository.js';
import { sanitizeFieldValue } from '../richText.js';
import { sendGroupInvitationEmail } from '../auth/mailer.js';
import { logger } from '../logger.js';

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

// Is `ancestorId` the manager of the group `targetUserId` belongs to? Groups
// are flat: the target belongs to the group of whoever manages them (a managed
// person) or to the one they joined themselves. A person's direct manager is
// NOT their group manager -- that is plain ownership, handled elsewhere.
export async function isGroupAncestorOf(ancestorId, targetUserId) {
  const { rows } = await query(
    `SELECT 1 FROM users WHERE id = (SELECT COALESCE(managed_by_user_id, id) FROM users WHERE id = $2) AND group_parent_id = $1`,
    [ancestorId, targetUserId]
  );
  return rows.length > 0;
}

export const JOIN_ERRORS = {
  member: 'Du bist bereits Mitglied einer Gruppe und kannst keiner weiteren Gruppe beitreten.',
  manager: 'Du verwaltest bereits eine eigene Gruppe und kannst deshalb keiner weiteren Gruppe beitreten.',
};

// Why `userId` can't join a group: 'member' (already in one), 'manager' (runs
// one: has people, members, a group name or join codes) or 'unavailable'.
async function joinBlocker(userId, run = query) {
  const { rows } = await run(
    `SELECT group_parent_id IS NOT NULL AS member,
            (coalesce(group_name, '') <> ''
             OR EXISTS (SELECT 1 FROM users m WHERE m.managed_by_user_id = u.id OR m.group_parent_id = u.id)
             OR EXISTS (SELECT 1 FROM group_join_codes c WHERE c.manager_user_id = u.id)) AS manager
     FROM users u WHERE id = $1 AND NOT is_guest AND deactivated_at IS NULL`,
    [userId]
  );
  if (rows.length === 0) return 'unavailable';
  return rows[0].member ? 'member' : rows[0].manager ? 'manager' : null;
}

async function canJoin(parentId, childId, run = query) {
  if (parentId === childId) return false;
  const { rows } = await run('SELECT 1 FROM users WHERE id = $1 AND group_parent_id IS NULL AND NOT is_guest AND deactivated_at IS NULL', [parentId]);
  return rows.length > 0 && (await joinBlocker(childId, run)) === null;
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

// Returns null when the invitation does not exist (any more), { error } when
// the invitee may not join, else { ok: true }.
export async function acceptInvitation(id, userId) {
  return withTransaction(async (client) => {
    const run = client.query.bind(client);
    const { rows } = await client.query('SELECT parent_user_id FROM group_invitations WHERE id = $1 AND child_user_id = $2', [id, userId]);
    if (rows.length === 0) return null;
    const blocker = await joinBlocker(userId, run);
    if (blocker && blocker !== 'unavailable') return { error: JOIN_ERRORS[blocker] };
    if (!(await canJoin(rows[0].parent_user_id, userId, run))) {
      await client.query('DELETE FROM group_invitations WHERE id = $1', [id]);
      return null;
    }
    await client.query('UPDATE users SET group_parent_id = $2 WHERE id = $1', [userId, rows[0].parent_user_id]);
    await client.query('DELETE FROM group_invitations WHERE child_user_id = $1', [userId]);
    return { ok: true };
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
const DAY_MS = 24 * 60 * 60 * 1000;
export const CODE_VALIDITIES = { '1d': 1, '3d': 3, '7d': 7, '1m': 30, unlimited: null };
const hashCode = (code) => crypto.createHash('sha256').update(code).digest('hex');
const normalizeCode = (code) => String(code ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');

// A code the group manager hands out (12 characters, shown as XXXX-XXXX-XXXX).
// `validity` is a key of CODE_VALIDITIES, `maxRedemptions` a number >= 1 or null
// for unlimited. A manager can have any number of codes; only the hash is stored.
export async function createJoinCode(userId, validity, maxRedemptions) {
  const raw = Array.from(crypto.randomBytes(12), (b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join('');
  const days = CODE_VALIDITIES[validity];
  const expiresAt = days ? new Date(Date.now() + days * DAY_MS) : null;
  const { rows } = await query(
    `INSERT INTO group_join_codes (manager_user_id, code_hash, code_hint, expires_at, max_redemptions) VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [userId, hashCode(raw), raw.slice(-4), expiresAt, maxRedemptions]
  );
  return { id: rows[0].id, code: raw.match(/.{4}/g).join('-'), expiresAt, maxRedemptions };
}

export async function listJoinCodes(userId) {
  const { rows } = await query(
    'SELECT id, code_hint, expires_at, max_redemptions, redemptions FROM group_join_codes WHERE manager_user_id = $1 ORDER BY created_at DESC',
    [userId]
  );
  return rows.map((r) => ({
    id: r.id, hint: r.code_hint, expiresAt: r.expires_at, maxRedemptions: r.max_redemptions, redemptions: r.redemptions,
    expired: r.expires_at !== null && r.expires_at <= new Date(),
    remaining: r.max_redemptions === null ? null : Math.max(0, r.max_redemptions - r.redemptions),
  }));
}

export async function deleteJoinCode(id, userId) {
  const { rowCount } = await query('DELETE FROM group_join_codes WHERE id = $1 AND manager_user_id = $2', [id, userId]);
  return rowCount > 0;
}

// Puts `userId` into the group of the manager who made the code, without a
// further confirmation. Returns { name } (the group), null for an unknown,
// expired, used-up or deleted code, or { error } if the redeemer may not join.
// The code row is locked, so concurrent redemptions can't exceed the limit.
export async function redeemJoinCode(userId, code) {
  const normalized = normalizeCode(code);
  if (normalized.length !== 12) return null;
  return withTransaction(async (client) => {
    const run = client.query.bind(client);
    const { rows } = await client.query(
      `SELECT c.id, c.manager_user_id, u.first_name, u.last_name, u.nickname, u.group_name FROM group_join_codes c
       JOIN users u ON u.id = c.manager_user_id
       WHERE c.code_hash = $1 AND (c.expires_at IS NULL OR c.expires_at > now())
         AND (c.max_redemptions IS NULL OR c.redemptions < c.max_redemptions) FOR UPDATE OF c`,
      [hashCode(normalized)]
    );
    if (rows.length === 0) return null;
    const blocker = await joinBlocker(userId, run);
    if (blocker && blocker !== 'unavailable') return { error: JOIN_ERRORS[blocker] };
    if (!(await canJoin(rows[0].manager_user_id, userId, run))) return null;
    const { rowCount } = await client.query('UPDATE users SET group_parent_id = $2 WHERE id = $1 AND group_parent_id IS NULL', [userId, rows[0].manager_user_id]);
    if (rowCount === 0) return { error: JOIN_ERRORS.member };
    await client.query('UPDATE group_join_codes SET redemptions = redemptions + 1 WHERE id = $1', [rows[0].id]);
    await client.query('DELETE FROM group_invitations WHERE child_user_id = $1', [userId]);
    return { name: labelOf(rows[0]) };
  });
}

// Groups are flat: me, my own persons and the members of my group (who have no groups of their own).
async function buildNode(userId, withMembers = true) {
  const { rows: self } = await query('SELECT first_name, last_name, nickname, group_name, group_data FROM users WHERE id = $1', [userId]);
  const { rows: persons } = await query(
    'SELECT id, first_name, last_name, nickname FROM users WHERE managed_by_user_id = $1 ORDER BY last_name, first_name',
    [userId]
  );
  const { rows: children } = withMembers ? await query(
    'SELECT id FROM users WHERE group_parent_id = $1 AND deactivated_at IS NULL ORDER BY last_name, first_name',
    [userId]
  ) : { rows: [] };
  return {
    id: userId,
    name: labelOf(self[0]),
    groupData: self[0].group_data ?? {},
    persons: persons.map((p) => ({ id: p.id, name: nameOf(p) })),
    children: await Promise.all(children.map((c) => buildNode(c.id, false))),
  };
}

// My group: who I belong to (if anyone), my own persons and the groups below me.
export async function getGroupTree(userId) {
  const { rows } = await query(
    `SELECT p.id, p.first_name, p.last_name, p.nickname, p.group_name, p.group_data FROM users u JOIN users p ON p.id = u.group_parent_id WHERE u.id = $1`,
    [userId]
  );
  return {
    parent: rows[0] ? { id: rows[0].id, name: labelOf(rows[0]), groupData: rows[0].group_data ?? {} } : null,
    groupName: (await query('SELECT group_name FROM users WHERE id = $1', [userId])).rows[0]?.group_name ?? '',
    groupData: (await query('SELECT group_data FROM users WHERE id = $1', [userId])).rows[0]?.group_data ?? {},
    node: await buildNode(userId),
    joinCodes: await listJoinCodes(userId),
    canJoinGroup: (await joinBlocker(userId)) === null,
    incoming: await listIncoming(userId),
    outgoing: await listOutgoing(userId),
  };
}

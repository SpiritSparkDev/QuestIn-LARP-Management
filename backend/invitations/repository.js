import crypto from 'node:crypto';
import { query } from '../db.js';
import { displayName } from '../displayName.js';
import { getAccountFieldSchema } from '../accountFieldSchema/repository.js';
import { encryptFieldBlob, decryptFieldBlob } from '../accountFields.js';

const SELECT_COLUMNS = `
  id, token, email, first_name, last_name, nickname, group_id,
  account_data_enc,
  event_id, cancelled_at, user_id,
  invited_by, expires_at, created_at, redeemed_at
`;

function decryptInvitation(row) {
  return {
    id: row.id,
    token: row.token,
    email: row.email,
    firstName: row.first_name,
    lastName: row.last_name,
    nickname: row.nickname,
    name: displayName({ firstName: row.first_name, lastName: row.last_name, nickname: row.nickname }),
    groupId: row.group_id,
    eventId: row.event_id,
    cancelledAt: row.cancelled_at,
    // Set = "convert this existing (guest) user" redeem mode; null = today's
    // "insert a brand-new user" redeem mode. See backend/auth/invite.js.
    userId: row.user_id,
    ...decryptFieldBlob(row.account_data_enc),
    invitedBy: row.invited_by,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
    redeemedAt: row.redeemed_at,
  };
}

export async function createInvitation({ email, firstName, lastName, nickname, groupId, invitedBy, eventId, ttlDays = 3, userId, ...otFields }) {
  const schema = await getAccountFieldSchema();
  const data = {};
  for (const field of schema) {
    if (otFields[field.key] !== undefined) data[field.key] = otFields[field.key];
  }
  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + ttlDays * 24 * 60 * 60 * 1000);
  const { rows } = await query(
    `INSERT INTO invitations (token, email, first_name, last_name, nickname, group_id, account_data_enc, event_id, invited_by, expires_at, user_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
     RETURNING ${SELECT_COLUMNS}`,
    [token, email, firstName, lastName, nickname ?? null, groupId, encryptFieldBlob(data), eventId ?? null, invitedBy, expiresAt, userId ?? null]
  );
  return decryptInvitation(rows[0]);
}

export async function getInvitationByToken(token) {
  const { rows } = await query(`SELECT ${SELECT_COLUMNS} FROM invitations WHERE token = $1`, [token]);
  return rows[0] ? decryptInvitation(rows[0]) : null;
}

export async function getInvitationById(id) {
  const { rows } = await query(`SELECT ${SELECT_COLUMNS} FROM invitations WHERE id = $1`, [id]);
  return rows[0] ? decryptInvitation(rows[0]) : null;
}

export async function regenerateToken(id, ttlDays = 3) {
  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + ttlDays * 24 * 60 * 60 * 1000);
  const { rows } = await query(
    `UPDATE invitations SET token = $2, expires_at = $3
     WHERE id = $1 AND redeemed_at IS NULL
     RETURNING ${SELECT_COLUMNS}`,
    [id, token, expiresAt]
  );
  return rows[0] ? decryptInvitation(rows[0]) : null;
}

// Accepts an optional transaction client so redemption can mark the
// invitation redeemed in the same atomic transaction as user creation.
export async function markRedeemed(id, client) {
  const runner = client ?? { query };
  const { rows } = await runner.query(
    'UPDATE invitations SET redeemed_at = now() WHERE id = $1 AND redeemed_at IS NULL RETURNING id',
    [id]
  );
  return rows.length > 0;
}

export async function listOpenInvitations() {
  const { rows } = await query(
    `SELECT ${SELECT_COLUMNS} FROM invitations WHERE redeemed_at IS NULL AND cancelled_at IS NULL ORDER BY created_at DESC`
  );
  return rows.map(decryptInvitation);
}

export async function cancelInvitation(id) {
  const { rows } = await query(
    'UPDATE invitations SET cancelled_at = now() WHERE id = $1 AND cancelled_at IS NULL RETURNING id',
    [id]
  );
  return rows.length > 0;
}

// Used to render "Benachrichtigt" rows in an event's participant list: an
// invitation for this event with no matching registration yet.
export async function listOpenInvitationsForEvent(eventId) {
  const { rows } = await query(
    `SELECT i.id, i.email, i.first_name, i.last_name, i.nickname
     FROM invitations i
     LEFT JOIN users u ON u.email = i.email
     LEFT JOIN registrations r ON r.user_id = u.id AND r.event_id = i.event_id
     WHERE i.event_id = $1
       AND i.cancelled_at IS NULL
       AND r.user_id IS NULL
       AND (i.redeemed_at IS NOT NULL OR i.expires_at > now())
     ORDER BY i.created_at`,
    [eventId]
  );
  return rows.map((r) => ({
    invitationId: r.id,
    email: r.email,
    name: displayName({ firstName: r.first_name, lastName: r.last_name, nickname: r.nickname }),
  }));
}

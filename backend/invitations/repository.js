import crypto from 'node:crypto';
import { query } from '../db.js';
import { encryptField, decryptField } from '../crypto/fieldCrypto.js';

const INVITATION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const SELECT_COLUMNS = `
  id, token, email, name, group_id,
  address_enc, birthdate_enc, phone_enc, emergency_contact_enc, medical_notes_enc,
  invited_by, expires_at, created_at, redeemed_at
`;

function decryptInvitation(row) {
  return {
    id: row.id,
    token: row.token,
    email: row.email,
    name: row.name,
    groupId: row.group_id,
    address: decryptField(row.address_enc),
    birthdate: decryptField(row.birthdate_enc),
    phone: decryptField(row.phone_enc),
    emergencyContact: decryptField(row.emergency_contact_enc),
    medicalNotes: decryptField(row.medical_notes_enc),
    invitedBy: row.invited_by,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
    redeemedAt: row.redeemed_at,
  };
}

export async function createInvitation({ email, name, groupId, invitedBy, address, birthdate, phone, emergencyContact, medicalNotes }) {
  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + INVITATION_TTL_MS);
  const { rows } = await query(
    `INSERT INTO invitations (token, email, name, group_id, address_enc, birthdate_enc, phone_enc, emergency_contact_enc, medical_notes_enc, invited_by, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
     RETURNING ${SELECT_COLUMNS}`,
    [
      token, email, name, groupId,
      address !== undefined ? encryptField(address) : null,
      birthdate !== undefined ? encryptField(birthdate) : null,
      phone !== undefined ? encryptField(phone) : null,
      emergencyContact !== undefined ? encryptField(emergencyContact) : null,
      medicalNotes !== undefined ? encryptField(medicalNotes) : null,
      invitedBy, expiresAt,
    ]
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

export async function regenerateToken(id) {
  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + INVITATION_TTL_MS);
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
  await runner.query('UPDATE invitations SET redeemed_at = now() WHERE id = $1', [id]);
}

export async function listOpenInvitations() {
  const { rows } = await query(
    `SELECT ${SELECT_COLUMNS} FROM invitations WHERE redeemed_at IS NULL ORDER BY created_at DESC`
  );
  return rows.map(decryptInvitation);
}

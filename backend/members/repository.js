import { query } from '../db.js';
import { encryptField, decryptField } from '../crypto/fieldCrypto.js';

const SELECT_COLUMNS = `
  users.id, users.email, users.name, users.email_verified,
  users.address_enc, users.birthdate_enc, users.phone_enc, users.emergency_contact_enc, users.medical_notes_enc, users.pronomen_enc,
  groups.id AS group_id, groups.key AS group_key, groups.name AS group_name
`;

function decryptMember(row) {
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    emailVerified: row.email_verified,
    status: 'active',
    group: { id: row.group_id, key: row.group_key, name: row.group_name },
    address: decryptField(row.address_enc),
    birthdate: decryptField(row.birthdate_enc),
    phone: decryptField(row.phone_enc),
    emergencyContact: decryptField(row.emergency_contact_enc),
    medicalNotes: decryptField(row.medical_notes_enc),
    pronomen: decryptField(row.pronomen_enc),
  };
}

export async function listMembers() {
  const { rows } = await query(
    `SELECT ${SELECT_COLUMNS} FROM users JOIN groups ON groups.id = users.group_id ORDER BY users.name`
  );
  return rows.map(decryptMember);
}

export async function getMember(id) {
  const { rows } = await query(
    `SELECT ${SELECT_COLUMNS} FROM users JOIN groups ON groups.id = users.group_id WHERE users.id = $1`,
    [id]
  );
  if (rows.length === 0) return null;
  const member = decryptMember(rows[0]);
  const { rows: characterRows } = await query(
    `SELECT characters.id, characters.name, characters.event_id, events.name AS event_name
     FROM characters JOIN events ON events.id = characters.event_id
     WHERE characters.user_id = $1 ORDER BY events.event_date DESC`,
    [id]
  );
  member.characters = characterRows.map((r) => ({ id: r.id, name: r.name, eventId: r.event_id, eventName: r.event_name }));
  return member;
}

export async function updateMember(id, fields) {
  const { rows } = await query(
    `UPDATE users SET
       group_id = COALESCE($2, group_id),
       address_enc = COALESCE($3, address_enc),
       birthdate_enc = COALESCE($4, birthdate_enc),
       phone_enc = COALESCE($5, phone_enc),
       emergency_contact_enc = COALESCE($6, emergency_contact_enc),
       medical_notes_enc = COALESCE($7, medical_notes_enc),
       pronomen_enc = COALESCE($8, pronomen_enc)
     WHERE id = $1
     RETURNING id`,
    [
      id,
      fields.group ?? null,
      fields.address !== undefined ? encryptField(fields.address) : null,
      fields.birthdate !== undefined ? encryptField(fields.birthdate) : null,
      fields.phone !== undefined ? encryptField(fields.phone) : null,
      fields.emergencyContact !== undefined ? encryptField(fields.emergencyContact) : null,
      fields.medicalNotes !== undefined ? encryptField(fields.medicalNotes) : null,
      fields.pronomen !== undefined ? encryptField(fields.pronomen) : null,
    ]
  );
  if (rows.length === 0) return null;
  return getMember(id);
}

import { query } from '../db.js';
import { encryptField, decryptField } from '../crypto/fieldCrypto.js';
import { displayName } from '../displayName.js';

const SELECT_COLUMNS = `
  users.id, users.email, users.first_name, users.last_name, users.nickname, users.email_verified,
  users.address_enc, users.birthdate_enc, users.phone_enc, users.emergency_contact_last_name_enc, users.emergency_contact_first_name_enc, users.emergency_contact_phone_enc, users.medical_notes_enc, users.pronomen_enc,
  groups.id AS group_id, groups.key AS group_key, groups.name AS group_name
`;

function decryptMember(row) {
  return {
    id: row.id,
    email: row.email,
    firstName: row.first_name,
    lastName: row.last_name,
    nickname: row.nickname,
    name: displayName({ firstName: row.first_name, lastName: row.last_name, nickname: row.nickname }),
    emailVerified: row.email_verified,
    status: 'active',
    group: { id: row.group_id, key: row.group_key, name: row.group_name },
    address: decryptField(row.address_enc),
    birthdate: decryptField(row.birthdate_enc),
    phone: decryptField(row.phone_enc),
    emergencyContactLastName: decryptField(row.emergency_contact_last_name_enc),
    emergencyContactFirstName: decryptField(row.emergency_contact_first_name_enc),
    emergencyContactPhone: decryptField(row.emergency_contact_phone_enc),
    medicalNotes: decryptField(row.medical_notes_enc),
    pronomen: decryptField(row.pronomen_enc),
  };
}

export async function listMembers() {
  const { rows } = await query(
    `SELECT ${SELECT_COLUMNS} FROM users JOIN groups ON groups.id = users.group_id ORDER BY users.last_name, users.first_name`
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
       emergency_contact_last_name_enc = COALESCE($6, emergency_contact_last_name_enc),
       emergency_contact_first_name_enc = COALESCE($7, emergency_contact_first_name_enc),
       emergency_contact_phone_enc = COALESCE($8, emergency_contact_phone_enc),
       medical_notes_enc = COALESCE($9, medical_notes_enc),
       pronomen_enc = COALESCE($10, pronomen_enc),
       first_name = COALESCE($11, first_name),
       last_name = COALESCE($12, last_name),
       nickname = COALESCE($13, nickname)
     WHERE id = $1
     RETURNING id`,
    [
      id,
      fields.group ?? null,
      fields.address !== undefined ? encryptField(fields.address) : null,
      fields.birthdate !== undefined ? encryptField(fields.birthdate) : null,
      fields.phone !== undefined ? encryptField(fields.phone) : null,
      fields.emergencyContactLastName !== undefined ? encryptField(fields.emergencyContactLastName) : null,
      fields.emergencyContactFirstName !== undefined ? encryptField(fields.emergencyContactFirstName) : null,
      fields.emergencyContactPhone !== undefined ? encryptField(fields.emergencyContactPhone) : null,
      fields.medicalNotes !== undefined ? encryptField(fields.medicalNotes) : null,
      fields.pronomen !== undefined ? encryptField(fields.pronomen) : null,
      fields.firstName ?? null,
      fields.lastName ?? null,
      fields.nickname ?? null,
    ]
  );
  if (rows.length === 0) return null;
  return getMember(id);
}

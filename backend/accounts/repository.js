import { query } from '../db.js';
import { encryptField, decryptField } from '../crypto/fieldCrypto.js';

function decryptAccount(row) {
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    group: { key: row.group_key, name: row.group_name },
    menus: row.visible_menus,
    canEditCharacters: row.can_edit_characters,
    emailVerified: row.email_verified,
    address: decryptField(row.address_enc),
    birthdate: decryptField(row.birthdate_enc),
    phone: decryptField(row.phone_enc),
    emergencyContact: decryptField(row.emergency_contact_enc),
    medicalNotes: decryptField(row.medical_notes_enc),
  };
}

const SELECT_COLUMNS = `
  users.id, users.email, users.name, users.email_verified,
  users.address_enc, users.birthdate_enc, users.phone_enc, users.emergency_contact_enc, users.medical_notes_enc,
  groups.key AS group_key, groups.name AS group_name, groups.visible_menus, groups.can_edit_characters
`;

const FROM_JOIN = `FROM users JOIN groups ON groups.id = users.group_id`;

export async function getAccount(userId) {
  const { rows } = await query(`SELECT ${SELECT_COLUMNS} ${FROM_JOIN} WHERE users.id = $1`, [userId]);
  if (rows.length === 0) return null;
  return decryptAccount(rows[0]);
}

export async function updateAccount(userId, fields) {
  const { rows } = await query(
    `UPDATE users SET
       name = COALESCE($2, name),
       address_enc = COALESCE($3, address_enc),
       birthdate_enc = COALESCE($4, birthdate_enc),
       phone_enc = COALESCE($5, phone_enc),
       emergency_contact_enc = COALESCE($6, emergency_contact_enc),
       medical_notes_enc = COALESCE($7, medical_notes_enc)
     WHERE id = $1
     RETURNING id`,
    [
      userId,
      fields.name ?? null,
      fields.address !== undefined ? encryptField(fields.address) : null,
      fields.birthdate !== undefined ? encryptField(fields.birthdate) : null,
      fields.phone !== undefined ? encryptField(fields.phone) : null,
      fields.emergencyContact !== undefined ? encryptField(fields.emergencyContact) : null,
      fields.medicalNotes !== undefined ? encryptField(fields.medicalNotes) : null,
    ]
  );
  if (rows.length === 0) return null;
  return getAccount(userId);
}

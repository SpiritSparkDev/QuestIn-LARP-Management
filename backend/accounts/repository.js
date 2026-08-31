import { query } from '../db.js';
import { encryptField, decryptField } from '../crypto/fieldCrypto.js';
import { displayName } from '../displayName.js';

function decryptAccount(row) {
  return {
    id: row.id,
    email: row.email,
    firstName: row.first_name,
    lastName: row.last_name,
    nickname: row.nickname,
    name: displayName({ firstName: row.first_name, lastName: row.last_name, nickname: row.nickname }),
    group: { key: row.group_key, name: row.group_name },
    menus: row.visible_menus,
    canEditCharacters: row.can_edit_characters,
    accountFields: row.account_fields,
    characterClasses: row.character_classes,
    canOverrideCheckinStatus: row.can_override_checkin_status,
    emailVerified: row.email_verified,
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

const SELECT_COLUMNS = `
  users.id, users.email, users.first_name, users.last_name, users.nickname, users.email_verified,
  users.address_enc, users.birthdate_enc, users.phone_enc, users.emergency_contact_last_name_enc, users.emergency_contact_first_name_enc, users.emergency_contact_phone_enc, users.medical_notes_enc, users.pronomen_enc,
  groups.key AS group_key, groups.name AS group_name, groups.visible_menus, groups.can_edit_characters, groups.account_fields, groups.character_classes, groups.can_override_checkin_status
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
       first_name = COALESCE($2, first_name),
       last_name = COALESCE($3, last_name),
       nickname = COALESCE($4, nickname),
       address_enc = COALESCE($5, address_enc),
       birthdate_enc = COALESCE($6, birthdate_enc),
       phone_enc = COALESCE($7, phone_enc),
       emergency_contact_last_name_enc = COALESCE($8, emergency_contact_last_name_enc),
       emergency_contact_first_name_enc = COALESCE($9, emergency_contact_first_name_enc),
       emergency_contact_phone_enc = COALESCE($10, emergency_contact_phone_enc),
       medical_notes_enc = COALESCE($11, medical_notes_enc),
       pronomen_enc = COALESCE($12, pronomen_enc)
     WHERE id = $1
     RETURNING id`,
    [
      userId,
      fields.firstName ?? null,
      fields.lastName ?? null,
      fields.nickname ?? null,
      fields.address !== undefined ? encryptField(fields.address) : null,
      fields.birthdate !== undefined ? encryptField(fields.birthdate) : null,
      fields.phone !== undefined ? encryptField(fields.phone) : null,
      fields.emergencyContactLastName !== undefined ? encryptField(fields.emergencyContactLastName) : null,
      fields.emergencyContactFirstName !== undefined ? encryptField(fields.emergencyContactFirstName) : null,
      fields.emergencyContactPhone !== undefined ? encryptField(fields.emergencyContactPhone) : null,
      fields.medicalNotes !== undefined ? encryptField(fields.medicalNotes) : null,
      fields.pronomen !== undefined ? encryptField(fields.pronomen) : null,
    ]
  );
  if (rows.length === 0) return null;
  return getAccount(userId);
}

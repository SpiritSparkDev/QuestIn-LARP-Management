import { query } from '../db.js';
import { displayName } from '../displayName.js';
import { decryptEncryptedAccountFields, encryptAccountFieldValues } from '../accountFields.js';

function decryptAccount(row) {
  return {
    id: row.id,
    email: row.email,
    firstName: row.first_name,
    lastName: row.last_name,
    nickname: row.nickname,
    hotkeys: row.hotkeys,
    name: displayName({ firstName: row.first_name, lastName: row.last_name, nickname: row.nickname }),
    group: { key: row.group_key, name: row.group_name },
    menus: row.visible_menus,
    canEditCharacters: row.can_edit_characters,
    accountFields: row.account_fields,
    characterClasses: row.character_classes,
    canOverrideCheckinStatus: row.can_override_checkin_status,
    emailVerified: row.email_verified,
    ...decryptEncryptedAccountFields(row),
  };
}

const SELECT_COLUMNS = `
  users.id, users.email, users.first_name, users.last_name, users.nickname, users.email_verified, users.hotkeys,
  users.address_enc, users.birthdate_enc, users.phone_enc, users.emergency_contact_last_name_enc, users.emergency_contact_first_name_enc, users.emergency_contact_phone_enc, users.medical_notes_enc,
  users.con_tage_enc, users.accommodation_enc, users.craft_offer_enc, users.travel_method_enc, users.data_sharing_opt_out_enc, users.photo_opt_out_enc,
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
       hotkeys = COALESCE($5, hotkeys),
       address_enc = COALESCE($6, address_enc),
       birthdate_enc = COALESCE($7, birthdate_enc),
       phone_enc = COALESCE($8, phone_enc),
       emergency_contact_last_name_enc = COALESCE($9, emergency_contact_last_name_enc),
       emergency_contact_first_name_enc = COALESCE($10, emergency_contact_first_name_enc),
       emergency_contact_phone_enc = COALESCE($11, emergency_contact_phone_enc),
       medical_notes_enc = COALESCE($12, medical_notes_enc),
       con_tage_enc = COALESCE($13, con_tage_enc),
       accommodation_enc = COALESCE($14, accommodation_enc),
       craft_offer_enc = COALESCE($15, craft_offer_enc),
       travel_method_enc = COALESCE($16, travel_method_enc),
       data_sharing_opt_out_enc = COALESCE($17, data_sharing_opt_out_enc),
       photo_opt_out_enc = COALESCE($18, photo_opt_out_enc)
     WHERE id = $1
     RETURNING id`,
    [
      userId,
      fields.firstName ?? null,
      fields.lastName ?? null,
      fields.nickname ?? null,
      fields.hotkeys !== undefined ? JSON.stringify(fields.hotkeys) : null,
      ...encryptAccountFieldValues(fields),
    ]
  );
  if (rows.length === 0) return null;
  return getAccount(userId);
}

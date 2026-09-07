import { query, withTransaction } from '../db.js';
import { displayName } from '../displayName.js';
import { decryptEncryptedAccountFields, encryptAccountFieldValues } from '../accountFields.js';

const SELECT_COLUMNS = `
  users.id, users.email, users.first_name, users.last_name, users.nickname, users.email_verified, users.deactivated_at,
  users.address_enc, users.birthdate_enc, users.phone_enc, users.emergency_contact_last_name_enc, users.emergency_contact_first_name_enc, users.emergency_contact_phone_enc, users.medical_notes_enc,
  users.con_tage_enc, users.accommodation_enc, users.craft_offer_enc, users.travel_method_enc, users.data_sharing_opt_out_enc, users.photo_opt_out_enc,
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
    status: row.deactivated_at ? 'deactivated' : 'active',
    deactivatedAt: row.deactivated_at,
    group: { id: row.group_id, key: row.group_key, name: row.group_name },
    ...decryptEncryptedAccountFields(row),
  };
}

export async function listMembers(includeDeactivated = false) {
  const where = includeDeactivated ? '' : 'WHERE users.deactivated_at IS NULL';
  const { rows } = await query(
    `SELECT ${SELECT_COLUMNS} FROM users JOIN groups ON groups.id = users.group_id ${where} ORDER BY users.last_name, users.first_name`
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
       first_name = COALESCE($3, first_name),
       last_name = COALESCE($4, last_name),
       nickname = COALESCE($5, nickname),
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
      id,
      fields.group ?? null,
      fields.firstName ?? null,
      fields.lastName ?? null,
      fields.nickname ?? null,
      ...encryptAccountFieldValues(fields),
    ]
  );
  if (rows.length === 0) return null;
  return getMember(id);
}

export async function deactivateMember(id) {
  return withTransaction(async (client) => {
    const { rows } = await client.query(
      'UPDATE users SET deactivated_at = now() WHERE id = $1 RETURNING id',
      [id]
    );
    if (rows.length === 0) return null;
    await client.query('DELETE FROM sessions WHERE user_id = $1', [id]);
    return rows[0];
  });
}

export async function reactivateMember(id) {
  const { rows } = await query(
    'UPDATE users SET deactivated_at = NULL WHERE id = $1 RETURNING id',
    [id]
  );
  return rows[0] ?? null;
}

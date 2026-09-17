import { query } from '../db.js';
import { displayName } from '../displayName.js';
import { getAccountFieldSchema } from '../accountFieldSchema/repository.js';
import { encryptFieldBlob, decryptFieldBlob } from '../accountFields.js';

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
    canOverrideCheckinStatus: row.can_override_checkin_status,
    emailVerified: row.email_verified,
    discordUsername: row.discord_username,
    ...decryptFieldBlob(row.account_data_enc),
  };
}

const SELECT_COLUMNS = `
  users.id, users.email, users.first_name, users.last_name, users.nickname, users.email_verified, users.hotkeys,
  users.account_data_enc,
  groups.key AS group_key, groups.name AS group_name, groups.visible_menus, groups.can_edit_characters, groups.account_fields, groups.can_override_checkin_status,
  discord_accounts.username AS discord_username
`;

const FROM_JOIN = `
  FROM users JOIN groups ON groups.id = users.group_id
  LEFT JOIN oauth_accounts discord_accounts ON discord_accounts.user_id = users.id AND discord_accounts.provider = 'discord'
`;

export async function getAccount(userId) {
  const { rows } = await query(`SELECT ${SELECT_COLUMNS} ${FROM_JOIN} WHERE users.id = $1`, [userId]);
  if (rows.length === 0) return null;
  return decryptAccount(rows[0]);
}

export async function updateAccount(userId, fields) {
  const schema = await getAccountFieldSchema();
  const { rows: currentRows } = await query('SELECT account_data_enc FROM users WHERE id = $1', [userId]);
  if (currentRows.length === 0) return null;
  const nextData = decryptFieldBlob(currentRows[0].account_data_enc);
  for (const field of schema) {
    if (fields[field.key] !== undefined) nextData[field.key] = fields[field.key];
  }

  // Merges into the blob in JS rather than one atomic UPDATE ... COALESCE
  // per column (impossible once the field set is dynamic) -- two
  // concurrent PATCH /account calls touching different fields on the same
  // account can race, last write wins. Accepted tradeoff of the
  // single-blob model (design spec 2026-09-17, section 9).
  const { rows } = await query(
    `UPDATE users SET
       first_name = COALESCE($2, first_name),
       last_name = COALESCE($3, last_name),
       nickname = COALESCE($4, nickname),
       hotkeys = COALESCE($5, hotkeys),
       account_data_enc = $6
     WHERE id = $1
     RETURNING id`,
    [
      userId,
      fields.firstName ?? null,
      fields.lastName ?? null,
      fields.nickname ?? null,
      fields.hotkeys !== undefined ? JSON.stringify(fields.hotkeys) : null,
      encryptFieldBlob(nextData),
    ]
  );
  if (rows.length === 0) return null;
  return getAccount(userId);
}

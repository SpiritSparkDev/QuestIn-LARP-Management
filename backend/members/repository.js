import { query, withTransaction } from '../db.js';
import { displayName } from '../displayName.js';
import { getAccountFieldSchema } from '../accountFieldSchema/repository.js';
import { encryptFieldBlob, decryptFieldBlob } from '../accountFields.js';

const SELECT_COLUMNS = `
  users.id, users.email, users.first_name, users.last_name, users.nickname, users.email_verified, users.deactivated_at,
  users.is_guest,
  users.account_data_enc,
  groups.id AS group_id, groups.key AS group_key, groups.name AS group_name,
  discord_accounts.username AS discord_username
`;

const FROM_JOIN = `
  FROM users JOIN groups ON groups.id = users.group_id
  LEFT JOIN oauth_accounts discord_accounts ON discord_accounts.user_id = users.id AND discord_accounts.provider = 'discord'
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
    isGuest: row.is_guest,
    group: { id: row.group_id, key: row.group_key, name: row.group_name },
    discordUsername: row.discord_username,
    ...decryptFieldBlob(row.account_data_enc),
  };
}

export async function listMembers(includeDeactivated = false) {
  const where = includeDeactivated ? '' : 'WHERE users.deactivated_at IS NULL';
  const { rows } = await query(
    `SELECT ${SELECT_COLUMNS} ${FROM_JOIN} ${where} ORDER BY users.last_name, users.first_name`
  );
  return rows.map(decryptMember);
}

export async function getMember(id) {
  const { rows } = await query(
    `SELECT ${SELECT_COLUMNS} ${FROM_JOIN} WHERE users.id = $1`,
    [id]
  );
  if (rows.length === 0) return null;
  const member = decryptMember(rows[0]);
  // A character no longer carries its own event_id (account-wide, can be
  // registered for many events) -- "its" event(s) only exist via
  // registrations.character_id, so this lists one row per registration
  // rather than one row per character.
  const { rows: characterRows } = await query(
    `SELECT characters.id, characters.name, registrations.event_id, events.name AS event_name
     FROM characters
     JOIN registrations ON registrations.character_id = characters.id
     JOIN events ON events.id = registrations.event_id
     WHERE characters.user_id = $1 ORDER BY events.event_date DESC`,
    [id]
  );
  member.characters = characterRows.map((r) => ({ id: r.id, name: r.name, eventId: r.event_id, eventName: r.event_name }));
  return member;
}

export async function updateMember(id, fields) {
  const schema = await getAccountFieldSchema();
  const { rows: currentRows } = await query('SELECT account_data_enc FROM users WHERE id = $1', [id]);
  if (currentRows.length === 0) return null;
  const nextData = decryptFieldBlob(currentRows[0].account_data_enc);
  for (const field of schema) {
    if (fields[field.key] !== undefined) nextData[field.key] = fields[field.key];
  }

  const { rows } = await query(
    `UPDATE users SET
       group_id = COALESCE($2, group_id),
       first_name = COALESCE($3, first_name),
       last_name = COALESCE($4, last_name),
       nickname = COALESCE($5, nickname),
       account_data_enc = $6
     WHERE id = $1
     RETURNING id`,
    [
      id,
      fields.group ?? null,
      fields.firstName ?? null,
      fields.lastName ?? null,
      fields.nickname ?? null,
      encryptFieldBlob(nextData),
    ]
  );
  if (rows.length === 0) return null;
  return getMember(id);
}

export async function deactivateMember(id) {
  return withTransaction(async (client) => {
    const { rows } = await client.query(
      'UPDATE users SET deactivated_at = COALESCE(deactivated_at, now()) WHERE id = $1 RETURNING id',
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

export async function deleteMember(id) {
  const { rows } = await query('DELETE FROM users WHERE id = $1 RETURNING id', [id]);
  return rows[0] ?? null;
}

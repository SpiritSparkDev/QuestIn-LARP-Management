import { query, withTransaction } from '../db.js';
import { displayName } from '../displayName.js';
import { getAccountFieldSchema } from '../accountFieldSchema/repository.js';
import { encryptFieldBlob, decryptFieldBlob } from '../accountFields.js';
import { sanitizeFieldValue } from '../richText.js';
import { decryptFieldBlob as decryptRegistrationBlob } from '../registrationFields.js';

const SELECT_COLUMNS = `
  users.id, users.email, users.first_name, users.last_name, users.nickname, users.email_verified, users.deactivated_at,
  users.is_guest, users.managed_by_user_id,
  owners.first_name AS owner_first_name, owners.last_name AS owner_last_name, owners.nickname AS owner_nickname,
  users.account_data_enc,
  groups.id AS group_id, groups.key AS group_key, groups.name AS group_name,
  discord_accounts.username AS discord_username
`;

const FROM_JOIN = `
  FROM users JOIN groups ON groups.id = users.group_id
  LEFT JOIN users owners ON owners.id = users.managed_by_user_id
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
    // Set for a managed person (registered by someone else, e.g. a group or a child): who manages them.
    managedBy: row.managed_by_user_id
      ? { id: row.managed_by_user_id, name: displayName({ firstName: row.owner_first_name, lastName: row.owner_last_name, nickname: row.owner_nickname }) }
      : null,
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
  const members = rows.map(decryptMember);

  // Each member's event registrations (event + status only), so the list can
  // be filtered by registration without a request per member.
  const { rows: registrationRows } = await query(
    'SELECT user_id, event_id, status, con_payer FROM registrations WHERE user_id = ANY($1::uuid[])',
    [members.map((m) => m.id)]
  );
  const byUser = new Map();
  for (const r of registrationRows) {
    if (!byUser.has(r.user_id)) byUser.set(r.user_id, []);
    byUser.get(r.user_id).push({ eventId: r.event_id, status: r.status, conPayer: r.con_payer });
  }
  return members.map((m) => ({ ...m, registrations: byUser.get(m.id) ?? [] }));
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
  // registrations.character_id, so this lists one row per registration. The
  // LEFT JOINs keep characters that aren't registered anywhere yet, so staff
  // can still find (and edit) them here.
  const { rows: characterRows } = await query(
    `SELECT characters.id, characters.name, characters.class, registrations.event_id, events.name AS event_name
     FROM characters
     LEFT JOIN registrations ON registrations.character_id = characters.id
     LEFT JOIN events ON events.id = registrations.event_id
     WHERE characters.user_id = $1 ORDER BY events.event_date DESC NULLS LAST, characters.created_at`,
    [id]
  );
  member.characters = characterRows.map((r) => ({ id: r.id, name: r.name, class: r.class, eventId: r.event_id, eventName: r.event_name }));
  const { rows: registrationRows } = await query(
    `SELECT r.event_id, r.status, r.con_role, r.extras, r.waiver_version_accepted, r.waiver_accepted_at, r.registration_data_enc, r.nsc_wishes, c.name AS character_name
     FROM registrations r LEFT JOIN characters c ON c.id = r.character_id WHERE r.user_id = $1`,
    [id]
  );
  member.registrations = registrationRows.map((r) => ({
    eventId: r.event_id,
    status: r.status,
    conRole: r.con_role,
    characterName: r.character_name,
    nscWishes: r.nsc_wishes,
    extras: r.extras,
    waiverVersionAccepted: r.waiver_version_accepted,
    waiverAcceptedAt: r.waiver_accepted_at,
    fields: decryptRegistrationBlob(r.registration_data_enc),
  }));
  return member;
}

export async function updateMember(id, fields) {
  const schema = await getAccountFieldSchema();
  const { rows: currentRows } = await query('SELECT account_data_enc FROM users WHERE id = $1', [id]);
  if (currentRows.length === 0) return null;
  const nextData = decryptFieldBlob(currentRows[0].account_data_enc);
  for (const field of schema) {
    if (fields[field.key] !== undefined) nextData[field.key] = sanitizeFieldValue(field, fields[field.key]);
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

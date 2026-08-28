import { query } from '../db.js';

const SELECT_COLUMNS = 'id, key, name, visible_menus, account_fields, can_edit_characters, character_classes, can_override_checkin_status, is_protected';

export async function listGroups() {
  const { rows } = await query(`SELECT ${SELECT_COLUMNS} FROM groups ORDER BY name`);
  return rows;
}

export async function getGroup(id) {
  const { rows } = await query(`SELECT ${SELECT_COLUMNS} FROM groups WHERE id = $1`, [id]);
  return rows[0] ?? null;
}

export async function createGroup({ key, name, visibleMenus, accountFields, canEditCharacters, characterClasses, canOverrideCheckinStatus }) {
  const { rows } = await query(
    `INSERT INTO groups (key, name, visible_menus, account_fields, can_edit_characters, character_classes, can_override_checkin_status)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING ${SELECT_COLUMNS}`,
    [key, name, JSON.stringify(visibleMenus ?? []), JSON.stringify(accountFields ?? []), !!canEditCharacters, JSON.stringify(characterClasses ?? []), !!canOverrideCheckinStatus]
  );
  return rows[0];
}

export async function updateGroup(id, { name, visibleMenus, accountFields, canEditCharacters, characterClasses, canOverrideCheckinStatus }) {
  const { rows } = await query(
    `UPDATE groups SET
       name = COALESCE($2, name),
       visible_menus = COALESCE($3, visible_menus),
       account_fields = COALESCE($4, account_fields),
       can_edit_characters = COALESCE($5, can_edit_characters),
       character_classes = COALESCE($6, character_classes),
       can_override_checkin_status = COALESCE($7, can_override_checkin_status)
     WHERE id = $1
     RETURNING ${SELECT_COLUMNS}`,
    [
      id,
      name ?? null,
      visibleMenus !== undefined ? JSON.stringify(visibleMenus) : null,
      accountFields !== undefined ? JSON.stringify(accountFields) : null,
      canEditCharacters !== undefined ? canEditCharacters : null,
      characterClasses !== undefined ? JSON.stringify(characterClasses) : null,
      canOverrideCheckinStatus !== undefined ? canOverrideCheckinStatus : null,
    ]
  );
  return rows[0] ?? null;
}

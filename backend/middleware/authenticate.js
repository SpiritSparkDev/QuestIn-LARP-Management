import { parseCookies, SESSION_COOKIE_NAME } from '../auth/cookies.js';
import { getSession } from '../auth/sessions.js';
import { query } from '../db.js';
import { effectiveAccountFields } from '../groups/repository.js';

// Group management (inviting, naming, registering people ...) is for the group
// manager only; plain members of a group get a 403.
export function requireGroupManager(handler) {
  return requireAuth((ctx) => (
    ctx.user.groupMemberOnly
      ? { status: 403, body: { error: 'Nur der Gruppenverwalter darf die Gruppe verwalten.' } }
      : handler(ctx)
  ));
}

export function requireAuth(handler) {
  return async (ctx) => {
    const cookies = parseCookies(ctx.req.headers.cookie);
    const token = cookies[SESSION_COOKIE_NAME];
    if (!token) return { status: 401, body: { error: 'Nicht angemeldet.' } };

    const session = await getSession(token);
    if (!session) return { status: 401, body: { error: 'Nicht angemeldet.' } };

    const { rows } = await query(
      `SELECT users.id, users.email, users.deactivated_at, (users.group_member_only OR users.group_parent_id IS NOT NULL) AS group_member_only,
              groups.id AS group_id, groups.key AS group_key, groups.name AS group_name,
              groups.visible_menus, groups.account_fields, groups.can_edit_characters,
              groups.can_override_checkin_status, groups.can_export_members, groups.can_export_sensitive, groups.can_use_offline
       FROM users
       JOIN groups ON groups.id = users.group_id
       WHERE users.id = $1`,
      [session.userId]
    );
    if (rows.length === 0) return { status: 401, body: { error: 'Nicht angemeldet.' } };
    if (rows[0].deactivated_at) return { status: 401, body: { error: 'Konto deaktiviert.' } };

    const row = rows[0];
    const user = {
      id: row.id,
      email: row.email,
      groupMemberOnly: row.group_member_only,
      group: {
        id: row.group_id,
        key: row.group_key,
        name: row.group_name,
        visibleMenus: row.visible_menus,
        accountFields: await effectiveAccountFields(row.group_key, row.account_fields),
        canEditCharacters: row.can_edit_characters,
        canOverrideCheckinStatus: row.can_override_checkin_status,
        canExportMembers: row.can_export_members,
        canExportSensitive: row.can_export_sensitive,
        canUseOffline: row.can_use_offline,
      },
    };

    // "Als [Rolle] betrachten": a real admin sees (and acts with) another group's
    // permissions for this session. The identity stays the same.
    if (session.viewAsGroupId && user.group.key === 'admin') {
      const { rows: viewRows } = await query(
        `SELECT id, key, name, visible_menus, account_fields, can_edit_characters, can_override_checkin_status, can_export_members, can_export_sensitive, can_use_offline
         FROM groups WHERE id = $1`,
        [session.viewAsGroupId]
      );
      if (viewRows.length > 0) {
        const v = viewRows[0];
        user.realGroup = user.group;
        user.viewingAs = { id: v.id, key: v.key, name: v.name };
        user.group = {
          id: v.id,
          key: v.key,
          name: v.name,
          visibleMenus: v.visible_menus,
          accountFields: v.account_fields,
          canEditCharacters: v.can_edit_characters,
          canOverrideCheckinStatus: v.can_override_checkin_status,
          canExportMembers: v.can_export_members,
          canExportSensitive: v.can_export_sensitive,
          canUseOffline: v.can_use_offline,
        };
      }
    }

    return handler({ ...ctx, user });
  };
}

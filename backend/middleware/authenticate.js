import { parseCookies, SESSION_COOKIE_NAME } from '../auth/cookies.js';
import { getSession } from '../auth/sessions.js';
import { query } from '../db.js';

export function requireAuth(handler) {
  return async (ctx) => {
    const cookies = parseCookies(ctx.req.headers.cookie);
    const token = cookies[SESSION_COOKIE_NAME];
    if (!token) return { status: 401, body: { error: 'Nicht angemeldet.' } };

    const session = await getSession(token);
    if (!session) return { status: 401, body: { error: 'Nicht angemeldet.' } };

    const { rows } = await query(
      `SELECT users.id, users.email, users.deactivated_at,
              groups.id AS group_id, groups.key AS group_key, groups.name AS group_name,
              groups.visible_menus, groups.account_fields, groups.can_edit_characters,
              groups.can_override_checkin_status
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
      group: {
        id: row.group_id,
        key: row.group_key,
        name: row.group_name,
        visibleMenus: row.visible_menus,
        accountFields: row.account_fields,
        canEditCharacters: row.can_edit_characters,
        canOverrideCheckinStatus: row.can_override_checkin_status,
      },
    };

    return handler({ ...ctx, user });
  };
}

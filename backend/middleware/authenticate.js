import { parseCookies, SESSION_COOKIE_NAME } from '../auth/cookies.js';
import { getSession } from '../auth/sessions.js';
import { query } from '../db.js';

export function requireAuth(handler) {
  return async (ctx) => {
    const cookies = parseCookies(ctx.req.headers.cookie);
    const token = cookies[SESSION_COOKIE_NAME];
    if (!token) return { status: 401, body: { error: 'not authenticated' } };

    const session = await getSession(token);
    if (!session) return { status: 401, body: { error: 'not authenticated' } };

    const { rows } = await query('SELECT id, email, role, name FROM users WHERE id = $1', [session.userId]);
    if (rows.length === 0) return { status: 401, body: { error: 'not authenticated' } };

    return handler({ ...ctx, user: rows[0] });
  };
}

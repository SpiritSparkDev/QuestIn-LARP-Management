import { router } from '../routes.js';
import { requireAuth } from '../middleware/authenticate.js';
import { readJsonBody } from '../httpBody.js';
import { parseCookies, SESSION_COOKIE_NAME } from '../auth/cookies.js';
import { setSessionViewAs } from '../auth/sessions.js';
import { query } from '../db.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// "Als [Rolle] betrachten": only a real admin (also while viewing as someone
// else, so they can always get back). groupId null ends it.
router.post('/view-as', requireAuth(async ({ req, user }) => {
  if ((user.realGroup ?? user.group).key !== 'admin') return { status: 403, body: { error: 'Kein Zugriff.' } };
  const body = await readJsonBody(req);
  if (body === null) return { status: 400, body: { error: 'invalid JSON' } };
  const token = parseCookies(req.headers.cookie)[SESSION_COOKIE_NAME];
  if (body.groupId === null || body.groupId === undefined) {
    await setSessionViewAs(token, null);
    return { status: 200, body: { viewingAs: null } };
  }
  if (typeof body.groupId !== 'string' || !UUID_RE.test(body.groupId)) return { status: 400, body: { error: 'groupId must be a group id' } };
  const { rows } = await query('SELECT id, key, name FROM groups WHERE id = $1', [body.groupId]);
  if (rows.length === 0) return { status: 404, body: { error: 'group not found' } };
  await setSessionViewAs(token, rows[0].id);
  return { status: 200, body: { viewingAs: rows[0] } };
}));

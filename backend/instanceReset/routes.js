import { router } from '../routes.js';
import { requireAuth } from '../middleware/authenticate.js';
import { requireAdminGroup } from '../middleware/authorize.js';
import { readJsonBody } from '../httpBody.js';
import { query } from '../db.js';
import { verifyPassword } from '../crypto/password.js';
import { isOffline } from '../appMode.js';
import { envAdminEmail, isEnvAdmin, getInstanceName, getResetPreview, resetInstance } from './reset.js';

function blockedReason(user) {
  if (isOffline()) return 'Auf der Offline-Instanz gibt es kein Zurücksetzen.';
  if (!envAdminEmail()) return 'ADMINUSER ist auf diesem Server nicht gesetzt, darum kann niemand die Instanz zurücksetzen.';
  if (!isEnvAdmin(user)) return 'Nur der Admin aus der Umgebungsvariable ADMINUSER darf die Instanz zurücksetzen.';
  return null;
}

router.get('/instance-reset', requireAuth(requireAdminGroup(async ({ req, user }) => {
  const reason = blockedReason(user);
  if (reason) return { status: 200, body: { allowed: false, reason } };
  return {
    status: 200,
    body: { allowed: true, instanceName: await getInstanceName(req.headers.host), counts: await getResetPreview() },
  };
})));

router.post('/instance-reset', requireAuth(requireAdminGroup(async ({ req, user }) => {
  const reason = blockedReason(user);
  if (reason) return { status: 403, body: { error: reason } };
  const body = await readJsonBody(req);
  if (body === null) return { status: 400, body: { error: 'invalid JSON' } };

  const instanceName = await getInstanceName(req.headers.host);
  if (String(body.confirm ?? '').trim().toLowerCase() !== instanceName) {
    return { status: 400, body: { error: `Zur Bestätigung bitte genau „${instanceName}" eintippen.` } };
  }
  const { rows } = await query('SELECT password_hash FROM users WHERE id = $1', [user.id]);
  if (!rows[0]?.password_hash || typeof body.password !== 'string' || !(await verifyPassword(body.password, rows[0].password_hash))) {
    return { status: 403, body: { error: 'Das Passwort stimmt nicht.' } };
  }

  const result = await resetInstance({ actor: user, includeSettings: body.includeSettings === true });
  return { status: 200, body: result };
})));

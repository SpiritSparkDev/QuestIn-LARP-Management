import { router } from '../routes.js';
import { hashPassword } from '../crypto/password.js';
import { createSession } from './sessions.js';
import { serializeSessionCookie } from './cookies.js';
import { readJsonBody } from '../httpBody.js';
import { getInvitationByToken } from '../invitations/repository.js';
import { activateInvitation } from '../invitations/activate.js';
import { isValidPassword, isValidEmail } from '../validation.js';

// Lets the set-password page know whether the person still has to enter an e-mail address.
router.get('/auth/invite/info', async ({ req }) => {
  const token = new URL(req.url, 'http://localhost').searchParams.get('token') ?? '';
  const invitation = await getInvitationByToken(token);
  if (!invitation || invitation.redeemedAt || invitation.cancelledAt || new Date(invitation.expiresAt) < new Date()) {
    return { status: 400, body: { error: 'Ungültiger oder abgelaufener Link.' } };
  }
  return { status: 200, body: { needsEmail: !invitation.email, name: invitation.name } };
});

router.post('/auth/invite/redeem', async ({ req }) => {
  const body = await readJsonBody(req);
  if (body === null) return { status: 400, body: { error: 'invalid JSON' } };
  const { token, password } = body;
  if (!token || !password) {
    return { status: 400, body: { error: 'token and password are required' } };
  }
  if (!isValidPassword(password)) {
    return { status: 400, body: { error: 'Passwort muss mindestens 8 Zeichen lang sein.' } };
  }

  const invitation = await getInvitationByToken(token);
  if (!invitation || invitation.redeemedAt || invitation.cancelledAt || new Date(invitation.expiresAt) < new Date()) {
    return { status: 400, body: { error: 'Ungültiger oder abgelaufener Link.' } };
  }

  const email = (invitation.email || body.email || '').trim().toLowerCase();
  if (!isValidEmail(email)) {
    return { status: 400, body: { error: 'Bitte gib eine gültige E-Mail-Adresse an.' } };
  }

  const passwordHash = await hashPassword(password);

  let userId;
  try {
    ({ userId } = await activateInvitation(invitation, { passwordHash, email }));
  } catch (err) {
    if (err.code === 'ALREADY_REDEEMED') {
      return { status: 400, body: { error: 'Ungültiger oder abgelaufener Link.' } };
    }
    if (err.code === '23505') {
      return { status: 409, body: { error: 'Diese E-Mail-Adresse wird bereits verwendet.' } };
    }
    throw err;
  }

  const session = await createSession(userId);
  return {
    status: 200,
    body: { id: userId },
    headers: { 'Set-Cookie': serializeSessionCookie(session.token, session.expiresAt) },
  };
});

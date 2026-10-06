import { router } from '../routes.js';
import { withTransaction } from '../db.js';
import { hashPassword } from '../crypto/password.js';
import { createSession } from './sessions.js';
import { serializeSessionCookie } from './cookies.js';
import { readJsonBody } from '../httpBody.js';
import { rateLimit } from '../middleware/rateLimit.js';
import { isValidPassword } from '../validation.js';
import { generateAccessToken } from './accessTokens.js';
import { getEmailInvitation } from '../groupTree/repository.js';

const REDEEM_RATE_LIMIT = { keyPrefix: 'group-invite-redeem', maxAttempts: 20, windowMs: 15 * 60 * 1000 };
const INVALID = { status: 400, body: { error: 'Ungültiger oder abgelaufener Link.' } };

router.get('/auth/group-invite/info', async ({ req }) => {
  const invitation = await getEmailInvitation(new URL(req.url, 'http://localhost').searchParams.get('token') ?? '');
  if (!invitation) return INVALID;
  return { status: 200, body: { email: invitation.email, parentName: invitation.parentName } };
});

// The usual sign-up data; the account is created directly below the inviting manager.
router.post('/auth/group-invite/redeem', rateLimit(REDEEM_RATE_LIMIT)(async ({ req }) => {
  const body = await readJsonBody(req);
  if (body === null) return { status: 400, body: { error: 'invalid JSON' } };
  const { token, password, firstName, lastName, nickname } = body;
  if (!token || !password || !firstName || !lastName) {
    return { status: 400, body: { error: 'Vorname, Nachname und Passwort sind erforderlich.' } };
  }
  if (!isValidPassword(password)) {
    return { status: 400, body: { error: 'Passwort muss mindestens 8 Zeichen lang sein.' } };
  }
  const invitation = await getEmailInvitation(token);
  if (!invitation) return INVALID;

  const passwordHash = await hashPassword(password);
  const accessToken = generateAccessToken();
  let userId;
  try {
    userId = await withTransaction(async (client) => {
      // The mail reached this address, so it counts as verified.
      const { rows } = await client.query(
        `INSERT INTO users (email, password_hash, group_id, group_parent_id, first_name, last_name, nickname, email_verified, access_token, keep_data_consent, group_member_only)
         VALUES (lower($1), $2, (SELECT id FROM groups WHERE key = 'mitglied'), $3, $4, $5, $6, true, $7, $8, true) RETURNING id`,
        [invitation.email, passwordHash, invitation.parentId, firstName, lastName, nickname || null, accessToken, body.keepDataConsent === true]
      );
      await client.query('DELETE FROM group_invitations WHERE lower(email) = lower($1)', [invitation.email]);
      return rows[0].id;
    });
  } catch (err) {
    if (err.code === '23505') return { status: 409, body: { error: 'Diese E-Mail-Adresse wird bereits verwendet.' } };
    throw err;
  }

  const session = await createSession(userId);
  return { status: 200, body: { id: userId }, headers: { 'Set-Cookie': serializeSessionCookie(session.token, session.expiresAt) } };
}));

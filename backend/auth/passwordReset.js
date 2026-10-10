import { router } from '../routes.js';
import { query } from '../db.js';
import { hashPassword } from '../crypto/password.js';
import { sendPasswordResetEmail, sendInvitationEmail, sendGuestAccessEmail } from './mailer.js';
import { findOpenInvitationByEmail, regenerateToken } from '../invitations/repository.js';
import { getAppSettings } from '../appSettings/repository.js';
import { readJsonBody } from '../httpBody.js';
import { logger } from '../logger.js';
import { rateLimit } from '../middleware/rateLimit.js';
import { isValidPassword } from '../validation.js';
import { getUserByAccessToken, rotateAccessToken, ensureAccessToken } from './accessTokens.js';

const RESET_RATE_LIMIT = { keyPrefix: 'password-reset', maxAttempts: 10, windowMs: 15 * 60 * 1000 };

// Self-service "Passwort vergessen?": resends the user's existing permanent
// link rather than minting a one-off token -- it's the same link an admin
// can view/send from the members screen, and it only rotates once it's
// actually used (see /auth/password-reset/confirm below).
//
// Two kinds of people used to get nothing here although they believe they
// have an account: someone whose invitation was never redeemed (often
// because it expired) gets a renewed invitation, and someone with only a
// Direktanmeldung (is_guest) gets their ticket links. The response is the
// same 200 in every case, so it still doesn't reveal which addresses exist.
router.post('/auth/password-reset/request', rateLimit(RESET_RATE_LIMIT)(async ({ req, requestId }) => {
  const body = await readJsonBody(req);
  if (body === null) return { status: 400, body: { error: 'invalid JSON' } };
  const email = body.email?.trim().toLowerCase();
  if (!email) return { status: 400, body: { error: 'email is required' } };

  try {
    await sendAccessMail(email);
  } catch (err) {
    logger.error('failed to send password reset email', { requestId, email, error: err.message });
  }

  // Always 200 regardless of whether the email is registered — avoids leaking which emails exist.
  return { status: 200, body: { requested: true } };
}));

async function sendAccessMail(email) {
  const { rows } = await query(
    'SELECT id, is_guest FROM users WHERE lower(email) = $1 AND deactivated_at IS NULL ORDER BY is_guest LIMIT 1',
    [email]
  );
  const user = rows[0];
  if (user && !user.is_guest) {
    const token = await ensureAccessToken(user.id);
    await sendPasswordResetEmail(email, token, { userId: user.id });
    return;
  }

  // Covers a never-redeemed invitation and a pending guest-to-account conversion alike.
  const invitation = await findOpenInvitationByEmail(email);
  if (invitation) {
    const { invitationTtlDays } = await getAppSettings();
    const renewed = await regenerateToken(invitation.id, invitationTtlDays);
    if (renewed) {
      await sendInvitationEmail(renewed.email, renewed.token, { account: renewed });
      return;
    }
  }

  if (user) {
    const { rows: tickets } = await query(
      `SELECT e.name AS event_name, r.payment_token FROM registrations r JOIN events e ON e.id = r.event_id
       WHERE r.user_id = $1 AND r.payment_token IS NOT NULL AND r.payment_token_expires_at > now()
       ORDER BY e.event_date NULLS LAST`,
      [user.id]
    );
    await sendGuestAccessEmail(email, {
      userId: user.id,
      tickets: tickets.map((t) => ({ eventName: t.event_name, paymentToken: t.payment_token })),
    });
  }
}

router.post('/auth/password-reset/confirm', rateLimit(RESET_RATE_LIMIT)(async ({ req }) => {
  const body = await readJsonBody(req);
  if (body === null) return { status: 400, body: { error: 'invalid JSON' } };
  const { token, password } = body;
  if (!token || !password) {
    return { status: 400, body: { error: 'token and password are required' } };
  }
  if (!isValidPassword(password)) {
    return { status: 400, body: { error: 'Passwort muss mindestens 8 Zeichen lang sein.' } };
  }

  const user = await getUserByAccessToken(token);
  if (!user) {
    return { status: 400, body: { error: 'Ungültiger oder abgelaufener Link.' } };
  }

  const passwordHash = await hashPassword(password);
  await query('UPDATE users SET password_hash = $1, email_verified = true WHERE id = $2', [passwordHash, user.id]);
  await rotateAccessToken(user.id);
  await query('DELETE FROM sessions WHERE user_id = $1', [user.id]);
  return { status: 200, body: { reset: true } };
}));

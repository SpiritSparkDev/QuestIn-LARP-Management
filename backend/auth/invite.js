import { router } from '../routes.js';
import { withTransaction } from '../db.js';
import { hashPassword } from '../crypto/password.js';
import { createSession } from './sessions.js';
import { serializeSessionCookie } from './cookies.js';
import { readJsonBody } from '../httpBody.js';
import { getInvitationByToken, markRedeemed } from '../invitations/repository.js';

router.post('/auth/invite/redeem', async ({ req }) => {
  const body = await readJsonBody(req);
  if (body === null) return { status: 400, body: { error: 'invalid JSON' } };
  const { token, password } = body;
  if (!token || !password) {
    return { status: 400, body: { error: 'token and password are required' } };
  }
  if (password.length < 8) {
    return { status: 400, body: { error: 'password must be at least 8 characters' } };
  }

  const invitation = await getInvitationByToken(token);
  if (!invitation || invitation.redeemedAt || new Date(invitation.expiresAt) < new Date()) {
    return { status: 400, body: { error: 'invalid or expired invitation' } };
  }

  const passwordHash = await hashPassword(password);

  let userId;
  try {
    userId = await withTransaction(async (client) => {
      const { rows } = await client.query(
        `INSERT INTO users (email, password_hash, group_id, first_name, last_name, nickname, email_verified, address_enc, birthdate_enc, phone_enc, emergency_contact_enc, medical_notes_enc, pronomen_enc)
         VALUES ($1, $2, $3, $4, $5, $6, true,
           (SELECT address_enc FROM invitations WHERE id = $7),
           (SELECT birthdate_enc FROM invitations WHERE id = $7),
           (SELECT phone_enc FROM invitations WHERE id = $7),
           (SELECT emergency_contact_enc FROM invitations WHERE id = $7),
           (SELECT medical_notes_enc FROM invitations WHERE id = $7),
           (SELECT pronomen_enc FROM invitations WHERE id = $7))
         RETURNING id`,
        [invitation.email, passwordHash, invitation.groupId, invitation.firstName, invitation.lastName, invitation.nickname ?? null, invitation.id]
      );
      const redeemed = await markRedeemed(invitation.id, client);
      if (!redeemed) {
        const err = new Error('invitation already redeemed');
        err.code = 'ALREADY_REDEEMED';
        throw err;
      }
      return rows[0].id;
    });
  } catch (err) {
    if (err.code === 'ALREADY_REDEEMED') {
      return { status: 400, body: { error: 'invalid or expired invitation' } };
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

import { withTransaction } from '../db.js';
import { generateAccessToken } from '../auth/accessTokens.js';
import { markRedeemed } from './repository.js';

// Turns an open invitation into an active account, atomically with marking
// it redeemed. Used by the invitee setting their password (POST
// /auth/invite/redeem) and by an admin activating them directly (POST
// /members/invitations/:id/activate) -- then `passwordHash` is null and the
// person sets a password later via their access link / "Passwort vergessen".
// Throws err.code ALREADY_REDEEMED, or the pg unique violation 23505 if the
// address already belongs to another account.
export async function activateInvitation(invitation, { passwordHash = null, email = invitation.email } = {}) {
  const accessToken = generateAccessToken();
  return withTransaction(async (client) => {
    let userId;
    if (invitation.userId) {
      // Guest-conversion mode: update the existing guest row in place
      // instead of inserting a new one -- same record, now with login
      // access. The WHERE guard is defense-in-depth alongside
      // markRedeemed's own race guard: it also refuses to touch a row
      // that was somehow already converted or is no longer a guest.
      const { rowCount } = await client.query(
        `UPDATE users SET password_hash = $2, is_guest = false, email_verified = true, access_token = $3, managed_by_user_id = NULL,
           email = COALESCE(email, $4)
         WHERE id = $1 AND is_guest = true AND password_hash IS NULL`,
        [invitation.userId, passwordHash, accessToken, email]
      );
      if (rowCount === 0) throw alreadyRedeemed();
      userId = invitation.userId;
    } else {
      const { rows } = await client.query(
        `INSERT INTO users (email, password_hash, group_id, first_name, last_name, nickname, email_verified, account_data_enc, access_token)
         VALUES ($1, $2, $3, $4, $5, $6, true, (SELECT account_data_enc FROM invitations WHERE id = $7), $8)
         RETURNING id`,
        [email, passwordHash, invitation.groupId, invitation.firstName, invitation.lastName, invitation.nickname ?? null, invitation.id, accessToken]
      );
      userId = rows[0].id;
    }
    if (!(await markRedeemed(invitation.id, client))) throw alreadyRedeemed();
    return { userId, accessToken };
  });
}

function alreadyRedeemed() {
  const err = new Error('invitation already redeemed');
  err.code = 'ALREADY_REDEEMED';
  return err;
}

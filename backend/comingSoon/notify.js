// Fires once an admin disables coming_soon_enabled (see
// backend/appSettings/routes.js), fire-and-forget same as
// notifyRegistrationOtFieldsChanged in backend/registrations/repository.js:
// a delivery failure must never affect the admin's PUT /app-settings
// response, and one bad recipient must not stop the rest of the batch.
import { query } from '../db.js';
import { createInvitation } from '../invitations/repository.js';
import { sendInvitationEmail } from '../auth/mailer.js';
import { getAppSettings } from '../appSettings/repository.js';
import { logger } from '../logger.js';

export async function sendComingSoonReminders(invitedBy) {
  const { rows } = await query(
    `SELECT id, email, first_name, last_name, nickname, group_id
     FROM users WHERE coming_soon_reminder_requested_at IS NOT NULL AND password_hash IS NULL`
  );
  if (rows.length === 0) return;

  const { invitationTtlDays } = await getAppSettings();
  for (const row of rows) {
    let invitation;
    try {
      invitation = await createInvitation({
        userId: row.id,
        email: row.email,
        firstName: row.first_name,
        lastName: row.last_name,
        nickname: row.nickname,
        groupId: row.group_id,
        invitedBy,
        ttlDays: invitationTtlDays,
      });
      await query('UPDATE users SET coming_soon_reminder_requested_at = NULL WHERE id = $1', [row.id]);
    } catch (err) {
      logger.error('failed to create coming-soon reminder invitation', { error: err.message, userId: row.id });
      continue;
    }

    try {
      await sendInvitationEmail(invitation.email, invitation.token, { account: invitation });
    } catch (err) {
      logger.error('failed to send coming-soon reminder email', { error: err.message, userId: row.id });
    }
  }
}

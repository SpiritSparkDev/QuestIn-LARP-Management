import { router } from '../routes.js';
import { requireAuth, requireGroupManager } from '../middleware/authenticate.js';
import { query } from '../db.js';
import { getManagedPerson } from './repository.js';
import { createInvitation } from '../invitations/repository.js';
import { sendInvitationEmail, baseUrl } from '../auth/mailer.js';
import { getAppSettings } from '../appSettings/repository.js';
import { logger } from '../logger.js';

router.post('/managed-persons/:id/convert', requireGroupManager(async ({ params, user, requestId }) => {
  const person = await getManagedPerson(params.id, user.id);
  if (!person) return { status: 404, body: { error: 'managed person not found' } };
  const { rows: groupRows } = await query('SELECT group_id FROM users WHERE id = $1', [person.id]);

  const { invitationTtlDays } = await getAppSettings();
  const invitation = await createInvitation({
    userId: person.id,
    email: person.email || null,
    firstName: person.firstName ?? '',
    lastName: person.lastName ?? '',
    nickname: person.nickname,
    groupId: groupRows[0].group_id,
    invitedBy: user.id,
    ttlDays: invitationTtlDays,
  });

  // Without an e-mail address there is nobody to mail: the link is handed to the manager instead.
  if (invitation.email) {
    try {
      await sendInvitationEmail(invitation.email, invitation.token, { account: invitation });
    } catch (err) {
      logger.error('failed to send managed-person conversion email', { requestId, error: err.message, managedPersonId: person.id });
    }
  }

  const link = `${await baseUrl()}/set-password.html?token=${invitation.token}`;
  return { status: 201, body: { id: invitation.id, link } };
}));

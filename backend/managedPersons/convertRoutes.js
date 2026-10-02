import { router } from '../routes.js';
import { requireAuth } from '../middleware/authenticate.js';
import { query } from '../db.js';
import { getManagedPerson } from './repository.js';
import { createInvitation } from '../invitations/repository.js';
import { sendInvitationEmail, baseUrl } from '../auth/mailer.js';
import { getAppSettings } from '../appSettings/repository.js';
import { logger } from '../logger.js';

router.post('/managed-persons/:id/convert', requireAuth(async ({ params, user, requestId }) => {
  const person = await getManagedPerson(params.id, user.id);
  if (!person) return { status: 404, body: { error: 'managed person not found' } };
  if (!person.email) {
    return { status: 400, body: { error: 'E-Mail-Adresse erforderlich, um einen Account zu erstellen.' } };
  }

  const { rows: groupRows } = await query('SELECT group_id FROM users WHERE id = $1', [person.id]);

  const { invitationTtlDays } = await getAppSettings();
  const invitation = await createInvitation({
    userId: person.id,
    email: person.email,
    firstName: person.firstName,
    lastName: person.lastName,
    nickname: person.nickname,
    groupId: groupRows[0].group_id,
    invitedBy: user.id,
    ttlDays: invitationTtlDays,
  });

  try {
    await sendInvitationEmail(invitation.email, invitation.token, { account: invitation });
  } catch (err) {
    logger.error('failed to send managed-person conversion email', { requestId, error: err.message, managedPersonId: person.id });
  }

  const link = `${await baseUrl()}/set-password.html?token=${invitation.token}`;
  return { status: 201, body: { id: invitation.id, link } };
}));

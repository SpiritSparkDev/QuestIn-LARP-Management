import { router } from '../routes.js';
import { requireAuth } from '../middleware/authenticate.js';
import { requireMenu } from '../middleware/authorize.js';
import { getEvent } from '../events/repository.js';
import { PRIVACY_CATEGORIES, listPrivacyFields, privacyStatus, runPrivacyDeletion } from './repository.js';

router.get('/privacy-fields', requireAuth(requireMenu('events')(async () => ({
  status: 200,
  body: { fields: await listPrivacyFields(), categories: Object.entries(PRIVACY_CATEGORIES).map(([key, c]) => ({ key, ...c })) },
}))));

router.get('/events/:id/privacy', requireAuth(requireMenu('events')(async ({ params }) => {
  const event = await getEvent(params.id);
  if (!event) return { status: 404, body: { error: 'event not found' } };
  return { status: 200, body: privacyStatus(event) };
})));

router.post('/events/:id/privacy/:category/run', requireAuth(requireMenu('events')(async ({ params, user }) => {
  const ran = await runPrivacyDeletion(params.id, params.category, user.id);
  if (!ran) return { status: 409, body: { error: 'Löschung ist nicht fällig.' } };
  return { status: 200, body: { deleted: true } };
})));

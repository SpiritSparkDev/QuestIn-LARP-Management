import { router } from '../routes.js';
import { requireAuth } from '../middleware/authenticate.js';
import { listPendingReviews, resolveReview } from './repository.js';

router.get('/character-changes', requireAuth(async ({ user }) => (
  { status: 200, body: await listPendingReviews(user.id) }
)));

for (const decision of ['accept', 'reject']) {
  router.post(`/character-changes/:id/${decision}`, requireAuth(async ({ params, user }) => {
    if (!/^[0-9a-f-]{36}$/i.test(params.id)) return { status: 404, body: { error: 'change not found' } };
    const result = await resolveReview(params.id, user.id, decision);
    return result ? { status: 200, body: result } : { status: 404, body: { error: 'change not found' } };
  }));
}

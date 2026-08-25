import { router } from '../routes.js';
import { requireAuth } from '../middleware/authenticate.js';
import { registerForEvent, unregisterFromEvent } from './repository.js';

router.post('/events/:id/register', requireAuth(async ({ params, user }) => {
  try {
    const registration = await registerForEvent(user.id, params.id);
    return { status: 201, body: registration };
  } catch (err) {
    if (err.code === 'EVENT_NOT_FOUND') return { status: 404, body: { error: 'event not found' } };
    if (err.code === 'ALREADY_REGISTERED') return { status: 409, body: { error: err.message } };
    throw err;
  }
}));

router.delete('/events/:id/register', requireAuth(async ({ params, user }) => {
  try {
    await unregisterFromEvent(user.id, params.id);
    return { status: 200, body: { unregistered: true } };
  } catch (err) {
    if (err.code === 'REGISTRATION_NOT_FOUND') return { status: 404, body: { error: 'registration not found' } };
    if (err.code === 'CANNOT_UNREGISTER') return { status: 409, body: { error: err.message } };
    throw err;
  }
}));

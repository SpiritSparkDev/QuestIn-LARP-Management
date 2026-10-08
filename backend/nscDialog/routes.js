import { router } from '../routes.js';
import { requireAuth } from '../middleware/authenticate.js';
import { requireMenu } from '../middleware/authorize.js';
import { isRateLimited } from '../middleware/rateLimit.js';
import { readJsonBody } from '../httpBody.js';
import { hasNscRegistration, readThread, addMessage, respondToProposal, listOverview, notifyOtherSide } from './repository.js';

const ERRORS = { INVALID_MESSAGE: 400, NOT_NSC: 404, PROPOSAL_NOT_OPEN: 409 };
const handle = (fn) => async (ctx) => {
  try {
    return await fn(ctx);
  } catch (e) {
    if (ERRORS[e.code]) return { status: ERRORS[e.code], body: { error: e.message } };
    throw e;
  }
};

// Player: own thread only.
router.get('/events/:id/nsc-dialog', requireAuth(handle(async ({ params, user }) => {
  if (!(await hasNscRegistration(params.id, user.id))) return { status: 404, body: { error: 'Kein NSC-Dialog.' } };
  return { status: 200, body: await readThread(params.id, user.id, 'player') };
})));

router.post('/events/:id/nsc-dialog', requireAuth(handle(async ({ req, params, user }) => {
  const body = await readJsonBody(req);
  if (body === null) return { status: 400, body: { error: 'invalid JSON' } };
  if (isRateLimited(`nsc-dialog:${user.id}`, 10, 10 * 60_000)) return { status: 429, body: { error: 'Zu viele Nachrichten. Bitte später erneut versuchen.' } };
  await addMessage(params.id, user.id, user.id, 'player', { body: body.body });
  notifyOtherSide(params.id, user.id, 'player');
  return { status: 201, body: await readThread(params.id, user.id, 'player') };
})));

router.patch('/events/:id/nsc-dialog/:messageId', requireAuth(handle(async ({ req, params, user }) => {
  const body = await readJsonBody(req);
  if (body === null || typeof body.accept !== 'boolean') return { status: 400, body: { error: 'accept (boolean) required' } };
  if (!(await hasNscRegistration(params.id, user.id))) return { status: 404, body: { error: 'Kein NSC-Dialog.' } };
  await respondToProposal(params.id, user.id, params.messageId, body.accept);
  return { status: 200, body: await readThread(params.id, user.id, 'player') };
})));

// Staff (events menu): overview and any thread.
router.get('/events/:id/nsc-dialogs', requireAuth(requireMenu('events')(async ({ params }) => (
  { status: 200, body: await listOverview(params.id) }
))));

router.get('/events/:id/nsc-dialogs/:userId', requireAuth(requireMenu('events')(handle(async ({ params }) => (
  { status: 200, body: await readThread(params.id, params.userId, 'staff') }
)))));

router.post('/events/:id/nsc-dialogs/:userId', requireAuth(requireMenu('events')(handle(async ({ req, params, user }) => {
  const body = await readJsonBody(req);
  if (body === null) return { status: 400, body: { error: 'invalid JSON' } };
  await addMessage(params.id, params.userId, user.id, 'staff', { body: body.body, proposal: body.proposal });
  notifyOtherSide(params.id, params.userId, 'staff');
  return { status: 201, body: await readThread(params.id, params.userId, 'staff') };
}))));

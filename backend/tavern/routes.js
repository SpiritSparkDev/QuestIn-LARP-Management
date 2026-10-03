import { router } from '../routes.js';
import { requireAuth } from '../middleware/authenticate.js';
import { readJsonBody } from '../httpBody.js';
import { getAppSettings } from '../appSettings/repository.js';
import { getEvent } from '../events/repository.js';
import {
  TOPUP_METHODS, listItems, createItem, updateItem, deleteItem,
  listAccounts, getAccount, createAccount, setLocked, listParticipantsWithoutAccount,
  listTransactions, topUp, charge, voidTransaction, listBalancesForUser,
} from './repository.js';

const MAX_AMOUNT_CENTS = 1_000_000;
const MAX_QUANTITY = 99;

// Staff endpoints: the add-on must be on, and the caller needs the "taverne"
// menu (admins always have it).
function requireTavern(handler) {
  return requireAuth(async (ctx) => {
    const settings = await getAppSettings();
    if (!settings.tavernEnabled) return { status: 404, body: { error: 'Das Tavernenkonto ist nicht aktiviert.' } };
    const { group } = ctx.user;
    if (group.key !== 'admin' && !group.visibleMenus.includes('taverne')) {
      return { status: 403, body: { error: 'Kein Zugriff.' } };
    }
    return handler(ctx);
  });
}

const isCents = (value) => Number.isInteger(value) && value > 0 && value <= MAX_AMOUNT_CENTS;

const ERROR_STATUS = {
  INSUFFICIENT_FUNDS: 409, ACCOUNT_LOCKED: 409, ACCOUNT_EXISTS: 409, ALREADY_VOIDED: 409, NUMBER_UNAVAILABLE: 503,
  ITEM_NOT_FOUND: 400, NOTHING_TO_CHARGE: 400, ACCOUNT_NOT_FOUND: 404, TRANSACTION_NOT_FOUND: 404,
};

// Maps the repository's coded errors to HTTP responses; anything else is a bug.
async function handleErrors(fn) {
  try {
    return await fn();
  } catch (err) {
    if (ERROR_STATUS[err.code]) return { status: ERROR_STATUS[err.code], body: { error: err.message, code: err.code } };
    throw err;
  }
}

// ---- menu ----

router.get('/tavern/items', requireTavern(async () => ({ status: 200, body: await listItems() })));

function validateItemBody(body, { partial }) {
  if (!partial || body.name !== undefined) {
    if (typeof body.name !== 'string' || !body.name.trim()) return 'name is required';
  }
  if (!partial || body.priceCents !== undefined) {
    if (!Number.isInteger(body.priceCents) || body.priceCents < 0 || body.priceCents > MAX_AMOUNT_CENTS) return 'priceCents must be a non-negative integer';
  }
  if (body.category !== undefined && body.category !== null && typeof body.category !== 'string') return 'category must be a string';
  if (body.sortOrder !== undefined && !Number.isInteger(body.sortOrder)) return 'sortOrder must be an integer';
  if (body.active !== undefined && typeof body.active !== 'boolean') return 'active must be a boolean';
  return null;
}

router.post('/tavern/items', requireTavern(async ({ req }) => {
  const body = await readJsonBody(req);
  if (body === null) return { status: 400, body: { error: 'invalid JSON' } };
  const error = validateItemBody(body, { partial: false });
  if (error) return { status: 400, body: { error } };
  return { status: 201, body: await createItem({ ...body, name: body.name.trim() }) };
}));

router.put('/tavern/items/:id', requireTavern(async ({ req, params }) => {
  const body = await readJsonBody(req);
  if (body === null) return { status: 400, body: { error: 'invalid JSON' } };
  const error = validateItemBody(body, { partial: true });
  if (error) return { status: 400, body: { error } };
  const item = await updateItem(params.id, { ...body, name: body.name?.trim() });
  return item ? { status: 200, body: item } : { status: 404, body: { error: 'item not found' } };
}));

router.delete('/tavern/items/:id', requireTavern(async ({ params }) => {
  return (await deleteItem(params.id))
    ? { status: 200, body: { deleted: true } }
    : { status: 404, body: { error: 'item not found' } };
}));

// ---- accounts ----

function searchParams(req) {
  return new URL(req.url, 'http://localhost').searchParams;
}

router.get('/tavern/accounts', requireTavern(async ({ req }) => {
  const query = searchParams(req);
  const eventId = query.get('eventId');
  if (!eventId) return { status: 400, body: { error: 'eventId is required' } };
  return { status: 200, body: await listAccounts(eventId, query.get('q')) };
}));

router.get('/tavern/participants', requireTavern(async ({ req }) => {
  const query = searchParams(req);
  const eventId = query.get('eventId');
  if (!eventId) return { status: 400, body: { error: 'eventId is required' } };
  return { status: 200, body: await listParticipantsWithoutAccount(eventId, query.get('q')) };
}));

router.post('/tavern/accounts', requireTavern(async ({ req }) => {
  const body = await readJsonBody(req);
  if (body === null) return { status: 400, body: { error: 'invalid JSON' } };
  const { eventId, userId, label } = body;
  if (typeof eventId !== 'string' || !(await getEvent(eventId))) return { status: 404, body: { error: 'event not found' } };
  if (!userId && !(typeof label === 'string' && label.trim())) {
    return { status: 400, body: { error: 'Entweder eine Person oder eine Bezeichnung ist nötig.' } };
  }
  return handleErrors(async () => ({ status: 201, body: await createAccount({ eventId, userId, label: label?.trim() }) }));
}));

router.get('/tavern/accounts/:id', requireTavern(async ({ params }) => {
  const account = await getAccount(params.id);
  if (!account) return { status: 404, body: { error: 'account not found' } };
  return { status: 200, body: { account, transactions: await listTransactions(params.id) } };
}));

router.put('/tavern/accounts/:id/lock', requireTavern(async ({ req, params }) => {
  const body = await readJsonBody(req);
  if (body === null || typeof body.locked !== 'boolean') return { status: 400, body: { error: 'locked must be a boolean' } };
  const account = await setLocked(params.id, body.locked);
  return account ? { status: 200, body: account } : { status: 404, body: { error: 'account not found' } };
}));

router.post('/tavern/accounts/:id/topup', requireTavern(async ({ req, params, user }) => {
  const body = await readJsonBody(req);
  if (body === null) return { status: 400, body: { error: 'invalid JSON' } };
  if (!isCents(body.amountCents)) return { status: 400, body: { error: 'amountCents must be a positive integer' } };
  if (!TOPUP_METHODS.includes(body.method)) return { status: 400, body: { error: `method must be one of: ${TOPUP_METHODS.join(', ')}` } };
  return handleErrors(async () => {
    await topUp(params.id, { amountCents: body.amountCents, method: body.method, note: body.note, createdBy: user.id });
    return { status: 201, body: { account: await getAccount(params.id), transactions: await listTransactions(params.id) } };
  });
}));

router.post('/tavern/accounts/:id/charge', requireTavern(async ({ req, params, user }) => {
  const body = await readJsonBody(req);
  if (body === null) return { status: 400, body: { error: 'invalid JSON' } };
  const items = Array.isArray(body.items) ? body.items : [];
  for (const item of items) {
    if (typeof item?.itemId !== 'string' || !Number.isInteger(item.quantity) || item.quantity < 1 || item.quantity > MAX_QUANTITY) {
      return { status: 400, body: { error: 'items must be [{ itemId, quantity }] with quantity 1-99' } };
    }
  }
  if (body.customAmountCents !== undefined && !isCents(body.customAmountCents)) {
    return { status: 400, body: { error: 'customAmountCents must be a positive integer' } };
  }
  return handleErrors(async () => {
    await charge(params.id, { items, customAmountCents: body.customAmountCents ?? 0, note: body.note, createdBy: user.id });
    return { status: 201, body: { account: await getAccount(params.id), transactions: await listTransactions(params.id) } };
  });
}));

router.post('/tavern/transactions/:id/void', requireTavern(async ({ params, user }) => {
  return handleErrors(async () => {
    const entry = await voidTransaction(params.id, { createdBy: user.id });
    return { status: 200, body: { transaction: entry } };
  });
}));

// ---- self-service balance ----

router.get('/tavern/my-balance', requireAuth(async ({ user }) => {
  const settings = await getAppSettings();
  if (!settings.tavernEnabled) return { status: 200, body: [] };
  return { status: 200, body: await listBalancesForUser(user.id) };
}));

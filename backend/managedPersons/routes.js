import { router } from '../routes.js';
import { requireAuth } from '../middleware/authenticate.js';
import { readJsonBody } from '../httpBody.js';
import { isValidEmail } from '../validation.js';
import { filterToAllowedFields } from '../members/routes.js';
import {
  listManagedPersons, getManagedPerson, createManagedPerson, updateManagedPerson, deleteManagedPerson,
} from './repository.js';

router.get('/managed-persons', requireAuth(async ({ user }) => {
  const persons = await listManagedPersons(user.id);
  return { status: 200, body: persons };
}));

router.get('/managed-persons/:id', requireAuth(async ({ params, user }) => {
  const person = await getManagedPerson(params.id, user.id);
  if (!person) return { status: 404, body: { error: 'managed person not found' } };
  return { status: 200, body: person };
}));

router.post('/managed-persons', requireAuth(async ({ req, user }) => {
  const body = await readJsonBody(req);
  if (body === null) return { status: 400, body: { error: 'invalid JSON' } };
  const { email, firstName, lastName, nickname, ...otFields } = body;
  if (!firstName || !lastName) {
    return { status: 400, body: { error: 'firstName and lastName are required' } };
  }
  if (email && !isValidEmail(email)) {
    return { status: 400, body: { error: 'invalid email format' } };
  }

  const disallowed = await filterToAllowedFields(otFields, user.group.accountFields);
  if (disallowed.length > 0) {
    return { status: 400, body: { error: `not permitted to set: ${disallowed.join(', ')}` } };
  }

  try {
    const person = await createManagedPerson({
      ownerId: user.id, groupId: user.group.id, email: email?.toLowerCase(), firstName, lastName, nickname, ...otFields,
    });
    return { status: 201, body: person };
  } catch (err) {
    if (err.code === 'EMAIL_TAKEN') return { status: 409, body: { error: err.message } };
    throw err;
  }
}));

router.patch('/managed-persons/:id', requireAuth(async ({ req, params, user }) => {
  const body = await readJsonBody(req);
  if (body === null) return { status: 400, body: { error: 'invalid JSON' } };
  if (body.email && !isValidEmail(body.email)) {
    return { status: 400, body: { error: 'invalid email format' } };
  }

  const disallowed = await filterToAllowedFields(body, user.group.accountFields);
  if (disallowed.length > 0) {
    return { status: 400, body: { error: `not permitted to set: ${disallowed.join(', ')}` } };
  }

  try {
    const fields = body.email !== undefined ? { ...body, email: body.email?.toLowerCase() } : body;
    const person = await updateManagedPerson(params.id, user.id, fields);
    if (!person) return { status: 404, body: { error: 'managed person not found' } };
    return { status: 200, body: person };
  } catch (err) {
    if (err.code === 'EMAIL_TAKEN') return { status: 409, body: { error: err.message } };
    throw err;
  }
}));

router.delete('/managed-persons/:id', requireAuth(async ({ req, params, user }) => {
  try {
    const force = new URL(req.url, 'http://localhost').searchParams.get('force') === 'true';
    const deleted = await deleteManagedPerson(params.id, user.id, { force });
    if (!deleted) return { status: 404, body: { error: 'managed person not found' } };
    return { status: 200, body: { deleted: true } };
  } catch (err) {
    if (err.code === 'HAS_REGISTRATIONS') return { status: 409, body: { error: err.message } };
    throw err;
  }
}));

import { router } from '../routes.js';
import { requireAuth } from '../middleware/authenticate.js';
import { readJsonBody } from '../httpBody.js';
import { getAccount, updateAccount } from './repository.js';
import { validateCharacterData } from '../events/schemaValidation.js';
import { query } from '../db.js';

router.get('/account', requireAuth(async ({ user }) => {
  const account = await getAccount(user.id);
  return { status: 200, body: account };
}));

router.patch('/account', requireAuth(async ({ req, user }) => {
  const body = await readJsonBody(req);
  if (body === null) return { status: 400, body: { error: 'invalid JSON' } };

  if (body.nscData !== undefined) {
    const { rows } = await query('SELECT schema FROM nsc_profile_schema LIMIT 1');
    const schema = rows[0]?.schema ?? [];
    const errors = validateCharacterData(schema, body.nscData);
    if (errors.length > 0) {
      return { status: 400, body: { error: 'invalid nscData', details: errors } };
    }
  }

  const account = await updateAccount(user.id, body);
  if (!account) return { status: 404, body: { error: 'account not found' } };
  return { status: 200, body: account };
}));

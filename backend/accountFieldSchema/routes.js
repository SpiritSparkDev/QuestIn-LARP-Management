import { router } from '../routes.js';
import { requireAuth } from '../middleware/authenticate.js';
import { requireAdminGroup } from '../middleware/authorize.js';
import { readJsonBody } from '../httpBody.js';
import { validateSchemaShape } from '../events/schemaValidation.js';
import { getAccountFieldSchema, setAccountFieldSchema } from './repository.js';

const RESERVED_ACCOUNT_FIELD_KEYS = ['id', 'group', 'name', 'email', 'firstName', 'lastName', 'nickname', 'menus', 'accountFields'];

router.get('/account-schema', requireAuth(async () => {
  const schema = await getAccountFieldSchema();
  return { status: 200, body: schema };
}));

router.put('/account-schema', requireAuth(requireAdminGroup(async ({ req }) => {
  const body = await readJsonBody(req);
  if (body === null) return { status: 400, body: { error: 'invalid JSON' } };
  const { schema } = body;
  if (!validateSchemaShape(schema, RESERVED_ACCOUNT_FIELD_KEYS)) {
    return { status: 400, body: { error: 'schema must be an array of objects, each with a unique, non-reserved string "key" (not "id" or "group")' } };
  }
  const saved = await setAccountFieldSchema(schema);
  return { status: 200, body: saved };
})));

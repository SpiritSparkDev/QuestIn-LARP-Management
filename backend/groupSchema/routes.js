import { router } from '../routes.js';
import { requireAuth } from '../middleware/authenticate.js';
import { requireAdminGroup } from '../middleware/authorize.js';
import { readJsonBody } from '../httpBody.js';
import { validateSchemaShape } from '../events/schemaValidation.js';
import { getGroupFieldSchema, setGroupFieldSchema } from './repository.js';

router.get('/group-schema', requireAuth(async () => ({ status: 200, body: await getGroupFieldSchema() })));

router.put('/group-schema', requireAuth(requireAdminGroup(async ({ req }) => {
  const body = await readJsonBody(req);
  if (body === null) return { status: 400, body: { error: 'invalid JSON' } };
  if (!validateSchemaShape(body.schema)) {
    return { status: 400, body: { error: 'schema must be an array of objects, each with a unique, non-reserved string "key" (not "id" or "name")' } };
  }
  return { status: 200, body: await setGroupFieldSchema(body.schema) };
})));

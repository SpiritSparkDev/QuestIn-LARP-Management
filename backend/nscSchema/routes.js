import { router } from '../routes.js';
import { requireAuth } from '../middleware/authenticate.js';
import { requireAdminGroup } from '../middleware/authorize.js';
import { readJsonBody } from '../httpBody.js';
import { validateSchemaShape } from '../events/schemaValidation.js';
import { getNscProfileSchema, setNscProfileSchema } from './repository.js';

router.get('/nsc-schema', requireAuth(async () => {
  const schema = await getNscProfileSchema();
  return { status: 200, body: schema };
}));

router.put('/nsc-schema', requireAuth(requireAdminGroup(async ({ req }) => {
  const body = await readJsonBody(req);
  if (body === null) return { status: 400, body: { error: 'invalid JSON' } };
  const { schema } = body;
  if (!validateSchemaShape(schema)) {
    return { status: 400, body: { error: 'schema must be an array of objects, each with a unique, non-reserved string "key" (not "id" or "name")' } };
  }
  const saved = await setNscProfileSchema(schema);
  return { status: 200, body: saved };
})));

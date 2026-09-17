import { router } from '../routes.js';
import { requireAuth } from '../middleware/authenticate.js';
import { requireAdminGroup } from '../middleware/authorize.js';
import { readJsonBody } from '../httpBody.js';
import { validateSchemaShape } from '../events/schemaValidation.js';
import { getRegistrationFieldSchema, setRegistrationFieldSchema } from './repository.js';

const RESERVED_REGISTRATION_FIELD_KEYS = ['id', 'userId', 'eventId', 'status', 'conRole', 'characterId'];

router.get('/registration-schema', requireAuth(async () => {
  const schema = await getRegistrationFieldSchema();
  return { status: 200, body: schema };
}));

router.put('/registration-schema', requireAuth(requireAdminGroup(async ({ req }) => {
  const body = await readJsonBody(req);
  if (body === null) return { status: 400, body: { error: 'invalid JSON' } };
  const { schema } = body;
  if (!validateSchemaShape(schema, RESERVED_REGISTRATION_FIELD_KEYS)) {
    return { status: 400, body: { error: 'schema must be an array of objects, each with a unique, non-reserved string "key" (not "id")' } };
  }
  const saved = await setRegistrationFieldSchema(schema);
  return { status: 200, body: saved };
})));

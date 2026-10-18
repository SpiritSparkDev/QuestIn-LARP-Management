import { router } from '../routes.js';
import { requireAuth } from '../middleware/authenticate.js';
import { requireAdminGroup } from '../middleware/authorize.js';
import { readJsonBody } from '../httpBody.js';
import { validateSchemaShape } from '../events/schemaValidation.js';
import { getChildFieldSchema, setChildFieldSchema } from './repository.js';
import { getRegistrationFieldSchema } from '../registrationFieldSchema/repository.js';

const RESERVED_KEYS = ['id', 'userId', 'eventId', 'status', 'conRole', 'characterId'];

router.get('/child-schema', requireAuth(async () => ({ status: 200, body: await getChildFieldSchema() })));

router.put('/child-schema', requireAuth(requireAdminGroup(async ({ req }) => {
  const body = await readJsonBody(req);
  if (body === null) return { status: 400, body: { error: 'invalid JSON' } };
  const { schema } = body;
  if (!validateSchemaShape(schema, RESERVED_KEYS)) {
    return { status: 400, body: { error: 'schema must be an array of objects, each with a unique, non-reserved string "key" (not "id")' } };
  }
  // The values share the registration blob with the common registration fields: keys must not collide.
  const taken = new Set((await getRegistrationFieldSchema()).map((f) => f.key));
  const clash = schema.find((f) => taken.has(f.key));
  if (clash) return { status: 400, body: { error: `Das Feld „${clash.key}“ gibt es schon im Anmelde-Schema.` } };
  return { status: 200, body: await setChildFieldSchema(schema) };
})));

import { router } from '../routes.js';
import { requireAuth } from '../middleware/authenticate.js';
import { readJsonBody } from '../httpBody.js';
import { query } from '../db.js';

function isValidSchemaShape(schema) {
  return Array.isArray(schema) && schema.every(
    (field) => field && typeof field === 'object' && typeof field.key === 'string' && field.key.length > 0
  );
}

router.get('/nsc-schema', requireAuth(async ({ user }) => {
  if (user.group.key !== 'admin' && user.group.key !== 'nsc') {
    return { status: 403, body: { error: 'forbidden' } };
  }
  const { rows } = await query('SELECT schema FROM nsc_profile_schema LIMIT 1');
  return { status: 200, body: rows[0]?.schema ?? [] };
}));

router.put('/nsc-schema', requireAuth(async ({ req, user }) => {
  if (user.group.key !== 'admin') {
    return { status: 403, body: { error: 'forbidden' } };
  }
  const body = await readJsonBody(req);
  if (body === null) return { status: 400, body: { error: 'invalid JSON' } };
  const { schema } = body;
  if (!isValidSchemaShape(schema)) {
    return { status: 400, body: { error: 'schema must be an array of objects each with a string "key"' } };
  }
  const { rows } = await query('SELECT id FROM nsc_profile_schema LIMIT 1');
  if (rows.length === 0) {
    await query('INSERT INTO nsc_profile_schema (schema) VALUES ($1)', [JSON.stringify(schema)]);
  } else {
    await query('UPDATE nsc_profile_schema SET schema = $1 WHERE id = $2', [JSON.stringify(schema), rows[0].id]);
  }
  return { status: 200, body: schema };
}));

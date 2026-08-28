import { query } from '../db.js';

export async function getNscProfileSchema() {
  const { rows } = await query('SELECT schema FROM nsc_profile_schema LIMIT 1');
  return rows[0]?.schema ?? [];
}

export async function setNscProfileSchema(schema) {
  const { rows } = await query('SELECT id FROM nsc_profile_schema LIMIT 1');
  if (rows.length === 0) {
    await query('INSERT INTO nsc_profile_schema (schema) VALUES ($1)', [JSON.stringify(schema)]);
  } else {
    await query('UPDATE nsc_profile_schema SET schema = $1 WHERE id = $2', [JSON.stringify(schema), rows[0].id]);
  }
  return schema;
}

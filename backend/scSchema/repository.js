import { query } from '../db.js';

export async function getScCharacterSchema() {
  const { rows } = await query('SELECT schema FROM sc_character_schema LIMIT 1');
  return rows[0]?.schema ?? [];
}

export async function setScCharacterSchema(schema) {
  const { rows } = await query('SELECT id FROM sc_character_schema LIMIT 1');
  if (rows.length === 0) {
    await query('INSERT INTO sc_character_schema (schema) VALUES ($1)', [JSON.stringify(schema)]);
  } else {
    await query('UPDATE sc_character_schema SET schema = $1 WHERE id = $2', [JSON.stringify(schema), rows[0].id]);
  }
  return schema;
}

import pg from 'pg';
import { logger } from './logger.js';

// Keep DATE columns as plain 'YYYY-MM-DD' strings — pg's default Date-object
// parsing shifts the value by a day depending on the server's local timezone.
pg.types.setTypeParser(1082, (value) => value);

const { Pool } = pg;

let pool;

function getPool() {
  if (!pool) {
    pool = new Pool({ connectionString: process.env.DATABASE_URL, connectionTimeoutMillis: 5000 });
    pool.on('error', (err) => {
      logger.error('idle client error', { error: err.message });
    });
  }
  return pool;
}

export async function query(text, params) {
  return getPool().query(text, params);
}

export async function withTransaction(fn) {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch {
      // connection is already gone; nothing more we can do, surface the original error
    }
    throw err;
  } finally {
    client.release();
  }
}

export async function closePool() {
  if (pool) {
    await pool.end();
    pool = undefined;
  }
}

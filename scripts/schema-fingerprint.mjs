// Prints a normalized, sorted description of the database schema (columns,
// constraints, indexes). Column *order* is ignored on purpose: it depends on
// the order ALTER TABLE ... ADD COLUMN migrations ran, which is exactly the
// harmless difference between servers that applied migrations in another order.
//
//   DATABASE_URL=postgres://… node scripts/schema-fingerprint.mjs > server.txt
//   diff fresh.txt server.txt          # empty output = identical schema
import pg from 'pg';

const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
await client.connect();

const lines = [];
const add = async (kind, sql) => {
  const { rows } = await client.query(sql);
  for (const r of rows) lines.push(`${kind} ${r.line}`);
};

await add('column', `
  SELECT format('%I.%I %s%s%s', table_name, column_name, data_type,
                CASE WHEN is_nullable = 'NO' THEN ' NOT NULL' ELSE '' END,
                COALESCE(' DEFAULT ' || column_default, '')) AS line
  FROM information_schema.columns WHERE table_schema = 'public'`);
await add('constraint', `
  SELECT format('%I %I %s', c.conrelid::regclass, c.conname, pg_get_constraintdef(c.oid)) AS line
  FROM pg_constraint c JOIN pg_namespace n ON n.oid = c.connamespace WHERE n.nspname = 'public'`);
await add('index', `SELECT indexdef AS line FROM pg_indexes WHERE schemaname = 'public'`);
await add('migration', `SELECT filename AS line FROM schema_migrations`);

await client.end();
console.log(lines.sort().join('\n'));

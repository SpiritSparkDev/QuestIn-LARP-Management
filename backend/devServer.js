// Dev entry point (docker-compose.dev.yml, `npm run dev`): applies pending
// migrations, then starts the server. Run under
// `node --watch-path=backend --watch-path=db/migrations`, so a new migration
// file is applied on the next automatic restart instead of only when the
// container starts. Production keeps `npm start` with its own migrate step.
import { runMigrations } from '../db/migrate.js';
import { startServer } from './server.js';
import { logger } from './logger.js';

try {
  const applied = await runMigrations();
  if (applied.length > 0) logger.info('migrations complete', { count: applied.length });
} catch (err) {
  // Watch mode keeps waiting: fixing the file restarts and retries.
  logger.error('migration failed', { error: err.message });
  process.exit(1);
}
startServer();

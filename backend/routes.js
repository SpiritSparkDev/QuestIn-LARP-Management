import { Router } from './router.js';
import { query } from './db.js';

export const router = new Router();

router.get('/health', async () => {
  await query('SELECT 1');
  return { status: 200, body: { status: 'ok' } };
});

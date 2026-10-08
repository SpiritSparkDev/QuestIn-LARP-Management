import { router } from '../routes.js';
import { requireAuth } from '../middleware/authenticate.js';
import { requireAdminGroup } from '../middleware/authorize.js';
import { listAudit } from './repository.js';

router.get('/audit', requireAuth(requireAdminGroup(async ({ req }) => {
  const { searchParams } = new URL(req.url, 'http://localhost');
  const limit = Math.min(Math.max(Number(searchParams.get('limit')) || 200, 1), 1000);
  const prefix = searchParams.get('prefix');
  return { status: 200, body: await listAudit({ action: searchParams.get('action') || undefined, prefix: /^[a-z_]+\.$/.test(prefix ?? '') ? prefix : undefined, limit }) };
})));

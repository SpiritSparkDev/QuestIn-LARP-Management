import { router } from '../routes.js';
import { requireAuth } from '../middleware/authenticate.js';
import { readJsonBody } from '../httpBody.js';
import { getAccount, updateAccount } from './repository.js';
import { getAppSettings } from '../appSettings/repository.js';

router.get('/account', requireAuth(async ({ user }) => {
  const account = await getAccount(user.id);
  // Drives the admin sidebar's "PDF-Import" link (opt-in add-on).
  const { pdfImportEnabled } = await getAppSettings();
  return { status: 200, body: { ...account, pdfImportEnabled } };
}));

router.patch('/account', requireAuth(async ({ req, user }) => {
  const body = await readJsonBody(req);
  if (body === null) return { status: 400, body: { error: 'invalid JSON' } };
  const account = await updateAccount(user.id, body);
  if (!account) return { status: 404, body: { error: 'account not found' } };
  return { status: 200, body: account };
}));

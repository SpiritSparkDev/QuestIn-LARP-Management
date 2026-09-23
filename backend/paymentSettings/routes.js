import { router } from '../routes.js';
import { requireAuth } from '../middleware/authenticate.js';
import { requireAdminGroup } from '../middleware/authorize.js';
import { readJsonBody } from '../httpBody.js';
import { getPaymentSettings, setPaymentSettings, getBankInfo } from './repository.js';

router.get('/admin/settings/payments', requireAuth(requireAdminGroup(async () => {
  const settings = await getPaymentSettings();
  return { status: 200, body: settings };
})));

router.put('/admin/settings/payments', requireAuth(requireAdminGroup(async ({ req }) => {
  const body = await readJsonBody(req);
  if (body === null) return { status: 400, body: { error: 'invalid JSON' } };
  const { stripeSecretKey, stripeWebhookSecret, bankIban, bankBic, bankAccountHolder } = body;
  const saved = await setPaymentSettings({ stripeSecretKey, stripeWebhookSecret, bankIban, bankBic, bankAccountHolder });
  return { status: 200, body: saved };
})));

router.get('/payment-settings', requireAuth(async () => {
  const bankInfo = await getBankInfo();
  return { status: 200, body: bankInfo };
}));

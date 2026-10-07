import Stripe from 'stripe';
import { isOffline } from '../appMode.js';
import { getPaymentSettingsForUse } from '../paymentSettings/repository.js';

export async function getStripeClient() {
  if (isOffline()) return null;
  const { stripeSecretKey } = await getPaymentSettingsForUse();
  if (!stripeSecretKey) return null;
  return new Stripe(stripeSecretKey);
}

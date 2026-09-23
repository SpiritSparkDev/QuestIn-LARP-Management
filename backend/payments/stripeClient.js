import Stripe from 'stripe';
import { getPaymentSettingsForUse } from '../paymentSettings/repository.js';

export async function getStripeClient() {
  const { stripeSecretKey } = await getPaymentSettingsForUse();
  if (!stripeSecretKey) return null;
  return new Stripe(stripeSecretKey);
}

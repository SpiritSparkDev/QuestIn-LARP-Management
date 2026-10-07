import { query } from '../db.js';
import { resolvePriceForGroup } from '../events/repository.js';
import { getTransporterAndFrom, baseUrl, sendGuestDeadlineEmail } from '../auth/mailer.js';
import { logger } from '../logger.js';

const DAY_MS = 86400000;
const OPEN = ['pending', 'confirmed'];

// Con-Zahler automation, run a few times a day:
//  1. Once the last dated Preisstufe has run out and a Con-Zahler tier applies,
//     every still unpaid registration of that event becomes a Con-Zahler
//     registration (accounts and guests alike): marked, re-priced to the
//     Con-Zahler tier, and the ticket is then issued as Con-Zahler ticket.
//  2. Whoever ticked "remind me" at the registration (opt-in; accounts and guests)
//     gets one mail a week before each deadline, so they can still pay the lower
//     price. Every mail carries an opt-out link.
// Never throws.
export async function runConPayerAutomation({ now = new Date(), send = sendGuestDeadlineEmail } = {}) {
  try {
    const converted = await convertToConPayers(now);
    const mails = await sendGuestDeadlineMails(now, send);
    return { converted, mails };
  } catch (err) {
    logger.error('con payer automation failed', { error: err.message });
    return { converted: 0, mails: 0 };
  }
}

async function convertToConPayers(now) {
  const { rows } = await query(
    `SELECT r.event_id, r.user_id, r.price_group, e.pricing
     FROM registrations r JOIN events e ON e.id = r.event_id
     WHERE r.paid_at IS NULL AND NOT r.con_payer AND r.status = ANY($1::text[])
       AND r.price_group IS NOT NULL AND e.event_date >= CURRENT_DATE`,
    [OPEN]
  );
  let converted = 0;
  for (const r of rows) {
    const tier = resolvePriceForGroup(r.pricing, r.price_group, now);
    if (!tier?.conPayer) continue;
    const { rowCount } = await query(
      `UPDATE registrations SET con_payer = true, price_tier = $3, price_list_cents = $4,
         amount_due_cents = CASE WHEN amount_due_cents IS NULL THEN NULL ELSE GREATEST(amount_due_cents - COALESCE(price_list_cents, 0) + $4, 0) END
       WHERE event_id = $1 AND user_id = $2 AND paid_at IS NULL AND NOT con_payer`,
      [r.event_id, r.user_id, tier.tierName, tier.amountCents]
    );
    converted += rowCount;
  }
  return converted;
}

async function sendGuestDeadlineMails(now, send) {
  const { rows } = await query(
    // A managed person without an address of their own is mailed at their manager's.
    `SELECT r.event_id, r.user_id, r.price_group, r.created_at, r.payment_token, r.optout_token, u.is_guest,
            COALESCE(u.email, m.email) AS email, e.name AS event_name, e.pricing
     FROM registrations r JOIN events e ON e.id = r.event_id JOIN users u ON u.id = r.user_id
     LEFT JOIN users m ON m.id = u.managed_by_user_id
     WHERE r.deadline_mail_optin AND r.optout_token IS NOT NULL
       AND COALESCE(u.email, m.email) IS NOT NULL AND COALESCE(u.email, m.email) NOT LIKE '%@test.invalid'
       AND r.paid_at IS NULL AND NOT r.con_payer AND r.status = ANY($1::text[])
       AND r.price_group IS NOT NULL AND e.event_date >= CURRENT_DATE`,
    [OPEN]
  );
  const today = now.toISOString().slice(0, 10);
  const transport = rows.length ? await getTransporterAndFrom() : null;
  const base = rows.length ? await baseUrl() : '';
  let mails = 0;
  for (const r of rows) {
    const tiers = r.pricing?.tiers ?? [];
    const active = tiers.find((t) => t.until == null || today <= t.until);
    if (!active?.until) continue; // no deadline ahead
    const deadline = new Date(`${active.until}T00:00:00Z`);
    const windowStart = deadline.getTime() - 7 * DAY_MS;
    // Only for people who registered before the week began, and once per deadline.
    if (now.getTime() < windowStart || new Date(r.created_at).getTime() >= windowStart) continue;
    const { rowCount } = await query(
      `UPDATE registrations SET deadline_mail_for = $3
       WHERE event_id = $1 AND user_id = $2 AND deadline_mail_for IS DISTINCT FROM $3::date`,
      [r.event_id, r.user_id, active.until]
    );
    if (rowCount === 0) continue;
    const next = tiers[tiers.indexOf(active) + 1];
    try {
      await send(r.email, {
        eventName: r.event_name,
        deadline: active.until,
        // Guests have no login: their link leads to payment and ticket.
        url: r.is_guest && r.payment_token ? `${base}/guest-payment.html?token=${r.payment_token}` : `${base}/account.html#anmelden`,
        optoutUrl: `${base}/deadline-optout.html?token=${r.optout_token}`,
        conPayerNext: next?.conPayer === true,
        userId: r.user_id,
      }, transport);
      mails += 1;
    } catch (err) {
      logger.error('failed to send guest deadline mail', { error: err.message, eventId: r.event_id });
      // Allow a retry on the next run.
      await query('UPDATE registrations SET deadline_mail_for = NULL WHERE event_id = $1 AND user_id = $2', [r.event_id, r.user_id]);
    }
  }
  return mails;
}

// "Meine Anmeldungen" im QuestIn-Hub: Der Hub fragt serverseitig die
// Anmeldungen einer Person ab, die ihr Konto hier mit dem Hub verknüpft hat
// (oauth_accounts, provider 'hub'). Signiert wie die Webhooks (HMAC über
// "<timestamp>.<body>" mit dem Client-Secret). Nur Event, Status, Rolle,
// Charaktername und Zahlungsstand; keine Profil- oder Anmeldefelder.
import { router } from '../routes.js';
import { query } from '../db.js';
import { readRawBody } from '../httpBody.js';
import { hubConfig } from '../auth/hubLogin.js';
import { getAppSettings } from '../appSettings/repository.js';
import { isOffline } from '../appMode.js';
import { logger } from '../logger.js';
import { verifyHubSignature } from '../hubProfile/routes.js';
import { CON_ROLE_LABELS } from '../registrations/lock.js';

const STATUS_LABELS = {
  notified: 'Benachrichtigt', pending: 'Angemeldet', confirmed: 'Bestätigt',
  checked_in: 'Eingecheckt', checked_out: 'Ausgecheckt', cancelled: 'Abgesagt', waitlisted: 'Warteliste',
};

// Wie statusLabel() in frontend/js/formFields.js.
export function statusLabel(status, conPayer) {
  const label = STATUS_LABELS[status] ?? status;
  if (!conPayer) return label;
  if (status === 'pending') return 'Angemeldet, Con-Zahler';
  return ['confirmed', 'checked_in', 'checked_out'].includes(status) ? `${label}, Con-Zahler` : label;
}

// Wie paymentStateLabel() in account.html.
export function paymentState(r) {
  if (r.status === 'cancelled') return { state: 'none' };
  if (r.paid_at) return { state: 'paid' };
  if (r.con_payer) return { state: 'onsite' };
  if (r.amount_due_cents == null || r.amount_due_cents <= 0) return { state: 'none' };
  if (r.transfer_notified_at) return { state: 'notified', notifiedAt: r.transfer_notified_at.toISOString().slice(0, 10) };
  return { state: 'open', amountDueCents: r.amount_due_cents };
}

export async function registrationsForHubSub(sub, origin) {
  const { rows } = await query(
    `SELECT r.status, r.con_role, r.con_payer, r.amount_due_cents, r.paid_at, r.transfer_notified_at,
            e.name AS event_name, e.event_date, e.end_date, c.name AS character_name, nc.name AS nsc_character_name
     FROM oauth_accounts o
     JOIN registrations r ON r.user_id = o.user_id
     JOIN events e ON e.id = r.event_id
     LEFT JOIN characters c ON c.id = r.character_id
     LEFT JOIN characters nc ON nc.id = r.nsc_character_id
     WHERE o.provider = 'hub' AND o.provider_user_id = $1
     ORDER BY e.event_date`,
    [sub]
  );
  return rows.map((r) => ({
    eventName: r.event_name,
    startDate: r.event_date,
    endDate: r.end_date,
    status: r.status,
    statusLabel: statusLabel(r.status, r.con_payer),
    role: r.con_role ? CON_ROLE_LABELS[r.con_role] ?? r.con_role : null,
    characterName: r.con_role === 'nsc' ? r.nsc_character_name ?? null : r.character_name ?? null,
    payment: paymentState(r),
    url: `${origin}/account.html#anmelden`,
  }));
}

router.post('/api/hub/registrations', async ({ req, requestId }) => {
  const config = hubConfig();
  if (!config || isOffline()) return { status: 404, body: { error: 'not found' } };
  const raw = await readRawBody(req, 10_000);
  if (raw === null) return { status: 400, body: { error: 'invalid body' } };
  const text = raw.toString('utf8');
  if (!verifyHubSignature(config.clientSecret, req.headers['x-questin-timestamp'], text, req.headers['x-questin-signature'])) {
    logger.warn('hub registrations request with invalid signature', { requestId });
    return { status: 401, body: { error: 'invalid signature' } };
  }
  let body;
  try { body = JSON.parse(text); } catch { return { status: 400, body: { error: 'invalid JSON' } }; }
  if (typeof body?.sub !== 'string' || !body.sub) return { status: 400, body: { error: 'sub is required' } };
  const origin = new URL((await getAppSettings()).effectiveBaseUrl).origin;
  return { status: 200, headers: { 'Cache-Control': 'no-store' }, body: { registrations: await registrationsForHubSub(body.sub, origin) } };
});

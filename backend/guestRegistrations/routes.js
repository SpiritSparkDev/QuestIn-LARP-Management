// Public (unauthenticated) endpoints backing the embeddable ticket widget
// (frontend/ticket-widget.html): a visitor on an external site can secure a
// ticket without first creating a full account. The resulting `users` row
// is flagged is_guest=true with no password_hash, so it can never log in
// (backend/auth/login.js already rejects any row with password_hash IS
// NULL) -- an admin can later convert it to a full account via
// POST /members/:id/generate-conversion-link (backend/members/routes.js).
import { router } from '../routes.js';
import { query } from '../db.js';
import { readJsonBody } from '../httpBody.js';
import { isValidEmail } from '../validation.js';
import { rateLimit } from '../middleware/rateLimit.js';
import { registerForEvent } from '../registrations/repository.js';
import { getEvent, getEventByCode, listEvents, resolvePriceForGroup } from '../events/repository.js';
import { setGuestPaymentToken } from '../payments/repository.js';
import { sendGuestTicketEmail } from '../auth/mailer.js';
import { logger } from '../logger.js';
import { getAppSettings } from '../appSettings/repository.js';
import { sanitizeRichText, sanitizeFieldValue } from '../richText.js';
import { getAccountFieldSchema } from '../accountFieldSchema/repository.js';
import { getRegistrationFieldSchema } from '../registrationFieldSchema/repository.js';
import { encryptFieldBlob, decryptFieldBlob } from '../accountFields.js';

const GUEST_REGISTER_RATE_LIMIT = { keyPrefix: 'guest-register', maxAttempts: 10, windowMs: 15 * 60 * 1000 };
const PAYMENT_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const GUEST_GROUP_KEY = 'mitglied';
const COMING_SOON_ERROR = { status: 409, body: { error: 'Die Anmeldung ist noch gesperrt und startet bald.' } };

// The account (personal-data) fields a guest is asked for: the same schema a
// normal member fills in under "Konto" (minus the access-control field "group").
async function guestAccountSchema() {
  return (await getAccountFieldSchema()).filter((field) => field.key !== 'group');
}

function pickFields(schema, values) {
  const picked = {};
  for (const field of schema) {
    if (values?.[field.key] !== undefined) picked[field.key] = sanitizeFieldValue(field, values[field.key]);
  }
  return picked;
}

// Open events a guest can book (login page: "Ohne Konto").
router.get('/public/events', async () => {
  if ((await getAppSettings()).comingSoonEnabled) return COMING_SOON_ERROR;
  const events = (await listEvents()).filter((e) => e.is_active && e.code);
  return { status: 200, body: events.map((e) => ({ code: e.code, name: e.name, eventDate: e.event_date })) };
});

router.get('/public/events/:code', async ({ params }) => {
  const { comingSoonEnabled, waiverText } = await getAppSettings();
  if (comingSoonEnabled) return COMING_SOON_ERROR;
  // The router matches raw, still-percent-encoded path segments (see
  // Router.match in backend/router.js), so a code containing "/" -- the
  // exact format the admin UI suggests, e.g. "P17/2027" -- arrives here as
  // literal "P17%2F2027" unless decoded first.
  const event = await getEventByCode(decodeURIComponent(params.code));
  if (!event) return { status: 404, body: { error: 'event not found' } };
  if (!event.is_active) {
    return { status: 409, body: { error: 'Für dieses Event ist aktuell keine Anmeldung möglich.' } };
  }

  const groups = event.pricing?.groups ?? [];
  const prices = {};
  for (const group of groups) {
    const resolved = resolvePriceForGroup(event.pricing, group);
    if (resolved) prices[group] = resolved.amountCents;
  }

  return {
    status: 200,
    body: {
      id: event.id, name: event.name, eventDate: event.event_date, priceGroups: groups, prices,
      accountFields: await guestAccountSchema(),
      registrationFields: await getRegistrationFieldSchema(),
      // Ready-to-insert HTML for the embeddable widget (plain-text waivers keep their line breaks).
      waiverHtml: waiverText ? sanitizeRichText(waiverText).replace(/\n/g, '<br>') : null,
    },
  };
});

router.post('/public/events/:eventId/guest-registration', rateLimit(GUEST_REGISTER_RATE_LIMIT)(async ({ req, params }) => {
  if ((await getAppSettings()).comingSoonEnabled) return COMING_SOON_ERROR;
  const body = await readJsonBody(req);
  if (body === null) return { status: 400, body: { error: 'invalid JSON' } };
  const { firstName, lastName, nickname, priceGroup, waiverAccepted, accountData, registrationData } = body;
  const conPayer = body.conPayer === true;
  const email = body.email?.toLowerCase();
  if (!email || !firstName || !lastName) {
    return { status: 400, body: { error: 'email, firstName, and lastName are required' } };
  }
  if (!isValidEmail(email)) {
    return { status: 400, body: { error: 'Ungültiges E-Mail-Format.' } };
  }

  const event = await getEvent(params.eventId);
  if (!event) return { status: 404, body: { error: 'event not found' } };

  const { rows: existingRows } = await query('SELECT id, is_guest FROM users WHERE email = $1', [email]);
  let userId;
  let createdNewUser = false;
  if (existingRows.length > 0) {
    if (!existingRows[0].is_guest) {
      return {
        status: 409,
        body: { error: 'Diese E-Mail-Adresse gehört bereits zu einem Konto. Bitte melde dich an, um ein Ticket zu buchen.' },
      };
    }
    userId = existingRows[0].id;
  } else {
    const { rows } = await query(
      `INSERT INTO users (email, group_id, first_name, last_name, nickname, is_guest, email_verified)
       VALUES ($1, (SELECT id FROM groups WHERE key = $2), $3, $4, $5, true, false)
       RETURNING id`,
      [email, GUEST_GROUP_KEY, firstName, lastName, nickname ?? null]
    );
    userId = rows[0].id;
    createdNewUser = true;
  }

  const requestingUser = { id: userId, group: { key: GUEST_GROUP_KEY, canEditCharacters: false } };
  try {
    await registerForEvent(userId, params.eventId, 'ticket', null, false, null, [], priceGroup, registrationData ?? {}, requestingUser, waiverAccepted, { conPayer });
  } catch (err) {
    // Only clean up the guest row if THIS request created it -- an existing
    // guest reusing their email for a second event must never be deleted
    // just because that particular registration attempt failed.
    if (createdNewUser) {
      await query('DELETE FROM users WHERE id = $1', [userId]).catch(() => {});
    }
    if (err.code === 'ALREADY_REGISTERED') {
      return {
        status: 409,
        body: { error: 'Diese E-Mail-Adresse ist für dieses Event bereits registriert – bitte im Postfach nach dem Zahlungslink schauen.' },
      };
    }
    if (err.code === 'EVENT_NOT_ACTIVE') {
      return { status: 409, body: { error: 'Für dieses Event ist aktuell keine Anmeldung möglich.' } };
    }
    if (err.code === 'INVALID_PRICE_GROUP') {
      return { status: 400, body: { error: err.message } };
    }
    if (err.code === 'WAIVER_NOT_ACCEPTED') {
      return { status: 400, body: { error: err.message } };
    }
    throw err;
  }

  const accountValues = pickFields(await guestAccountSchema(), accountData);
  if (Object.keys(accountValues).length > 0) {
    const { rows: blobRows } = await query('SELECT account_data_enc FROM users WHERE id = $1', [userId]);
    const merged = { ...decryptFieldBlob(blobRows[0]?.account_data_enc), ...accountValues };
    await query('UPDATE users SET account_data_enc = $2 WHERE id = $1', [userId, encryptFieldBlob(merged)]);
  }

  const { rows: amountRows } = await query(
    'SELECT amount_due_cents FROM registrations WHERE event_id = $1 AND user_id = $2',
    [params.eventId, userId]
  );
  const amountDueCents = amountRows[0]?.amount_due_cents ?? null;

  if (!amountDueCents) {
    return { status: 201, body: { status: 'confirmed' } };
  }

  const { token } = await setGuestPaymentToken(params.eventId, userId, PAYMENT_TOKEN_TTL_MS);
  try {
    await sendGuestTicketEmail(email, { eventName: event.name, paymentToken: token, userId, conPayer });
  } catch (err) {
    logger.error('failed to send guest ticket email', { error: err.message, eventId: params.eventId, userId });
  }

  // Con-Zahler pay at the con: no redirect to the payment page, the ticket is theirs anyway.
  if (conPayer) return { status: 201, body: { status: 'con_payer' } };
  return { status: 201, body: { status: 'registered', paymentUrl: `/guest-payment.html?token=${token}` } };
}));

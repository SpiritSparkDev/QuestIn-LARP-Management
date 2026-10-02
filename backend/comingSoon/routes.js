// Public (unauthenticated) endpoint backing the "Erinnere mich" form on
// frontend/coming-soon.html. Creates the same kind of guest `users` row the
// ticket widget does (backend/guestRegistrations/routes.js) -- is_guest=true,
// no password_hash, so it can never log in -- but marked via
// coming_soon_reminder_requested_at instead of a registration. Once an admin
// disables coming_soon_enabled, backend/comingSoon/notify.js turns every
// marked guest into a real invitation (guest-conversion redeem mode, see
// backend/auth/invite.js) and emails them the link.
import { router } from '../routes.js';
import { query } from '../db.js';
import { readJsonBody } from '../httpBody.js';
import { isValidEmail } from '../validation.js';
import { rateLimit } from '../middleware/rateLimit.js';

const REMINDER_RATE_LIMIT = { keyPrefix: 'coming-soon-remind', maxAttempts: 10, windowMs: 15 * 60 * 1000 };
const GUEST_GROUP_KEY = 'mitglied';

router.post('/public/coming-soon/remind-me', rateLimit(REMINDER_RATE_LIMIT)(async ({ req }) => {
  const body = await readJsonBody(req);
  if (body === null) return { status: 400, body: { error: 'invalid JSON' } };
  const { firstName, lastName } = body;
  const email = body.email?.toLowerCase();
  if (!email || !firstName || !lastName) {
    return { status: 400, body: { error: 'email, firstName, and lastName are required' } };
  }
  if (!isValidEmail(email)) {
    return { status: 400, body: { error: 'Ungültiges E-Mail-Format.' } };
  }

  const { rows } = await query('SELECT id, is_guest, coming_soon_reminder_requested_at FROM users WHERE email = $1', [email]);
  if (rows.length > 0) {
    const existing = rows[0];
    if (!existing.is_guest) {
      return { status: 409, body: { error: 'Diese E-Mail-Adresse gehört bereits zu einem Konto.' } };
    }
    if (existing.coming_soon_reminder_requested_at) {
      return { status: 409, body: { error: 'Du bist bereits für die Erinnerung angemeldet.' } };
    }
    await query('UPDATE users SET coming_soon_reminder_requested_at = now() WHERE id = $1', [existing.id]);
    return { status: 201, body: { status: 'registered' } };
  }

  await query(
    `INSERT INTO users (email, group_id, first_name, last_name, is_guest, email_verified, coming_soon_reminder_requested_at)
     VALUES ($1, (SELECT id FROM groups WHERE key = $2), $3, $4, true, false, now())`,
    [email, GUEST_GROUP_KEY, firstName, lastName]
  );
  return { status: 201, body: { status: 'registered' } };
}));

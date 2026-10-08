import { query } from './db.js';
import { logger } from './logger.js';

// APP_MODE=offline: the on-site Con server. It must never open outgoing connections
// (Stripe, SMTP, OAuth, reminder jobs); mails are parked in mail_outbox instead.
export function isOffline() {
  return process.env.APP_MODE === 'offline';
}

// Drop-in for a nodemailer transporter: stores the mail for sending after the handback.
export const outboxTransport = {
  async sendMail({ to, from, subject, html, text }) {
    await query(
      'INSERT INTO mail_outbox (to_address, from_address, subject, body, is_html) VALUES ($1, $2, $3, $4, $5)',
      [to, from ?? null, subject, html ?? text ?? '', html !== undefined]
    );
    return { queued: true };
  },
};

// An online instance started on a retired/offline database would accept writes
// from the wrong copy -- shout in the log. Defensive: the table may not exist yet.
export async function warnIfWrongDatabase() {
  if (isOffline()) return null;
  try {
    const { rows } = await query(
      `SELECT role FROM instance_authority WHERE role IN ('retired', 'offline_primary') LIMIT 1`
    );
    if (!rows[0]) return null;
    logger.warn('APP_MODE=online, but this database is an OFFLINE copy -- wrong database?', { role: rows[0].role });
    return rows[0].role;
  } catch (err) {
    if (err.code !== '42P01') logger.error('instance authority startup check failed', { error: err.message });
    return null;
  }
}

import { query } from '../db.js';
import { logger } from '../logger.js';
import { isValidEmail } from '../validation.js';
import { getTransporterAndFrom } from '../auth/mailer.js';

export const MAILING_STATUSES = ['notified', 'pending', 'waitlisted', 'confirmed', 'checked_in', 'checked_out', 'cancelled'];
export const MAILING_ROLES = ['sc', 'nsc', 'ticket', 'helfer', 'orga', 'hilfs_orga'];
export const MAX_RECIPIENTS = 1000;

// Admin-written HTML goes into mails only, but never ship active content:
// scripts/frames/forms, inline event handlers and javascript: links go.
export function cleanMailHtml(html) {
  return String(html ?? '')
    .replace(/<(script|iframe|object|embed|form|template)\b[\s\S]*?<\/\1\s*>/gi, '')
    .replace(/<\/?(script|iframe|object|embed|form|meta|link|base)\b[^>]*>/gi, '')
    .replace(/\son[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    .replace(/(href|src)\s*=\s*(["'])\s*javascript:[^"']*\2/gi, '$1=$2#$2');
}

export const htmlToText = (html) => String(html ?? '')
  .replace(/<(br|\/p|\/div|\/li|\/h[1-6]|\/tr)\s*\/?>/gi, '\n')
  .replace(/<[^>]*>/g, '')
  .replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&')
  .replace(/\n{3,}/g, '\n\n').trim();

export function parseManualEmails(text) {
  const valid = [];
  const invalid = [];
  for (const raw of String(text ?? '').split(/[,;\s]+/)) {
    const email = raw.trim().toLowerCase();
    if (!email) continue;
    (isValidEmail(email) ? valid : invalid).push(email);
  }
  return { valid, invalid };
}

// Recipients from the registrations of one event. Default: everyone who is not cancelled.
export async function registeredRecipients(eventId, filter = {}) {
  const statuses = filter.statuses?.length ? filter.statuses : MAILING_STATUSES.filter((s) => s !== 'cancelled');
  const roles = filter.conRoles?.length ? filter.conRoles : null;
  const { rows } = await query(
    `SELECT DISTINCT ON (lower(u.email)) lower(u.email) AS email
       FROM registrations r JOIN users u ON u.id = r.user_id
      WHERE r.event_id = $1 AND u.email IS NOT NULL AND u.deactivated_at IS NULL
        AND r.status = ANY($2::text[])
        AND ($3::text[] IS NULL OR r.con_role = ANY($3::text[]))
        AND ($4 = 'any' OR ($4 = 'paid' AND r.paid_at IS NOT NULL) OR ($4 = 'unpaid' AND r.paid_at IS NULL))
        AND (NOT $5 OR u.is_guest)
      ORDER BY lower(u.email)`,
    [eventId, statuses, roles, filter.payment ?? 'any', filter.guestsOnly === true]
  );
  return rows.map((r) => r.email);
}

export async function countRegistrationsWithoutEmail(eventId) {
  const { rows } = await query(
    `SELECT count(*)::int AS n FROM registrations r JOIN users u ON u.id = r.user_id
      WHERE r.event_id = $1 AND u.email IS NULL AND r.status <> 'cancelled'`, [eventId]);
  return rows[0].n;
}

export async function resolveRecipients(eventId, { includeRegistered, filter, manualEmails }) {
  const registered = includeRegistered ? await registeredRecipients(eventId, filter) : [];
  const { valid, invalid } = parseManualEmails(manualEmails);
  const known = new Set(registered);
  const manual = [...new Set(valid)].filter((e) => !known.has(e));
  return { registered, manual, invalid, all: [...registered, ...manual] };
}

export async function createMailing({ eventId, sentBy, subject, bodyHtml, recipients, filter, testOnly }) {
  const { rows } = await query(
    `INSERT INTO event_mailings (event_id, sent_by, subject, body_html, recipient_count, filter, test_only)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
    [eventId, sentBy, subject, bodyHtml, recipients.length, JSON.stringify(filter ?? {}), testOnly]
  );
  return rows[0].id;
}

export async function listMailings(eventId) {
  const { rows } = await query(
    `SELECT m.id, m.subject, m.recipient_count, m.sent_count, m.failed_count, m.failed_addresses, m.test_only, m.status,
            m.created_at, m.finished_at, u.first_name, u.last_name
       FROM event_mailings m LEFT JOIN users u ON u.id = m.sent_by
      WHERE m.event_id = $1 ORDER BY m.created_at DESC LIMIT 20`, [eventId]);
  return rows.map((r) => ({
    id: r.id, subject: r.subject, recipientCount: r.recipient_count, sentCount: r.sent_count, failedCount: r.failed_count,
    failedAddresses: r.failed_addresses, testOnly: r.test_only, status: r.status, createdAt: r.created_at, finishedAt: r.finished_at,
    sentBy: [r.first_name, r.last_name].filter(Boolean).join(' ') || null,
  }));
}

// Sends one mail per recipient (nobody sees the others' addresses), in the
// background so the request returns at once; progress lands in the row.
export function startSending(mailingId, { recipients, subject, bodyHtml }) {
  setImmediate(async () => {
    let sent = 0;
    const failed = [];
    try {
      const { transporter, from } = await getTransporterAndFrom();
      const html = cleanMailHtml(bodyHtml);
      const text = htmlToText(html);
      for (const to of recipients) {
        try {
          // Test-Modus people live on an undeliverable domain -- skip, as the system mails do.
          if (!to.endsWith('@test.invalid')) await transporter.sendMail({ to, from, subject, html, text });
          sent += 1;
        } catch (err) {
          failed.push(to);
          logger.error('mailing: send failed', { mailingId, to, error: err.message });
        }
        await query('UPDATE event_mailings SET sent_count = $2, failed_count = $3 WHERE id = $1', [mailingId, sent, failed.length]);
      }
    } catch (err) {
      logger.error('mailing: aborted', { mailingId, error: err.message });
      failed.push(...recipients.slice(sent + failed.length));
    }
    await query(
      `UPDATE event_mailings SET status = 'done', finished_at = now(), sent_count = $2, failed_count = $3, failed_addresses = $4 WHERE id = $1`,
      [mailingId, sent, failed.length, JSON.stringify(failed.slice(0, 100))]
    ).catch((err) => logger.error('mailing: could not finish', { mailingId, error: err.message }));
  });
}

import { query } from '../db.js';
import { logger } from '../logger.js';
import { isOffline } from '../appMode.js';
import { getTransporterAndFrom, deliver, isUnconfiguredTransporter } from '../auth/mailer.js';

const BATCH = 200;
const OFFLINE_PLACEHOLDER = /^offline-([0-9a-f-]{36})@offline\.invalid$/i;

// The offline snapshot replaces every participant's address with
// offline-<user id>@offline.invalid (backend/offlinePackage/snapshot.js), so
// the real one is looked up here. null = recipient no longer exists.
async function realAddress(row) {
  const match = OFFLINE_PLACEHOLDER.exec(row.to_address);
  if (!match) return row.to_address;
  const { rows } = await query('SELECT email FROM users WHERE id = $1 AND deactivated_at IS NULL', [row.user_id ?? match[1]]);
  return rows[0]?.email ?? null;
}

// Sends the mails the offline Con instance parked in mail_outbox; the return
// merge copies them into this (online) database (backend/offlineMerge/merge.js).
// Runs right after a merge and again with the background jobs, so a mail that
// failed (SMTP down) is retried. Without a configured SMTP server nothing is
// touched -- the mails stay queued instead of vanishing into jsonTransport.
// The current From address is used, not the offline one.
export async function flushMailOutbox() {
  if (isOffline() || !process.env.DATABASE_URL) return { sent: 0, failed: 0 };
  const { rows } = await query(
    `SELECT id, to_address, subject, body, is_html, slot, user_id FROM mail_outbox
     WHERE sent_at IS NULL ORDER BY created_at LIMIT ${BATCH}`
  );
  if (rows.length === 0) return { sent: 0, failed: 0 };
  const { transporter, from } = await getTransporterAndFrom();
  if (isUnconfiguredTransporter(transporter)) {
    logger.warn('mail outbox not sent: no SMTP host configured', { queued: rows.length });
    return { sent: 0, failed: 0, notConfigured: rows.length };
  }
  let sent = 0;
  let failed = 0;
  for (const row of rows) {
    const to = await realAddress(row);
    if (!to) {
      // Nobody to send to any more -- stop retrying.
      await query("UPDATE mail_outbox SET sent_at = now(), error = 'Empfänger existiert nicht mehr' WHERE id = $1", [row.id]);
      failed++;
      continue;
    }
    try {
      await deliver(transporter, from, to, {
        subject: row.subject, body: row.body, isHtml: row.is_html, slot: row.slot, userId: row.user_id,
      });
      await query('UPDATE mail_outbox SET sent_at = now(), error = NULL WHERE id = $1', [row.id]);
      sent++;
    } catch (err) {
      await query('UPDATE mail_outbox SET error = $2 WHERE id = $1', [row.id, err.message]);
      failed++;
    }
  }
  if (sent || failed) logger.info('mail outbox flushed', { sent, failed });
  return { sent, failed };
}

export async function countQueuedOutbox() {
  const { rows } = await query('SELECT count(*)::int AS n FROM mail_outbox WHERE sent_at IS NULL');
  return rows[0].n;
}

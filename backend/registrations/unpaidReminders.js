import { query } from '../db.js';
import { displayName } from '../displayName.js';
import { getAppSettings } from '../appSettings/repository.js';
import { getTransporterAndFrom, sendUnpaidReminderOrgaEmail } from '../auth/mailer.js';
import { resolveOtFieldsChangeRecipients } from './repository.js';
import { logger } from '../logger.js';

const euro = (cents) => `${(cents / 100).toFixed(2).replace('.', ',')} €`;

// Registrations that came in through an imported PDF stay open until somebody
// pays. Up to three times (days after the registration, set under
// Einstellungen) the orga gets one mail per event listing everyone who still
// owes money. Con-Zahler pay at the con and are left out. Never throws.
export async function runUnpaidReminders({ now = new Date(), send = sendUnpaidReminderOrgaEmail } = {}) {
  try {
    const { unpaidReminderDays: days } = await getAppSettings();
    if (!days?.length) return 0;
    const { rows } = await query(
      `SELECT r.event_id, r.user_id, r.unpaid_reminders_sent AS sent, r.created_at, r.amount_due_cents,
              e.name AS event_name, u.first_name, u.last_name, u.nickname
       FROM registrations r
       JOIN events e ON e.id = r.event_id
       JOIN users u ON u.id = r.user_id
       WHERE r.pdf_import AND r.paid_at IS NULL AND NOT r.con_payer
         AND r.status IN ('pending', 'confirmed') AND r.unpaid_reminders_sent < $1
       ORDER BY e.name, u.last_name, u.first_name`,
      [days.length]
    );
    const due = rows.filter((r) => new Date(r.created_at).getTime() + days[r.sent] * 86400000 <= now.getTime());
    const byEvent = new Map();
    for (const r of due) {
      if (!byEvent.has(r.event_id)) byEvent.set(r.event_id, []);
      byEvent.get(r.event_id).push(r);
    }
    if (byEvent.size === 0) return 0;
    const transport = await getTransporterAndFrom();
    let mails = 0;
    for (const [eventId, regs] of byEvent) {
      const list = regs.map((r) => `- ${displayName({ firstName: r.first_name, lastName: r.last_name, nickname: r.nickname })}${r.amount_due_cents != null ? ` (${euro(r.amount_due_cents)})` : ''} – Erinnerung ${r.sent + 1} von ${days.length}`).join('\n');
      const reminderNumber = Math.max(...regs.map((r) => r.sent + 1));
      let delivered = false;
      for (const to of await resolveOtFieldsChangeRecipients(eventId)) {
        try {
          await send(to, { eventName: regs[0].event_name, reminderNumber, list }, transport);
          delivered = true;
          mails += 1;
        } catch (err) {
          logger.error('failed to send unpaid reminder', { error: err.message, to, eventId });
        }
      }
      // Only count the reminder when somebody actually got it, so a mail outage retries later.
      if (delivered) {
        await query(
          'UPDATE registrations SET unpaid_reminders_sent = unpaid_reminders_sent + 1 WHERE event_id = $1 AND user_id = ANY($2::uuid[])',
          [eventId, regs.map((r) => r.user_id)]
        );
      }
    }
    return mails;
  } catch (err) {
    logger.error('unpaid reminder run failed', { error: err.message });
    return 0;
  }
}

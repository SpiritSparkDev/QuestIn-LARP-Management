import { query } from '../db.js';
import { displayName } from '../displayName.js';
import { logger } from '../logger.js';
import { getEvent } from '../events/repository.js';
import { resolveOtFieldsChangeRecipients } from '../registrations/repository.js';
import { getTransporterAndFrom, sendNscDialogStaffEmail, sendNscDialogPlayerEmail } from '../auth/mailer.js';

const err = (code, message) => Object.assign(new Error(message), { code });

// Only registrations with NSC reference (role NSC or "auch NSC-bereit") may have a dialog.
export async function hasNscRegistration(eventId, userId) {
  const { rows } = await query(
    "SELECT 1 FROM registrations WHERE event_id = $1 AND user_id = $2 AND (con_role = 'nsc' OR nsc_available)",
    [eventId, userId]
  );
  return rows.length > 0;
}

const view = (m, side) => ({
  id: m.id,
  from: m.author_side,
  body: m.body,
  proposal: m.proposal ? { ...m.proposal, status: m.proposal_status } : null,
  createdAt: m.created_at,
  unread: m.author_side !== side && !m.read_at,
});

// Returns the thread as seen by `side` and marks the other side's messages read.
export async function readThread(eventId, userId, side) {
  const { rows } = await query(
    'SELECT * FROM nsc_dialog_messages WHERE event_id = $1 AND user_id = $2 ORDER BY created_at, id',
    [eventId, userId]
  );
  await query(
    'UPDATE nsc_dialog_messages SET read_at = now() WHERE event_id = $1 AND user_id = $2 AND author_side <> $3 AND read_at IS NULL',
    [eventId, userId, side]
  );
  return rows.map((m) => view(m, side));
}

export function validateMessage({ body, proposal }, side) {
  const text = typeof body === 'string' ? body.trim() : '';
  if (text.length < 1 || text.length > 2000) throw err('INVALID_MESSAGE', 'Nachricht: 1 bis 2000 Zeichen.');
  let p = null;
  if (proposal != null) {
    if (side !== 'staff') throw err('INVALID_MESSAGE', 'Nur Orga/SL kann Rollenvorschläge senden.');
    const roleName = typeof proposal.roleName === 'string' ? proposal.roleName.trim() : '';
    const description = typeof proposal.description === 'string' ? proposal.description.trim() : '';
    if (roleName.length < 1 || roleName.length > 100 || description.length > 1000) throw err('INVALID_MESSAGE', 'Rollenvorschlag: Name 1 bis 100, Beschreibung bis 1000 Zeichen.');
    p = { roleName, description };
  }
  return { text, proposal: p };
}

export async function addMessage(eventId, userId, authorId, side, input) {
  const { text, proposal } = validateMessage(input, side);
  if (!(await hasNscRegistration(eventId, userId))) throw err('NOT_NSC', 'Für diese Anmeldung gibt es keinen NSC-Dialog.');
  await query(
    `INSERT INTO nsc_dialog_messages (event_id, user_id, author_id, author_side, body, proposal, proposal_status)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [eventId, userId, authorId, side, text, proposal && JSON.stringify(proposal), proposal ? 'open' : null]
  );
}

export async function respondToProposal(eventId, userId, messageId, accept) {
  const { rows } = await query(
    `UPDATE nsc_dialog_messages SET proposal_status = $4
     WHERE id = $3 AND event_id = $1 AND user_id = $2 AND proposal_status = 'open' RETURNING id`,
    [eventId, userId, messageId, accept ? 'accepted' : 'declined']
  );
  if (rows.length === 0) throw err('PROPOSAL_NOT_OPEN', 'Kein offener Vorschlag.');
}

export async function listOverview(eventId) {
  const { rows } = await query(
    `SELECT m.user_id, u.first_name, u.last_name, u.nickname, COUNT(*)::int AS messages,
            COUNT(*) FILTER (WHERE m.author_side = 'player' AND m.read_at IS NULL)::int AS unread,
            COUNT(*) FILTER (WHERE m.proposal_status = 'open')::int AS open_proposals,
            MAX(m.created_at) AS last_at,
            COALESCE(jsonb_agg(m.proposal->>'roleName' ORDER BY m.created_at) FILTER (WHERE m.proposal_status = 'accepted'), '[]') AS accepted
     FROM nsc_dialog_messages m JOIN users u ON u.id = m.user_id
     WHERE m.event_id = $1 GROUP BY m.user_id, u.first_name, u.last_name, u.nickname ORDER BY MAX(m.created_at) DESC`,
    [eventId]
  );
  return rows.map((r) => ({
    userId: r.user_id,
    name: displayName({ firstName: r.first_name, lastName: r.last_name, nickname: r.nickname }),
    messages: r.messages, unread: r.unread, openProposals: r.open_proposals, lastAt: r.last_at, acceptedRoles: r.accepted,
  }));
}

async function ownerName(userId) {
  const { rows } = await query('SELECT first_name, last_name, nickname FROM users WHERE id = $1', [userId]);
  return rows[0] ? displayName({ firstName: rows[0].first_name, lastName: rows[0].last_name, nickname: rows[0].nickname }) : 'Unbekannt';
}

// Hint only (never the message text); never throws.
export async function notifyOtherSide(eventId, userId, side) {
  try {
    const event = await getEvent(eventId);
    const eventName = event?.name ?? 'Unbekanntes Event';
    const transport = await getTransporterAndFrom();
    if (side === 'player') {
      const userName = await ownerName(userId);
      for (const to of await resolveOtFieldsChangeRecipients(eventId)) {
        await sendNscDialogStaffEmail(to, { eventName, userName }, transport).catch((e) => logger.error('nsc dialog mail failed', { error: e.message, eventId }));
      }
    } else {
      const { rows } = await query('SELECT email FROM users WHERE id = $1', [userId]);
      if (rows[0]) await sendNscDialogPlayerEmail(rows[0].email, { eventName, userId }, transport);
    }
  } catch (e) {
    logger.error('failed to send nsc dialog notification', { error: e.message, eventId, userId });
  }
}

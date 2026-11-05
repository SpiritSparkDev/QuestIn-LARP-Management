import { router } from '../routes.js';
import { requireAuth } from '../middleware/authenticate.js';
import { requireMenu } from '../middleware/authorize.js';
import { readJsonBody } from '../httpBody.js';
import { query } from '../db.js';
import { displayName } from '../displayName.js';
import { getBankReferenceTemplate } from '../paymentSettings/repository.js';
import { buildPaymentReference } from '../payments/reference.js';
import { markPaidManually } from '../payments/repository.js';
import { parseStatement } from './parse.js';
import { matchEntries, summarize } from './match.js';

const MAX_BODY_BYTES = 5_000_000;
const MAX_ITEMS = 200;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Open = payable and unpaid: same rule as the group-payment list.
const OPEN_SQL = `r.paid_at IS NULL AND r.amount_due_cents > 0 AND NOT r.con_payer AND e.payments_open`;

async function loadOpen() {
  const template = await getBankReferenceTemplate();
  const { rows } = await query(
    `SELECT r.event_id, r.user_id, r.con_role, r.amount_due_cents, u.first_name, u.last_name, u.nickname, e.code, e.name AS event_name
     FROM registrations r JOIN users u ON u.id = r.user_id JOIN events e ON e.id = r.event_id
     WHERE ${OPEN_SQL}`
  );
  const names = new Map();
  const registrations = rows.map((r) => {
    const name = displayName({ firstName: r.first_name, lastName: r.last_name, nickname: r.nickname });
    names.set(`${r.event_id}:${r.user_id}`, { name, amountDueCents: r.amount_due_cents });
    return {
      eventId: r.event_id, userId: r.user_id, name, amountDueCents: r.amount_due_cents,
      reference: buildPaymentReference(r.event_id, r.user_id, { code: r.code, eventName: r.event_name, role: r.con_role, firstName: r.first_name, lastName: r.last_name, template }),
    };
  });
  const { rows: groups } = await query(
    `SELECT g.id, g.event_id, g.reference, g.user_ids FROM group_payments g JOIN events e ON e.id = g.event_id
     WHERE g.kind = 'bank' AND g.reference IS NOT NULL AND e.payments_open`
  );
  const groupPayments = groups.map((g) => {
    const open = g.user_ids.map((u) => ({ userId: u, ...names.get(`${g.event_id}:${u}`) })).filter((p) => p.name);
    return { id: g.id, eventId: g.event_id, reference: g.reference, userIds: open.map((p) => p.userId), names: open.map((p) => p.name), amountCents: open.reduce((s, p) => s + p.amountDueCents, 0) };
  });
  return { registrations, groupPayments };
}

router.post('/admin/bank-reconcile/preview', requireAuth(requireMenu('checkin')(async ({ req }) => {
  const body = await readJsonBody(req, MAX_BODY_BYTES);
  if (body === null || typeof body.content !== 'string') return { status: 400, body: { error: 'content must be the statement as text' } };
  let entries;
  try {
    entries = parseStatement(body.content);
  } catch (err) {
    return { status: 400, body: { error: err.message } };
  }
  const results = matchEntries(entries, await loadOpen());
  return { status: 200, body: { entries: results, summary: summarize(results) } };
})));

router.post('/admin/bank-reconcile/book', requireAuth(requireMenu('checkin')(async ({ req, user }) => {
  const body = await readJsonBody(req, MAX_BODY_BYTES);
  const items = body?.items;
  if (!Array.isArray(items) || items.length > MAX_ITEMS || items.some((i) => !i
    || typeof i.eventId !== 'string' || !UUID.test(i.eventId) || !Number.isInteger(i.amountCents)
    || !Array.isArray(i.userIds) || i.userIds.length === 0 || i.userIds.length > 100
    || i.userIds.some((u) => typeof u !== 'string' || !UUID.test(u)))) {
    return { status: 400, body: { error: `items must be a list of up to ${MAX_ITEMS} { eventId, userIds, amountCents }` } };
  }
  let booked = 0;
  const skipped = [];
  for (const item of items) {
    const userIds = [...new Set(item.userIds)];
    const { rows } = await query(
      `SELECT r.user_id, (${OPEN_SQL}) AS open, r.paid_at IS NOT NULL AS paid, r.amount_due_cents, u.first_name, u.last_name, u.nickname
       FROM registrations r JOIN events e ON e.id = r.event_id JOIN users u ON u.id = r.user_id WHERE r.event_id = $1 AND r.user_id = ANY($2)`,
      [item.eventId, userIds]
    );
    const byUser = new Map(rows.map((r) => [r.user_id, r]));
    const names = new Map(rows.map((r) => [r.user_id, displayName({ firstName: r.first_name, lastName: r.last_name, nickname: r.nickname })]));
    const skip = (userId, reason) => {
      const name = names.get(userId);
      skipped.push({ eventId: item.eventId, userId, reason, ...(name ? { name } : {}) });
    };
    const open = [];
    let blocked = false;
    for (const userId of userIds) {
      const r = byUser.get(userId);
      if (!r) { skip(userId, 'not_found'); blocked = true; }
      else if (r.paid) skip(userId, 'already_paid');
      else if (!r.open) { skip(userId, 'not_payable'); blocked = true; }
      else open.push(r);
    }
    if (open.length === 0) continue;
    if (blocked) {
      open.forEach((r) => skip(r.user_id, 'not_payable'));
      continue;
    }
    if (open.reduce((s, r) => s + r.amount_due_cents, 0) !== item.amountCents) {
      open.forEach((r) => skip(r.user_id, 'amount_mismatch'));
      continue;
    }
    for (const r of open) {
      try {
        await markPaidManually(item.eventId, r.user_id, user.id);
        booked++;
      } catch {
        skip(r.user_id, 'error');
      }
    }
  }
  return { status: 200, body: { booked, skipped } };
})));

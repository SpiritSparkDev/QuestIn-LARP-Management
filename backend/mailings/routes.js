import { router } from '../routes.js';
import { requireAuth } from '../middleware/authenticate.js';
import { requireMenu } from '../middleware/authorize.js';
import { readJsonBody } from '../httpBody.js';
import { getEvent } from '../events/repository.js';
import { logAudit } from '../audit/repository.js';
import {
  MAILING_STATUSES, MAILING_ROLES, MAX_RECIPIENTS, cleanMailHtml, htmlToText, resolveRecipients,
  countRegistrationsWithoutEmail, createMailing, listMailings, startSending,
} from './repository.js';

const PAYMENTS = ['any', 'paid', 'unpaid'];

function parseFilter(filter = {}) {
  const pick = (list, allowed) => (Array.isArray(list) ? list.filter((v) => allowed.includes(v)) : []);
  return {
    statuses: pick(filter.statuses, MAILING_STATUSES),
    conRoles: pick(filter.conRoles, MAILING_ROLES),
    payment: PAYMENTS.includes(filter.payment) ? filter.payment : 'any',
    guestsOnly: filter.guestsOnly === true,
  };
}

const withEvent = (handler) => async (ctx) => {
  const event = await getEvent(ctx.params.id);
  return event ? handler({ ...ctx, event }) : { status: 404, body: { error: 'event not found' } };
};

router.post('/events/:id/mailing/preview', requireAuth(requireMenu('events')(withEvent(async ({ req, event }) => {
  const body = await readJsonBody(req);
  if (body === null) return { status: 400, body: { error: 'invalid JSON' } };
  const r = await resolveRecipients(event.id, { includeRegistered: body.includeRegistered === true, filter: parseFilter(body.filter), manualEmails: body.manualEmails });
  return {
    status: 200,
    body: {
      registered: r.registered.length, manual: r.manual.length, invalid: r.invalid, total: r.all.length,
      withoutEmail: await countRegistrationsWithoutEmail(event.id), max: MAX_RECIPIENTS,
    },
  };
}))));

router.post('/events/:id/mailing', requireAuth(requireMenu('events')(withEvent(async ({ req, user, event }) => {
  const body = await readJsonBody(req);
  if (body === null) return { status: 400, body: { error: 'invalid JSON' } };
  const subject = typeof body.subject === 'string' ? body.subject.trim() : '';
  if (!subject || subject.length > 200) return { status: 400, body: { error: 'Bitte gib einen Betreff an (max. 200 Zeichen).' } };
  const bodyHtml = cleanMailHtml(typeof body.bodyHtml === 'string' ? body.bodyHtml : '');
  if (!htmlToText(bodyHtml) && !/<img\b/i.test(bodyHtml)) return { status: 400, body: { error: 'Bitte schreibe einen Nachrichtentext.' } };
  if (bodyHtml.length > 500_000) return { status: 400, body: { error: 'Die Nachricht ist zu groß.' } };

  const filter = parseFilter(body.filter);
  const testOnly = body.testOnly === true;
  let recipients;
  if (testOnly) {
    recipients = [user.email];
  } else {
    const r = await resolveRecipients(event.id, { includeRegistered: body.includeRegistered === true, filter, manualEmails: body.manualEmails });
    if (r.invalid.length > 0) return { status: 400, body: { error: `Ungültige E-Mail-Adressen: ${r.invalid.slice(0, 5).join(', ')}` } };
    recipients = r.all;
  }
  if (recipients.length === 0) return { status: 400, body: { error: 'Es gibt keine Empfänger.' } };
  if (recipients.length > MAX_RECIPIENTS) return { status: 400, body: { error: `Maximal ${MAX_RECIPIENTS} Empfänger pro Rundmail.` } };

  const id = await createMailing({ eventId: event.id, sentBy: user.id, subject, bodyHtml, recipients, filter: { ...filter, includeRegistered: body.includeRegistered === true }, testOnly });
  await logAudit({ actorId: user.id, action: 'event.mailing', details: { eventId: event.id, mailingId: id, subject, recipients: recipients.length, testOnly } });
  startSending(id, { recipients, subject, bodyHtml });
  return { status: 202, body: { id, total: recipients.length } };
}))));

router.get('/events/:id/mailings', requireAuth(requireMenu('events')(withEvent(async ({ event }) => (
  { status: 200, body: await listMailings(event.id) }
)))));

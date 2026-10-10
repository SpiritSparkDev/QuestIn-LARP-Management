import { logger } from '../logger.js';
import { getSlotAssignment, getEmailTemplate } from './repository.js';
import { buildMergeContext } from './mergeFields.js';
import { renderEmailTemplate } from './render.js';

// Renders a system email for `slot`, using the admin-assigned template if
// one is set, otherwise `fallback()` (today's hardcoded German text) --
// matches the existing getTransporterAndFrom/baseUrl convention in
// backend/auth/mailer.js of skipping any DB access entirely when
// DATABASE_URL isn't set (the mailer unit tests rely on this).
//
// `userId`, if given, pulls that member's OT fields (and, with
// `characterId`, one of their IT fields) into the template as
// {{account.*}}/{{character.*}}. `account`, given instead, is a plain
// object (e.g. an not-yet-redeemed invitation's own fields) used as-is --
// for recipients that aren't a real `users` row yet. `extra` fields are
// merged at the top level of the context (e.g. {{link}}), per-slot, see
// backend/emailTemplates/slots.js.
export async function renderSlotEmail(slot, fallback, { userId, characterId, account, extra = {} } = {}) {
  if (process.env.DATABASE_URL) {
    try {
      const templateId = await getSlotAssignment(slot);
      if (templateId) {
        const template = await getEmailTemplate(templateId);
        // A template written for another slot would carry that slot's
        // wording around this slot's link -- send the default text instead.
        if (template && template.slot !== slot) {
          logger.warn('assigned email template belongs to another slot, using default text', { slot, templateId, templateSlot: template.slot });
        } else if (template) {
          const base = userId
            ? await buildMergeContext(userId, { characterId })
            : { account: account ?? {}, character: {} };
          const context = { ...base, ...extra };
          const rendered = renderEmailTemplate(template, context);
          return { subject: rendered.subject, body: rendered.body, isHtml: template.isHtml, slot, userId: userId ?? null };
        }
      }
    } catch (err) {
      logger.error('failed to render assigned email template, falling back to default text', { slot, error: err.message });
    }
  }
  return { ...fallback(), isHtml: false, slot, userId: userId ?? null };
}

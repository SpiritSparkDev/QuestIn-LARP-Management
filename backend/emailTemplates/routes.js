import { router } from '../routes.js';
import { requireAuth } from '../middleware/authenticate.js';
import { requireAdminGroup } from '../middleware/authorize.js';
import { readJsonBody } from '../httpBody.js';
import {
  listEmailTemplates, getEmailTemplate, createEmailTemplate, updateEmailTemplate, deleteEmailTemplate,
  listSlotAssignments, setSlotAssignment,
} from './repository.js';
import { listAvailableMergeFields, buildMergeContext } from './mergeFields.js';
import { renderEmailTemplate } from './render.js';
import { EMAIL_SLOTS, EMAIL_SLOT_CATEGORIES, getEmailSlot, missingRequiredFields, exampleExtraFields } from './slots.js';
import { listCharactersForUser } from '../characters/repository.js';
import { getTransporterAndFrom, baseUrl } from '../auth/mailer.js';
import { logger } from '../logger.js';

const MAX_NAME_LENGTH = 200;
const MAX_SUBJECT_LENGTH = 500;
const MAX_BODY_LENGTH = 50000;

function validateTemplateInput(body) {
  const { name, subject, body: content, isHtml, slot } = body;
  if (typeof name !== 'string' || name.trim().length === 0) return 'name ist erforderlich';
  const slotDef = typeof slot === 'string' ? getEmailSlot(slot) : null;
  if (!slotDef) return 'Bitte die Art der E-Mail wählen (slot)';
  if (name.length > MAX_NAME_LENGTH) return `name darf höchstens ${MAX_NAME_LENGTH} Zeichen lang sein`;
  if (subject !== undefined && typeof subject !== 'string') return 'subject muss Text sein';
  if ((subject ?? '').length > MAX_SUBJECT_LENGTH) return `subject darf höchstens ${MAX_SUBJECT_LENGTH} Zeichen lang sein`;
  if (content !== undefined && typeof content !== 'string') return 'body muss Text sein';
  if ((content ?? '').length > MAX_BODY_LENGTH) return `body darf höchstens ${MAX_BODY_LENGTH} Zeichen lang sein`;
  if (isHtml !== undefined && typeof isHtml !== 'boolean') return 'isHtml muss ein Wahrheitswert sein';
  const missing = missingRequiredFields(slot, content);
  if (missing.length > 0) {
    return `Für „${slotDef.label}“ muss der Inhalt ${missing.map((f) => `{{${f.key}}} (${f.label})`).join(' und ')} enthalten`;
  }
  return null;
}

router.get('/admin/email-templates', requireAuth(requireAdminGroup(async () => {
  const templates = await listEmailTemplates();
  return { status: 200, body: templates };
})));

router.get('/admin/email-templates/fields', requireAuth(requireAdminGroup(async () => {
  const fields = await listAvailableMergeFields();
  return { status: 200, body: fields };
})));

// Lists every system-email "slot" (see backend/emailTemplates/slots.js)
// together with its current template assignment, if any -- the UI uses
// this to render one row per slot with a template picker.
router.get('/admin/email-templates/slots', requireAuth(requireAdminGroup(async () => {
  const assignments = await listSlotAssignments();
  const slots = EMAIL_SLOTS.map((slot) => ({ ...slot, templateId: assignments[slot.key] ?? null }));
  return { status: 200, body: { categories: EMAIL_SLOT_CATEGORIES, slots } };
})));

router.put('/admin/email-templates/slots/:slot', requireAuth(requireAdminGroup(async ({ req, params }) => {
  const slotDef = getEmailSlot(params.slot);
  if (!slotDef) return { status: 404, body: { error: 'unknown slot' } };
  const body = await readJsonBody(req);
  if (body === null) return { status: 400, body: { error: 'invalid JSON' } };
  const { templateId } = body;
  if (templateId !== null && templateId !== undefined) {
    const template = await getEmailTemplate(templateId);
    if (!template) return { status: 400, body: { error: 'template not found' } };
    if (template.slot !== params.slot) {
      const own = getEmailSlot(template.slot);
      return {
        status: 400,
        body: { error: own
          ? `Die Vorlage „${template.name}“ ist für „${own.label}“ geschrieben, nicht für „${slotDef.label}“.`
          : `Der Vorlage „${template.name}“ ist noch keine Art der E-Mail zugeordnet.` },
      };
    }
  }
  const saved = await setSlotAssignment(params.slot, templateId ?? null);
  return { status: 200, body: saved };
})));

router.get('/admin/email-templates/members/:userId/characters', requireAuth(requireAdminGroup(async ({ params }) => {
  const characters = await listCharactersForUser(params.userId);
  return { status: 200, body: characters.map((c) => ({ id: c.id, name: c.name })) };
})));

router.get('/admin/email-templates/:id', requireAuth(requireAdminGroup(async ({ params }) => {
  const template = await getEmailTemplate(params.id);
  if (!template) return { status: 404, body: { error: 'template not found' } };
  return { status: 200, body: template };
})));

router.post('/admin/email-templates', requireAuth(requireAdminGroup(async ({ req }) => {
  const body = await readJsonBody(req);
  if (body === null) return { status: 400, body: { error: 'invalid JSON' } };
  const error = validateTemplateInput(body);
  if (error) return { status: 400, body: { error } };
  const template = await createEmailTemplate(body);
  return { status: 201, body: template };
})));

router.put('/admin/email-templates/:id', requireAuth(requireAdminGroup(async ({ req, params }) => {
  const body = await readJsonBody(req);
  if (body === null) return { status: 400, body: { error: 'invalid JSON' } };
  const error = validateTemplateInput(body);
  if (error) return { status: 400, body: { error } };
  const template = await updateEmailTemplate(params.id, body);
  if (!template) return { status: 404, body: { error: 'template not found' } };
  return { status: 200, body: template };
})));

router.delete('/admin/email-templates/:id', requireAuth(requireAdminGroup(async ({ params }) => {
  const deleted = await deleteEmailTemplate(params.id);
  if (!deleted) return { status: 404, body: { error: 'template not found' } };
  return { status: 200, body: { deleted: true } };
})));

// The member's real OT/IT fields plus example values for the template's
// slot-specific placeholders, so {{link}} shows which kind of link (and
// which page) the real mail will carry instead of rendering empty.
async function previewContext(template, userId, characterId) {
  const context = await buildMergeContext(userId, { characterId });
  return { ...context, ...exampleExtraFields(template.slot, await baseUrl()) };
}

// Renders a template against a real member's (and optionally one of their
// characters') data without sending anything -- lets an admin check the
// merge before spending a real test send.
router.post('/admin/email-templates/:id/preview', requireAuth(requireAdminGroup(async ({ req, params }) => {
  const template = await getEmailTemplate(params.id);
  if (!template) return { status: 404, body: { error: 'template not found' } };
  const body = await readJsonBody(req);
  if (body === null) return { status: 400, body: { error: 'invalid JSON' } };
  const { userId, characterId } = body;
  if (!userId) return { status: 400, body: { error: 'userId is required' } };

  try {
    const context = await previewContext(template, userId, characterId);
    const rendered = renderEmailTemplate(template, context);
    return { status: 200, body: { ...rendered, isHtml: template.isHtml } };
  } catch (err) {
    if (err.code === 'MEMBER_NOT_FOUND') return { status: 404, body: { error: 'member not found' } };
    if (err.code === 'CHARACTER_NOT_FOUND') return { status: 400, body: { error: 'character does not belong to this member' } };
    if (err.code === 'INVALID_TEMPLATE') return { status: 400, body: { error: err.message } };
    throw err;
  }
})));

router.post('/admin/email-templates/:id/send-test', requireAuth(requireAdminGroup(async ({ req, params }) => {
  const template = await getEmailTemplate(params.id);
  if (!template) return { status: 404, body: { error: 'template not found' } };
  const body = await readJsonBody(req);
  if (body === null) return { status: 400, body: { error: 'invalid JSON' } };
  const { userId, characterId } = body;
  if (!userId) return { status: 400, body: { error: 'userId is required' } };

  let context;
  try {
    context = await previewContext(template, userId, characterId);
  } catch (err) {
    if (err.code === 'MEMBER_NOT_FOUND') return { status: 404, body: { error: 'member not found' } };
    if (err.code === 'CHARACTER_NOT_FOUND') return { status: 400, body: { error: 'character does not belong to this member' } };
    throw err;
  }

  let rendered;
  try {
    rendered = renderEmailTemplate(template, context);
  } catch (err) {
    if (err.code === 'INVALID_TEMPLATE') return { status: 400, body: { error: err.message } };
    throw err;
  }

  const { transporter, from } = await getTransporterAndFrom();
  try {
    await transporter.sendMail({
      to: context.account.email,
      from,
      subject: `[Test] ${rendered.subject}`,
      ...(template.isHtml ? { html: rendered.body } : { text: rendered.body }),
    });
  } catch (err) {
    logger.error('failed to send test email', { templateId: params.id, userId, error: err.message });
    return { status: 502, body: { error: `Versand fehlgeschlagen: ${err.message}` } };
  }

  return { status: 200, body: { sent: true, to: context.account.email, ...rendered } };
})));

import { router } from '../routes.js';
import { requireAuth } from '../middleware/authenticate.js';
import { requireAdminGroup } from '../middleware/authorize.js';
import { readJsonBody } from '../httpBody.js';
import {
  listEmailTemplates, getEmailTemplate, createEmailTemplate, updateEmailTemplate, deleteEmailTemplate,
} from './repository.js';
import { listAvailableMergeFields, buildMergeContext } from './mergeFields.js';
import { renderEmailTemplate } from './render.js';
import { listCharactersForUser } from '../characters/repository.js';
import { getTransporterAndFrom } from '../auth/mailer.js';
import { logger } from '../logger.js';

const MAX_NAME_LENGTH = 200;
const MAX_SUBJECT_LENGTH = 500;
const MAX_BODY_LENGTH = 50000;

function validateTemplateInput(body) {
  const { name, subject, body: content, isHtml } = body;
  if (typeof name !== 'string' || name.trim().length === 0) return 'name ist erforderlich';
  if (name.length > MAX_NAME_LENGTH) return `name darf höchstens ${MAX_NAME_LENGTH} Zeichen lang sein`;
  if (subject !== undefined && typeof subject !== 'string') return 'subject muss Text sein';
  if ((subject ?? '').length > MAX_SUBJECT_LENGTH) return `subject darf höchstens ${MAX_SUBJECT_LENGTH} Zeichen lang sein`;
  if (content !== undefined && typeof content !== 'string') return 'body muss Text sein';
  if ((content ?? '').length > MAX_BODY_LENGTH) return `body darf höchstens ${MAX_BODY_LENGTH} Zeichen lang sein`;
  if (isHtml !== undefined && typeof isHtml !== 'boolean') return 'isHtml muss ein Wahrheitswert sein';
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
    const context = await buildMergeContext(userId, { characterId });
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
    context = await buildMergeContext(userId, { characterId });
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

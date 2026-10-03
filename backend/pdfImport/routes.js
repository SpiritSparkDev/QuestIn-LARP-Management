import { router } from '../routes.js';
import { requireAuth } from '../middleware/authenticate.js';
import { requireAdminGroup } from '../middleware/authorize.js';
import { readJsonBody } from '../httpBody.js';
import { logger } from '../logger.js';
import { getAppSettings } from '../appSettings/repository.js';
import { getAccountFieldSchema } from '../accountFieldSchema/repository.js';
import { getRegistrationFieldSchema } from '../registrationFieldSchema/repository.js';
import { getScCharacterSchema } from '../scSchema/repository.js';
import { getTransporterAndFrom, sendPdfImportReceivedEmail } from '../auth/mailer.js';
import { readPdfFields, applyMapping } from './pdfFields.js';
import {
  getPdfImportConfig, setPdfTemplate, setPdfImportConfig,
  createPdfImport, listPdfImports, getPdfImport, deletePdfImport, markPdfImportEmail, markPdfImportAdopted,
} from './repository.js';
import { adoptImport } from './adopt.js';
import { getEvent } from '../events/repository.js';

const MAX_PDF_BYTES = 10 * 1024 * 1024;
const MAX_UPLOAD_BODY_BYTES = 15 * 1024 * 1024;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// All app fields a PDF field can be assigned to, grouped for the admin UI.
async function buildTargets() {
  const [accountSchema, registrationSchema, scSchema] = await Promise.all([
    getAccountFieldSchema(), getRegistrationFieldSchema(), getScCharacterSchema(),
  ]);
  const label = (f) => f.label ?? f.key;
  return [
    { value: 'sender:email', label: 'E-Mail des Einsenders', group: 'Einsender' },
    { value: 'account:firstName', label: 'Vorname', group: 'Person (OT)' },
    { value: 'account:lastName', label: 'Nachname', group: 'Person (OT)' },
    { value: 'account:nickname', label: 'Rufname', group: 'Person (OT)' },
    ...accountSchema.map((f) => ({ value: `account:${f.key}`, label: label(f), group: 'Person (OT)' })),
    ...registrationSchema.map((f) => ({ value: `registration:${f.key}`, label: label(f), group: 'Anmeldung (OT)' })),
    { value: 'meta:conRole', label: 'Rolle (Spieler / NSC / Helfer)', group: 'Anmeldung (OT)' },
    { value: 'meta:priceGroup', label: 'Teilnahmegruppe', group: 'Anmeldung (OT)' },
    { value: 'meta:flags', label: 'Sonderrollen (Komma-getrennt)', group: 'Anmeldung (OT)' },
    { value: 'meta:waiver', label: 'Einverständnis akzeptiert', group: 'Anmeldung (OT)' },
    { value: 'character:name', label: 'Charaktername', group: 'Charakter (IT)' },
    ...scSchema.map((f) => ({ value: `character:${f.key}`, label: label(f), group: 'Charakter (IT)' })),
  ];
}

// The add-on is opt-in: every route 404s while it's switched off, so a
// disabled add-on exposes nothing even to an admin who knows the URLs.
function requireAddon(handler) {
  return requireAuth(requireAdminGroup(async (ctx) => {
    const settings = await getAppSettings();
    if (!settings.pdfImportEnabled) return { status: 404, body: { error: 'PDF-Import ist nicht aktiviert.' } };
    return handler(ctx);
  }));
}

function decodePdf(body) {
  const { filename, dataBase64 } = body;
  if (typeof filename !== 'string' || !filename) return { error: { status: 400, body: { error: 'filename is required' } } };
  // Buffer.from ignores the encoding for non-strings and would allocate
  // an array-like's length -- only accept real strings.
  if (typeof dataBase64 !== 'string') return { error: { status: 400, body: { error: 'dataBase64 must be a base64 string' } } };
  const buffer = Buffer.from(dataBase64, 'base64');
  if (buffer.length === 0) return { error: { status: 400, body: { error: 'dataBase64 is required' } } };
  if (buffer.length > MAX_PDF_BYTES) {
    return { error: { status: 413, body: { error: `PDF exceeds the ${MAX_PDF_BYTES / (1024 * 1024)}MB limit` } } };
  }
  return { filename, buffer };
}

function senderName(mapped) {
  return [mapped.account?.firstName, mapped.account?.lastName].filter(Boolean).join(' ');
}

// Tries to turn an import into a registered guest account; the outcome (or
// the reason it failed) is stored on the import so it shows in the list.
async function tryAdopt(record, eventId, user) {
  try {
    const { userId } = await adoptImport(record.mapped, { eventId, actingUser: user });
    await markPdfImportAdopted(record.id, { userId, eventId });
    return { adopted: true };
  } catch (err) {
    const known = ['EMAIL_HAS_ACCOUNT', 'INVALID_EMAIL', 'NAME_MISSING', 'EVENT_NOT_FOUND', 'ALREADY_REGISTERED', 'WAIVER_NOT_ACCEPTED', 'INVALID_CHARACTER_DATA', 'INVALID_PRICE_GROUP', 'EVENT_NOT_ACTIVE'];
    if (!known.includes(err.code)) {
      logger.error('pdf import: adoption failed', { error: err.message });
    }
    await markPdfImportAdopted(record.id, { eventId, error: known.includes(err.code) ? err.message : 'Unerwarteter Fehler beim Anlegen des Gast-Kontos.' });
    return { adopted: false, reason: err.message };
  }
}

async function sendReceipt(record) {
  const to = record.mapped.sender?.email;
  if (!to || !EMAIL_RE.test(to)) return { sent: false, reason: 'Keine gültige E-Mail-Adresse im PDF.' };
  try {
    const transport = await getTransporterAndFrom();
    await sendPdfImportReceivedEmail(to, { name: senderName(record.mapped) || to }, transport);
    await markPdfImportEmail(record.id);
    return { sent: true };
  } catch (err) {
    logger.error('pdf import: failed to send receipt email', { error: err.message });
    await markPdfImportEmail(record.id, { error: err.message });
    return { sent: false, reason: err.message };
  }
}

router.get('/pdf-import/config', requireAddon(async () => {
  return { status: 200, body: { config: await getPdfImportConfig(), targets: await buildTargets() } };
}));

router.post('/pdf-import/template', requireAddon(async ({ req }) => {
  const body = await readJsonBody(req, MAX_UPLOAD_BODY_BYTES);
  if (body === null) return { status: 400, body: { error: 'invalid JSON' } };
  const decoded = decodePdf(body);
  if (decoded.error) return decoded.error;
  try {
    const fields = await readPdfFields(decoded.buffer);
    const config = await setPdfTemplate({ filename: decoded.filename, pdfFields: fields });
    return { status: 200, body: { config, targets: await buildTargets() } };
  } catch (err) {
    if (err.code === 'INVALID_PDF') return { status: 400, body: { error: err.message } };
    throw err;
  }
}));

router.put('/pdf-import/config', requireAddon(async ({ req }) => {
  const body = await readJsonBody(req);
  if (body === null) return { status: 400, body: { error: 'invalid JSON' } };
  const { mapping, emailEnabled } = body;
  if (emailEnabled !== undefined && typeof emailEnabled !== 'boolean') {
    return { status: 400, body: { error: 'emailEnabled must be a boolean' } };
  }
  if (mapping !== undefined) {
    if (typeof mapping !== 'object' || mapping === null || Array.isArray(mapping)) {
      return { status: 400, body: { error: 'mapping must be an object' } };
    }
    const config = await getPdfImportConfig();
    const fieldNames = new Set(config.pdfFields.map((f) => f.name));
    const targets = new Set((await buildTargets()).map((t) => t.value));
    for (const [name, rule] of Object.entries(mapping)) {
      if (!fieldNames.has(name)) return { status: 400, body: { error: `Unbekanntes PDF-Feld: ${name}` } };
      if (typeof rule !== 'object' || rule === null || !targets.has(rule.target)) {
        return { status: 400, body: { error: `Ungültiges Ziel für ${name}` } };
      }
      if (rule.optionLabels !== undefined
        && (typeof rule.optionLabels !== 'object' || rule.optionLabels === null
          || Object.values(rule.optionLabels).some((v) => typeof v !== 'string'))) {
        return { status: 400, body: { error: `optionLabels für ${name} muss ein Objekt aus Texten sein` } };
      }
    }
  }
  const saved = await setPdfImportConfig({ mapping, emailEnabled });
  return { status: 200, body: { config: saved } };
}));

router.post('/pdf-import/submissions', requireAddon(async ({ req, user }) => {
  const body = await readJsonBody(req, MAX_UPLOAD_BODY_BYTES);
  if (body === null) return { status: 400, body: { error: 'invalid JSON' } };
  const decoded = decodePdf(body);
  if (decoded.error) return decoded.error;

  const config = await getPdfImportConfig();
  if (Object.keys(config.mapping).length === 0) {
    return { status: 409, body: { error: 'Es wurde noch keine Feldzuordnung gespeichert.' } };
  }
  let fields;
  try {
    fields = await readPdfFields(decoded.buffer);
  } catch (err) {
    if (err.code === 'INVALID_PDF') return { status: 400, body: { error: err.message } };
    throw err;
  }
  const { raw, mapped } = applyMapping(fields, config.mapping);
  const record = await createPdfImport({ createdBy: user.id, sourceFilename: decoded.filename, raw, mapped });

  let adoption = { adopted: false, reason: null };
  if (typeof body.eventId === 'string' && body.eventId) {
    if (!(await getEvent(body.eventId))) return { status: 404, body: { error: 'event not found' } };
    adoption = await tryAdopt(record, body.eventId, user);
  }
  let email = { sent: false, reason: null };
  if (body.sendEmail === true && config.emailEnabled) email = await sendReceipt(record);
  return { status: 201, body: { import: await getPdfImport(record.id), email, adoption } };
}));

router.get('/pdf-import/submissions', requireAddon(async () => {
  return { status: 200, body: await listPdfImports() };
}));

router.get('/pdf-import/submissions/:id', requireAddon(async ({ params }) => {
  const record = await getPdfImport(params.id);
  if (!record) return { status: 404, body: { error: 'import not found' } };
  return { status: 200, body: record };
}));

router.post('/pdf-import/submissions/:id/adopt', requireAddon(async ({ req, params, user }) => {
  const body = (await readJsonBody(req)) ?? {};
  const record = await getPdfImport(params.id);
  if (!record) return { status: 404, body: { error: 'import not found' } };
  if (record.adoptedAt) return { status: 409, body: { error: 'Dieser Import wurde bereits als Gast-Konto übernommen.' } };
  if (typeof body.eventId !== 'string' || !(await getEvent(body.eventId))) {
    return { status: 400, body: { error: 'eventId must be an existing event' } };
  }
  const adoption = await tryAdopt(record, body.eventId, user);
  return adoption.adopted
    ? { status: 200, body: { import: await getPdfImport(params.id) } }
    : { status: 400, body: { error: adoption.reason } };
}));

router.post('/pdf-import/submissions/:id/send-email', requireAddon(async ({ params }) => {
  const record = await getPdfImport(params.id);
  if (!record) return { status: 404, body: { error: 'import not found' } };
  const email = await sendReceipt(record);
  return { status: email.sent ? 200 : 400, body: email.sent ? { sent: true } : { error: email.reason } };
}));

router.delete('/pdf-import/submissions/:id', requireAddon(async ({ params }) => {
  const deleted = await deletePdfImport(params.id);
  if (!deleted) return { status: 404, body: { error: 'import not found' } };
  return { status: 200, body: { deleted: true } };
}));

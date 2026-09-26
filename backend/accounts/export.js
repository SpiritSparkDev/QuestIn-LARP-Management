// GDPR/DSGVO self-service data export (Art. 15 DSGVO): every logged-in
// member can download everything the system holds about them. Two separate
// downloads -- a human-readable text dump of all database data, and (only
// if the member has uploaded files) a ZIP of the actual file bytes -- per
// the user's explicit request, not a single combined bundle.
import { ZipArchive } from 'archiver';
import { router } from '../routes.js';
import { requireAuth } from '../middleware/authenticate.js';
import { query } from '../db.js';
import { getAccount } from './repository.js';
import { listCharactersForUser } from '../characters/repository.js';
import { listRegistrationsForUser } from '../registrations/repository.js';
import { listCharacterFiles } from '../characterFiles/repository.js';
import { getAccountFieldSchema } from '../accountFieldSchema/repository.js';
import { getRegistrationFieldSchema } from '../registrationFieldSchema/repository.js';
import { getScCharacterSchema } from '../scSchema/repository.js';
import { getNscProfileSchema } from '../nscSchema/repository.js';
import { getStorageSettingsForUse } from '../storageSettings/repository.js';
import { getStorage } from '../storage/index.js';
import { logger } from '../logger.js';

function formatCents(cents) {
  return `${(cents / 100).toFixed(2).replace('.', ',')} €`;
}

function formatValue(value) {
  if (value === null || value === undefined || value === '') return '–';
  if (Array.isArray(value)) return value.length > 0 ? value.join(', ') : '–';
  if (typeof value === 'boolean') return value ? 'Ja' : 'Nein';
  return String(value);
}

// Renders every field the schema knows about, in schema order, using each
// field's admin-defined label instead of its raw key -- mirrors how the
// frontend already presents these same OT/IT fields to the member.
function formatSchemaFields(schema, data) {
  return schema.map((field) => `  ${field.label ?? field.key}: ${formatValue(data[field.key])}`).join('\n');
}

async function buildExportText(userId) {
  const account = await getAccount(userId);
  const { rows: oauthRows } = await query('SELECT provider, username FROM oauth_accounts WHERE user_id = $1', [userId]);
  const accountSchema = await getAccountFieldSchema();
  const registrationSchema = await getRegistrationFieldSchema();
  const scSchema = await getScCharacterSchema();
  const nscSchema = await getNscProfileSchema();
  const characters = await listCharactersForUser(userId);
  const registrations = await listRegistrationsForUser(userId);
  const { rows: payments } = await query(
    `SELECT p.method, p.amount_cents, p.refund_amount_cents, p.refunded_at, p.created_at, e.name AS event_name
     FROM payments p JOIN events e ON e.id = p.event_id
     WHERE p.user_id = $1 ORDER BY p.created_at`,
    [userId]
  );
  const characterFiles = [];
  for (const character of characters) {
    const files = await listCharacterFiles(character.id);
    for (const file of files) characterFiles.push({ ...file, characterName: character.name });
  }

  const lines = [];
  lines.push(`Datenauskunft für ${account.name} (${account.email})`);
  lines.push(`Erstellt am: ${new Date().toLocaleString('de-DE')}`);
  lines.push('');

  lines.push('=== Konto ===');
  lines.push(`E-Mail: ${account.email}`);
  lines.push(`Vorname: ${formatValue(account.firstName)}`);
  lines.push(`Nachname: ${formatValue(account.lastName)}`);
  lines.push(`Rufname: ${formatValue(account.nickname)}`);
  lines.push(`Gruppe: ${account.group?.name ?? '–'}`);
  lines.push(`E-Mail bestätigt: ${formatValue(account.emailVerified)}`);
  lines.push(formatSchemaFields(accountSchema, account));
  if (oauthRows.length > 0) {
    lines.push('Verknüpfte Anmeldeanbieter:');
    for (const o of oauthRows) lines.push(`  ${o.provider}: ${o.username ?? '–'}`);
  }
  lines.push('');

  lines.push('=== Charaktere ===');
  if (characters.length === 0) lines.push('(keine)');
  for (const c of characters) {
    lines.push(`- ${c.name} (${c.class === 'nsc' ? 'NSC' : 'SC'})`);
    lines.push(formatSchemaFields(c.class === 'nsc' ? nscSchema : scSchema, c.data ?? {}));
  }
  lines.push('');

  lines.push('=== Anmeldungen ===');
  if (registrations.length === 0) lines.push('(keine)');
  for (const r of registrations) {
    lines.push(`- ${r.eventName} (${r.eventDate}): ${r.status}, Rolle: ${r.conRole}`);
    if (r.priceGroup) lines.push(`  Teilnahmegruppe: ${r.priceGroup}${r.priceTier ? ` (${r.priceTier})` : ''}`);
    if (r.amountDueCents != null) lines.push(`  Betrag: ${formatCents(r.amountDueCents)} — ${r.paidAt ? `bezahlt am ${new Date(r.paidAt).toLocaleString('de-DE')}` : 'offen'}`);
    lines.push(formatSchemaFields(registrationSchema, r));
  }
  lines.push('');

  lines.push('=== Zahlungen ===');
  if (payments.length === 0) lines.push('(keine)');
  for (const p of payments) {
    const refund = p.refunded_at ? `, davon ${formatCents(p.refund_amount_cents)} erstattet am ${new Date(p.refunded_at).toLocaleString('de-DE')}` : '';
    lines.push(`- ${p.event_name}: ${formatCents(p.amount_cents)} (${p.method}) am ${new Date(p.created_at).toLocaleString('de-DE')}${refund}`);
  }
  lines.push('');

  lines.push('=== Hochgeladene Dateien ===');
  if (characterFiles.length === 0) lines.push('(keine — siehe auch: kein ZIP-Download verfügbar)');
  for (const f of characterFiles) {
    lines.push(`- ${f.original_filename} (${f.characterName}, ${new Date(f.created_at).toLocaleString('de-DE')})`);
  }

  return lines.join('\n') + '\n';
}

router.get('/account/export', requireAuth(async ({ user }) => {
  const text = await buildExportText(user.id);
  const filename = `pakyrion-daten-${new Date().toISOString().slice(0, 10)}.txt`;
  return {
    status: 200,
    isBinary: true,
    body: Buffer.from(text, 'utf8'),
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Content-Disposition': `attachment; filename="${filename}"`,
    },
  };
}));

router.get('/account/export/files', requireAuth(async ({ user }) => {
  const characters = await listCharactersForUser(user.id);
  const filesByCharacter = [];
  for (const character of characters) {
    const files = await listCharacterFiles(character.id);
    if (files.length > 0) filesByCharacter.push({ character, files });
  }
  if (filesByCharacter.length === 0) {
    return { status: 404, body: { error: 'Keine Dateien vorhanden.' } };
  }

  const storageSettings = await getStorageSettingsForUse();
  const archive = new ZipArchive();
  const chunks = [];
  archive.on('data', (chunk) => chunks.push(chunk));
  const archiveFinished = new Promise((resolve, reject) => {
    archive.on('end', resolve);
    archive.on('error', reject);
  });

  for (const { character, files } of filesByCharacter) {
    for (const file of files) {
      const storage = getStorage(file.storage_backend, storageSettings);
      try {
        const data = await storage.download(file.id);
        archive.append(data, { name: `${character.name}/${file.original_filename}` });
      } catch (err) {
        // A single unreachable file (e.g. a since-misconfigured remote
        // backend) must not block the export of every other file -- skip
        // and log it instead of failing the whole ZIP.
        logger.error('failed to include file in GDPR export', { error: err.message, fileId: file.id, userId: user.id });
      }
    }
  }
  archive.finalize();
  await archiveFinished;

  const filename = `pakyrion-dateien-${new Date().toISOString().slice(0, 10)}.zip`;
  return {
    status: 200,
    isBinary: true,
    body: Buffer.concat(chunks),
    headers: {
      'Content-Type': 'application/zip',
      'Content-Disposition': `attachment; filename="${filename}"`,
    },
  };
}));

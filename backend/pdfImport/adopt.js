import { query } from '../db.js';
import { isValidEmail } from '../validation.js';
import { getAccountFieldSchema } from '../accountFieldSchema/repository.js';
import { encryptFieldBlob, decryptFieldBlob } from '../accountFields.js';
import { createCharacter } from '../characters/repository.js';
import { registerForEvent } from '../registrations/repository.js';
import { getEvent } from '../events/repository.js';

const GUEST_GROUP_KEY = 'mitglied';

// Turns the "Rolle" value from a PDF (admin-labelled, e.g. "Spieler"/"NSC")
// into a con_role. Anything unrecognised counts as a normal player.
export function conRoleFromValue(value) {
  const text = String(value ?? '').toLowerCase();
  if (text.includes('nsc')) return 'nsc';
  if (text.includes('helfer')) return 'helfer';
  return 'sc';
}

function adoptionError(message, code) {
  const err = new Error(message);
  err.code = code;
  return err;
}

// Finds or creates the guest account for an import. A guest has no
// password (it can never log in) and is identified by e-mail when the PDF
// has one; without an e-mail a fresh guest is created every time.
// Existing full accounts are never touched.
async function findOrCreateGuest(mapped) {
  const email = mapped.sender?.email?.trim().toLowerCase() || null;
  if (email && !isValidEmail(email)) {
    throw adoptionError('Die E-Mail-Adresse im PDF ist ungültig.', 'INVALID_EMAIL');
  }
  if (email) {
    const { rows } = await query('SELECT id, is_guest FROM users WHERE email = $1', [email]);
    if (rows.length > 0) {
      if (!rows[0].is_guest) {
        throw adoptionError('Diese E-Mail-Adresse gehört bereits zu einem Konto.', 'EMAIL_HAS_ACCOUNT');
      }
      return { userId: rows[0].id, created: false };
    }
  }
  const firstName = mapped.account?.firstName || '';
  const lastName = mapped.account?.lastName || '';
  if (!firstName && !lastName) {
    throw adoptionError('Im PDF wurden weder Vor- noch Nachname gefunden.', 'NAME_MISSING');
  }
  const { rows } = await query(
    `INSERT INTO users (email, group_id, first_name, last_name, nickname, is_guest, email_verified)
     VALUES ($1, (SELECT id FROM groups WHERE key = $2), $3, $4, $5, true, false)
     RETURNING id`,
    [email, GUEST_GROUP_KEY, firstName, lastName, mapped.account?.nickname ?? null]
  );
  return { userId: rows[0].id, created: true };
}

async function saveAccountFields(userId, mapped) {
  const schema = await getAccountFieldSchema();
  const { rows } = await query('SELECT account_data_enc FROM users WHERE id = $1', [userId]);
  const data = { ...decryptFieldBlob(rows[0]?.account_data_enc) };
  for (const field of schema) {
    if (mapped.account?.[field.key] !== undefined) data[field.key] = mapped.account[field.key];
  }
  await query('UPDATE users SET account_data_enc = $2 WHERE id = $1', [userId, encryptFieldBlob(data)]);
}

// Creates the character named in the PDF, if any. Returns its id or null.
// An NSC's character is only a placeholder (stub); for SC invalid data is surfaced.
async function createImportedCharacter(userId, conRole, mapped) {
  const { name, ...data } = mapped.character ?? {};
  if (!name || conRole === 'helfer') return null;
  try {
    const character = await createCharacter(userId, { name, data, stub: conRole === 'nsc' });
    return character.id;
  } catch (err) {
    if (err.code === 'INVALID_CHARACTER_DATA') {
      throw adoptionError(`Charakterdaten ungültig: ${err.details.join(', ')}`, 'INVALID_CHARACTER_DATA');
    }
    throw err;
  }
}

// Creates (or reuses) the guest account for a PDF import, stores the
// account/character data from the PDF and registers the guest for the event
// -- the same shape a guest-widget ticket produces, so the guest shows up in
// Mitglieder/Check-In and can later be converted to a full account.
// Without a character in the PDF a player becomes a plain "ticket" guest.
export async function adoptImport(mapped, { eventId, actingUser }) {
  const event = await getEvent(eventId);
  if (!event) throw adoptionError('Event nicht gefunden.', 'EVENT_NOT_FOUND');

  const { userId, created } = await findOrCreateGuest(mapped);
  let characterId = null;
  try {
    await saveAccountFields(userId, mapped);

    let conRole = conRoleFromValue(mapped.meta?.conRole);
    if (conRole === 'sc' && !mapped.character?.name) conRole = 'ticket';
    characterId = await createImportedCharacter(userId, conRole, mapped);

    const priceGroup = event.pricing?.groups?.includes(mapped.meta?.priceGroup) ? mapped.meta.priceGroup : undefined;
    const requestedFlags = typeof mapped.meta?.flags === 'string' ? mapped.meta.flags.split(',').map((f) => f.trim()) : [];
    const flags = (event.flags ?? []).filter((f) => requestedFlags.includes(f));
    try {
      await registerForEvent(
        userId, eventId, conRole, characterId, false, null, flags, priceGroup,
        mapped.registration ?? {}, actingUser, mapped.meta?.waiver === true, { pdfImport: true },
      );
    } catch (err) {
      if (err.code === 'ALREADY_REGISTERED') throw adoptionError('Diese Direktanmeldung ist für das Event bereits angemeldet.', 'ALREADY_REGISTERED');
      if (err.code === 'WAIVER_NOT_ACCEPTED') {
        throw adoptionError('Die Einverständniserklärung ist im PDF nicht bestätigt (Feld „Einverständnis akzeptiert“ zuordnen).', 'WAIVER_NOT_ACCEPTED');
      }
      throw err;
    }
  } catch (err) {
    // Undo what this attempt created so a retry doesn't leave duplicates:
    // the character, and the guest itself if this attempt created it.
    if (characterId) await query('DELETE FROM characters WHERE id = $1', [characterId]).catch(() => {});
    if (created) await query('DELETE FROM users WHERE id = $1', [userId]).catch(() => {});
    throw err;
  }
  return { userId };
}

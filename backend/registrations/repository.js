import crypto from 'node:crypto';
import { query, withTransaction } from '../db.js';
import { getEvent, resolvePriceForGroup } from '../events/repository.js';
import { applyTransition } from './statusMachine.js';
import { displayName } from '../displayName.js';
import { decryptFieldBlob as decryptAccountFieldBlob } from '../accountFields.js';
import { filterCharacterFields } from '../characters/visibility.js';
import { listOpenInvitationsForEvent } from '../invitations/repository.js';
import { getRegistrationFieldSchema } from '../registrationFieldSchema/repository.js';
import { encryptFieldBlob, decryptFieldBlob } from '../registrationFields.js';
import { sendRegistrationOtFieldsChangedEmail, sendRegistrationWithdrawnOrgaEmail, sendWaitlistedEmail, sendWaitlistPromotedEmail, getTransporterAndFrom } from '../auth/mailer.js';
import { logger } from '../logger.js';
import { getAppSettings } from '../appSettings/repository.js';
import { buildPaymentReference } from '../payments/reference.js';
import { sanitizeFieldValue, sanitizeDocumentFields } from '../richText.js';
import { validateCharacterData } from '../events/schemaValidation.js';
import { getNscProfileSchema } from '../nscSchema/repository.js';
import { updateCharacter } from '../characters/repository.js';
import { logAudit } from '../audit/repository.js';
import { COUNTED_STATUSES, loadCapacity, capacityBlock, withAdded, withRemoved, BLOCK_MESSAGES } from './capacity.js';

// 'ticket' = a self-service guest ticket bought via the external ticket
// widget (backend/guestRegistrations/routes.js) -- no character, distinct
// from 'helfer' (crew).
const SELF_SERVICE_CON_ROLES = ['sc', 'nsc', 'helfer', 'ticket'];
const STAFF_CON_ROLES = ['orga', 'hilfs_orga'];
const ALL_CON_ROLES = [...SELF_SERVICE_CON_ROLES, ...STAFF_CON_ROLES];
// Roles that don't play a character on-site, so approval doesn't require one assigned.
const CHARACTER_EXEMPT_CON_ROLES = [...STAFF_CON_ROLES, 'helfer', 'ticket'];
// A registration's character_id: 'sc' must have one, 'nsc' may optionally
// have one, every other role must not.
const CHARACTER_REQUIRED_CON_ROLES = ['sc'];
const CHARACTER_OPTIONAL_CON_ROLES = ['nsc'];

// Orga/Hilfs-Orga may only be granted by someone who is already orga/hilfs_orga
// for THIS SAME event, or who holds system role moderator/admin.
async function canGrantStaffConRole(eventId, requestingUser) {
  if (requestingUser.group.key === 'admin' || requestingUser.group.key === 'moderator') return true;
  const { rows } = await query(
    "SELECT 1 FROM registrations WHERE event_id = $1 AND user_id = $2 AND con_role IN ('orga', 'hilfs_orga')",
    [eventId, requestingUser.id]
  );
  return rows.length > 0;
}

// Validates characterId against con_role: 'sc' must have one that exists,
// belongs to userId; 'nsc' may optionally have one; every other
// con_role must NOT have one.
// For con_role 'sc', also enforces "at most one registration ever"
// (design spec 2026-09-16, section 4.3) -- excludes the caller's own
// (eventId, userId) row so re-saving an existing registration's con-role
// doesn't flag itself as a conflict. con_role 'nsc' stays exempt: the
// character remains reusable across many events.
// Returns the characterId to store (null when none applies).
async function resolveCharacterId(userId, conRole, characterId, eventId, { allowMissingSc = false } = {}) {
  const isRequired = CHARACTER_REQUIRED_CON_ROLES.includes(conRole) && !allowMissingSc;
  const isOptional = CHARACTER_OPTIONAL_CON_ROLES.includes(conRole);
  if (!isRequired && !isOptional && !(allowMissingSc && conRole === 'sc')) {
    if (characterId) {
      const err = new Error(`Für die Rolle "${conRole}" darf kein Charakter angegeben werden.`);
      err.code = 'CHARACTER_NOT_ALLOWED';
      throw err;
    }
    return null;
  }
  if (!characterId) {
    if (isRequired) {
      const err = new Error(`Für die Rolle "${conRole}" ist ein Charakter erforderlich.`);
      err.code = 'CHARACTER_REQUIRED';
      throw err;
    }
    return null;
  }
  const { rows } = await query('SELECT user_id FROM characters WHERE id = $1', [characterId]);
  if (rows.length === 0) {
    const err = new Error('character not found');
    err.code = 'CHARACTER_NOT_FOUND';
    throw err;
  }
  const character = rows[0];
  if (character.user_id !== userId) {
    const err = new Error('character does not belong to this user');
    err.code = 'CHARACTER_FORBIDDEN';
    throw err;
  }
  if (conRole === 'sc') {
    const { rows: existing } = await query(
      "SELECT 1 FROM registrations WHERE character_id = $1 AND con_role = 'sc' AND NOT (event_id = $2 AND user_id = $3)",
      [characterId, eventId, userId]
    );
    if (existing.length > 0) {
      const err = new Error('Dieser Charakter ist bereits für ein anderes Event angemeldet.');
      err.code = 'CHARACTER_ALREADY_REGISTERED';
      throw err;
    }
  }
  return characterId;
}

// NSC questionnaire values: only kept for con_role 'nsc' (else undefined = nothing to
// store). Sanitized + validated against the NSC schema like character data.
async function resolveNscData(conRole, nscData) {
  if (conRole !== 'nsc' || nscData === undefined || nscData === null) return undefined;
  const schema = await getNscProfileSchema();
  const data = sanitizeDocumentFields(schema, nscData);
  const errors = validateCharacterData(schema, data);
  if (errors.length > 0) {
    const err = new Error('invalid character data');
    err.code = 'INVALID_CHARACTER_DATA';
    err.details = errors;
    throw err;
  }
  return data;
}

// With a character the values live on the character (reusable at the next event);
// staffOnly fields are only writable by a different staff member (updateCharacter).
function writeNscDataToCharacter(characterId, ownerId, data, requestingUser) {
  return updateCharacter(characterId, ownerId, { data }, {
    nsc: true,
    isElevated: Boolean(requestingUser?.group?.canOverrideCheckinStatus) && requestingUser.id !== ownerId,
    actorId: requestingUser?.id ?? null,
  });
}

// Returns { nscAvailable, nscCharacterId } to store.
async function resolveNscAvailability(userId, conRole, nscAvailable, nscCharacterId, characterId) {
  const available = Boolean(nscAvailable);
  if (conRole !== 'sc') {
    if (available || nscCharacterId) {
      const err = new Error('nscAvailable/nscCharacterId sind nur zusammen mit con_role "sc" erlaubt.');
      err.code = 'INVALID_NSC_AVAILABILITY';
      throw err;
    }
    return { nscAvailable: false, nscCharacterId: null };
  }
  if (nscCharacterId && !available) {
    const err = new Error('nscCharacterId erfordert nscAvailable = true.');
    err.code = 'INVALID_NSC_AVAILABILITY';
    throw err;
  }
  if (!available) return { nscAvailable: false, nscCharacterId: null };
  if (!nscCharacterId) return { nscAvailable: true, nscCharacterId: null };

  const { rows } = await query('SELECT user_id FROM characters WHERE id = $1', [nscCharacterId]);
  if (rows.length === 0) {
    const err = new Error('character not found');
    err.code = 'CHARACTER_NOT_FOUND';
    throw err;
  }
  const character = rows[0];
  if (character.user_id !== userId) {
    const err = new Error('character does not belong to this user');
    err.code = 'CHARACTER_FORBIDDEN';
    throw err;
  }
  if (nscCharacterId === characterId) {
    const err = new Error('nscCharacterId darf nicht der Charakter der Anmeldung selbst sein.');
    err.code = 'INVALID_NSC_AVAILABILITY';
    throw err;
  }
  return { nscAvailable: true, nscCharacterId };
}

// Validates the requested flags against the event's defined vocabulary --
// role-independent (unlike resolveNscAvailability/the old resolveIsGsc, no
// con_role gate: a flag like "Ersthelfer" applies regardless of SC/NSC/etc).
// Returns the flags to store, deduplicated and normalized to eventFlags'
// order (so display is consistent regardless of the order they were sent in).
function resolveFlags(eventFlags, flags) {
  const requested = Array.isArray(flags) ? flags : [];
  const invalid = requested.filter((f) => !eventFlags.includes(f));
  if (invalid.length > 0) {
    const err = new Error(`Unbekannte Flags: ${invalid.join(', ')}`);
    err.code = 'INVALID_FLAG';
    throw err;
  }
  return eventFlags.filter((f) => requested.includes(f));
}

// Resolves the requested price group against the event's configured
// pricing (if any) into what gets stored on the registration. An event
// with no groups configured ignores priceGroup entirely (amount stays
// unset, same as before this feature existed -- an admin sets it
// manually). If a tier can't be resolved (every tier's cutoff has already
// passed), the group is still recorded but priceListCents stays null --
// registration must never be blocked by an exhausted pricing table, the
// admin just sets the amount manually afterwards.
function resolvePriceGroup(event, priceGroup) {
  const groups = event.pricing?.groups ?? [];
  if (groups.length === 0) return { priceGroup: null, priceTier: null, priceListCents: null, conPayer: false };
  if (!groups.includes(priceGroup)) {
    const err = new Error(`priceGroup must be one of: ${groups.join(', ')}`);
    err.code = 'INVALID_PRICE_GROUP';
    throw err;
  }
  const resolved = resolvePriceForGroup(event.pricing, priceGroup);
  return {
    priceGroup,
    priceTier: resolved?.tierName ?? null,
    priceListCents: resolved?.amountCents ?? null,
    conPayer: resolved?.conPayer === true,
  };
}

export { COUNTED_STATUSES };

// One bed in one of the event's lodgings (add-on "Unterkünfte"; the lodgings
// themselves are managed in backend/lodging).
async function resolveLodging(eventId, enabled, lodgingId, details) {
  if (lodgingId === undefined || lodgingId === null || lodgingId === '') return { lodging: null, lodgingCents: 0, details: null };
  if (!enabled) throw extrasError('LODGING_DISABLED', 'Unterkünfte sind nicht aktiviert.');
  const { rows } = await query(
    'SELECT id, name, beds, price_cents, kind FROM event_lodgings WHERE id = $1 AND event_id = $2',
    [/^[0-9a-f-]{36}$/i.test(String(lodgingId)) ? lodgingId : null, eventId]
  );
  if (rows.length === 0) throw extrasError('INVALID_LODGING', 'Unbekannte Unterkunft.');
  return { lodging: rows[0], lodgingCents: rows[0].price_cents, details: rows[0].kind === 'pitch' ? validateTent(details) : null };
}

// A tent pitch is booked for the participant's own tent: size and IT/OT.
// IT or OT is required; the size is optional, but then both length and width.
function validateTent(details) {
  const sizeOk = (cm) => Number.isInteger(cm) && cm >= 50 && cm <= 3000;
  const hasSize = details && (details.lengthCm != null || details.widthCm != null);
  const ok = details && typeof details === 'object' && ['it', 'ot'].includes(details.tentType)
    && (!hasSize || (sizeOk(details.lengthCm) && sizeOk(details.widthCm)));
  if (!ok) throw extrasError('INVALID_LODGING_DETAILS', 'Bitte die Art (IT oder OT) des Zelts angeben – und, falls angegeben, Länge und Breite.');
  return { tentType: details.tentType, ...(hasSize ? { lengthCm: details.lengthCm, widthCm: details.widthCm } : {}) };
}

// "4,0 × 3,0 m, IT" for tables and exports.
export function tentText(details) {
  if (!details) return '';
  const metres = (cm) => (cm / 100).toFixed(1).replace('.', ',');
  const type = details.tentType === 'it' ? 'IT' : 'OT';
  return details.lengthCm ? `${metres(details.lengthCm)} × ${metres(details.widthCm)} m, ${type}` : `${type}-Zelt`;
}

// Same transaction/lock rule as assertExtrasCapacity.
async function assertLodgingCapacity(client, lodging, excludeUserId = null) {
  // A pitch lodging with 0 places is unlimited.
  if (!lodging || (lodging.kind === 'pitch' && lodging.beds === 0)) return;
  const { rows } = await client.query(
    `SELECT count(*)::int AS taken FROM registrations
     WHERE lodging_id = $1 AND status = ANY($2::text[]) AND ($3::uuid IS NULL OR user_id <> $3)`,
    [lodging.id, COUNTED_STATUSES, excludeUserId]
  );
  if (rows[0].taken >= lodging.beds) throw extrasError('LODGING_FULL', `„${lodging.name}“ ist voll.`);
}

function amountDueFor(priceListCents, addonsCents) {
  if (priceListCents != null) return priceListCents + addonsCents;
  return addonsCents > 0 ? addonsCents : null;
}

const MAX_EXTRA_QUANTITY = 20;

function extrasError(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

// Validates { extraId: quantity } against the event's extras catalog and
// totals the price. Zero quantities are dropped, so "has a key" = "is booked".
function resolveExtras(event, requested) {
  const extras = {};
  let extrasCents = 0;
  if (requested === undefined || requested === null) return { extras, extrasCents };
  if (typeof requested !== 'object' || Array.isArray(requested)) throw extrasError('INVALID_EXTRAS', 'extras must be an object of quantities');
  for (const [id, quantity] of Object.entries(requested)) {
    const extra = (event.extras ?? []).find((e) => e.id === id);
    if (!extra) throw extrasError('INVALID_EXTRAS', 'Unbekanntes Extra.');
    if (!Number.isInteger(quantity) || quantity < 0 || quantity > MAX_EXTRA_QUANTITY) {
      throw extrasError('INVALID_EXTRAS', `Menge für „${extra.name}“ muss eine Zahl von 0 bis ${MAX_EXTRA_QUANTITY} sein.`);
    }
    if (quantity === 0) continue;
    extras[id] = quantity;
    extrasCents += quantity * extra.priceCents;
  }
  return { extras, extrasCents };
}

// Must run inside a transaction that holds the event row lock, so two people
// booking the last cabin at once can't both get it. `excludeUserId` leaves the
// person's own current booking out when they change it.
async function assertExtrasCapacity(client, event, extras, excludeUserId = null) {
  for (const extra of event.extras ?? []) {
    const wanted = extras[extra.id] ?? 0;
    if (!wanted || extra.capacity == null) continue;
    const { rows } = await client.query(
      `SELECT COALESCE(SUM((extras ->> $2::text)::int), 0)::int AS booked
       FROM registrations WHERE event_id = $1 AND status = ANY($3::text[]) AND ($4::uuid IS NULL OR user_id <> $4)`,
      [event.id, extra.id, COUNTED_STATUSES, excludeUserId]
    );
    const left = Math.max(extra.capacity - rows[0].booked, 0);
    if (wanted > left) {
      throw extrasError('EXTRA_SOLD_OUT', left === 0 ? `„${extra.name}“ ist ausgebucht.` : `„${extra.name}“ ist nur noch ${left}× verfügbar.`);
    }
  }
}

export async function registerForEvent(userId, eventId, conRole, characterId, nscAvailable, nscCharacterId, flags, priceGroup, otFields, requestingUser, waiverAccepted, { bypassWaiver = false, allowMissingCharacter = false, extras: requestedExtras, lodgingId: requestedLodgingId, lodgingDetails: requestedLodgingDetails, conPayer = false, pdfImport = false, deadlineMails = false, nscData } = {}) {
  const event = await getEvent(eventId);
  if (!event) {
    const err = new Error('event not found');
    err.code = 'EVENT_NOT_FOUND';
    throw err;
  }

  // A configured waiver is opt-in enforcement: an org that hasn't set one up
  // yet (empty text, the default) must not have every existing registration
  // flow suddenly start rejecting requests.
  const appSettings = await getAppSettings();
  // `bypassWaiver`: an admin registering someone else -- that person hasn't
  // accepted anything, so the waiver fields simply stay empty.
  if (appSettings.waiverText && waiverAccepted !== true && !bypassWaiver) {
    const err = new Error('Der Einverständniserklärung muss zugestimmt werden.');
    err.code = 'WAIVER_NOT_ACCEPTED';
    throw err;
  }

  if (!ALL_CON_ROLES.includes(conRole)) {
    const err = new Error(`conRole must be one of: ${ALL_CON_ROLES.join(', ')}`);
    err.code = 'INVALID_CON_ROLE';
    throw err;
  }

  if (STAFF_CON_ROLES.includes(conRole) && !(await canGrantStaffConRole(eventId, requestingUser))) {
    const err = new Error('forbidden: only an existing orga/hilfs_orga for this event, or a moderator/admin, may set this role');
    err.code = 'FORBIDDEN_CON_ROLE';
    throw err;
  }

  // Generalizes the old sc-character-creation active-event gate to every
  // self-service con_role, now that character creation itself has no event
  // context at all to gate on.
  if (SELF_SERVICE_CON_ROLES.includes(conRole) && !requestingUser.group.canEditCharacters && !event.is_active) {
    const err = new Error('Anmeldung ist nur für das aktuell aktive Event möglich.');
    err.code = 'EVENT_NOT_ACTIVE';
    throw err;
  }

  const resolvedCharacterId = await resolveCharacterId(userId, conRole, characterId, eventId, { allowMissingSc: allowMissingCharacter });
  const resolvedNsc = await resolveNscAvailability(userId, conRole, nscAvailable, nscCharacterId, resolvedCharacterId);
  const resolvedNscData = await resolveNscData(conRole, nscData);
  const resolvedFlags = resolveFlags(event.flags, flags);
  const resolvedPrice = resolvePriceGroup(event, priceGroup);
  const { extras: resolvedExtras, extrasCents } = resolveExtras(event, requestedExtras);
  const requestedLodging = await resolveLodging(eventId, appSettings.lodgingEnabled, requestedLodgingId, requestedLodgingDetails);

  const schema = await getRegistrationFieldSchema();
  const data = {};
  for (const field of schema) {
    if (otFields?.[field.key] !== undefined) data[field.key] = sanitizeFieldValue(field, otFields[field.key]);
  }

  try {
    const registration = await withTransaction(async (client) => {
      // Total limit and the SC / NSC limit; roles that do not count (crew) never wait.
      const capacityState = await loadCapacity((sql, params) => client.query(sql, params), eventId, { lockEvent: true });
      const status = capacityBlock(capacityState, conRole) ? 'waitlisted' : 'pending';
      await assertExtrasCapacity(client, event, resolvedExtras);
      // Waitlisted people don't hold a bed (they would take one at promotion).
      const lodging = status === 'waitlisted' ? { lodging: null, lodgingCents: 0, details: null } : requestedLodging;
      await assertLodgingCapacity(client, lodging.lodging);
      const amountDueCents = amountDueFor(resolvedPrice.priceListCents, extrasCents + lodging.lodgingCents);
      const { rows } = await client.query(
        `INSERT INTO registrations (user_id, event_id, con_role, character_id, nsc_available, nsc_character_id, flags, price_group, price_tier, price_list_cents, amount_due_cents, registration_data_enc, status, waiver_version_accepted, waiver_accepted_at, extras, extras_cents, lodging_id, lodging_cents, lodging_details, con_payer, pdf_import, deadline_mail_optin, optout_token, nsc_data)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $15, $11, $12, $13, $14, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25::jsonb)
         RETURNING user_id, event_id, status, con_role, character_id, nsc_available, nsc_character_id, flags, checked_in_at, checked_out_at, waiver_version_accepted, waiver_accepted_at, extras, extras_cents`,
        [
          userId, eventId, conRole, resolvedCharacterId, resolvedNsc.nscAvailable, resolvedNsc.nscCharacterId, resolvedFlags,
          resolvedPrice.priceGroup, resolvedPrice.priceTier, resolvedPrice.priceListCents,
          encryptFieldBlob(data), status,
          waiverAccepted === true ? appSettings.waiverVersion : null,
          waiverAccepted === true ? new Date() : null,
          amountDueCents, JSON.stringify(resolvedExtras), extrasCents, lodging.lodging?.id ?? null, lodging.lodgingCents, lodging.details ? JSON.stringify(lodging.details) : null,
          conPayer === true || resolvedPrice.conPayer, pdfImport === true,
          deadlineMails === true, deadlineMails === true ? crypto.randomBytes(24).toString('hex') : null,
          JSON.stringify(resolvedCharacterId || !resolvedNscData ? {} : resolvedNscData),
        ]
      );
      return rows[0];
    });
    if (resolvedCharacterId && resolvedNscData) await writeNscDataToCharacter(resolvedCharacterId, userId, resolvedNscData, requestingUser);
    if (registration.status === 'waitlisted') {
      // Fire-and-forget (same convention as notifyRegistrationOtFieldsChanged
      // in routes.js): the try/catch below never throws, and awaiting it here
      // would block the HTTP response on sending an email.
      (async () => {
        try {
          // `event` is already in scope from the EVENT_NOT_FOUND check at the
          // top of this function -- no second getEvent() call needed.
          const { rows: userRows } = await query('SELECT email FROM users WHERE id = $1', [userId]);
          if (userRows[0]) {
            const transport = await getTransporterAndFrom();
            await sendWaitlistedEmail(userRows[0].email, { eventName: event?.name ?? 'Unbekanntes Event', userId }, transport);
          }
        } catch (err) {
          logger.error('failed to send waitlisted notification', { error: err.message, userId, eventId });
        }
      })();
    }
    await logAudit({ actorId: requestingUser?.id ?? userId, action: 'registration.created', subjectUserId: userId, details: { eventId, eventName: event?.name, conRole, waitlisted: registration.status === 'waitlisted' } });
    return registration;
  } catch (err) {
    if (err.code === '23505') {
      const dup = new Error('Bereits für dieses Event angemeldet.');
      dup.code = 'ALREADY_REGISTERED';
      throw dup;
    }
    throw err;
  }
}

// Changes the extras of an existing registration and moves amount_due by the
// price difference (so a manual amount/discount the admin set stays intact).
// Locked once the registration is paid or cancelled; after the event date only
// staff may still change it.
export async function updateRegistrationExtras(eventId, userId, requested, { staff = false } = {}) {
  const event = await getEvent(eventId);
  if (!event) throw extrasError('EVENT_NOT_FOUND', 'event not found');
  const resolved = resolveExtras(event, requested);
  return withTransaction(async (client) => {
    await client.query('SELECT 1 FROM events WHERE id = $1 FOR UPDATE', [eventId]);
    const { rows } = await client.query(
      `SELECT r.status, r.paid_at, r.extras_cents, e.event_date < CURRENT_DATE AS past
       FROM registrations r JOIN events e ON e.id = r.event_id
       WHERE r.event_id = $1 AND r.user_id = $2 FOR UPDATE OF r`,
      [eventId, userId]
    );
    if (rows.length === 0) throw extrasError('REGISTRATION_NOT_FOUND', 'registration not found');
    const current = rows[0];
    if (current.status === 'cancelled') throw extrasError('EXTRAS_LOCKED', 'Die Anmeldung ist abgesagt.');
    if (current.paid_at) throw extrasError('EXTRAS_LOCKED', 'Die Anmeldung ist bereits bezahlt – Extras lassen sich nicht mehr ändern.');
    if (current.past && !staff) throw extrasError('EXTRAS_LOCKED', 'Das Event hat bereits stattgefunden.');
    await assertExtrasCapacity(client, event, resolved.extras, userId);
    const { rows: updated } = await client.query(
      `UPDATE registrations SET extras = $3, extras_cents = $4,
         amount_due_cents = CASE WHEN amount_due_cents IS NULL AND $4 = 0 THEN NULL ELSE GREATEST(COALESCE(amount_due_cents, 0) + $5, 0) END
       WHERE event_id = $1 AND user_id = $2
       RETURNING extras, extras_cents, amount_due_cents`,
      [eventId, userId, JSON.stringify(resolved.extras), resolved.extrasCents, resolved.extrasCents - current.extras_cents]
    );
    return { extras: updated[0].extras, extrasCents: updated[0].extras_cents, amountDueCents: updated[0].amount_due_cents };
  });
}

// Moves a registration into a lodging (or out of it with lodgingId = null).
// Same locks as the extras; a paid registration may still switch between
// lodgings of the same price (nothing to pay or refund).
export async function updateRegistrationLodging(eventId, userId, lodgingId, { staff = false, details } = {}) {
  const event = await getEvent(eventId);
  if (!event) throw extrasError('EVENT_NOT_FOUND', 'event not found');
  const settings = await getAppSettings();
  // Staff moving someone to another tent pitch: the tent the person already registered carries over.
  if (staff && details === undefined) {
    details = (await query('SELECT lodging_details FROM registrations WHERE event_id = $1 AND user_id = $2', [eventId, userId])).rows[0]?.lodging_details ?? undefined;
  }
  const resolved = await resolveLodging(eventId, settings.lodgingEnabled, lodgingId, details);
  return withTransaction(async (client) => {
    await client.query('SELECT 1 FROM events WHERE id = $1 FOR UPDATE', [eventId]);
    const { rows } = await client.query(
      `SELECT r.status, r.paid_at, r.lodging_cents, e.event_date < CURRENT_DATE AS past
       FROM registrations r JOIN events e ON e.id = r.event_id
       WHERE r.event_id = $1 AND r.user_id = $2 FOR UPDATE OF r`,
      [eventId, userId]
    );
    if (rows.length === 0) throw extrasError('REGISTRATION_NOT_FOUND', 'registration not found');
    const current = rows[0];
    if (current.status === 'cancelled') throw extrasError('LODGING_LOCKED', 'Die Anmeldung ist abgesagt.');
    if (current.status === 'waitlisted' && resolved.lodging) throw extrasError('LODGING_LOCKED', 'Auf der Warteliste ist keine Unterkunft buchbar.');
    if (current.paid_at && resolved.lodgingCents !== current.lodging_cents) throw extrasError('LODGING_LOCKED', 'Die Anmeldung ist bereits bezahlt – nur eine Unterkunft zum gleichen Preis ist wählbar.');
    if (current.past && !staff) throw extrasError('LODGING_LOCKED', 'Das Event hat bereits stattgefunden.');
    await assertLodgingCapacity(client, resolved.lodging, userId);
    const { rows: updated } = await client.query(
      `UPDATE registrations SET lodging_id = $3, lodging_cents = $4, lodging_details = $6,
         amount_due_cents = CASE WHEN amount_due_cents IS NULL AND $4 = 0 THEN NULL ELSE GREATEST(COALESCE(amount_due_cents, 0) + $5, 0) END
       WHERE event_id = $1 AND user_id = $2
       RETURNING lodging_id, lodging_cents, lodging_details, amount_due_cents`,
      [eventId, userId, resolved.lodging?.id ?? null, resolved.lodgingCents, resolved.lodgingCents - current.lodging_cents, resolved.details ? JSON.stringify(resolved.details) : null]
    );
    return { lodgingId: updated[0].lodging_id, lodgingCents: updated[0].lodging_cents, lodgingDetails: updated[0].lodging_details, amountDueCents: updated[0].amount_due_cents };
  });
}

// "Charakter nachreichen / austauschen": changes the character of an existing registration
// without touching its role. SC: a registration may exist without a character (null = nachreichen)
// and a character that is booked as SC for another event is not available; NSC: the character is
// optional (null = Springer). The old character is free again as soon as it is replaced.
// Participants (and their managers) may do this until check-in; staff any time before check-out.
export async function setRegistrationCharacter(eventId, userId, characterId, requestingUser, { staff = false } = {}) {
  const { rows: current } = await query(
    'SELECT con_role, status, character_id FROM registrations WHERE event_id = $1 AND user_id = $2',
    [eventId, userId]
  );
  if (current.length === 0) {
    const err = new Error('registration not found');
    err.code = 'REGISTRATION_NOT_FOUND';
    throw err;
  }
  const { con_role: conRole, status, character_id: oldCharacterId } = current[0];
  if (!['sc', 'nsc'].includes(conRole)) {
    const err = new Error(`Für die Rolle "${conRole}" gibt es keinen Charakter.`);
    err.code = 'CHARACTER_NOT_ALLOWED';
    throw err;
  }
  const open = staff ? ['pending', 'waitlisted', 'confirmed', 'checked_in'] : ['pending', 'waitlisted', 'confirmed'];
  if (!open.includes(status)) {
    const err = new Error('Der Charakter lässt sich in diesem Status nicht mehr ändern. Bitte wende dich an die Orga.');
    err.code = 'CHARACTER_LOCKED';
    throw err;
  }
  const resolved = await resolveCharacterId(userId, conRole, characterId || null, eventId, { allowMissingSc: true });
  if ((resolved ?? null) === (oldCharacterId ?? null)) return { eventId, userId, characterId: resolved ?? null, changed: false };
  await query(
    // The NSC answers of the registration only belong to the old character-less (Springer) state.
    `UPDATE registrations SET character_id = $3,
       nsc_data = CASE WHEN con_role = 'nsc' AND $3::uuid IS NOT NULL THEN '{}'::jsonb ELSE nsc_data END
     WHERE event_id = $1 AND user_id = $2`,
    [eventId, userId, resolved]
  );
  await logAudit({
    actorId: requestingUser.id,
    action: 'registration.character_changed',
    subjectUserId: userId,
    details: { eventId, from: oldCharacterId ?? null, to: resolved ?? null },
  });
  return { eventId, userId, characterId: resolved ?? null, changed: true };
}

export async function setConRole(eventId, userId, conRole, characterId, nscAvailable, nscCharacterId, flags, requestingUser, nscData) {
  if (!ALL_CON_ROLES.includes(conRole)) {
    const err = new Error(`conRole must be one of: ${ALL_CON_ROLES.join(', ')}`);
    err.code = 'INVALID_CON_ROLE';
    throw err;
  }
  const isOwnRegistration = userId === requestingUser.id;
  const staffGrantOk = await canGrantStaffConRole(eventId, requestingUser);
  if (!isOwnRegistration && !staffGrantOk) {
    const err = new Error('forbidden: only an existing orga/hilfs_orga for this event, or a moderator/admin, may change another user\'s con_role');
    err.code = 'FORBIDDEN_CON_ROLE';
    throw err;
  }
  if (STAFF_CON_ROLES.includes(conRole) && !staffGrantOk) {
    const err = new Error('forbidden: only an existing orga/hilfs_orga for this event, or a moderator/admin, may set this role');
    err.code = 'FORBIDDEN_CON_ROLE';
    throw err;
  }

  // con_role can change across the character/no-character boundary (e.g. a
  // helfer promoted to orga keeps character_id NULL; but nothing stops a
  // future caller from also changing a helfer to sc here) -- always resolve
  // characterId the same way registerForEvent does, so this can never write
  // a row that violates registrations_character_con_role_check.
  // setConRole never loaded the event before (registerForEvent does, for
  // capacity/is_active) -- flags needs the event's flag vocabulary to
  // validate against. Falls back to [] if the event is somehow gone by now
  // (the FK on registrations.event_id makes that practically unreachable,
  // but resolveFlags rejecting any non-empty request in that case is the
  // safe default either way).
  const event = await getEvent(eventId);
  const resolvedCharacterId = await resolveCharacterId(userId, conRole, characterId, eventId, { allowMissingSc: true });
  const resolvedNsc = await resolveNscAvailability(userId, conRole, nscAvailable, nscCharacterId, resolvedCharacterId);
  const resolvedNscData = await resolveNscData(conRole, nscData);

  // Unlike nscAvailable (legitimately role-coupled -- resolveNscAvailability
  // itself rejects it outside con_role='sc'), flags are explicitly
  // role-independent (plan Global Constraints). Omitting flags from this
  // call must preserve whatever is currently stored, not wipe it -- same
  // "only touch what's explicitly sent" contract updateRegistrationOtFields
  // already has for the OT-schema fields. The only production caller
  // (admin/checkin.html's con-role promotion dropdown) never sends flags at
  // all, so without this guard every promotion silently cleared them.
  let resolvedFlags;
  if (flags !== undefined) {
    resolvedFlags = resolveFlags(event?.flags ?? [], flags);
  } else {
    const { rows: currentFlagsRows } = await query(
      'SELECT flags FROM registrations WHERE event_id = $1 AND user_id = $2',
      [eventId, userId]
    );
    resolvedFlags = currentFlagsRows[0]?.flags ?? [];
  }

  // A role change moves the person between the limits: the target limit must have room (this registration
  // leaves its old one first), and the old role's place is free for the waitlist afterwards.
  const { rows: before } = await query('SELECT con_role, status FROM registrations WHERE event_id = $1 AND user_id = $2', [eventId, userId]);
  const roleChanged = before.length > 0 && before[0].con_role !== conRole;
  if (roleChanged && COUNTED_STATUSES.includes(before[0].status)) {
    const state = await loadCapacity((sql, params) => query(sql, params), eventId);
    const block = capacityBlock(withRemoved(state, before[0].con_role), conRole);
    if (block) {
      const err = new Error(`${BLOCK_MESSAGES[block]} Der Wechsel zu „${conRole}“ ist erst möglich, wenn dort ein Platz frei wird.`);
      err.code = 'CAPACITY_FULL';
      throw err;
    }
  }

  const { rows } = await query(
    `UPDATE registrations SET con_role = $3, character_id = $4, nsc_available = $5, nsc_character_id = $6, flags = $7,
       nsc_data = CASE WHEN $3 <> 'nsc' OR $4::uuid IS NOT NULL THEN '{}'::jsonb WHEN $8::boolean THEN $9::jsonb ELSE nsc_data END
     WHERE event_id = $1 AND user_id = $2
     RETURNING user_id, event_id, status, con_role, character_id, nsc_available, nsc_character_id, flags, checked_in_at, checked_out_at`,
    [eventId, userId, conRole, resolvedCharacterId, resolvedNsc.nscAvailable, resolvedNsc.nscCharacterId, resolvedFlags, resolvedNscData !== undefined, JSON.stringify(resolvedNscData ?? {})]
  );
  if (rows.length === 0) {
    const err = new Error('registration not found');
    err.code = 'REGISTRATION_NOT_FOUND';
    throw err;
  }
  if (resolvedCharacterId && resolvedNscData) await writeNscDataToCharacter(resolvedCharacterId, userId, resolvedNscData, requestingUser);
  if (roleChanged) await maybePromoteFromWaitlist(eventId);
  return rows[0];
}

// Pending/waitlisted registrations are simply deleted. A confirmed one (money
// may have been paid) is set to 'cancelled' instead and the Orga is mailed to
// review it -- refunds are handled manually. Returns { manualReview }.
export async function unregisterFromEvent(userId, eventId) {
  const { rows: existingRows } = await query(
    'SELECT status, paid_at, amount_due_cents FROM registrations WHERE user_id = $1 AND event_id = $2',
    [userId, eventId]
  );
  const previousStatus = existingRows[0]?.status;

  if (previousStatus === 'confirmed') {
    await setStatus(eventId, userId, 'cancelled', 'confirmed');
    await logAudit({ actorId: userId, action: 'registration.cancelled', subjectUserId: userId, details: { eventId, self: true, paid: Boolean(existingRows[0].paid_at) } });
    notifyWithdrawn(userId, eventId, existingRows[0]);
    return { manualReview: true };
  }

  const { rowCount } = await query(
    "DELETE FROM registrations WHERE user_id = $1 AND event_id = $2 AND status IN ('pending', 'waitlisted')",
    [userId, eventId]
  );
  if (rowCount === 0) {
    if (existingRows.length === 0) {
      const err = new Error('registration not found');
      err.code = 'REGISTRATION_NOT_FOUND';
      throw err;
    }
    const err = new Error('Abmelden nach Check-In nicht mehr möglich.');
    err.code = 'CANNOT_UNREGISTER';
    throw err;
  }
  await logAudit({ actorId: userId, action: 'registration.cancelled', subjectUserId: userId, details: { eventId, self: true } });
  if (previousStatus === 'pending') {
    await maybePromoteFromWaitlist(eventId);
  }
  return { manualReview: false };
}

// Fire-and-forget like the other Orga notifications; never throws.
function notifyWithdrawn(userId, eventId, reg) {
  (async () => {
    try {
      const event = await getEvent(eventId);
      const { rows } = await query('SELECT first_name, last_name, nickname FROM users WHERE id = $1', [userId]);
      const userName = displayName({ firstName: rows[0]?.first_name, lastName: rows[0]?.last_name, nickname: rows[0]?.nickname });
      const paymentInfo = reg.paid_at ? 'Die Anmeldung war bereits bezahlt.' : 'Die Anmeldung war noch nicht als bezahlt markiert.';
      const transport = await getTransporterAndFrom();
      for (const to of await resolveOtFieldsChangeRecipients(eventId)) {
        await sendRegistrationWithdrawnOrgaEmail(to, { userName, eventName: event?.name ?? 'Unbekanntes Event', paymentInfo }, transport);
      }
    } catch (err) {
      logger.error('failed to send withdrawn notification', { error: err.message, userId, eventId });
    }
  })();
}

// Promotes as many waitlisted registrations as now fit under `capacity`,
// oldest first -- not just one, so both "one slot freed" (a cancellation)
// and "several slots freed at once" (a capacity increase) are handled by
// the same code path. No-op if auto-promote is off or the event has no
// capacity limit (nothing could ever be waitlisted there).
export async function maybePromoteFromWaitlist(eventId) {
  const { waitlistAutoPromote } = await getAppSettings();
  if (!waitlistAutoPromote) return;

  const promotedUserIds = await withTransaction(async (client) => {
    // Oldest first, but each person only moves up if THEIR limit has room: a waiting NSC must not
    // block an SC (or the other way round) when only one of the two limits is full.
    let state = await loadCapacity((sql, params) => client.query(sql, params), eventId, { lockEvent: true });
    // No limit at all: nobody can be waiting because of one (a manual waitlist entry stays what it is).
    if (state.limits.total === null && state.limits.sc === null && state.limits.nsc === null) return [];
    const { rows: waiting } = await client.query(
      "SELECT user_id, con_role FROM registrations WHERE event_id = $1 AND status = 'waitlisted' ORDER BY COALESCE(waitlisted_at, created_at) ASC",
      [eventId]
    );
    const promoted = [];
    for (const candidate of waiting) {
      if (capacityBlock(state, candidate.con_role)) continue;
      await client.query(
        "UPDATE registrations SET status = 'pending' WHERE event_id = $1 AND user_id = $2 AND status = 'waitlisted'",
        [eventId, candidate.user_id]
      );
      state = withAdded(state, candidate.con_role);
      promoted.push(candidate.user_id);
    }
    return promoted;
  });

  if (promotedUserIds.length === 0) return;
  // Fire-and-forget (same convention as notifyRegistrationOtFieldsChanged in
  // routes.js): the promotion UPDATEs already happened inside the awaited
  // transaction above -- callers only need to wait for that, not for mail
  // delivery. Awaiting this loop here would serialize a capacity increase's
  // N promotion emails in front of the caller's response. Outer try/catch
  // (in addition to the per-recipient one) so a getEvent/transport failure
  // can't become an unhandled rejection now that nothing awaits this IIFE.
  (async () => {
    try {
      const event = await getEvent(eventId);
      const eventName = event?.name ?? 'Unbekanntes Event';
      const transport = await getTransporterAndFrom();
      for (const userId of promotedUserIds) {
        try {
          const { rows: userRows } = await query('SELECT email FROM users WHERE id = $1', [userId]);
          if (userRows[0]) await sendWaitlistPromotedEmail(userRows[0].email, { eventName, userId }, transport);
        } catch (err) {
          logger.error('failed to send waitlist-promoted notification', { error: err.message, userId, eventId });
        }
      }
    } catch (err) {
      logger.error('failed to prepare waitlist-promoted notifications', { error: err.message, eventId });
    }
  })();
}

// "2× Hütte, 1× Stellplatz" for tables and exports.
function extrasText(catalog, booked) {
  return Object.entries(booked ?? {})
    .map(([id, quantity]) => `${quantity}× ${catalog.find((e) => e.id === id)?.name ?? 'Unbekanntes Extra'}`)
    .join(', ');
}

export async function listParticipantsForEvent(eventId, { schema = [], viewer } = {}) {
  const eventExtras = (await getEvent(eventId))?.extras ?? [];
  const otKeys = (viewer?.group?.accountFields ?? []).filter((key) => key !== 'group');

  const { rows: registrations } = await query(
    `SELECT r.user_id, u.first_name, u.last_name, u.nickname, r.status, r.con_role, r.nsc_available, r.nsc_character_id, r.nsc_data AS reg_nsc_data, rc.nsc_data AS char_nsc_data, r.flags, r.created_at, r.checked_in_at, r.checked_out_at,
            r.amount_due_cents, r.paid_at, r.transfer_notified_at, r.con_payer, r.price_group, r.price_tier, r.discount_cents, r.extras, r.extras_cents, r.lodging_id, r.lodging_details, lodging.name AS lodging_name, latest_payment.method AS payment_method,
            latest_payment.refund_amount_cents, latest_payment.refunded_at,
            r.waiver_version_accepted, r.waiver_accepted_at,
            u.account_data_enc, r.registration_data_enc
     FROM registrations r
     JOIN users u ON u.id = r.user_id
     LEFT JOIN characters rc ON rc.id = r.character_id
     LEFT JOIN event_lodgings lodging ON lodging.id = r.lodging_id
     LEFT JOIN LATERAL (
       SELECT method, refund_amount_cents, refunded_at FROM payments p
       WHERE p.event_id = r.event_id AND p.user_id = r.user_id
       ORDER BY p.created_at DESC LIMIT 1
     ) latest_payment ON true
     WHERE r.event_id = $1
     ORDER BY u.last_name, u.first_name`,
    [eventId]
  );
  const { rows: characters } = await query(
    `SELECT c.id, c.user_id, c.name, c.data
     FROM characters c
     JOIN registrations r ON r.character_id = c.id
     WHERE r.event_id = $1`,
    [eventId]
  );

  // Characters a staff member could assign when changing someone's role: all of the
  // person's characters. `freeForSc` = not bound to another event's SC registration
  // (the rule resolveCharacterId enforces for con_role 'sc'); NSC may reuse any.
  const { rows: selectable } = await query(
    `SELECT c.id, c.user_id, c.name, c.nsc_data,
            NOT EXISTS (
              SELECT 1 FROM registrations r2
              WHERE r2.character_id = c.id AND r2.con_role = 'sc' AND NOT (r2.event_id = $1 AND r2.user_id = c.user_id)
            ) AS free_for_sc
     FROM characters c
     WHERE c.user_id IN (SELECT user_id FROM registrations WHERE event_id = $1)
     ORDER BY c.created_at`,
    [eventId]
  );
  const selectableByUser = new Map();
  for (const c of selectable) {
    if (!selectableByUser.has(c.user_id)) selectableByUser.set(c.user_id, []);
    selectableByUser.get(c.user_id).push({ id: c.id, name: c.name, freeForSc: c.free_for_sc, nscData: c.nsc_data });
  }

  const charactersByUser = new Map();
  for (const c of characters) {
    if (!charactersByUser.has(c.user_id)) charactersByUser.set(c.user_id, []);
    charactersByUser.get(c.user_id).push({
      id: c.id,
      name: c.name,
      data: filterCharacterFields(c, schema, viewer),
    });
  }

  const registered = registrations.map((r) => {
    const accountData = decryptAccountFieldBlob(r.account_data_enc);
    const registrationData = decryptFieldBlob(r.registration_data_enc);
    const otFields = {};
    for (const key of otKeys) {
      if (key in accountData) otFields[key] = accountData[key];
      else if (key in registrationData) otFields[key] = registrationData[key];
    }
    return {
      userId: r.user_id,
      invitationId: null,
      name: displayName({ firstName: r.first_name, lastName: r.last_name, nickname: r.nickname }),
      status: r.status,
      conRole: r.con_role,
      nscAvailable: r.nsc_available,
      nscCharacterId: r.nsc_character_id,
      nscData: r.char_nsc_data ?? r.reg_nsc_data,
      flags: r.flags,
      registeredAt: r.created_at,
      checkedInAt: r.checked_in_at,
      checkedOutAt: r.checked_out_at,
      amountDueCents: r.amount_due_cents,
      paidAt: r.paid_at,
      transferNotifiedAt: r.transfer_notified_at,
      conPayer: r.con_payer,
      priceGroup: r.price_group,
      priceTier: r.price_tier,
      discountCents: r.discount_cents,
      extras: r.extras,
      extrasCents: r.extras_cents,
      extrasText: extrasText(eventExtras, r.extras),
      lodgingId: r.lodging_id,
      lodgingName: r.lodging_name ? `${r.lodging_name}${r.lodging_details ? ` (${tentText(r.lodging_details)})` : ''}` : '',
      paymentMethod: r.payment_method,
      refundAmountCents: r.refund_amount_cents,
      refundedAt: r.refunded_at,
      waiverVersionAccepted: r.waiver_version_accepted,
      waiverAcceptedAt: r.waiver_accepted_at,
      characters: charactersByUser.get(r.user_id) ?? [],
      selectableCharacters: selectableByUser.get(r.user_id) ?? [],
      otFields,
    };
  });

  const notified = (await listOpenInvitationsForEvent(eventId)).map((inv) => ({
    userId: null,
    invitationId: inv.invitationId,
    name: inv.name,
    status: 'notified',
    checkedInAt: null,
    checkedOutAt: null,
    amountDueCents: null,
    paidAt: null,
    priceGroup: null,
    priceTier: null,
    discountCents: 0,
    extras: {},
    extrasCents: 0,
    extrasText: '',
    lodgingId: null,
    lodgingName: '',
    paymentMethod: null,
    refundAmountCents: null,
    refundedAt: null,
    waiverVersionAccepted: null,
    waiverAcceptedAt: null,
    characters: [],
    otFields: {},
  }));

  return [...notified, ...registered];
}

export async function getScanLookup(eventId, userId) {
  const { rows } = await query(
    `SELECT r.user_id, u.first_name, u.last_name, u.nickname, g.key AS group_key, r.status, r.con_role, r.nsc_available, r.flags, r.paid_at, r.amount_due_cents, r.con_payer
     FROM registrations r
     JOIN users u ON u.id = r.user_id
     JOIN groups g ON g.id = u.group_id
     WHERE r.event_id = $1 AND r.user_id = $2`,
    [eventId, userId]
  );
  if (rows.length === 0) return null;
  const r = rows[0];
  const { rows: characters } = await query(
    `SELECT c.id, c.name
     FROM characters c
     JOIN registrations r ON r.character_id = c.id
     WHERE r.event_id = $1 AND r.user_id = $2`,
    [eventId, userId]
  );
  return {
    userId: r.user_id,
    name: displayName({ firstName: r.first_name, lastName: r.last_name, nickname: r.nickname }),
    group: r.group_key,
    status: r.status,
    conRole: r.con_role,
    nscAvailable: r.nsc_available,
    flags: r.flags,
    paidAt: r.paid_at,
    amountDueCents: r.amount_due_cents,
    conPayer: r.con_payer,
    characters: characters.map((c) => ({ id: c.id, name: c.name })),
  };
}

export async function listRegistrationsForUser(userId) {
  const { rows } = await query(
    `SELECT r.event_id, e.name AS event_name, e.code AS event_code, u.first_name AS user_first_name, u.last_name AS user_last_name, e.event_date, r.status, r.con_role, r.character_id, r.nsc_available, r.nsc_character_id, r.nsc_data AS reg_nsc_data, c.nsc_data AS char_nsc_data, r.flags, r.checked_in_at, r.checked_out_at,
            r.amount_due_cents, r.paid_at, r.transfer_notified_at, r.price_group, r.price_tier, r.waiver_version_accepted, r.waiver_accepted_at, r.extras, r.extras_cents, r.lodging_id, r.lodging_cents, r.lodging_details, lodging.name AS lodging_name,
            r.registration_data_enc, r.con_payer, c.name AS character_name, nc.name AS nsc_character_name
     FROM registrations r
     JOIN events e ON e.id = r.event_id
     JOIN users u ON u.id = r.user_id
     LEFT JOIN characters c ON c.id = r.character_id
     LEFT JOIN characters nc ON nc.id = r.nsc_character_id
     LEFT JOIN event_lodgings lodging ON lodging.id = r.lodging_id
     WHERE r.user_id = $1
     ORDER BY e.event_date`,
    [userId]
  );
  return rows.map((r) => ({
    eventId: r.event_id,
    eventName: r.event_name,
    eventDate: r.event_date,
    status: r.status,
    conRole: r.con_role,
    characterId: r.character_id,
    characterName: r.character_name,
    nscAvailable: r.nsc_available,
    nscCharacterId: r.nsc_character_id,
    nscCharacterName: r.nsc_character_name,
    nscData: r.char_nsc_data ?? r.reg_nsc_data,
    flags: r.flags,
    checkedInAt: r.checked_in_at,
    checkedOutAt: r.checked_out_at,
    amountDueCents: r.amount_due_cents,
    paidAt: r.paid_at,
    transferNotifiedAt: r.transfer_notified_at,
    conPayer: r.con_payer,
    priceGroup: r.price_group,
    priceTier: r.price_tier,
    extras: r.extras,
    extrasCents: r.extras_cents,
    lodgingId: r.lodging_id,
    lodgingCents: r.lodging_cents,
    lodgingName: r.lodging_name,
    lodgingDetails: r.lodging_details,
    waiverVersionAccepted: r.waiver_version_accepted,
    waiverAcceptedAt: r.waiver_accepted_at,
    paymentReference: buildPaymentReference(r.event_id, userId, { code: r.event_code, firstName: r.user_first_name, lastName: r.user_last_name }),
    ...decryptFieldBlob(r.registration_data_enc),
  }));
}

const TIMESTAMP_COLUMNS = { checkin: 'checked_in_at', checkout: 'checked_out_at' };

async function transitionStatus(eventId, userId, action) {
  const { rows } = await query(
    'SELECT status FROM registrations WHERE event_id = $1 AND user_id = $2',
    [eventId, userId]
  );
  if (rows.length === 0) {
    const err = new Error('registration not found');
    err.code = 'REGISTRATION_NOT_FOUND';
    throw err;
  }

  const currentStatus = rows[0].status;
  const nextStatus = applyTransition(currentStatus, action);
  const timestampColumn = TIMESTAMP_COLUMNS[action];
  const setClause = timestampColumn ? `status = $4, ${timestampColumn} = now()` : 'status = $4';
  const { rows: updated } = await query(
    `UPDATE registrations SET ${setClause}
     WHERE event_id = $1 AND user_id = $2 AND status = $3
     RETURNING user_id, event_id, status, checked_in_at, checked_out_at`,
    [eventId, userId, currentStatus, nextStatus]
  );
  if (updated.length === 0) {
    const err = new Error('Ungültiger Übergang: Anmeldestatus wurde zwischenzeitlich geändert.');
    err.code = 'INVALID_TRANSITION';
    throw err;
  }
  return updated[0];
}

// At the desk the person is asked whether they really paid. A "yes"
// (`paidConfirmed`) books the open amount as paid in cash; a Con-Zahler who is
// not approved yet is approved on the spot, since paying at the con is exactly
// their way in.
export async function checkIn(eventId, userId, { paidConfirmed = false, confirmedBy = null } = {}) {
  const { markPaidManually } = await import('../payments/repository.js');
  const { rows } = await query(
    'SELECT status, paid_at, amount_due_cents, con_payer FROM registrations WHERE event_id = $1 AND user_id = $2',
    [eventId, userId]
  );
  if (rows.length === 0) {
    const err = new Error('registration not found');
    err.code = 'REGISTRATION_NOT_FOUND';
    throw err;
  }
  const reg = rows[0];
  if (reg.status === 'pending' && reg.con_payer) await transitionStatus(eventId, userId, 'approve');
  const result = await transitionStatus(eventId, userId, 'checkin');
  if (paidConfirmed && reg.paid_at == null && reg.amount_due_cents != null) {
    await markPaidManually(eventId, userId, confirmedBy);
  }
  return result;
}

// Con-Zahler = pays at the con. Only while nothing is paid yet and the
// registration is still open.
export async function setConPayer(eventId, userId, conPayer) {
  const { rows } = await query(
    `UPDATE registrations SET con_payer = $3
     WHERE event_id = $1 AND user_id = $2 AND paid_at IS NULL AND status IN ('pending', 'waitlisted', 'confirmed')
     RETURNING con_payer`,
    [eventId, userId, conPayer === true]
  );
  if (rows.length === 0) {
    const err = new Error('Con-Zahler lässt sich nur für offene, unbezahlte Anmeldungen ändern.');
    err.code = 'CON_PAYER_LOCKED';
    throw err;
  }
  return rows[0];
}

export async function checkOut(eventId, userId) {
  return transitionStatus(eventId, userId, 'checkout');
}

// The character-existence check from Teil 1 is gone: the
// registrations_character_con_role_check CHECK constraint enforces
// character_id at INSERT time for 'sc' (required) and forbids it for
// helfer/orga/hilfs_orga; 'nsc' may or may not have one (see
// resolveNscAvailability/resolveCharacterId above) -- either way, there's
// nothing left to verify here.
export async function approveRegistration(eventId, userId) {
  return transitionStatus(eventId, userId, 'approve');
}

export async function cancelRegistration(eventId, userId) {
  const result = await transitionStatus(eventId, userId, 'cancel');
  await logAudit({ actorId: null, action: 'registration.cancelled', subjectUserId: userId, details: { eventId, self: false } });
  await maybePromoteFromWaitlist(eventId);
  return result;
}

export async function setStatus(eventId, userId, status, expectedStatus) {
  // A manual override moving a counted registration back to 'waitlisted' means it rejoins the waitlist NOW:
  // waitlisted_at (not created_at, which stays the original registration time) decides the promotion order.
  const rejoinsWaitlist = status === 'waitlisted' && COUNTED_STATUSES.includes(expectedStatus);
  const { rows } = await query(
    `UPDATE registrations SET
       status = $4,
       waitlisted_at = CASE WHEN $5 THEN now() WHEN $4 = 'waitlisted' THEN waitlisted_at ELSE NULL END,
       checked_in_at = CASE
         WHEN $4 IN ('pending', 'confirmed', 'cancelled', 'waitlisted') THEN NULL
         WHEN $4 = 'checked_in' AND checked_in_at IS NULL THEN now()
         ELSE checked_in_at
       END,
       checked_out_at = CASE
         WHEN $4 IN ('pending', 'confirmed', 'cancelled', 'waitlisted', 'checked_in') THEN NULL
         WHEN checked_out_at IS NULL THEN now()
         ELSE checked_out_at
       END
     WHERE event_id = $1 AND user_id = $2 AND status = $3
     RETURNING user_id, event_id, status, checked_in_at, checked_out_at`,
    [eventId, userId, expectedStatus, status, rejoinsWaitlist]
  );
  if (rows.length === 0) {
    const { rows: existing } = await query(
      'SELECT status FROM registrations WHERE event_id = $1 AND user_id = $2',
      [eventId, userId]
    );
    if (existing.length === 0) {
      const err = new Error('registration not found');
      err.code = 'REGISTRATION_NOT_FOUND';
      throw err;
    }
    const err = new Error('Status wurde zwischenzeitlich geändert.');
    err.code = 'STATUS_CONFLICT';
    throw err;
  }

  // A manual override can free a capacity slot two ways: an explicit
  // 'cancelled', or staff moving a counted registration straight back to
  // 'waitlisted' (the checkin.html override dropdown allows this -- exactly
  // the `rejoinsWaitlist` case computed above). Both stop counting toward
  // capacity, so both must offer the freed slot to the next waitlisted person.
  if (rejoinsWaitlist || (status === 'cancelled' && COUNTED_STATUSES.includes(expectedStatus))) {
    await maybePromoteFromWaitlist(eventId);
  }
  if (expectedStatus === 'waitlisted' && status === 'pending') {
    // Fire-and-forget (same convention as notifyRegistrationOtFieldsChanged
    // in routes.js): the try/catch below never throws, and awaiting it here
    // would block the HTTP response on sending an email.
    (async () => {
      try {
        const event = await getEvent(eventId);
        const { rows: userRows } = await query('SELECT email FROM users WHERE id = $1', [userId]);
        if (userRows[0]) {
          const transport = await getTransporterAndFrom();
          await sendWaitlistPromotedEmail(userRows[0].email, { eventName: event?.name ?? 'Unbekanntes Event', userId }, transport);
        }
      } catch (err) {
        logger.error('failed to send waitlist-promoted notification (manual)', { error: err.message, userId, eventId });
      }
    })();
  }

  return rows[0];
}

export async function updateRegistrationOtFields(eventId, userId, otFields, flags) {
  const schema = await getRegistrationFieldSchema();
  const { rows: currentRows } = await query(
    'SELECT registration_data_enc, flags FROM registrations WHERE event_id = $1 AND user_id = $2',
    [eventId, userId]
  );
  if (currentRows.length === 0) {
    const err = new Error('registration not found');
    err.code = 'REGISTRATION_NOT_FOUND';
    throw err;
  }
  const nextData = decryptFieldBlob(currentRows[0].registration_data_enc);
  for (const field of schema) {
    if (otFields[field.key] !== undefined) nextData[field.key] = sanitizeFieldValue(field, otFields[field.key]);
  }

  // Flags aren't part of the OT-schema blob above (they're event-scoped,
  // not a global schema field) -- only touched when the caller explicitly
  // sent them, same "only what's sent" contract as the schema fields loop.
  let nextFlags = currentRows[0].flags;
  if (flags !== undefined) {
    const event = await getEvent(eventId);
    nextFlags = resolveFlags(event?.flags ?? [], flags);
  }

  const { rows } = await query(
    `UPDATE registrations SET registration_data_enc = $3, flags = $4
     WHERE event_id = $1 AND user_id = $2
     RETURNING user_id, event_id, status, con_role, character_id, flags, checked_in_at, checked_out_at, registration_data_enc`,
    [eventId, userId, encryptFieldBlob(nextData), nextFlags]
  );
  const r = rows[0];
  return {
    userId: r.user_id,
    eventId: r.event_id,
    status: r.status,
    conRole: r.con_role,
    characterId: r.character_id,
    flags: r.flags,
    checkedInAt: r.checked_in_at,
    checkedOutAt: r.checked_out_at,
    ...decryptFieldBlob(r.registration_data_enc),
  };
}

// Recipients for the "a registration's OT fields changed" notification:
// every user holding an orga/hilfs_orga registration for THIS event, plus
// every system admin/moderator, regardless of event. A plain UNION (not a
// JOIN + OR) so each half stays simple to read and test independently.
export async function resolveOtFieldsChangeRecipients(eventId) {
  const { rows } = await query(
    `SELECT email FROM (
       SELECT u.email FROM users u
       JOIN registrations r ON r.user_id = u.id
       WHERE r.event_id = $1 AND r.con_role IN ('orga', 'hilfs_orga')
       UNION
       SELECT u.email FROM users u
       JOIN groups g ON g.id = u.group_id
       WHERE g.key IN ('admin', 'moderator')
     ) recipients`,
    [eventId]
  );
  return rows.map((r) => r.email);
}

// Never throws -- a delivery failure to one or all recipients must not turn
// a successful field save into a 500. Each recipient gets its own
// try/catch so one bad address doesn't stop the rest.
export async function notifyRegistrationOtFieldsChanged(eventId, userId) {
  try {
    const event = await getEvent(eventId);
    const { rows: userRows } = await query(
      'SELECT first_name, last_name, nickname FROM users WHERE id = $1',
      [userId]
    );
    const userName = userRows[0]
      ? displayName({ firstName: userRows[0].first_name, lastName: userRows[0].last_name, nickname: userRows[0].nickname })
      : 'Unbekannt';
    const eventName = event?.name ?? 'Unbekanntes Event';
    const recipients = await resolveOtFieldsChangeRecipients(eventId);
    // Build one transporter/from pair for the whole recipient loop instead of
    // per-recipient -- getTransporterAndFrom() re-reads SMTP settings and
    // opens a fresh nodemailer connection each time it's called, which would
    // otherwise serialize into N connect/greet/socket-timeout waits.
    const transport = await getTransporterAndFrom();
    for (const to of recipients) {
      try {
        await sendRegistrationOtFieldsChangedEmail(to, { userName, eventName }, transport);
      } catch (err) {
        logger.error('failed to send OT-fields-changed notification', { error: err.message, to, eventId, userId });
      }
    }
  } catch (err) {
    logger.error('failed to prepare OT-fields-changed notification', { error: err.message, eventId, userId });
  }
}

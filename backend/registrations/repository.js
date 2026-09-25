import { query, withTransaction } from '../db.js';
import { getEvent, resolvePriceForGroup } from '../events/repository.js';
import { applyTransition } from './statusMachine.js';
import { displayName } from '../displayName.js';
import { decryptFieldBlob as decryptAccountFieldBlob } from '../accountFields.js';
import { filterCharacterFields } from '../characters/visibility.js';
import { listOpenInvitationsForEvent } from '../invitations/repository.js';
import { getRegistrationFieldSchema } from '../registrationFieldSchema/repository.js';
import { encryptFieldBlob, decryptFieldBlob } from '../registrationFields.js';
import { sendRegistrationOtFieldsChangedEmail, sendWaitlistedEmail, sendWaitlistPromotedEmail, getTransporterAndFrom } from '../auth/mailer.js';
import { logger } from '../logger.js';
import { getAppSettings } from '../appSettings/repository.js';
import { buildPaymentReference } from '../payments/reference.js';

const SELF_SERVICE_CON_ROLES = ['sc', 'nsc', 'helfer'];
const STAFF_CON_ROLES = ['orga', 'hilfs_orga'];
const ALL_CON_ROLES = [...SELF_SERVICE_CON_ROLES, ...STAFF_CON_ROLES];
// Roles that don't play a character on-site, so approval doesn't require one assigned.
const CHARACTER_EXEMPT_CON_ROLES = [...STAFF_CON_ROLES, 'helfer'];
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
// belongs to userId, and is class='sc'; 'nsc' may optionally have one of
// class='nsc'; every other con_role must NOT have one.
// For an sc-class character, also enforces "at most one registration ever"
// (design spec 2026-09-16, section 4.3) -- excludes the caller's own
// (eventId, userId) row so re-saving an existing registration's con-role
// doesn't flag itself as a conflict. NSC stays exempt: it remains reusable
// across many events, unchanged from before this spec.
// Returns the characterId to store (null when none applies).
async function resolveCharacterId(userId, conRole, characterId, eventId) {
  const isRequired = CHARACTER_REQUIRED_CON_ROLES.includes(conRole);
  const isOptional = CHARACTER_OPTIONAL_CON_ROLES.includes(conRole);
  if (!isRequired && !isOptional) {
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
  const { rows } = await query('SELECT user_id, class FROM characters WHERE id = $1', [characterId]);
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
  const expectedClass = conRole === 'nsc' ? 'nsc' : 'sc';
  if (character.class !== expectedClass) {
    const err = new Error(`Rolle "${conRole}" erfordert einen Charakter der Klasse "${expectedClass}".`);
    err.code = 'CHARACTER_CLASS_MISMATCH';
    throw err;
  }
  if (expectedClass === 'sc') {
    const { rows: existing } = await query(
      'SELECT 1 FROM registrations WHERE character_id = $1 AND NOT (event_id = $2 AND user_id = $3)',
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

// Validates the "sc + also available as NSC" bolt-on: only meaningful when
// con_role='sc'; nscCharacterId (if given) must be the caller's own
// nsc-class character, with no "at most one" restriction (nsc characters
// stay reusable, same as resolveCharacterId's 'nsc' case).
// Returns { nscAvailable, nscCharacterId } to store.
async function resolveNscAvailability(userId, conRole, nscAvailable, nscCharacterId) {
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

  const { rows } = await query('SELECT user_id, class FROM characters WHERE id = $1', [nscCharacterId]);
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
  if (character.class !== 'nsc') {
    const err = new Error('nscCharacterId erfordert einen Charakter der Klasse "nsc".');
    err.code = 'CHARACTER_CLASS_MISMATCH';
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
  if (groups.length === 0) return { priceGroup: null, priceTier: null, priceListCents: null };
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
  };
}

export const COUNTED_STATUSES = ['pending', 'confirmed', 'checked_in', 'checked_out'];

export async function registerForEvent(userId, eventId, conRole, characterId, nscAvailable, nscCharacterId, flags, priceGroup, otFields, requestingUser) {
  const event = await getEvent(eventId);
  if (!event) {
    const err = new Error('event not found');
    err.code = 'EVENT_NOT_FOUND';
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

  const resolvedCharacterId = await resolveCharacterId(userId, conRole, characterId, eventId);
  const resolvedNsc = await resolveNscAvailability(userId, conRole, nscAvailable, nscCharacterId);
  const resolvedFlags = resolveFlags(event.flags, flags);
  const resolvedPrice = resolvePriceGroup(event, priceGroup);

  const schema = await getRegistrationFieldSchema();
  const data = {};
  for (const field of schema) {
    if (otFields?.[field.key] !== undefined) data[field.key] = otFields[field.key];
  }

  try {
    const registration = await withTransaction(async (client) => {
      const { rows: eventRows } = await client.query('SELECT capacity FROM events WHERE id = $1 FOR UPDATE', [eventId]);
      const capacity = eventRows[0]?.capacity ?? null;
      let status = 'pending';
      if (capacity !== null) {
        const { rows: countRows } = await client.query(
          'SELECT count(*)::int AS count FROM registrations WHERE event_id = $1 AND status = ANY($2::text[])',
          [eventId, COUNTED_STATUSES]
        );
        if (countRows[0].count >= capacity) status = 'waitlisted';
      }
      const { rows } = await client.query(
        `INSERT INTO registrations (user_id, event_id, con_role, character_id, nsc_available, nsc_character_id, flags, price_group, price_tier, price_list_cents, amount_due_cents, registration_data_enc, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $10, $11, $12)
         RETURNING user_id, event_id, status, con_role, character_id, nsc_available, nsc_character_id, flags, checked_in_at, checked_out_at`,
        [
          userId, eventId, conRole, resolvedCharacterId, resolvedNsc.nscAvailable, resolvedNsc.nscCharacterId, resolvedFlags,
          resolvedPrice.priceGroup, resolvedPrice.priceTier, resolvedPrice.priceListCents,
          encryptFieldBlob(data), status,
        ]
      );
      return rows[0];
    });
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
            await sendWaitlistedEmail(userRows[0].email, { eventName: event?.name ?? 'Unbekanntes Event' }, transport);
          }
        } catch (err) {
          logger.error('failed to send waitlisted notification', { error: err.message, userId, eventId });
        }
      })();
    }
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

export async function setConRole(eventId, userId, conRole, characterId, nscAvailable, nscCharacterId, flags, requestingUser) {
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
  const resolvedCharacterId = await resolveCharacterId(userId, conRole, characterId, eventId);
  const resolvedNsc = await resolveNscAvailability(userId, conRole, nscAvailable, nscCharacterId);

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

  const { rows } = await query(
    `UPDATE registrations SET con_role = $3, character_id = $4, nsc_available = $5, nsc_character_id = $6, flags = $7
     WHERE event_id = $1 AND user_id = $2
     RETURNING user_id, event_id, status, con_role, character_id, nsc_available, nsc_character_id, flags, checked_in_at, checked_out_at`,
    [eventId, userId, conRole, resolvedCharacterId, resolvedNsc.nscAvailable, resolvedNsc.nscCharacterId, resolvedFlags]
  );
  if (rows.length === 0) {
    const err = new Error('registration not found');
    err.code = 'REGISTRATION_NOT_FOUND';
    throw err;
  }
  return rows[0];
}

export async function unregisterFromEvent(userId, eventId) {
  const { rows: existingRows } = await query(
    'SELECT status FROM registrations WHERE user_id = $1 AND event_id = $2',
    [userId, eventId]
  );
  const previousStatus = existingRows[0]?.status;

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
  if (previousStatus === 'pending') {
    await maybePromoteFromWaitlist(eventId);
  }
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
    const { rows: eventRows } = await client.query('SELECT capacity FROM events WHERE id = $1 FOR UPDATE', [eventId]);
    const capacity = eventRows[0]?.capacity ?? null;
    if (capacity === null) return [];

    const promoted = [];
    for (;;) {
      const { rows: countRows } = await client.query(
        'SELECT count(*)::int AS count FROM registrations WHERE event_id = $1 AND status = ANY($2::text[])',
        [eventId, COUNTED_STATUSES]
      );
      if (countRows[0].count >= capacity) break;

      const { rows: nextRows } = await client.query(
        "SELECT user_id FROM registrations WHERE event_id = $1 AND status = 'waitlisted' ORDER BY created_at ASC LIMIT 1",
        [eventId]
      );
      if (nextRows.length === 0) break;

      await client.query(
        "UPDATE registrations SET status = 'pending' WHERE event_id = $1 AND user_id = $2 AND status = 'waitlisted'",
        [eventId, nextRows[0].user_id]
      );
      promoted.push(nextRows[0].user_id);
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
          if (userRows[0]) await sendWaitlistPromotedEmail(userRows[0].email, { eventName }, transport);
        } catch (err) {
          logger.error('failed to send waitlist-promoted notification', { error: err.message, userId, eventId });
        }
      }
    } catch (err) {
      logger.error('failed to prepare waitlist-promoted notifications', { error: err.message, eventId });
    }
  })();
}

export async function listParticipantsForEvent(eventId, { schema = [], viewer } = {}) {
  const otKeys = (viewer?.group?.accountFields ?? []).filter((key) => key !== 'group');

  const { rows: registrations } = await query(
    `SELECT r.user_id, u.first_name, u.last_name, u.nickname, r.status, r.con_role, r.nsc_available, r.nsc_character_id, r.flags, r.checked_in_at, r.checked_out_at,
            r.amount_due_cents, r.paid_at, r.price_group, r.price_tier, r.discount_cents, latest_payment.method AS payment_method,
            u.account_data_enc, r.registration_data_enc
     FROM registrations r
     JOIN users u ON u.id = r.user_id
     LEFT JOIN LATERAL (
       SELECT method FROM payments p
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
      flags: r.flags,
      checkedInAt: r.checked_in_at,
      checkedOutAt: r.checked_out_at,
      amountDueCents: r.amount_due_cents,
      paidAt: r.paid_at,
      priceGroup: r.price_group,
      priceTier: r.price_tier,
      discountCents: r.discount_cents,
      paymentMethod: r.payment_method,
      characters: charactersByUser.get(r.user_id) ?? [],
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
    paymentMethod: null,
    characters: [],
    otFields: {},
  }));

  return [...notified, ...registered];
}

export async function getScanLookup(eventId, userId) {
  const { rows } = await query(
    `SELECT r.user_id, u.first_name, u.last_name, u.nickname, g.key AS group_key, r.status, r.con_role, r.nsc_available, r.flags
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
    characters: characters.map((c) => ({ id: c.id, name: c.name })),
  };
}

export async function listRegistrationsForUser(userId) {
  const { rows } = await query(
    `SELECT r.event_id, e.name AS event_name, e.event_date, r.status, r.con_role, r.character_id, r.nsc_available, r.nsc_character_id, r.flags, r.checked_in_at, r.checked_out_at,
            r.amount_due_cents, r.paid_at, r.price_group, r.price_tier,
            r.registration_data_enc, c.name AS character_name, nc.name AS nsc_character_name
     FROM registrations r
     JOIN events e ON e.id = r.event_id
     LEFT JOIN characters c ON c.id = r.character_id
     LEFT JOIN characters nc ON nc.id = r.nsc_character_id
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
    flags: r.flags,
    checkedInAt: r.checked_in_at,
    checkedOutAt: r.checked_out_at,
    amountDueCents: r.amount_due_cents,
    paidAt: r.paid_at,
    priceGroup: r.price_group,
    priceTier: r.price_tier,
    paymentReference: buildPaymentReference(r.event_id, userId),
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

export async function checkIn(eventId, userId) {
  return transitionStatus(eventId, userId, 'checkin');
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
  await maybePromoteFromWaitlist(eventId);
  return result;
}

export async function setStatus(eventId, userId, status, expectedStatus) {
  // A manual override moving a counted registration back to 'waitlisted'
  // means it's rejoining the waitlist NOW, not whenever it originally
  // registered. maybePromoteFromWaitlist promotes oldest-created_at-first,
  // so without this the rejoining row would keep its old created_at from
  // its original registration and could jump ahead of (or, worse, be
  // immediately re-selected over) people who have genuinely been waiting
  // since before it was demoted -- created_at has no other reader (see
  // maybePromoteFromWaitlist's ORDER BY), so resetting it here is safe.
  const rejoinsWaitlist = status === 'waitlisted' && COUNTED_STATUSES.includes(expectedStatus);
  const { rows } = await query(
    `UPDATE registrations SET
       status = $4,
       created_at = CASE WHEN $5 THEN now() ELSE created_at END,
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
          await sendWaitlistPromotedEmail(userRows[0].email, { eventName: event?.name ?? 'Unbekanntes Event' }, transport);
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
    if (otFields[field.key] !== undefined) nextData[field.key] = otFields[field.key];
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

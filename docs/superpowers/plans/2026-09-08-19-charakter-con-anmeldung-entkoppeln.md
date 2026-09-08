# Charakter/Con-Anmeldung entkoppeln Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Decouple character creation from event registration — characters become account-wide (like NSC characters already are), `registrations.character_id` links a registration to a specific character, and a new standalone `con-anmeldungen.html` page takes over the registration UI that `characters.html` grew in Teil 1.

**Architecture:** `characters.event_id` is dropped entirely (both classes become account-wide). `registrations.character_id` (nullable, CHECK-constrained against `con_role`) replaces the implicit `characters.event_id`-based lookup everywhere. Event-specific character data is written through `PUT /characters/:id` with an `eventId`, which validates the submitted fragment against that event's schema and *merges* it into the character's existing `data` — so a character accumulates fields across every event it registers for instead of being locked to one schema.

**Tech Stack:** Same as the rest of this app — Node.js stdlib backend, `pg`, vanilla JS frontend, no build step.

**Spec:** `docs/superpowers/specs/2026-09-08-charakter-con-anmeldung-entkoppeln-design.md`

## Global Constraints

- No frontend framework, no build step, no new npm dependencies.
- The LAST task must run the full `npm test` suite as an explicit step.
- `characters.event_id` and `registrations.character_id` are dropped/added and every backend consumer of the old column fixed in the SAME task — the column drop alone breaks `characters/repository.js`, `characters/routes.js`, and `registrations/repository.js`'s `listParticipantsForEvent`/`getScanLookup` simultaneously, so splitting this across a task boundary would leave an intermediate task whose own deliverable is a broken app (same lesson as Teil 1's Task 1).
- `validateCharacterData` (unchanged) rejects unknown keys — so an event-scoped character-data write must validate ONLY the submitted fragment against that event's schema, then merge the validated fragment into the character's existing `data`, never re-validate the whole accumulated `data` against a single schema.
- The `event.is_active` gate that used to apply only to `sc`-class character creation now applies, generalized, to every self-service `con_role` (`sc`/`gsc`/`nsc`/`helfer`) at registration time — non-`canEditCharacters` users may only create a NEW registration for the currently active event.
- Editing an existing registration to switch which character it references is explicitly out of scope — unregister (only possible while `status='pending'`, unchanged existing rule) and re-register with the correct character instead.
- Every existing test must still pass; verify with each task's specified scope before the final full-suite gate.
- Verify visually via Claude Browser tools for every page touched.

---

### Task 1: Datenmodell + Backend

**Files:**
- Create: `db/migrations/028_charakter_con_anmeldung_entkoppeln.sql`
- Modify: `backend/characters/repository.js`
- Modify: `backend/characters/routes.js`
- Modify: `backend/registrations/repository.js`
- Modify: `backend/registrations/routes.js`
- Modify: `tests/integration/characters.test.js`
- Modify: `tests/integration/charactersVisibility.test.js`
- Modify: `tests/integration/registrations.test.js`
- Modify: `tests/integration/checkin.test.js`
- Modify: `tests/integration/scanLookup.test.js`
- Modify: `tests/integration/schema-registrations.test.js`

**Interfaces:**
- Produces: `characters` table with no `event_id` column — `id, user_id, class, name, data, created_at`. Produces: `registrations.character_id` (nullable `uuid REFERENCES characters(id)`, CHECK-constrained: NOT NULL when `con_role IN ('sc','gsc','nsc')`, NULL when `con_role IN ('helfer','orga','hilfs_orga')`).
- Produces: `createCharacter(userId, { characterClass, name, data })` (no `eventId` param — was `{ characterClass, eventId, name, data }`).
- Produces: `updateCharacter(id, userId, { name, data, eventId })` — `eventId` is a NEW, required-when-`data`-is-present-for-sc param; merges the validated fragment into existing `data` instead of replacing it.
- Produces: `registerForEvent(userId, eventId, conRole, characterId, requestingUser)` (new `characterId` param, inserted before `requestingUser`) — throws `err.code` one of `EVENT_NOT_FOUND`, `INVALID_CON_ROLE`, `FORBIDDEN_CON_ROLE`, `EVENT_NOT_ACTIVE` (new), `CHARACTER_REQUIRED`/`CHARACTER_NOT_ALLOWED`/`CHARACTER_NOT_FOUND`/`CHARACTER_FORBIDDEN`/`CHARACTER_CLASS_MISMATCH` (new), `ALREADY_REGISTERED`.
- Produces: `setConRole(eventId, userId, conRole, characterId, requestingUser)` (new `characterId` param, inserted before `requestingUser`) — same new error codes as `registerForEvent` for character validation, plus existing `INVALID_CON_ROLE`/`FORBIDDEN_CON_ROLE`/`REGISTRATION_NOT_FOUND`.
- Produces: `approveRegistration(eventId, userId)` — simplified, no longer throws `NO_CHARACTER` (the DB CHECK constraint now guarantees every `sc`/`gsc`/`nsc` registration has a character).

- [ ] **Step 1: Write the migration**

Create `db/migrations/028_charakter_con_anmeldung_entkoppeln.sql`:

```sql
-- 1. registrations.character_id (nullable first, backfilled below — the
--    backfill needs characters.event_id, which is dropped at the very end).
ALTER TABLE registrations ADD COLUMN character_id uuid REFERENCES characters(id);

-- 2a. Backfill sc/gsc registrations: link to the oldest sc-class character
--     the same user created for that same event.
UPDATE registrations r SET character_id = sub.character_id
FROM (
  SELECT DISTINCT ON (r2.user_id, r2.event_id) r2.user_id, r2.event_id, c.id AS character_id
  FROM registrations r2
  JOIN characters c ON c.user_id = r2.user_id AND c.event_id = r2.event_id AND c.class = 'sc'
  WHERE r2.con_role IN ('sc', 'gsc')
  ORDER BY r2.user_id, r2.event_id, c.created_at ASC
) sub
WHERE r.user_id = sub.user_id AND r.event_id = sub.event_id AND r.con_role IN ('sc', 'gsc');

-- 2b. Backfill nsc registrations: link to the oldest nsc-class character the
--     user owns (nsc characters were always account-wide, never event-bound).
UPDATE registrations r SET character_id = sub.character_id
FROM (
  SELECT DISTINCT ON (r2.user_id) r2.user_id, c.id AS character_id
  FROM registrations r2
  JOIN characters c ON c.user_id = r2.user_id AND c.class = 'nsc'
  WHERE r2.con_role = 'nsc'
  ORDER BY r2.user_id, c.created_at ASC
) sub
WHERE r.user_id = sub.user_id AND r.con_role = 'nsc';

-- 3. Enforce the invariant going forward.
ALTER TABLE registrations ADD CONSTRAINT registrations_character_con_role_check
  CHECK (
    (con_role IN ('sc', 'gsc', 'nsc') AND character_id IS NOT NULL)
    OR (con_role IN ('helfer', 'orga', 'hilfs_orga') AND character_id IS NULL)
  );

-- 4. characters.event_id is superseded by registrations.character_id.
ALTER TABLE characters DROP CONSTRAINT characters_class_event_check;
ALTER TABLE characters DROP COLUMN event_id;
```

- [ ] **Step 2: Rewrite `backend/characters/repository.js`**

```javascript
import { query } from '../db.js';
import { validateCharacterData } from '../events/schemaValidation.js';
import { getEvent } from '../events/repository.js';
import { getNscProfileSchema } from '../nscSchema/repository.js';

const SELECT_COLUMNS = 'id, user_id, class, name, data, created_at';

export async function createCharacter(userId, { characterClass, name, data }) {
  if (characterClass === 'nsc') {
    const schema = await getNscProfileSchema();
    const errors = validateCharacterData(schema, data ?? {});
    if (errors.length > 0) {
      const err = new Error('invalid character data');
      err.code = 'INVALID_CHARACTER_DATA';
      err.details = errors;
      throw err;
    }
    const { rows } = await query(
      `INSERT INTO characters (user_id, class, name, data)
       VALUES ($1, 'nsc', $2, $3)
       RETURNING ${SELECT_COLUMNS}`,
      [userId, name, JSON.stringify(data ?? {})]
    );
    return rows[0];
  }

  const { rows } = await query(
    `INSERT INTO characters (user_id, class, name, data)
     VALUES ($1, 'sc', $2, '{}')
     RETURNING ${SELECT_COLUMNS}`,
    [userId, name]
  );
  return rows[0];
}

export async function getCharacter(id) {
  const { rows } = await query(`SELECT ${SELECT_COLUMNS} FROM characters WHERE id = $1`, [id]);
  return rows[0] ?? null;
}

export async function listCharactersForUser(userId) {
  const { rows } = await query(
    `SELECT ${SELECT_COLUMNS} FROM characters WHERE user_id = $1 ORDER BY created_at`,
    [userId]
  );
  return rows;
}

// Characters registered for a given event, found via the registration link
// (not a direct column anymore — a character can be registered for many
// events, so "its" event only exists in the context of one registration).
export async function listCharactersForEvent(eventId) {
  const { rows } = await query(
    `SELECT c.id, c.user_id, c.class, c.name, c.data, c.created_at
     FROM characters c
     JOIN registrations r ON r.character_id = c.id
     WHERE r.event_id = $1 AND c.class = 'sc'
     ORDER BY c.name`,
    [eventId]
  );
  return rows;
}

export async function updateCharacter(id, userId, { name, data, eventId }) {
  const character = await getCharacter(id);
  if (!character || character.user_id !== userId) return null;

  let mergedData;
  if (data !== undefined) {
    if (character.class === 'nsc') {
      const schema = await getNscProfileSchema();
      const errors = validateCharacterData(schema, data);
      if (errors.length > 0) {
        const err = new Error('invalid character data');
        err.code = 'INVALID_CHARACTER_DATA';
        err.details = errors;
        throw err;
      }
      mergedData = data;
    } else {
      if (!eventId) {
        const err = new Error('eventId is required when updating data for an sc-class character');
        err.code = 'EVENT_ID_REQUIRED';
        throw err;
      }
      const event = await getEvent(eventId);
      if (!event) {
        const err = new Error('event not found');
        err.code = 'EVENT_NOT_FOUND';
        throw err;
      }
      // The submitted `data` is validated as a complete fragment against
      // THIS event's schema (must contain exactly this schema's fields,
      // validateCharacterData rejects unknown keys) -- then merged into the
      // character's existing data so fields from other events' schemas
      // survive, instead of being wiped by a full replace.
      const errors = validateCharacterData(event.character_form_schema, data);
      if (errors.length > 0) {
        const err = new Error('invalid character data');
        err.code = 'INVALID_CHARACTER_DATA';
        err.details = errors;
        throw err;
      }
      mergedData = { ...character.data, ...data };
    }
  }

  const { rows } = await query(
    `UPDATE characters SET
       name = COALESCE($3, name),
       data = COALESCE($4, data)
     WHERE id = $1 AND user_id = $2
     RETURNING ${SELECT_COLUMNS}`,
    [id, userId, name ?? null, mergedData !== undefined ? JSON.stringify(mergedData) : null]
  );
  return rows[0] ?? null;
}
```

- [ ] **Step 3: Rewrite `backend/characters/routes.js`**

```javascript
import { router } from '../routes.js';
import { requireAuth } from '../middleware/authenticate.js';
import { readJsonBody } from '../httpBody.js';
import { getEvent } from '../events/repository.js';
import { createCharacter, getCharacter, listCharactersForUser, listCharactersForEvent, updateCharacter } from './repository.js';
import { filterCharacterFields } from './visibility.js';
import { getNscProfileSchema } from '../nscSchema/repository.js';

router.post('/characters', requireAuth(async ({ req, user }) => {
  const body = await readJsonBody(req);
  if (body === null) return { status: 400, body: { error: 'invalid JSON' } };
  const { class: characterClass = 'sc', name, data } = body;
  if (characterClass !== 'sc' && characterClass !== 'nsc') {
    return { status: 400, body: { error: 'class must be "sc" or "nsc"' } };
  }
  if (!name) {
    return { status: 400, body: { error: 'name is required' } };
  }

  try {
    const character = await createCharacter(user.id, { characterClass, name, data });
    return { status: 201, body: character };
  } catch (err) {
    if (err.code === 'INVALID_CHARACTER_DATA') {
      return { status: 400, body: { error: 'invalid character data', details: err.details } };
    }
    throw err;
  }
}));

router.get('/characters', requireAuth(async ({ user }) => {
  const characters = await listCharactersForUser(user.id);
  return { status: 200, body: characters };
}));

router.get('/events/:eventId/characters/public', requireAuth(async ({ params, user }) => {
  const event = await getEvent(params.eventId);
  if (!event) return { status: 404, body: { error: 'event not found' } };
  const characters = await listCharactersForEvent(params.eventId);
  const filtered = characters.map((c) => ({
    id: c.id,
    name: c.name,
    userId: c.user_id,
    data: filterCharacterFields(c, event.character_form_schema, user),
  }));
  return { status: 200, body: filtered };
}));

router.get('/characters/:id', requireAuth(async ({ params, user }) => {
  const character = await getCharacter(params.id);
  if (!character) return { status: 404, body: { error: 'character not found' } };

  const isOwner = character.user_id === user.id;
  const isElevated = user.group.canOverrideCheckinStatus;
  if (isOwner || isElevated) {
    return { status: 200, body: character };
  }

  // A stranger viewing an sc-class character by id (not through the
  // per-event /events/:eventId/characters/public list) has no single event
  // context to resolve "which schema's public fields" against anymore --
  // an sc character can be registered for many events with different
  // schemas. Default to showing nothing but the name (empty schema means
  // filterCharacterFields' publicKeys set is empty), same safe-default
  // this endpoint already used for the class it doesn't own a schema for.
  const schema = character.class === 'nsc' ? await getNscProfileSchema() : [];
  return { status: 200, body: { ...character, data: filterCharacterFields(character, schema, user) } };
}));

router.put('/characters/:id', requireAuth(async ({ req, params, user }) => {
  const character = await getCharacter(params.id);
  if (!character) return { status: 404, body: { error: 'character not found' } };
  const isOwner = character.user_id === user.id;
  const isElevated = user.group.canOverrideCheckinStatus;
  if (!isOwner && !isElevated) {
    return { status: 403, body: { error: 'forbidden' } };
  }
  const body = await readJsonBody(req);
  if (body === null) return { status: 400, body: { error: 'invalid JSON' } };
  try {
    const updated = await updateCharacter(params.id, character.user_id, body);
    return { status: 200, body: updated };
  } catch (err) {
    if (err.code === 'EVENT_NOT_FOUND') return { status: 404, body: { error: 'event not found' } };
    if (err.code === 'EVENT_ID_REQUIRED') return { status: 400, body: { error: err.message } };
    if (err.code === 'INVALID_CHARACTER_DATA') {
      return { status: 400, body: { error: 'invalid character data', details: err.details } };
    }
    throw err;
  }
}));
```

- [ ] **Step 4: Rewrite `backend/registrations/repository.js`**

```javascript
import { query } from '../db.js';
import { getEvent } from '../events/repository.js';
import { applyTransition } from './statusMachine.js';
import { displayName } from '../displayName.js';
import { decryptField } from '../crypto/fieldCrypto.js';
import { ENCRYPTED_ACCOUNT_FIELD_COLUMNS } from '../accountFields.js';
import { filterCharacterFields } from '../characters/visibility.js';
import { listOpenInvitationsForEvent } from '../invitations/repository.js';

const SELF_SERVICE_CON_ROLES = ['sc', 'nsc', 'gsc', 'helfer'];
const STAFF_CON_ROLES = ['orga', 'hilfs_orga'];
const ALL_CON_ROLES = [...SELF_SERVICE_CON_ROLES, ...STAFF_CON_ROLES];
// Roles that don't play a character on-site, so approval doesn't require one assigned.
const CHARACTER_EXEMPT_CON_ROLES = [...STAFF_CON_ROLES, 'helfer'];
// Roles whose registration must reference a specific character.
const CHARACTER_REQUIRED_CON_ROLES = ['sc', 'gsc', 'nsc'];

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

// Validates characterId against con_role: CHARACTER_REQUIRED_CON_ROLES must
// have one that exists, belongs to userId, and has the matching class
// (sc/gsc -> 'sc', nsc -> 'nsc'); every other con_role must NOT have one.
// Returns the characterId to store (always null for non-character roles).
async function resolveCharacterId(userId, conRole, characterId) {
  if (!CHARACTER_REQUIRED_CON_ROLES.includes(conRole)) {
    if (characterId) {
      const err = new Error(`characterId must not be set for con_role "${conRole}"`);
      err.code = 'CHARACTER_NOT_ALLOWED';
      throw err;
    }
    return null;
  }
  if (!characterId) {
    const err = new Error(`characterId is required for con_role "${conRole}"`);
    err.code = 'CHARACTER_REQUIRED';
    throw err;
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
    const err = new Error(`con_role "${conRole}" requires a character of class "${expectedClass}"`);
    err.code = 'CHARACTER_CLASS_MISMATCH';
    throw err;
  }
  return characterId;
}

export async function registerForEvent(userId, eventId, conRole, characterId, requestingUser) {
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
    const err = new Error('registration is only open for the currently active event');
    err.code = 'EVENT_NOT_ACTIVE';
    throw err;
  }

  const resolvedCharacterId = await resolveCharacterId(userId, conRole, characterId);

  try {
    const { rows } = await query(
      `INSERT INTO registrations (user_id, event_id, con_role, character_id)
       VALUES ($1, $2, $3, $4)
       RETURNING user_id, event_id, status, con_role, character_id, checked_in_at, checked_out_at`,
      [userId, eventId, conRole, resolvedCharacterId]
    );
    return rows[0];
  } catch (err) {
    if (err.code === '23505') {
      const dup = new Error('already registered for this event');
      dup.code = 'ALREADY_REGISTERED';
      throw dup;
    }
    throw err;
  }
}

export async function setConRole(eventId, userId, conRole, characterId, requestingUser) {
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
  const resolvedCharacterId = await resolveCharacterId(userId, conRole, characterId);

  const { rows } = await query(
    `UPDATE registrations SET con_role = $3, character_id = $4
     WHERE event_id = $1 AND user_id = $2
     RETURNING user_id, event_id, status, con_role, character_id, checked_in_at, checked_out_at`,
    [eventId, userId, conRole, resolvedCharacterId]
  );
  if (rows.length === 0) {
    const err = new Error('registration not found');
    err.code = 'REGISTRATION_NOT_FOUND';
    throw err;
  }
  return rows[0];
}

export async function unregisterFromEvent(userId, eventId) {
  const { rowCount } = await query(
    "DELETE FROM registrations WHERE user_id = $1 AND event_id = $2 AND status = 'pending'",
    [userId, eventId]
  );
  if (rowCount === 0) {
    const { rows } = await query(
      'SELECT status FROM registrations WHERE user_id = $1 AND event_id = $2',
      [userId, eventId]
    );
    if (rows.length === 0) {
      const err = new Error('registration not found');
      err.code = 'REGISTRATION_NOT_FOUND';
      throw err;
    }
    const err = new Error('cannot unregister after check-in');
    err.code = 'CANNOT_UNREGISTER';
    throw err;
  }
}

export async function listParticipantsForEvent(eventId, { schema = [], viewer } = {}) {
  const otKeys = (viewer?.group?.accountFields ?? []).filter((key) => key in ENCRYPTED_ACCOUNT_FIELD_COLUMNS);
  const otColumnsSql = otKeys.map((key) => `, u.${ENCRYPTED_ACCOUNT_FIELD_COLUMNS[key]}`).join('');

  const { rows: registrations } = await query(
    `SELECT r.user_id, u.first_name, u.last_name, u.nickname, r.status, r.con_role, r.checked_in_at, r.checked_out_at${otColumnsSql}
     FROM registrations r
     JOIN users u ON u.id = r.user_id
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

  const registered = registrations.map((r) => ({
    userId: r.user_id,
    invitationId: null,
    name: displayName({ firstName: r.first_name, lastName: r.last_name, nickname: r.nickname }),
    status: r.status,
    conRole: r.con_role,
    checkedInAt: r.checked_in_at,
    checkedOutAt: r.checked_out_at,
    characters: charactersByUser.get(r.user_id) ?? [],
    otFields: Object.fromEntries(otKeys.map((key) => [key, decryptField(r[ENCRYPTED_ACCOUNT_FIELD_COLUMNS[key]])])),
  }));

  const notified = (await listOpenInvitationsForEvent(eventId)).map((inv) => ({
    userId: null,
    invitationId: inv.invitationId,
    name: inv.name,
    status: 'notified',
    checkedInAt: null,
    checkedOutAt: null,
    characters: [],
    otFields: {},
  }));

  return [...notified, ...registered];
}

export async function getScanLookup(eventId, userId) {
  const { rows } = await query(
    `SELECT r.user_id, u.first_name, u.last_name, u.nickname, g.key AS group_key, r.status, r.con_role
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
    characters: characters.map((c) => ({ id: c.id, name: c.name })),
  };
}

export async function listRegistrationsForUser(userId) {
  const { rows } = await query(
    `SELECT r.event_id, e.name AS event_name, e.event_date, r.status, r.con_role, r.character_id, r.checked_in_at, r.checked_out_at
     FROM registrations r
     JOIN events e ON e.id = r.event_id
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
    checkedInAt: r.checked_in_at,
    checkedOutAt: r.checked_out_at,
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
    const err = new Error('invalid transition: registration status changed concurrently');
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
// registrations_character_con_role_check CHECK constraint now guarantees
// every sc/gsc/nsc registration already has a character_id at INSERT time,
// so there's nothing left to verify here.
export async function approveRegistration(eventId, userId) {
  return transitionStatus(eventId, userId, 'approve');
}

export async function cancelRegistration(eventId, userId) {
  return transitionStatus(eventId, userId, 'cancel');
}

export async function setStatus(eventId, userId, status, expectedStatus) {
  const { rows } = await query(
    `UPDATE registrations SET
       status = $4,
       checked_in_at = CASE
         WHEN $4 IN ('pending', 'confirmed', 'cancelled') THEN NULL
         WHEN $4 = 'checked_in' AND checked_in_at IS NULL THEN now()
         ELSE checked_in_at
       END,
       checked_out_at = CASE
         WHEN $4 IN ('pending', 'confirmed', 'cancelled', 'checked_in') THEN NULL
         WHEN checked_out_at IS NULL THEN now()
         ELSE checked_out_at
       END
     WHERE event_id = $1 AND user_id = $2 AND status = $3
     RETURNING user_id, event_id, status, checked_in_at, checked_out_at`,
    [eventId, userId, expectedStatus, status]
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
    const err = new Error('status changed concurrently');
    err.code = 'STATUS_CONFLICT';
    throw err;
  }
  return rows[0];
}
```

(`listRegistrationsForUser` gains `conRole`/`characterId` in its output — not strictly required by this task's backend, but Task 2's frontend needs them to render the "Meine Anmeldungen" list with a role/character label without a second round-trip.)

- [ ] **Step 5: Update `backend/registrations/routes.js`**

Change the register handler to read `characterId` from the body:

```javascript
router.post('/events/:id/register', requireAuth(async ({ req, params, user }) => {
  const body = await readJsonBody(req);
  if (body === null) return { status: 400, body: { error: 'invalid JSON' } };
  try {
    const registration = await registerForEvent(user.id, params.id, body.conRole, body.characterId, user);
    return { status: 201, body: registration };
  } catch (err) {
    if (err.code === 'EVENT_NOT_FOUND') return { status: 404, body: { error: 'event not found' } };
    if (err.code === 'ALREADY_REGISTERED') return { status: 409, body: { error: err.message } };
    if (err.code === 'INVALID_CON_ROLE') return { status: 400, body: { error: err.message } };
    if (err.code === 'FORBIDDEN_CON_ROLE') return { status: 403, body: { error: err.message } };
    if (err.code === 'EVENT_NOT_ACTIVE') return { status: 403, body: { error: err.message } };
    if (err.code === 'CHARACTER_REQUIRED' || err.code === 'CHARACTER_NOT_ALLOWED' || err.code === 'CHARACTER_CLASS_MISMATCH') {
      return { status: 400, body: { error: err.message } };
    }
    if (err.code === 'CHARACTER_NOT_FOUND') return { status: 404, body: { error: err.message } };
    if (err.code === 'CHARACTER_FORBIDDEN') return { status: 403, body: { error: err.message } };
    throw err;
  }
}));
```

Change the promotion handler to also read `characterId`:

```javascript
router.put('/events/:id/registrations/:userId/con-role', requireAuth(async ({ req, params, user }) => {
  const body = await readJsonBody(req);
  if (body === null) return { status: 400, body: { error: 'invalid JSON' } };
  try {
    const registration = await setConRole(params.id, params.userId, body.conRole, body.characterId, user);
    return { status: 200, body: registration };
  } catch (err) {
    if (err.code === 'REGISTRATION_NOT_FOUND') return { status: 404, body: { error: 'registration not found' } };
    if (err.code === 'INVALID_CON_ROLE') return { status: 400, body: { error: err.message } };
    if (err.code === 'FORBIDDEN_CON_ROLE') return { status: 403, body: { error: err.message } };
    if (err.code === 'CHARACTER_REQUIRED' || err.code === 'CHARACTER_NOT_ALLOWED' || err.code === 'CHARACTER_CLASS_MISMATCH') {
      return { status: 400, body: { error: err.message } };
    }
    if (err.code === 'CHARACTER_NOT_FOUND') return { status: 404, body: { error: err.message } };
    if (err.code === 'CHARACTER_FORBIDDEN') return { status: 403, body: { error: err.message } };
    throw err;
  }
}));
```

- [ ] **Step 6: Fix `tests/integration/characters.test.js`**

Read the whole file first. Every call to `POST /characters` for `class: 'sc'` (or the default class) that currently sends `eventId` in the body must lose that field — character creation no longer accepts it. Every test that previously relied on the created character having schema-validated `data` at creation time must instead: (1) create the character with just `{ name }` (or `{ class: 'sc', name }`), (2) separately call `PUT /characters/:id` with `{ eventId, data }` to write the event-scoped fields, and assert against THAT response instead. Every test asserting a 400 for invalid `data` against an event's schema at creation time must move that assertion to the `PUT .../:id` call instead (creation can no longer be invalid on `data`, since it no longer accepts any).

Add a new test proving the merge behavior spec section 4/5.2 describes:

```javascript
test('a character\'s data accumulates fields across two events with different schemas', async () => {
  await withTestServer(async (port) => {
    const participant = await makeUserAndSession();
    const eventA = await makeEvent([{ key: 'fraction', label: 'Fraktion', type: 'text', required: true }]);
    const eventB = await makeEvent([{ key: 'waffenklasse', label: 'Waffenklasse', type: 'text', required: true }]);

    const createRes = await fetch(`http://localhost:${port}/characters`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: participant.cookie },
      body: JSON.stringify({ name: 'Aldric' }),
    });
    assert.equal(createRes.status, 201);
    const { id } = await createRes.json();

    const putA = await fetch(`http://localhost:${port}/characters/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Cookie: participant.cookie },
      body: JSON.stringify({ eventId: eventA, data: { fraction: 'Nordmark' } }),
    });
    assert.equal(putA.status, 200);
    assert.deepEqual((await putA.json()).data, { fraction: 'Nordmark' });

    const putB = await fetch(`http://localhost:${port}/characters/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Cookie: participant.cookie },
      body: JSON.stringify({ eventId: eventB, data: { waffenklasse: 'Schwert' } }),
    });
    assert.equal(putB.status, 200);
    assert.deepEqual((await putB.json()).data, { fraction: 'Nordmark', waffenklasse: 'Schwert' });
  });
});

test('PUT /characters/:id rejects an sc-class data update with no eventId', async () => {
  await withTestServer(async (port) => {
    const participant = await makeUserAndSession();
    const createRes = await fetch(`http://localhost:${port}/characters`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: participant.cookie },
      body: JSON.stringify({ name: 'Aldric' }),
    });
    const { id } = await createRes.json();

    const res = await fetch(`http://localhost:${port}/characters/${id}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json', Cookie: participant.cookie },
      body: JSON.stringify({ data: { fraction: 'Nordmark' } }),
    });
    assert.equal(res.status, 400);
  });
});
```

- [ ] **Step 7: Fix `tests/integration/charactersVisibility.test.js`**

Read the whole file first. Same transformation as Step 6: every character creation drops `eventId`; any field data (`fraction`, `secretNote`) is written via a follow-up `PUT /characters/:id` with `{ eventId, data }` before the visibility assertions run.

- [ ] **Step 8: Fix `tests/integration/registrations.test.js`**

Read the whole file first. Every `POST /events/:id/register` call with `conRole: 'sc'`, `'gsc'`, or `'nsc'` now additionally requires a real `characterId` — for each such call, create a matching character first (`POST /characters` with the right `class`, no `eventId`) and pass its `id` as `characterId` in the register call. Calls with `conRole: 'helfer'`/`'orga'`/`'hilfs_orga'` need no `characterId` (must stay absent/`null` — do not add one).

Add tests for the new character-validation error paths on `POST /events/:id/register`:

```javascript
test('registering with con_role sc and no characterId is rejected', async () => {
  await withTestServer(async (port) => {
    const { cookie } = await makeUserAndSession();
    const eventId = await makeEvent();
    const res = await fetch(`http://localhost:${port}/events/${eventId}/register`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ conRole: 'sc' }),
    });
    assert.equal(res.status, 400);
  });
});

test('registering with con_role sc and someone else\'s characterId is rejected', async () => {
  await withTestServer(async (port) => {
    const owner = await makeUserAndSession();
    const stranger = await makeUserAndSession();
    const eventId = await makeEvent();
    const charRes = await fetch(`http://localhost:${port}/characters`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: owner.cookie },
      body: JSON.stringify({ name: 'Aldric' }),
    });
    const { id: characterId } = await charRes.json();

    const res = await fetch(`http://localhost:${port}/events/${eventId}/register`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: stranger.cookie },
      body: JSON.stringify({ conRole: 'sc', characterId }),
    });
    assert.equal(res.status, 403);
  });
});

test('registering with con_role nsc and an sc-class character is rejected (class mismatch)', async () => {
  await withTestServer(async (port) => {
    const { cookie } = await makeUserAndSession();
    const eventId = await makeEvent();
    const charRes = await fetch(`http://localhost:${port}/characters`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ name: 'Aldric' }),
    });
    const { id: characterId } = await charRes.json();

    const res = await fetch(`http://localhost:${port}/events/${eventId}/register`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ conRole: 'nsc', characterId }),
    });
    assert.equal(res.status, 400);
  });
});

test('registering with con_role helfer and a characterId set is rejected', async () => {
  await withTestServer(async (port) => {
    const { cookie } = await makeUserAndSession();
    const eventId = await makeEvent();
    const charRes = await fetch(`http://localhost:${port}/characters`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ name: 'Aldric' }),
    });
    const { id: characterId } = await charRes.json();

    const res = await fetch(`http://localhost:${port}/events/${eventId}/register`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ conRole: 'helfer', characterId }),
    });
    assert.equal(res.status, 400);
  });
});

test('a non-privileged user cannot register with a self-service con_role for an inactive event', async () => {
  await withTestServer(async (port) => {
    const { cookie } = await makeUserAndSession();
    const { query } = await import('../../backend/db.js');
    const { rows } = await query(
      "INSERT INTO events (name, event_date, is_active) VALUES ('Inactive Con', '2027-01-01', false) RETURNING id"
    );
    const eventId = rows[0].id;

    const res = await fetch(`http://localhost:${port}/events/${eventId}/register`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ conRole: 'helfer' }),
    });
    assert.equal(res.status, 403);
  });
});
```

Update the existing `approveRegistration`-related tests: the old `NO_CHARACTER`/409 tests for missing characters at approval time no longer apply the same way (a registration can't be created without a character for sc/gsc/nsc anymore) — remove any test that specifically asserted a 409 from `approveRegistration` due to a missing character on an sc/gsc/nsc registration; the `helfer`-succeeds-without-a-character test stays (still valid, `helfer` is character-exempt by design, unrelated to this change).

- [ ] **Step 9: Fix `tests/integration/checkin.test.js`**

Run this to find every raw registrations INSERT in the file:

```bash
grep -n "INSERT INTO registrations" tests/integration/checkin.test.js
```

Read the whole file. Add a small helper near the top (alongside `makeUserAndSession`/`makeEvent`):

```javascript
async function makeCharacter(userId) {
  const { rows } = await query(
    "INSERT INTO characters (user_id, class, name, data) VALUES ($1, 'sc', 'Test Char', '{}') RETURNING id",
    [userId]
  );
  return rows[0].id;
}
```

For every raw `INSERT INTO registrations (user_id, event_id, ...)` statement in this file (none of them currently set `con_role`, so they all default to `'sc'` via the column's `DEFAULT 'sc'` bridge from Teil 1 — after this migration, `'sc'` requires a `character_id`): call `const characterId = await makeCharacter(<that row's user id>);` beforehand, then add `character_id` to the INSERT's column list and `$<n>` placeholder list with `characterId` in the params array. Do this for every occurrence the grep above found — do not skip any, an unfixed one will fail with a CHECK-constraint violation.

- [ ] **Step 10: Fix `tests/integration/scanLookup.test.js`**

Same transformation as Step 9: find every raw `INSERT INTO registrations` in this file, add a `makeCharacter`-style helper if one doesn't already exist, and supply `character_id` for every row (they default to `con_role = 'sc'`).

- [ ] **Step 11: Fix `tests/integration/schema-registrations.test.js`**

Same transformation as Step 9 for any raw `INSERT INTO registrations` in this file. Also add a test confirming the new constraint exists and behaves correctly:

```javascript
test('registrations_character_con_role_check rejects an sc registration with no character_id', async () => {
  const { query } = await import('../../backend/db.js');
  const { rows: userRows } = await query(
    "INSERT INTO users (email, first_name, last_name, group_id, email_verified) VALUES ($1, 'C', 'T', (SELECT id FROM groups WHERE key = 'mitglied'), true) RETURNING id",
    [`schema-reg-${crypto.randomUUID()}@example.com`]
  );
  const { rows: eventRows } = await query(
    "INSERT INTO events (name, event_date) VALUES ('Schema Con', '2027-01-01') RETURNING id"
  );
  await assert.rejects(
    query(
      "INSERT INTO registrations (user_id, event_id, con_role) VALUES ($1, $2, 'sc')",
      [userRows[0].id, eventRows[0].id]
    ),
    /registrations_character_con_role_check/
  );
});
```

(Add `import crypto from 'node:crypto';` at the top of the file if it isn't already imported — check first.)

- [ ] **Step 12: Run the tests**

Run: `node --test tests/integration/characters.test.js tests/integration/charactersVisibility.test.js tests/integration/registrations.test.js tests/integration/checkin.test.js tests/integration/scanLookup.test.js tests/integration/schema-registrations.test.js`
Expected: all PASS.

- [ ] **Step 13: Run the full test suite**

Run: `npm test`
Expected: all PASS. Given the scale of this change (a dropped column read by 4+ backend files, plus 17 raw test INSERTs across 4 files), this full run happens now, not only at the end of Task 2 — catching a missed spot here is much cheaper than discovering it later.

- [ ] **Step 14: Commit**

```bash
git add -A
git commit -m "feat: decouple characters from events (event_id dropped, registrations.character_id added)"
```

---

### Task 2: Frontend — neue Con-Anmeldungen-Seite + voller Testlauf

**Files:**
- Create: `frontend/con-anmeldungen.html`
- Create: `db/migrations/029_con_anmeldungen_menu.sql`
- Modify: `frontend/characters.html`
- Modify: `frontend/js/nav.js`
- Modify: `backend/groups/routes.js`
- Modify: `db/groupDefaults.js`
- Modify: `db/seedGroups.js`

**Interfaces:**
- Consumes: `POST /characters` (no `eventId`), `PUT /characters/:id` with `{eventId, data}` or `{name}`, `POST /events/:id/register` with `{conRole, characterId}`, `GET /registrations` (now includes `conRole`/`characterId`) — all from Task 1.

- [ ] **Step 1: Add the `con-anmeldungen` menu key**

Create `db/migrations/029_con_anmeldungen_menu.sql`:

```sql
UPDATE groups SET visible_menus = visible_menus || '["con-anmeldungen"]'::jsonb
WHERE NOT (visible_menus @> '["con-anmeldungen"]'::jsonb);
```

(Grants it to all 3 existing groups, matching the "retroactive grant" pattern from migration 009/024 — a `groupDefaults.js` edit alone only affects a brand-new database's first seed.)

In `db/groupDefaults.js`, add `'con-anmeldungen'` to each of the 3 groups' `visibleMenus` arrays — for `admin` and `moderator`: `['konto', 'charaktere', 'con-anmeldungen', 'mitglieder', 'events', 'checkin']`; for `mitglied`: `['konto', 'charaktere', 'con-anmeldungen']`.

In `backend/groups/routes.js`, add `'con-anmeldungen'` to the `MENU_KEYS` array: `['konto', 'charaktere', 'con-anmeldungen', 'mitglieder', 'events', 'checkin']`.

`db/seedGroups.js` needs no code change (it already reads `group.visibleMenus` generically from `GROUP_DEFAULTS`) — just confirm this after editing `groupDefaults.js`.

In `frontend/js/nav.js`, add the new link to `MENU_LINKS` right after `charaktere`:

```javascript
const MENU_LINKS = [
  { key: 'konto', label: 'Konto', href: '/account.html' },
  { key: 'charaktere', label: 'Charaktere', href: '/characters.html' },
  { key: 'con-anmeldungen', label: 'Con-Anmeldungen', href: '/con-anmeldungen.html' },
  { key: 'mitglieder', label: 'Mitglieder', href: '/admin/members.html' },
  { key: 'events', label: 'Events', href: '/admin/events.html' },
  { key: 'checkin', label: 'Check-In', href: '/admin/checkin.html' },
];
```

- [ ] **Step 2: Simplify `frontend/characters.html`**

Remove entirely: the `#registration-list` table and its surrounding `<h2>Meine Anmeldungen</h2>`, the register-role `<select>` + register button `<p>`, `#registration-message`. Remove entirely from the script: `loadRegistrations`, `unregister`, the `registerButton`/`registerConRoleSelect`/`updateRegisterButtonLabel` block and its two `eventSelect` listeners for it, the `isModeratorOrAdmin` variable and its staff-only-option-stripping block, the final `await loadRegistrations()` call.

Remove the event-related parts of the character form: the `<label for="event-select">`/`<select id="event-select">` and `<label for="copy-from-select">`/`<select id="copy-from-select">` lines from `#sc-form-section`, and `#dynamic-fields` (no schema fields render here anymore — creation is name-only). Remove `eventSelect`/`dynamicFields`/`copyFromSelect` and every function that touches them (`renderSchemaFields`, `populateEventOptions`, the `copyFromSelect` change listener, `loadEvents`, the `events` variable) — keep `let events = [];` only if something else in the file still reads event names for display (check: `tagsForCharacter` reads `events.find(...)`, see below).

`tagsForCharacter(c)` currently does `const event = events.find((e) => e.id === c.event_id); const schema = event ? event.character_form_schema : [];` — `c.event_id` no longer exists, and a character has no single schema anymore. Replace it entirely: render whatever keys are present in `c.data` generically (label = key, since there's no schema to look up a nicer label from without an event context):

```javascript
function tagsForCharacter(c) {
  return Object.entries(c.data ?? {})
    .map(([key, value]) => ({ key, value: tagValueForField({ type: typeof value === 'boolean' ? 'boolean' : Array.isArray(value) ? 'multiselect' : 'text' }, value) }))
    .filter(({ value }) => value !== undefined)
    .map(({ key, value }) => `<span class="tag">${escapeHtml(key)}: ${escapeHtml(value)}</span>`)
    .join('');
}
```

Simplify `loadCharacters()`'s card template — drop the `char-meta` event-name div entirely (no single event to show):

```javascript
async function loadCharacters() {
  characters = await api.get('/characters');
  const scCharacters = characters.filter((c) => c.class !== 'nsc');
  listBody.innerHTML = scCharacters.map((c) => {
    const tagsHtml = tagsForCharacter(c);
    return `<div class="char-card">
      <h3>${escapeHtml(c.name)}</h3>
      <div class="char-tags">${tagsHtml}</div>
      <button type="button" data-edit="${c.id}" class="btn-ghost" style="margin-top:14px;">Bearbeiten</button>
      <div class="char-files" data-files-for="${c.id}">
        <p class="sub">Dateien werden geladen …</p>
      </div>
    </div>`;
  }).join('');

  listBody.querySelectorAll('[data-edit]').forEach((button) => {
    button.addEventListener('click', () => startEdit(button.dataset.edit));
  });
  scCharacters.forEach((c) => loadFilesInto(c.id));

  if (nscSection.style.display !== 'none') {
    nscCharacters = characters.filter((c) => c.class === 'nsc');
    renderNscList();
  }
}
```

`startEdit`/`resetForm`/the create-form submit handler become name-only:

```javascript
function startEdit(characterId) {
  const character = characters.find((c) => c.id === characterId);
  if (!character) return;
  editingCharacterId = characterId;
  formTitle.textContent = `Charakter bearbeiten: ${character.name}`;
  form.elements.name.value = character.name;
  form.querySelector('button[type="submit"]').textContent = 'Änderungen speichern';
}

function resetForm() {
  editingCharacterId = null;
  formTitle.textContent = 'Neuen Charakter anlegen';
  form.reset();
  form.querySelector('button[type="submit"]').textContent = 'Speichern';
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  message.textContent = '';
  message.className = '';
  const name = form.elements.name.value;
  try {
    if (editingCharacterId) {
      await api.put(`/characters/${editingCharacterId}`, { name });
    } else {
      await api.post('/characters', { class: 'sc', name });
    }
    message.textContent = 'Gespeichert.';
    message.className = 'success';
    resetForm();
    await loadCharacters();
  } catch (err) {
    message.textContent = err.status === 400 && err.body?.details
      ? err.body.details.join(', ')
      : err.message;
    message.className = 'error';
  }
});
```

The final `try` block loses `await loadEvents()` and `await loadRegistrations()`, and the `canEditCharacters`/`isModeratorOrAdmin` lines tied to removed UI:

```javascript
try {
  const account = await api.get('/account');
  document.getElementById('nav-links').innerHTML = renderNavLinks(account, window.location.pathname);
  scFormSection.style.display = '';
  nscSchema = await api.get('/nsc-schema');
  nscSection.style.display = '';
  renderNscSchemaFields();
  await loadCharacters();
} catch (err) {
  if (err.status === 401) window.location.href = '/login.html';
}
```

(`canEditCharacters` was only ever used by the now-removed `populateEventOptions`/event-visibility logic — remove its `let canEditCharacters = false;` declaration too if nothing else in the file reads it; grep the file to confirm before deleting.)

The NSC section (`#nsc-section`, `nscSchema`, `nscCharacters`, `renderNscSchemaFields`, `tagsForNscCharacter`, `renderNscList`, `startNscEdit`, `resetNscForm`, the `nscForm` submit handler) is untouched — NSC characters were already account-wide and unaffected by this change.

- [ ] **Step 3: Create `frontend/con-anmeldungen.html`**

```html
<!DOCTYPE html>
<html lang="de">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Con-Anmeldungen – Pakyrion</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=EB+Garamond:ital,wght@0,400..700;1,400..600&family=Work+Sans:wght@400;500;600&display=swap" rel="stylesheet">
<link href="https://fonts.googleapis.com/css2?family=Material+Symbols+Outlined:opsz,wght,FILL,GRAD@20..48,400,0..1,0&display=block" rel="stylesheet">
<link rel="stylesheet" href="/css/chronicle-crest.css">
</head>
<body>
<div class="shell">
  <div class="brand"><div class="brand-seal"></div><div class="brand-name">Pakyrion</div></div>
  <p class="brand-sub">QuestIn LARP Management</p>
  <div class="folio folio--wide">
    <nav class="app-nav" id="nav-links"></nav>
    <div class="header-actions">
      <button type="button" id="logout-link" class="btn-danger">
        <span class="material-symbols-outlined" aria-hidden="true">logout</span> Logout
      </button>
    </div>
    <h1>Con-Anmeldungen</h1>
    <h2>Meine Anmeldungen</h2>
    <table id="registration-list">
      <thead><tr><th>Event</th><th>Rolle</th><th>Status</th><th></th></tr></thead>
      <tbody></tbody>
    </table>

    <h2>Neu anmelden</h2>
    <form id="registration-form">
      <label for="event-select">Event</label>
      <select id="event-select" required></select>

      <label for="con-role-select">Rolle</label>
      <select id="con-role-select">
        <option value="sc">SC</option>
        <option value="nsc">NSC</option>
        <option value="gsc">GSC</option>
        <option value="helfer">Helfer</option>
        <option value="orga" data-staff-only>Orga</option>
        <option value="hilfs_orga" data-staff-only>Hilfs-Orga</option>
      </select>

      <div id="character-select-wrap">
        <label for="character-select">Charakter</label>
        <select id="character-select"></select>
        <p id="no-character-hint" style="display:none;">Du hast noch keinen passenden Charakter. <a href="/characters.html">Charakter anlegen</a></p>
      </div>

      <div id="dynamic-fields"></div>

      <button type="submit" id="register-button">Anmelden</button>
    </form>
    <p id="message"></p>
  </div>
</div>

<script type="module">
import { api } from '/js/api.js';
import { applyBranding } from '/js/branding.js';
applyBranding();
import { escapeHtml, renderField, collectFieldValues, attachLiveValidation, STATUS_LABELS, renderEventOptions } from '/js/formFields.js';
import { renderNavLinks } from '/js/nav.js';

const CON_ROLE_LABELS = { sc: 'SC', nsc: 'NSC', gsc: 'GSC', helfer: 'Helfer', orga: 'Orga', hilfs_orga: 'Hilfs-Orga' };

const registrationListBody = document.querySelector('#registration-list tbody');
const registrationForm = document.getElementById('registration-form');
attachLiveValidation(registrationForm);
const eventSelect = document.getElementById('event-select');
const conRoleSelect = document.getElementById('con-role-select');
const characterSelectWrap = document.getElementById('character-select-wrap');
const characterSelect = document.getElementById('character-select');
const noCharacterHint = document.getElementById('no-character-hint');
const dynamicFields = document.getElementById('dynamic-fields');
const registerButton = document.getElementById('register-button');
const message = document.getElementById('message');

let events = [];
let characters = [];
let canEditCharacters = false;
let isModeratorOrAdmin = false;

function updateRegisterButtonLabel() {
  const event = events.find((e) => e.id === eventSelect.value);
  registerButton.textContent = event ? `Anmelden für ${event.name}` : 'Anmelden';
}

function classForConRole(conRole) {
  return conRole === 'nsc' ? 'nsc' : 'sc';
}

function populateCharacterOptions() {
  const conRole = conRoleSelect.value;
  const needsCharacter = ['sc', 'gsc', 'nsc'].includes(conRole);
  characterSelectWrap.style.display = needsCharacter ? '' : 'none';
  if (!needsCharacter) {
    dynamicFields.innerHTML = '';
    return;
  }
  const expectedClass = classForConRole(conRole);
  const matching = characters.filter((c) => c.class === expectedClass);
  characterSelect.innerHTML = matching.map((c) => `<option value="${escapeHtml(c.id)}">${escapeHtml(c.name)}</option>`).join('');
  noCharacterHint.style.display = matching.length === 0 ? '' : 'none';
  renderDynamicFieldsForSelection();
}

function renderDynamicFieldsForSelection() {
  const event = events.find((e) => e.id === eventSelect.value);
  const character = characters.find((c) => c.id === characterSelect.value);
  const schema = event ? event.character_form_schema : [];
  const data = character ? character.data : {};
  dynamicFields.innerHTML = ['sc', 'gsc'].includes(conRoleSelect.value)
    ? schema.map((field) => renderField(field, data[field.key])).join('')
    : '';
  attachLiveValidation(dynamicFields);
}

conRoleSelect.addEventListener('change', populateCharacterOptions);
characterSelect.addEventListener('change', renderDynamicFieldsForSelection);
eventSelect.addEventListener('change', () => {
  updateRegisterButtonLabel();
  renderDynamicFieldsForSelection();
});

function populateEventOptions() {
  const visibleEvents = canEditCharacters ? events : events.filter((e) => e.is_active);
  eventSelect.innerHTML = renderEventOptions(visibleEvents);
  updateRegisterButtonLabel();
}

async function loadEvents() {
  events = await api.get('/events');
  populateEventOptions();
}

async function loadCharacters() {
  characters = await api.get('/characters');
  populateCharacterOptions();
}

async function loadRegistrations() {
  const registrations = await api.get('/registrations');
  registrationListBody.innerHTML = registrations.map((r) => {
    const label = STATUS_LABELS[r.status] ?? r.status;
    return `<tr>
    <td>${escapeHtml(r.eventName)}</td>
    <td>${escapeHtml(CON_ROLE_LABELS[r.conRole] ?? r.conRole)}</td>
    <td><span class="ribbon status-${escapeHtml(r.status)}">${escapeHtml(label)}</span></td>
    <td>${r.status === 'pending' ? `<button type="button" data-unregister="${r.eventId}">Abmelden</button>` : ''}</td>
  </tr>`;
  }).join('');

  registrationListBody.querySelectorAll('[data-unregister]').forEach((button) => {
    button.addEventListener('click', () => unregister(button.dataset.unregister));
  });
}

async function unregister(eventId) {
  message.textContent = '';
  message.className = '';
  try {
    await api.delete(`/events/${eventId}/register`);
    await loadRegistrations();
  } catch (err) {
    message.textContent = err.message;
    message.className = 'error';
  }
}

registrationForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  message.textContent = '';
  message.className = '';
  const eventId = eventSelect.value;
  const conRole = conRoleSelect.value;
  const needsCharacter = ['sc', 'gsc', 'nsc'].includes(conRole);
  const characterId = needsCharacter ? characterSelect.value : undefined;
  if (needsCharacter && !characterId) return;

  try {
    if (['sc', 'gsc'].includes(conRole)) {
      const schema = events.find((e) => e.id === eventId)?.character_form_schema ?? [];
      const data = collectFieldValues(registrationForm, schema);
      await api.put(`/characters/${characterId}`, { eventId, data });
    }
    await api.post(`/events/${eventId}/register`, { conRole, characterId });
    message.textContent = 'Angemeldet.';
    message.className = 'success';
    await loadRegistrations();
  } catch (err) {
    message.textContent = err.status === 400 && err.body?.details
      ? err.body.details.join(', ')
      : err.message;
    message.className = 'error';
  }
});

document.getElementById('logout-link').addEventListener('click', async () => {
  if (!confirm('Wirklich abmelden?')) return;
  await api.post('/auth/logout', {});
  window.location.href = '/login.html';
});

try {
  const account = await api.get('/account');
  canEditCharacters = account.canEditCharacters;
  document.getElementById('nav-links').innerHTML = renderNavLinks(account, window.location.pathname);
  isModeratorOrAdmin = account.group?.key === 'admin' || account.group?.key === 'moderator';
  if (!isModeratorOrAdmin) {
    document.querySelectorAll('#con-role-select option[data-staff-only]').forEach((opt) => opt.remove());
  }
  await loadEvents();
  await loadCharacters();
  await loadRegistrations();
} catch (err) {
  if (err.status === 401) window.location.href = '/login.html';
}
</script>
</body>
</html>
```

(`gsc` uses `class='sc'` characters exactly like `sc` does — same character pool, same schema fields; the only difference between `sc` and `gsc` is the label shown at check-in, established in Teil 1.)

- [ ] **Step 4: Verify visually**

Using Claude Browser tools against the running dev stack:
1. Log in as a plain `mitglied`-tier user, go to `/characters.html` — confirm character creation now only asks for a name, no event dropdown, no schema fields. Create a character.
2. Go to `/con-anmeldungen.html` (confirm the new nav link appears) — select an event, select role "SC", confirm the just-created character appears in the character dropdown, confirm the event's schema fields render, fill them in, submit — confirm "Angemeldet." and the registration appears in "Meine Anmeldungen" with the right role label.
3. Go back to `/characters.html` — confirm the character card now shows the tags you just filled in via the registration flow.
4. Register the SAME character for a SECOND event with a DIFFERENT schema (as admin, create a second event with different fields first if needed) — confirm both events' fields now show as tags on the character card in `characters.html` (the accumulation behavior).
5. Log in as `admin`, go to `/admin/checkin.html` for one of those events — confirm the participant row still shows the character correctly.

- [ ] **Step 5: Run the full test suite**

Run: `npm test`
Expected: all tests PASS.

- [ ] **Step 6: Commit**

```bash
git add frontend/con-anmeldungen.html frontend/characters.html frontend/js/nav.js backend/groups/routes.js db/groupDefaults.js db/migrations/029_con_anmeldungen_menu.sql
git commit -m "feat: add standalone Con-Anmeldungen page, simplify characters.html to pure character management"
```

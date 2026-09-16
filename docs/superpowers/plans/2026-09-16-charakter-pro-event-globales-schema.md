# Charakter-pro-Event + globales SC-Schema Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ein SC/GSC-Charakter ist künftig höchstens einer Event-Anmeldung zugeordnet (statt account-weit über beliebig viele Events wiederverwendbar), und das Charakter-Sheet-Schema für SC/GSC wird ein einziges globales, admin-editierbares Schema statt eines pro Event gepflegten.

**Architecture:** Neue Tabelle `sc_character_schema` (1:1 Muster von `nsc_profile_schema`) ersetzt `events.character_form_schema`. `characters.data` wird bei jedem Speichern komplett validiert/ersetzt (kein Merge mehr). Die "höchstens eine Registrierung"-Regel für SC/GSC wird auf Anwendungsebene in `resolveCharacterId` durchgesetzt (kein DB-Constraint, da NSC weiter mehrfach verwendbar bleibt). Migration 032 räumt Bestandsdaten auf: mehrfach verlinkte SC-Charaktere werden pro zusätzlicher Anmeldung kopiert, `data` wird auf das übernommene globale Schema gefiltert.

**Tech Stack:** Node.js (kein Framework, eigener `router` in `backend/routes.js`), PostgreSQL (rohe SQL-Migrationen, `node-postgres`), Vanilla-JS-Frontend (ES-Module, kein Build-Schritt), `node:test` für Integrationstests.

**Spec:** `docs/superpowers/specs/2026-09-16-charakter-pro-event-globales-schema-design.md`

## Global Constraints

- Kein Rollback in Migrationen (Projekt-Konvention, siehe alle bisherigen `db/migrations/*.sql`).
- Kein neues npm-Package — alles mit vorhandenen Bordmitteln (roher SQL, `node:test`, bestehende Frontend-Helfer in `frontend/js/formFields.js`).
- Jede Migration ist eine neue `.sql`-Datei unter `db/migrations/`, fortlaufend nummeriert (nächste freie Nummer: `032`).
- Backend-Routen folgen dem bestehenden Muster: `router.METHOD(path, requireAuth(...))`, Fehler über `err.code` im `catch`-Block auf HTTP-Status gemappt (siehe jede bestehende `backend/*/routes.js`).
- Frontend hat keine automatisierten Tests (Projekt-Konvention) — UI-Änderungen werden manuell im Dev-Server verifiziert.
- Deutsch für alle nutzersichtbaren Strings (Labels, Fehlermeldungen), Englisch für Code/Kommentare — bestehende Konvention.

---

## Task 1: Migration 032 + globales SC-Schema (Backend-Modul `scSchema`)

**Files:**
- Create: `db/migrations/032_charakter_pro_event_globales_schema.sql`
- Create: `backend/scSchema/repository.js`
- Create: `backend/scSchema/routes.js`
- Modify: `backend/server.js:20` (Route-Modul registrieren)
- Test: `tests/integration/scSchema.test.js`

**Interfaces:**
- Produces: `getScCharacterSchema(): Promise<Array<{key,label,type,required?,public?,options?}>>`, `setScCharacterSchema(schema): Promise<schema>` (exportiert aus `backend/scSchema/repository.js`, gebraucht von Task 2 und Task 3).
- Produces: `GET /sc-schema` (jeder authentifizierte User), `PUT /sc-schema` (nur `admin`-Gruppe).

- [ ] **Step 1: Migration schreiben**

```sql
-- 1. Globales Charakter-Sheet-Schema für SC/GSC, ersetzt
--    events.character_form_schema -- mirrort nsc_profile_schema 1:1.
CREATE TABLE sc_character_schema (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  schema jsonb NOT NULL DEFAULT '[]'
);

-- Startwert: character_form_schema des aktuell aktiven Events (falls
-- keins aktiv ist, bleibt das globale Schema leer -- ein Admin pflegt es
-- danach manuell über die neue admin/character-schema.html).
INSERT INTO sc_character_schema (schema)
SELECT COALESCE(
  (SELECT character_form_schema FROM events WHERE is_active = true LIMIT 1),
  '[]'::jsonb
);

-- 2. Mehrfach verlinkte SC-Charaktere aufsplitten: registrations hat
--    keine eigene id/created_at (Primärschlüssel ist (user_id, event_id),
--    siehe db/migrations/004_registrations.sql) -- Reihenfolge für "welche
--    Anmeldung behält das Original" kommt daher vom Event-Datum, nicht von
--    einem Anmelde-Zeitstempel: die Anmeldung zum am längsten
--    zurückliegenden Event behält den ursprünglichen Charakter-Datensatz,
--    jede weitere bekommt eine unabhängige Kopie (gleicher Name, gleicher
--    data-Stand zum Migrationszeitpunkt).
DO $$
DECLARE
  rec RECORD;
  new_id uuid;
BEGIN
  FOR rec IN
    SELECT r.user_id, r.event_id, r.character_id, c.name, c.data,
           ROW_NUMBER() OVER (PARTITION BY r.character_id ORDER BY e.event_date ASC) AS rn
    FROM registrations r
    JOIN characters c ON c.id = r.character_id AND c.class = 'sc'
    JOIN events e ON e.id = r.event_id
  LOOP
    IF rec.rn > 1 THEN
      INSERT INTO characters (user_id, class, name, data)
      VALUES (rec.user_id, 'sc', rec.name, rec.data)
      RETURNING id INTO new_id;

      UPDATE registrations SET character_id = new_id
      WHERE user_id = rec.user_id AND event_id = rec.event_id;
    END IF;
  END LOOP;
END $$;

-- 3. Jeden verbleibenden SC-Charakter auf das neu übernommene globale
--    Schema filtern (Felder aus Event-Schemas, die nicht dem des aktiven
--    Events entsprachen, werden verworfen).
UPDATE characters c
SET data = COALESCE((
  SELECT jsonb_object_agg(kv.key, kv.value)
  FROM jsonb_each(c.data) AS kv
  WHERE kv.key IN (
    SELECT elem->>'key' FROM sc_character_schema, jsonb_array_elements(schema) AS elem
  )
), '{}'::jsonb)
WHERE c.class = 'sc';

-- 4. events.character_form_schema ist durch sc_character_schema ersetzt.
ALTER TABLE events DROP COLUMN character_form_schema;
```

- [ ] **Step 2: `backend/scSchema/repository.js` schreiben (1:1-Muster von `backend/nscSchema/repository.js`)**

```javascript
import { query } from '../db.js';

export async function getScCharacterSchema() {
  const { rows } = await query('SELECT schema FROM sc_character_schema LIMIT 1');
  return rows[0]?.schema ?? [];
}

export async function setScCharacterSchema(schema) {
  const { rows } = await query('SELECT id FROM sc_character_schema LIMIT 1');
  if (rows.length === 0) {
    await query('INSERT INTO sc_character_schema (schema) VALUES ($1)', [JSON.stringify(schema)]);
  } else {
    await query('UPDATE sc_character_schema SET schema = $1 WHERE id = $2', [JSON.stringify(schema), rows[0].id]);
  }
  return schema;
}
```

- [ ] **Step 3: `backend/scSchema/routes.js` schreiben (1:1-Muster von `backend/nscSchema/routes.js`)**

```javascript
import { router } from '../routes.js';
import { requireAuth } from '../middleware/authenticate.js';
import { requireAdminGroup } from '../middleware/authorize.js';
import { readJsonBody } from '../httpBody.js';
import { validateSchemaShape } from '../events/schemaValidation.js';
import { getScCharacterSchema, setScCharacterSchema } from './repository.js';

router.get('/sc-schema', requireAuth(async () => {
  const schema = await getScCharacterSchema();
  return { status: 200, body: schema };
}));

router.put('/sc-schema', requireAuth(requireAdminGroup(async ({ req }) => {
  const body = await readJsonBody(req);
  if (body === null) return { status: 400, body: { error: 'invalid JSON' } };
  const { schema } = body;
  if (!validateSchemaShape(schema)) {
    return { status: 400, body: { error: 'schema must be an array of objects, each with a unique, non-reserved string "key" (not "id" or "name")' } };
  }
  const saved = await setScCharacterSchema(schema);
  return { status: 200, body: saved };
})));
```

- [ ] **Step 4: Route-Modul in `backend/server.js` registrieren**

In `backend/server.js`, direkt nach Zeile 20 (`import './nscSchema/routes.js';`) einfügen:

```javascript
import './scSchema/routes.js';
```

- [ ] **Step 5: Test schreiben (1:1-Muster von `tests/integration/nscSchema.test.js`, ohne Seed-Schritt — Migration 032 legt die Zeile selbst an)**

```javascript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { withTestServer } from '../testServer.js';

process.env.DATABASE_URL = process.env.TEST_DATABASE_URL
  || 'postgres://app:app@localhost:5433/pakyrion_test';
process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'a'.repeat(64);
delete process.env.SMTP_HOST;

const { runMigrations } = await import('../../db/migrate.js');
await runMigrations();

const { seedGroups } = await import('../../db/seedGroups.js');
await seedGroups();

const { query, closePool } = await import('../../backend/db.js');
const { createSession } = await import('../../backend/auth/sessions.js');

async function makeUserAndSession(groupKey = 'mitglied') {
  const { rows } = await query(
    "INSERT INTO users (email, first_name, last_name, group_id, email_verified) VALUES ($1, 'Sc', 'Schema Test', (SELECT id FROM groups WHERE key = $2), true) RETURNING id",
    [`sc-schema-${groupKey}-${crypto.randomUUID()}@example.com`, groupKey]
  );
  const session = await createSession(rows[0].id);
  return { userId: rows[0].id, cookie: `session=${session.token}` };
}

test('GET /sc-schema is reachable by any authenticated user and starts empty on a fresh DB', async () => {
  await withTestServer(async (port) => {
    const { cookie } = await makeUserAndSession('mitglied');
    const res = await fetch(`http://localhost:${port}/sc-schema`, { headers: { Cookie: cookie } });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), []);
  });
});

test('GET /sc-schema requires authentication', async () => {
  await withTestServer(async (port) => {
    const res = await fetch(`http://localhost:${port}/sc-schema`);
    assert.equal(res.status, 401);
  });
});

test('PUT /sc-schema rejects a non-admin group', async () => {
  await withTestServer(async (port) => {
    const { cookie } = await makeUserAndSession('mitglied');
    const res = await fetch(`http://localhost:${port}/sc-schema`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ schema: [] }),
    });
    assert.equal(res.status, 403);
  });
});

test('PUT /sc-schema updates the schema for an admin caller', async () => {
  await withTestServer(async (port) => {
    const { cookie } = await makeUserAndSession('admin');
    const newSchema = [{ key: 'fraction', label: 'Fraktion', type: 'text', required: true }];
    const putRes = await fetch(`http://localhost:${port}/sc-schema`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ schema: newSchema }),
    });
    assert.equal(putRes.status, 200);

    const getRes = await fetch(`http://localhost:${port}/sc-schema`, { headers: { Cookie: cookie } });
    assert.deepEqual(await getRes.json(), newSchema);
  });
});

test('PUT /sc-schema rejects a schema using the reserved key "id" or duplicate keys', async () => {
  await withTestServer(async (port) => {
    const { cookie } = await makeUserAndSession('admin');

    const withId = await fetch(`http://localhost:${port}/sc-schema`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ schema: [{ key: 'id', label: 'Id', type: 'text' }] }),
    });
    assert.equal(withId.status, 400);

    const withDuplicate = await fetch(`http://localhost:${port}/sc-schema`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ schema: [
        { key: 'x', label: 'X', type: 'text' },
        { key: 'x', label: 'X (2)', type: 'text' },
      ] }),
    });
    assert.equal(withDuplicate.status, 400);
  });
});

test.after(async () => {
  await query("DELETE FROM users WHERE email LIKE 'sc-schema-%'");
  await closePool();
});
```

- [ ] **Step 6: Migration + Tests laufen lassen**

Run: `npm test -- tests/integration/scSchema.test.js`
Expected: alle 5 Tests PASS. (Die Migration läuft dabei automatisch über `runMigrations()` am Dateikopf jedes Testfiles.)

- [ ] **Step 7: Commit**

```bash
git add db/migrations/032_charakter_pro_event_globales_schema.sql backend/scSchema backend/server.js tests/integration/scSchema.test.js
git commit -m "feat: add global sc_character_schema table + /sc-schema endpoints"
```

---

## Task 2: `backend/characters` — kein Merge mehr, DELETE-Endpoint, `registeredFor`

**Files:**
- Modify: `backend/characters/repository.js`
- Modify: `backend/characters/routes.js`
- Test: `tests/integration/characters.test.js` (umfassend überarbeitet)

**Interfaces:**
- Consumes: `getScCharacterSchema` aus `backend/scSchema/repository.js` (Task 1).
- Produces: `createCharacter(userId, {characterClass, name, data})`, `updateCharacter(id, userId, {name, data})` (kein `eventId`-Parameter mehr), `deleteCharacter(id, userId)`, `listCharactersForUser(userId)` (Zeilen jetzt mit `registeredFor: {eventId, eventName, conRole} | null` für `class==='sc'`, immer `null` für `class==='nsc'`) — gebraucht von Task 7/8 (Frontend).
- Produces: `DELETE /characters/:id` (200 `{deleted:true}` / 403 / 404 / 409 `CHARACTER_IN_USE`).

- [ ] **Step 1: `backend/characters/repository.js` komplett ersetzen**

```javascript
import { query } from '../db.js';
import { validateCharacterData } from '../events/schemaValidation.js';
import { getNscProfileSchema } from '../nscSchema/repository.js';
import { getScCharacterSchema } from '../scSchema/repository.js';

const SELECT_COLUMNS = 'id, user_id, class, name, data, created_at';
const CHARACTER_LOCKING_STATUSES = ['confirmed', 'checked_in', 'checked_out'];

async function schemaForClass(characterClass) {
  return characterClass === 'nsc' ? getNscProfileSchema() : getScCharacterSchema();
}

export async function createCharacter(userId, { characterClass = 'sc', name, data }) {
  const schema = await schemaForClass(characterClass);
  const errors = validateCharacterData(schema, data ?? {});
  if (errors.length > 0) {
    const err = new Error('invalid character data');
    err.code = 'INVALID_CHARACTER_DATA';
    err.details = errors;
    throw err;
  }
  const { rows } = await query(
    `INSERT INTO characters (user_id, class, name, data)
     VALUES ($1, $2, $3, $4)
     RETURNING ${SELECT_COLUMNS}`,
    [userId, characterClass, name, JSON.stringify(data ?? {})]
  );
  return rows[0];
}

export async function getCharacter(id) {
  const { rows } = await query(`SELECT ${SELECT_COLUMNS} FROM characters WHERE id = $1`, [id]);
  return rows[0] ?? null;
}

// Each sc-class row gets at most one registrations match (enforced at the
// application level in registrations/repository.js's resolveCharacterId,
// not a DB constraint -- see the design spec section 4.3) -- the LATERAL
// join only runs for class='sc' rows, so an nsc-class character (still
// reusable across many registrations) is never multiplied into duplicate
// list entries.
export async function listCharactersForUser(userId) {
  const { rows } = await query(
    `SELECT c.id, c.user_id, c.class, c.name, c.data, c.created_at,
            reg.event_id AS registered_event_id, reg.con_role AS registered_con_role,
            ev.name AS registered_event_name
     FROM characters c
     LEFT JOIN LATERAL (
       SELECT r.event_id, r.con_role
       FROM registrations r
       WHERE r.character_id = c.id
       ORDER BY r.event_id
       LIMIT 1
     ) reg ON c.class = 'sc'
     LEFT JOIN events ev ON ev.id = reg.event_id
     WHERE c.user_id = $1
     ORDER BY c.created_at`,
    [userId]
  );
  return rows.map((row) => ({
    id: row.id,
    user_id: row.user_id,
    class: row.class,
    name: row.name,
    data: row.data,
    created_at: row.created_at,
    registeredFor: row.registered_event_id
      ? { eventId: row.registered_event_id, eventName: row.registered_event_name, conRole: row.registered_con_role }
      : null,
  }));
}

// Characters registered for a given event, found via the registration link
// (not a direct column -- see design spec section 4.3).
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

export async function updateCharacter(id, userId, { name, data }) {
  const character = await getCharacter(id);
  if (!character || character.user_id !== userId) return null;

  let newData;
  if (data !== undefined) {
    const schema = await schemaForClass(character.class);
    const errors = validateCharacterData(schema, data);
    if (errors.length > 0) {
      const err = new Error('invalid character data');
      err.code = 'INVALID_CHARACTER_DATA';
      err.details = errors;
      throw err;
    }
    newData = data;
  }

  const { rows } = await query(
    `UPDATE characters SET
       name = COALESCE($3, name),
       data = COALESCE($4, data)
     WHERE id = $1 AND user_id = $2
     RETURNING ${SELECT_COLUMNS}`,
    [id, userId, name ?? null, newData !== undefined ? JSON.stringify(newData) : null]
  );
  return rows[0] ?? null;
}

export async function deleteCharacter(id, userId) {
  const character = await getCharacter(id);
  if (!character || character.user_id !== userId) return null;

  const { rows } = await query('SELECT status FROM registrations WHERE character_id = $1', [id]);
  if (rows.some((r) => CHARACTER_LOCKING_STATUSES.includes(r.status))) {
    const err = new Error('Charakter ist mit einer bestätigten Anmeldung verknüpft und kann nicht gelöscht werden.');
    err.code = 'CHARACTER_IN_USE';
    throw err;
  }

  await query('DELETE FROM characters WHERE id = $1', [id]);
  return true;
}
```

- [ ] **Step 2: `backend/characters/routes.js` komplett ersetzen**

```javascript
import { router } from '../routes.js';
import { requireAuth } from '../middleware/authenticate.js';
import { readJsonBody } from '../httpBody.js';
import { getEvent } from '../events/repository.js';
import { createCharacter, getCharacter, listCharactersForUser, listCharactersForEvent, updateCharacter, deleteCharacter } from './repository.js';
import { filterCharacterFields } from './visibility.js';
import { getNscProfileSchema } from '../nscSchema/repository.js';
import { getScCharacterSchema } from '../scSchema/repository.js';

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
  const schema = await getScCharacterSchema();
  const characters = await listCharactersForEvent(params.eventId);
  const filtered = characters.map((c) => ({
    id: c.id,
    name: c.name,
    userId: c.user_id,
    data: filterCharacterFields(c, schema, user),
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

  // Both classes now have exactly one, non-event-varying schema (sc's is
  // global as of this change, nsc's already was) -- a stranger viewing by
  // id sees whichever public fields that one schema marks, no per-event
  // ambiguity to fall back from anymore.
  const schema = character.class === 'nsc' ? await getNscProfileSchema() : await getScCharacterSchema();
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
    if (err.code === 'INVALID_CHARACTER_DATA') {
      return { status: 400, body: { error: 'invalid character data', details: err.details } };
    }
    throw err;
  }
}));

router.delete('/characters/:id', requireAuth(async ({ params, user }) => {
  const character = await getCharacter(params.id);
  if (!character) return { status: 404, body: { error: 'character not found' } };
  const isOwner = character.user_id === user.id;
  const isElevated = user.group.canOverrideCheckinStatus;
  if (!isOwner && !isElevated) {
    return { status: 403, body: { error: 'forbidden' } };
  }
  try {
    await deleteCharacter(params.id, character.user_id);
    return { status: 200, body: { deleted: true } };
  } catch (err) {
    if (err.code === 'CHARACTER_IN_USE') return { status: 409, body: { error: err.message } };
    throw err;
  }
}));
```

- [ ] **Step 3: `tests/integration/characters.test.js` komplett ersetzen**

Der bisherige `eventId`-PUT-Mechanismus (Merge über Events hinweg) entfällt komplett; `makeEvent` braucht keine `character_form_schema`-Spalte mehr, und ein neuer Helper setzt das globale Schema direkt.

```javascript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { withTestServer } from '../testServer.js';

process.env.DATABASE_URL = process.env.TEST_DATABASE_URL
  || 'postgres://app:app@localhost:5433/pakyrion_test';
process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'a'.repeat(64);
delete process.env.SMTP_HOST;

const { runMigrations } = await import('../../db/migrate.js');
await runMigrations();

const { seedGroups } = await import('../../db/seedGroups.js');
await seedGroups();

const { seedNscProfileSchema } = await import('../../db/seedNscProfileSchema.js');
await seedNscProfileSchema();

const { query, closePool } = await import('../../backend/db.js');
const { createSession } = await import('../../backend/auth/sessions.js');

async function makeUserAndSession(groupKey = 'mitglied') {
  const { rows } = await query(
    "INSERT INTO users (email, first_name, last_name, group_id, email_verified) VALUES ($1, 'Char', 'Test', (SELECT id FROM groups WHERE key = $2), true) RETURNING id",
    [`chars-${groupKey}-${crypto.randomUUID()}@example.com`, groupKey]
  );
  const session = await createSession(rows[0].id);
  return { userId: rows[0].id, cookie: `session=${session.token}` };
}

async function makeEvent(isActive = true) {
  const { rows } = await query(
    "INSERT INTO events (name, event_date, is_active) VALUES ('Char Test Con', '2027-05-01', $1) RETURNING id",
    [isActive]
  );
  return rows[0].id;
}

async function setScSchema(schema) {
  await query('UPDATE sc_character_schema SET schema = $1', [JSON.stringify(schema)]);
}

test.beforeEach(async () => {
  await setScSchema([{ key: 'fraction', label: 'Fraktion', type: 'text', required: true }]);
});

test('creating an sc-class character validates data against the global sc schema at creation time', async () => {
  await withTestServer(async (port) => {
    const participant = await makeUserAndSession();

    const missingRequired = await fetch(`http://localhost:${port}/characters`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: participant.cookie },
      body: JSON.stringify({ name: 'Aldric', data: {} }),
    });
    assert.equal(missingRequired.status, 400);

    const ok = await fetch(`http://localhost:${port}/characters`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: participant.cookie },
      body: JSON.stringify({ name: 'Aldric', data: { fraction: 'Nordmark' } }),
    });
    assert.equal(ok.status, 201);
    assert.deepEqual((await ok.json()).data, { fraction: 'Nordmark' });
  });
});

test('PUT /characters/:id replaces sc-class data (no merge, no eventId needed)', async () => {
  await withTestServer(async (port) => {
    const participant = await makeUserAndSession();

    const createRes = await fetch(`http://localhost:${port}/characters`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: participant.cookie },
      body: JSON.stringify({ name: 'Aldric', data: { fraction: 'Nordmark' } }),
    });
    const { id } = await createRes.json();

    const putRes = await fetch(`http://localhost:${port}/characters/${id}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json', Cookie: participant.cookie },
      body: JSON.stringify({ data: { fraction: 'Suedmark' } }),
    });
    assert.equal(putRes.status, 200);
    assert.deepEqual((await putRes.json()).data, { fraction: 'Suedmark' });
  });
});

test('a participant only sees their own characters in the list', async () => {
  await withTestServer(async (port) => {
    const alice = await makeUserAndSession();
    const bob = await makeUserAndSession();

    await fetch(`http://localhost:${port}/characters`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: alice.cookie },
      body: JSON.stringify({ name: 'Alice Char', data: { fraction: 'Nordmark' } }),
    });
    await fetch(`http://localhost:${port}/characters`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: bob.cookie },
      body: JSON.stringify({ name: 'Bob Char', data: { fraction: 'Suedmark' } }),
    });

    const aliceList = await (await fetch(`http://localhost:${port}/characters`, { headers: { Cookie: alice.cookie } })).json();
    assert.ok(aliceList.every((c) => c.name !== 'Bob Char'));
    assert.ok(aliceList.some((c) => c.name === 'Alice Char'));
  });
});

test('GET /characters lists registeredFor:null for an unused sc character and the event/role after registering', async () => {
  await withTestServer(async (port) => {
    const participant = await makeUserAndSession();
    const eventId = await makeEvent();

    const createRes = await fetch(`http://localhost:${port}/characters`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: participant.cookie },
      body: JSON.stringify({ name: 'Aldric', data: { fraction: 'Nordmark' } }),
    });
    const { id } = await createRes.json();

    const beforeList = await (await fetch(`http://localhost:${port}/characters`, { headers: { Cookie: participant.cookie } })).json();
    assert.equal(beforeList.find((c) => c.id === id).registeredFor, null);

    await fetch(`http://localhost:${port}/events/${eventId}/register`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: participant.cookie },
      body: JSON.stringify({ conRole: 'sc', characterId: id }),
    });

    const afterList = await (await fetch(`http://localhost:${port}/characters`, { headers: { Cookie: participant.cookie } })).json();
    const registered = afterList.find((c) => c.id === id).registeredFor;
    assert.equal(registered.eventId, eventId);
    assert.equal(registered.conRole, 'sc');
  });
});

test('a participant cannot view or edit another participant\'s character; an admin (canOverrideCheckinStatus) can view and edit it', async () => {
  await withTestServer(async (port) => {
    const owner = await makeUserAndSession();
    const stranger = await makeUserAndSession();
    const admin = await makeUserAndSession('admin');

    const createRes = await fetch(`http://localhost:${port}/characters`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: owner.cookie },
      body: JSON.stringify({ name: 'Owned', data: { fraction: 'Nordmark' } }),
    });
    const { id } = await createRes.json();

    const strangerGet = await fetch(`http://localhost:${port}/characters/${id}`, { headers: { Cookie: stranger.cookie } });
    assert.equal(strangerGet.status, 200);
    // The global schema's one field has no `public: true` flag by default
    // in this test's setScSchema call, so a non-owner sees no data fields.
    assert.deepEqual((await strangerGet.json()).data, {});

    const adminGet = await fetch(`http://localhost:${port}/characters/${id}`, { headers: { Cookie: admin.cookie } });
    assert.equal(adminGet.status, 200);

    const strangerPut = await fetch(`http://localhost:${port}/characters/${id}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json', Cookie: stranger.cookie },
      body: JSON.stringify({ name: 'Hijacked' }),
    });
    assert.equal(strangerPut.status, 403);

    const adminPut = await fetch(`http://localhost:${port}/characters/${id}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json', Cookie: admin.cookie },
      body: JSON.stringify({ name: 'Admin-Edit' }),
    });
    assert.equal(adminPut.status, 200);
    const adminUpdated = await adminPut.json();
    assert.equal(adminUpdated.name, 'Admin-Edit');
    assert.equal(adminUpdated.user_id, owner.userId);
  });
});

test('creating an nsc-class character validates against the current nsc_profile_schema, unaffected by the sc schema change', async () => {
  await withTestServer(async (port) => {
    const nscUser = await makeUserAndSession('mitglied');

    const missingRequired = await fetch(`http://localhost:${port}/characters`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: nscUser.cookie },
      body: JSON.stringify({ class: 'nsc', name: 'Wache Eins', data: { rollenAusruestung: ['NichtErlaubt'] } }),
    });
    assert.equal(missingRequired.status, 400);

    const ok = await fetch(`http://localhost:${port}/characters`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: nscUser.cookie },
      body: JSON.stringify({ class: 'nsc', name: 'Wache Eins', data: {} }),
    });
    assert.equal(ok.status, 201);
    assert.equal((await ok.json()).class, 'nsc');
  });
});

test('a user can create multiple sc-class characters (Ersatzcharaktere)', async () => {
  await withTestServer(async (port) => {
    const participant = await makeUserAndSession();

    const first = await fetch(`http://localhost:${port}/characters`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: participant.cookie },
      body: JSON.stringify({ name: 'Hauptcharakter', data: { fraction: 'Nordmark' } }),
    });
    assert.equal(first.status, 201);

    const second = await fetch(`http://localhost:${port}/characters`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: participant.cookie },
      body: JSON.stringify({ name: 'Ersatzcharakter', data: { fraction: 'Suedmark' } }),
    });
    assert.equal(second.status, 201);

    const list = await (await fetch(`http://localhost:${port}/characters`, { headers: { Cookie: participant.cookie } })).json();
    assert.equal(list.filter((c) => c.class === 'sc').length, 2);
  });
});

test('PUT on an nsc-class character validates against the current nsc_profile_schema', async () => {
  await withTestServer(async (port) => {
    const nscUser = await makeUserAndSession('mitglied');

    const createRes = await fetch(`http://localhost:${port}/characters`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: nscUser.cookie },
      body: JSON.stringify({ class: 'nsc', name: 'Wache Eins', data: {} }),
    });
    const { id } = await createRes.json();

    const invalidPut = await fetch(`http://localhost:${port}/characters/${id}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json', Cookie: nscUser.cookie },
      body: JSON.stringify({ data: { rollenAusruestung: ['NichtErlaubt'] } }),
    });
    assert.equal(invalidPut.status, 400);

    const validPut = await fetch(`http://localhost:${port}/characters/${id}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json', Cookie: nscUser.cookie },
      body: JSON.stringify({ name: 'Wache Zwei' }),
    });
    assert.equal(validPut.status, 200);
    assert.equal((await validPut.json()).name, 'Wache Zwei');
  });
});

test('DELETE /characters/:id removes an unused character; owner-only; blocked once confirmed', async () => {
  await withTestServer(async (port) => {
    const owner = await makeUserAndSession();
    const stranger = await makeUserAndSession();
    const eventId = await makeEvent();

    const createRes = await fetch(`http://localhost:${port}/characters`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: owner.cookie },
      body: JSON.stringify({ name: 'Deletable', data: { fraction: 'Nordmark' } }),
    });
    const { id } = await createRes.json();

    const strangerDelete = await fetch(`http://localhost:${port}/characters/${id}`, {
      method: 'DELETE', headers: { Cookie: stranger.cookie },
    });
    assert.equal(strangerDelete.status, 403);

    await fetch(`http://localhost:${port}/events/${eventId}/register`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: owner.cookie },
      body: JSON.stringify({ conRole: 'sc', characterId: id }),
    });
    await query("UPDATE registrations SET status = 'confirmed' WHERE character_id = $1", [id]);

    const blockedDelete = await fetch(`http://localhost:${port}/characters/${id}`, {
      method: 'DELETE', headers: { Cookie: owner.cookie },
    });
    assert.equal(blockedDelete.status, 409);

    await query("UPDATE registrations SET status = 'pending' WHERE character_id = $1", [id]);
    await query('DELETE FROM registrations WHERE character_id = $1', [id]);

    const okDelete = await fetch(`http://localhost:${port}/characters/${id}`, {
      method: 'DELETE', headers: { Cookie: owner.cookie },
    });
    assert.equal(okDelete.status, 200);

    const getAfterDelete = await fetch(`http://localhost:${port}/characters/${id}`, { headers: { Cookie: owner.cookie } });
    assert.equal(getAfterDelete.status, 404);
  });
});

test('PUT /characters/:id allows a canOverrideCheckinStatus group to edit another user\'s character', async () => {
  await withTestServer(async (port) => {
    const owner = await makeUserAndSession('mitglied');
    const sl = await makeUserAndSession('moderator');

    const createRes = await fetch(`http://localhost:${port}/characters`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: owner.cookie },
      body: JSON.stringify({ name: 'Fremdcharakter', data: { fraction: 'Nordmark' } }),
    });
    const { id } = await createRes.json();

    const updateRes = await fetch(`http://localhost:${port}/characters/${id}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json', Cookie: sl.cookie },
      body: JSON.stringify({ name: 'Von SL bearbeitet' }),
    });
    assert.equal(updateRes.status, 200);
    const updated = await updateRes.json();
    assert.equal(updated.name, 'Von SL bearbeitet');
    assert.equal(updated.user_id, owner.userId);
  });
});

test.after(async () => {
  await closePool();
});
```

- [ ] **Step 4: Tests laufen lassen**

Run: `npm test -- tests/integration/characters.test.js`
Expected: alle Tests PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/characters tests/integration/characters.test.js
git commit -m "feat: characters use the global sc schema, no more per-event merge; add DELETE /characters/:id"
```

---

## Task 3: `backend/registrations` — Einmal-Regel + globales Schema

**Files:**
- Modify: `backend/registrations/repository.js`
- Modify: `backend/registrations/routes.js`
- Test: `tests/integration/registrations.test.js` (neuer Testfall ergänzt)
- Test: `tests/integration/charactersVisibility.test.js` (überarbeitet)
- Test: `tests/integration/checkin.test.js` (`makeEvent`-Helper + ein Testfall angepasst)

**Interfaces:**
- Consumes: `getScCharacterSchema` aus `backend/scSchema/repository.js` (Task 1).
- Produces: `resolveCharacterId` wirft neu `CHARACTER_ALREADY_REGISTERED`, wenn ein `sc`/`gsc`-Charakter schon eine andere Registrierung hat.

- [ ] **Step 1: `resolveCharacterId` in `backend/registrations/repository.js` erweitern**

In `backend/registrations/repository.js`, die Funktion `resolveCharacterId` (aktuell Zeilen 36-69) ersetzen:

```javascript
// Validates characterId against con_role: CHARACTER_REQUIRED_CON_ROLES must
// have one that exists, belongs to userId, and has the matching class
// (sc/gsc -> 'sc', nsc -> 'nsc'); every other con_role must NOT have one.
// For an sc-class character, also enforces "at most one registration ever"
// (design spec 2026-09-16, section 4.3) -- excludes the caller's own
// (eventId, userId) row so re-saving an existing registration's con-role
// doesn't flag itself as a conflict. NSC stays exempt: it remains reusable
// across many events, unchanged from before this spec.
// Returns the characterId to store (always null for non-character roles).
async function resolveCharacterId(userId, conRole, characterId, eventId) {
  if (!CHARACTER_REQUIRED_CON_ROLES.includes(conRole)) {
    if (characterId) {
      const err = new Error(`Für die Rolle "${conRole}" darf kein Charakter angegeben werden.`);
      err.code = 'CHARACTER_NOT_ALLOWED';
      throw err;
    }
    return null;
  }
  if (!characterId) {
    const err = new Error(`Für die Rolle "${conRole}" ist ein Charakter erforderlich.`);
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
```

- [ ] **Step 2: Aufrufer von `resolveCharacterId` anpassen**

In `registerForEvent` (Zeile 100 im Original): `const resolvedCharacterId = await resolveCharacterId(userId, conRole, characterId);` wird zu:

```javascript
  const resolvedCharacterId = await resolveCharacterId(userId, conRole, characterId, eventId);
```

In `setConRole` (Zeile 144 im Original): `const resolvedCharacterId = await resolveCharacterId(userId, conRole, characterId);` wird zu:

```javascript
  const resolvedCharacterId = await resolveCharacterId(userId, conRole, characterId, eventId);
```

- [ ] **Step 3: `backend/registrations/routes.js` — globales Schema + 409-Handling**

`import { getEvent } from '../events/repository.js';` bekommt eine Ergänzung:

```javascript
import { getScCharacterSchema } from '../scSchema/repository.js';
```

Die `/events/:id/participants`-Route (Zeile 73-78 im Original) wird:

```javascript
router.get('/events/:id/participants', requireAuth(requireMenu('checkin')(async ({ params, user }) => {
  const event = await getEvent(params.id);
  if (!event) return { status: 404, body: { error: 'event not found' } };
  const schema = await getScCharacterSchema();
  const participants = await listParticipantsForEvent(params.id, { schema, viewer: user });
  return { status: 200, body: participants };
})));
```

Sowohl in `router.post('/events/:id/register', ...)` als auch in `router.put('/events/:id/registrations/:userId/con-role', ...)` wird im jeweiligen `catch`-Block, direkt nach der `CHARACTER_FORBIDDEN`-Zeile, ergänzt:

```javascript
    if (err.code === 'CHARACTER_ALREADY_REGISTERED') return { status: 409, body: { error: err.message } };
```

- [ ] **Step 4: Neuen Testfall in `tests/integration/registrations.test.js` ergänzen**

Nach dem bestehenden Test `'a participant can register and unregister for an event'` (endet vor Zeile ~105) einfügen:

```javascript
test('the same sc character cannot be used to register for a second event; freed again after unregistering', async () => {
  await withTestServer(async (port) => {
    const { cookie } = await makeUserAndSession();
    const eventA = await makeEvent();
    const eventB = await makeEventNamed('Zweites Con', '2027-09-01');
    const characterId = await makeCharacter(port, cookie);

    const firstReg = await fetch(`http://localhost:${port}/events/${eventA}/register`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ conRole: 'sc', characterId }),
    });
    assert.equal(firstReg.status, 201);

    const secondReg = await fetch(`http://localhost:${port}/events/${eventB}/register`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ conRole: 'sc', characterId }),
    });
    assert.equal(secondReg.status, 409);

    await fetch(`http://localhost:${port}/events/${eventA}/register`, { method: 'DELETE', headers: { Cookie: cookie } });

    const thirdReg = await fetch(`http://localhost:${port}/events/${eventB}/register`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ conRole: 'sc', characterId }),
    });
    assert.equal(thirdReg.status, 201);
  });
});
```

- [ ] **Step 5: `tests/integration/charactersVisibility.test.js` überarbeiten**

`makeEvent` (Zeilen 37-44) und `makeRegisteredCharacter` (Zeilen 46-68) ersetzen; jeder Testfall setzt das globale Schema vorab. Ganzer Datei-Kopf bis `makeRegisteredCharacter` ersetzen mit:

```javascript
const VISIBILITY_SCHEMA = [
  { key: 'fraction', label: 'Fraktion', type: 'text', public: true },
  { key: 'secretNote', label: 'Geheimnis', type: 'text' },
];

async function setScSchema(schema) {
  await query('UPDATE sc_character_schema SET schema = $1', [JSON.stringify(schema)]);
}

async function makeEvent(isActive = true) {
  const { rows } = await query(
    "INSERT INTO events (name, event_date, is_active) VALUES ('Visibility Test Con', '2027-06-01', $1) RETURNING id",
    [isActive]
  );
  return rows[0].id;
}

// Creates an sc-class character with `data` set at creation time, then
// registers it for eventId -- the character only shows up in
// /events/:eventId/characters/public once it's actually registered (the
// endpoint joins through registrations.character_id, not a direct column).
async function makeRegisteredCharacter(port, cookie, eventId, name, data) {
  const createRes = await fetch(`http://localhost:${port}/characters`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ name, data }),
  });
  const { id } = await createRes.json();

  await fetch(`http://localhost:${port}/events/${eventId}/register`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ conRole: 'sc', characterId: id }),
  });

  return id;
}

test.beforeEach(async () => {
  await setScSchema(VISIBILITY_SCHEMA);
});
```

Jeder bisherige `const eventId = await makeEvent();`-Aufruf bleibt unverändert (Helper-Signatur ohne Schema-Argument passt weiter). Der letzte Test (`'GET /characters/:id filters non-public fields...'`, Zeilen 171-190) bekommt eine angepasste Erwartung — nicht mehr leer, sondern gefiltert auf das (jetzt existierende) globale Schema:

```javascript
test('GET /characters/:id filters non-public fields for a non-owner, non-elevated viewer', async () => {
  await withTestServer(async (port) => {
    const owner = await makeUserAndSession();
    const stranger = await makeUserAndSession();
    const eventId = await makeEvent();

    const id = await makeRegisteredCharacter(port, owner.cookie, eventId, 'Delwyn', { fraction: 'Westmark', secretNote: 'Verraeter' });

    const strangerGet = await fetch(`http://localhost:${port}/characters/${id}`, { headers: { Cookie: stranger.cookie } });
    assert.equal(strangerGet.status, 200);
    const strangerBody = await strangerGet.json();
    // GET /characters/:id now resolves the one global sc schema (no more
    // per-event ambiguity) -- a stranger sees exactly the schema's public
    // fields, same as through the per-event /public list.
    assert.deepEqual(strangerBody.data, { fraction: 'Westmark' });

    const missingGet = await fetch(`http://localhost:${port}/characters/${crypto.randomUUID()}`, { headers: { Cookie: stranger.cookie } });
    assert.equal(missingGet.status, 404);
  });
});
```

- [ ] **Step 6: `tests/integration/checkin.test.js` — `makeEvent`-Helper anpassen**

`makeEvent` (Zeilen 51-57) wird:

```javascript
async function makeEvent() {
  const { rows } = await query(
    "INSERT INTO events (name, event_date, is_active) VALUES ('Checkin Test Con', '2027-09-01', true) RETURNING id"
  );
  return rows[0].id;
}
```

Jeder bestehende `makeEvent()`-Aufruf ohne Argument bleibt unverändert. Der eine Testfall mit einem expliziten Schema-Argument (`'participants list filters character (IT) fields...'`, um Zeile 414-441) wird angepasst: `makeEvent(schema)` → `makeEvent()`, und vor dem Aufruf von `makeCharacter` das globale Schema gesetzt:

```javascript
test('participants list filters character (IT) fields by canOverrideCheckinStatus and the schema\'s public flag', async () => {
  await withTestServer(async (port) => {
    const schema = [
      { key: 'faction', label: 'Fraktion', type: 'text', public: true },
      { key: 'secretGoal', label: 'Geheimes Ziel', type: 'text', public: false },
    ];
    await query('UPDATE sc_character_schema SET schema = $1', [JSON.stringify(schema)]);
    const eventId = await makeEvent();
    const admin = await makeUserAndSession('admin');
    const hilfsSl = await makeCustomGroupUserAndSession({ visibleMenus: ['checkin'], canOverrideCheckinStatus: false });
    const attendee = await makeUserAndSession('mitglied');
    const characterId = await makeCharacter(
      attendee.userId,
      'Aldric',
      JSON.stringify({ faction: 'Nordbund', secretGoal: 'Den Thron stürzen' })
    );
    await query('INSERT INTO registrations (user_id, event_id, character_id) VALUES ($1, $2, $3)', [attendee.userId, eventId, characterId]);

    const adminList = await fetch(`http://localhost:${port}/events/${eventId}/participants`, { headers: { Cookie: admin.cookie } });
    const adminChar = (await adminList.json()).find((p) => p.userId === attendee.userId).characters[0];
    assert.equal(adminChar.data.faction, 'Nordbund');
    assert.equal(adminChar.data.secretGoal, 'Den Thron stürzen');

    const hilfsSlList = await fetch(`http://localhost:${port}/events/${eventId}/participants`, { headers: { Cookie: hilfsSl.cookie } });
    const hilfsSlChar = (await hilfsSlList.json()).find((p) => p.userId === attendee.userId).characters[0];
    assert.equal(hilfsSlChar.data.faction, 'Nordbund');
    assert.equal('secretGoal' in hilfsSlChar.data, false);
  });
});
```

- [ ] **Step 7: Tests laufen lassen**

Run: `npm test -- tests/integration/registrations.test.js tests/integration/charactersVisibility.test.js tests/integration/checkin.test.js`
Expected: alle Tests PASS.

- [ ] **Step 8: Commit**

```bash
git add backend/registrations tests/integration/registrations.test.js tests/integration/charactersVisibility.test.js tests/integration/checkin.test.js
git commit -m "feat: enforce at-most-one-registration for sc/gsc characters; use global sc schema for participant visibility"
```

---

## Task 4: `backend/events` — `character_form_schema` entfernen

**Files:**
- Modify: `backend/events/repository.js`
- Modify: `backend/events/routes.js`
- Test: `tests/integration/events.test.js` (Schema-spezifische Tests entfernt, verbleibende Payloads bereinigt)

**Interfaces:**
- Consumes: nichts Neues.
- Produces: `createEvent({name, eventDate, code})`, `updateEvent(id, {name, eventDate, code})` (kein `characterFormSchema`-Parameter mehr).

- [ ] **Step 1: `backend/events/repository.js` anpassen**

Komplette Datei ersetzen:

```javascript
import { query } from '../db.js';

const SELECT_COLUMNS = 'id, name, event_date, code, is_active, created_at';

export async function createEvent({ name, eventDate, code }) {
  const { rows } = await query(
    `INSERT INTO events (name, event_date, code)
     VALUES ($1, $2, $3)
     RETURNING ${SELECT_COLUMNS}`,
    [name, eventDate, code ?? null]
  );
  return rows[0];
}

export async function getEvent(id) {
  const { rows } = await query(
    `SELECT ${SELECT_COLUMNS} FROM events WHERE id = $1`,
    [id]
  );
  return rows[0] ?? null;
}

export async function listEvents() {
  const { rows } = await query(
    `SELECT ${SELECT_COLUMNS} FROM events ORDER BY event_date`
  );
  return rows;
}

export async function updateEvent(id, { name, eventDate, code }) {
  // code is the one optional field a caller can legitimately want to CLEAR
  // (an empty string from a form), not just omit -- COALESCE alone can't
  // tell those apart, since both arrive as a falsy value bound to $4. $5
  // carries that distinction explicitly: only skip the write when the
  // field was genuinely absent from the call.
  const { rows } = await query(
    `UPDATE events SET
       name = COALESCE($2, name),
       event_date = COALESCE($3, event_date),
       code = CASE WHEN $5 THEN $4 ELSE code END
     WHERE id = $1
     RETURNING ${SELECT_COLUMNS}`,
    [id, name ?? null, eventDate ?? null, code ?? null, code !== undefined]
  );
  return rows[0] ?? null;
}

// At most one event is ever active: this unconditionally sets every row's
// is_active based on whether it matches id, in one statement, so the
// invariant holds after every call with no separate "deactivate the rest"
// step to keep in sync.
export async function activateEvent(id) {
  const existing = await getEvent(id);
  if (!existing) return null;
  await query('UPDATE events SET is_active = (id = $1)', [id]);
  return getEvent(id);
}
```

- [ ] **Step 2: `backend/events/routes.js` anpassen**

Komplette Datei ersetzen:

```javascript
import { router } from '../routes.js';
import { requireAuth } from '../middleware/authenticate.js';
import { requireMenu } from '../middleware/authorize.js';
import { readJsonBody } from '../httpBody.js';
import { createEvent, getEvent, listEvents, updateEvent, activateEvent } from './repository.js';

router.post('/events', requireAuth(requireMenu('events')(async ({ req }) => {
  const body = await readJsonBody(req);
  if (body === null) return { status: 400, body: { error: 'invalid JSON' } };
  const { name, eventDate, code } = body;
  if (!name || !eventDate) {
    return { status: 400, body: { error: 'name and eventDate are required' } };
  }
  const event = await createEvent({ name, eventDate, code });
  return { status: 201, body: event };
})));

router.get('/events', requireAuth(async () => {
  const events = await listEvents();
  return { status: 200, body: events };
}));

router.get('/events/:id', requireAuth(async ({ params }) => {
  const event = await getEvent(params.id);
  if (!event) return { status: 404, body: { error: 'event not found' } };
  return { status: 200, body: event };
}));

router.put('/events/:id', requireAuth(requireMenu('events')(async ({ req, params }) => {
  const body = await readJsonBody(req);
  if (body === null) return { status: 400, body: { error: 'invalid JSON' } };
  const event = await updateEvent(params.id, body);
  if (!event) return { status: 404, body: { error: 'event not found' } };
  return { status: 200, body: event };
})));

router.post('/events/:id/activate', requireAuth(requireMenu('events')(async ({ params }) => {
  const event = await activateEvent(params.id);
  if (!event) return { status: 404, body: { error: 'event not found' } };
  return { status: 200, body: event };
})));
```

- [ ] **Step 3: `tests/integration/events.test.js` bereinigen**

Vier Tests komplett entfernen (ihre Abdeckung lebt jetzt in `tests/integration/scSchema.test.js`, Task 1):
- `'admin creating an event with a malformed characterFormSchema gets 400'`
- `'PUT /events/:id rejects a characterFormSchema using the reserved key "id" or "name"'`

Aus den verbleibenden Tests jedes `characterFormSchema`-Vorkommen entfernen — jede Ersetzung ist eine exakte Zeilen-für-Zeile-Änderung:

In `'admin can create an event; participant cannot'` (Zeilen 33-37), das `payload`-Objekt:

```javascript
    const payload = {
      name: 'Sommercon 2027',
      eventDate: '2027-07-15',
    };
```

In `'any authenticated user can list and get events; unknown id is 404'` (Zeile 66):

```javascript
      body: JSON.stringify({ name: 'Wintercon', eventDate: '2027-01-10' }),
```

Der Test `'admin can update an event\'s character form schema'` (Zeilen 83-105) wird komplett ersetzt:

```javascript
test('admin can update an event\'s name', async () => {
  await withTestServer(async (port) => {
    const admin = await makeUserAndSession('admin');

    const createRes = await fetch(`http://localhost:${port}/events`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: admin.cookie },
      body: JSON.stringify({ name: 'Frühlingscon', eventDate: '2027-04-01' }),
    });
    const { id } = await createRes.json();

    const updateRes = await fetch(`http://localhost:${port}/events/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Cookie: admin.cookie },
      body: JSON.stringify({ name: 'Frühlingscon (Update)' }),
    });
    assert.equal(updateRes.status, 200);
    const updated = await updateRes.json();
    assert.equal(updated.name, 'Frühlingscon (Update)');
  });
});
```

In `'admin can activate an event; activating one deactivates all others; participant cannot activate'`, die `createEvent`-Hilfsfunktion (Zeilen 143-150):

```javascript
    async function createEvent(name) {
      const res = await fetch(`http://localhost:${port}/events`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: admin.cookie },
        body: JSON.stringify({ name, eventDate: '2027-10-01' }),
      });
      return res.json();
    }
```

- [ ] **Step 4: Tests laufen lassen**

Run: `npm test -- tests/integration/events.test.js`
Expected: alle verbleibenden Tests PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/events tests/integration/events.test.js
git commit -m "refactor: drop events.character_form_schema (superseded by sc_character_schema)"
```

---

## Task 5: Frontend — `account.html` Charaktere-Unterschritt

**Files:**
- Modify: `frontend/account.html`

**Interfaces:**
- Consumes: `GET /sc-schema`, `GET /characters` (jetzt mit `registeredFor`), `DELETE /characters/:id`, `POST /characters`, `PUT /characters/:id` (Task 1/2).

- [ ] **Step 1: Markup im `sc-tab`-Panel ersetzen**

In `frontend/account.html`, den Block von `<div class="tab-panel" id="sc-tab">` bis zu dessen schließendem `</div>` (ursprünglich Zeilen 125-137) ersetzen durch:

```html
        <div class="tab-panel" id="sc-tab">
          <div id="character-list" class="char-grid"></div>
          <button type="button" id="copy-character-btn" class="btn-ghost">Aus bestehendem Charakter kopieren</button>

          <dialog id="copy-character-dialog">
            <h3>Charakter kopieren</h3>
            <p class="lede">Übernimmt Name und Sheet-Daten in einen neuen, unabhängigen Charakter.</p>
            <label for="copy-character-select">Vorlage</label>
            <select id="copy-character-select"></select>
            <div class="dialog-actions">
              <button type="button" id="copy-character-confirm">Kopieren</button>
              <button type="button" id="copy-character-cancel" class="btn-ghost">Abbrechen</button>
            </div>
          </dialog>

          <div id="sc-form-section" style="display:none;">
            <h3 id="form-title">Neuen Charakter anlegen</h3>
            <form id="character-form">
              <label for="character-name">Charaktername</label>
              <input id="character-name" name="name" type="text" required>
              <div id="character-dynamic-fields"></div>
              <button type="submit">Speichern</button>
              <button type="button" id="character-cancel-edit" style="display:none;" class="btn-ghost">Abbrechen</button>
            </form>
            <p id="character-message"></p>
          </div>
        </div>
```

- [ ] **Step 2: SC-Schema laden + Formular-Funktionen ergänzen**

Nach der bestehenden Zeile `let nscSchema = [];` (im Original Zeile 496) ergänzen:

```javascript
let scSchema = [];
```

Nach der Funktion `resetNscForm`/vor `nscCancelButton.addEventListener(...)` — genauer: irgendwo vor `renderCharacterList`, z.B. direkt nach dem `characterFormTitle`-Konstanten-Block (ursprünglich um Zeile 489-494) — folgende neue Konstanten/Funktionen ergänzen:

```javascript
const characterDynamicFields = document.getElementById('character-dynamic-fields');
const characterCancelButton = document.getElementById('character-cancel-edit');

function renderScSchemaFields(data = {}) {
  characterDynamicFields.innerHTML = scSchema.map((field) => renderField(field, data[field.key], 'sc-char-')).join('');
  attachLiveValidation(characterDynamicFields);
}
```

- [ ] **Step 3: `renderCharacterList`, `startEdit`, `resetCharacterForm`, Submit-Handler ersetzen**

Den Block von `function renderCharacterList()` bis zum Ende des `characterForm.addEventListener('submit', ...)`-Handlers (ursprünglich Zeilen 706-768) komplett ersetzen durch:

```javascript
function statusLineForCharacter(c) {
  if (!c.registeredFor) return 'Noch keinem Event zugeordnet.';
  const roleLabel = CON_ROLE_LABELS[c.registeredFor.conRole] ?? c.registeredFor.conRole;
  return `Für ${escapeHtml(c.registeredFor.eventName)} als ${escapeHtml(roleLabel)} angemeldet.`;
}

function renderCharacterList() {
  const scCharacters = characters.filter((c) => c.class !== 'nsc');
  characterListBody.innerHTML = scCharacters.map((c) => {
    const tagsHtml = tagsForCharacter(c);
    return `<div class="char-card">
      <h3>${escapeHtml(c.name)}</h3>
      <p class="sub">${statusLineForCharacter(c)}</p>
      <div class="char-tags">${tagsHtml}</div>
      <button type="button" data-edit="${c.id}" class="btn-ghost" style="margin-top:14px;">Bearbeiten</button>
      <button type="button" data-delete="${c.id}" class="btn-ghost">Löschen</button>
      <div class="char-files" data-files-for="${c.id}">
        <p class="sub">Dateien werden geladen …</p>
      </div>
    </div>`;
  }).join('');

  characterListBody.querySelectorAll('[data-edit]').forEach((button) => {
    button.addEventListener('click', () => startEdit(button.dataset.edit));
  });
  characterListBody.querySelectorAll('[data-delete]').forEach((button) => {
    button.addEventListener('click', () => deleteCharacterCard(button.dataset.delete));
  });
  scCharacters.forEach((c) => loadFilesInto(c.id));

  if (nscSection.style.display !== 'none') {
    nscCharacters = characters.filter((c) => c.class === 'nsc');
    renderNscList();
  }
}

function startEdit(characterId) {
  const character = characters.find((c) => c.id === characterId);
  if (!character) return;
  editingCharacterId = characterId;
  characterFormTitle.textContent = `Charakter bearbeiten: ${character.name}`;
  characterForm.elements.name.value = character.name;
  renderScSchemaFields(character.data);
  characterForm.querySelector('button[type="submit"]').textContent = 'Änderungen speichern';
  characterCancelButton.style.display = '';
}

function resetCharacterForm() {
  editingCharacterId = null;
  characterFormTitle.textContent = 'Neuen Charakter anlegen';
  characterForm.reset();
  renderScSchemaFields();
  characterForm.querySelector('button[type="submit"]').textContent = 'Speichern';
  characterCancelButton.style.display = 'none';
}

characterCancelButton.addEventListener('click', resetCharacterForm);

async function deleteCharacterCard(characterId) {
  if (!confirm('Charakter wirklich löschen?')) return;
  characterMessage.textContent = '';
  characterMessage.className = '';
  try {
    await api.delete(`/characters/${characterId}`);
    if (editingCharacterId === characterId) resetCharacterForm();
    await loadCharacters();
  } catch (err) {
    characterMessage.textContent = err.message;
    characterMessage.className = 'error';
  }
}

document.getElementById('copy-character-btn').addEventListener('click', () => {
  const scCharacters = characters.filter((c) => c.class !== 'nsc');
  const select = document.getElementById('copy-character-select');
  select.innerHTML = scCharacters.map((c) => `<option value="${escapeHtml(c.id)}">${escapeHtml(c.name)}</option>`).join('');
  document.getElementById('copy-character-dialog').showModal();
});

document.getElementById('copy-character-cancel').addEventListener('click', () => {
  document.getElementById('copy-character-dialog').close();
});

document.getElementById('copy-character-confirm').addEventListener('click', () => {
  const sourceId = document.getElementById('copy-character-select').value;
  const source = characters.find((c) => c.id === sourceId);
  document.getElementById('copy-character-dialog').close();
  if (!source) return;
  resetCharacterForm();
  characterForm.elements.name.value = source.name;
  renderScSchemaFields(source.data);
  scFormSection.scrollIntoView({ behavior: 'smooth' });
});

characterForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  characterMessage.textContent = '';
  characterMessage.className = '';
  const name = characterForm.elements.name.value;
  const data = collectFieldValues(characterForm, scSchema);
  try {
    if (editingCharacterId) {
      await api.put(`/characters/${editingCharacterId}`, { name, data });
    } else {
      await api.post('/characters', { class: 'sc', name, data });
    }
    characterMessage.textContent = 'Gespeichert.';
    characterMessage.className = 'success';
    resetCharacterForm();
    await loadCharacters();
  } catch (err) {
    characterMessage.textContent = err.status === 400 && err.body?.details
      ? err.body.details.join(', ')
      : err.message;
    characterMessage.className = 'error';
  }
});
```

- [ ] **Step 4: SC-Schema im Bootstrap-Block laden**

Im abschließenden `try { const account = await api.get('/account'); ... }`-Block, die Zeile `scFormSection.style.display = '';` (ursprünglich Zeile 787) wird zu:

```javascript
  scFormSection.style.display = '';
  scSchema = await api.get('/sc-schema');
  renderScSchemaFields();
```

- [ ] **Step 5: Manuelle Verifikation im Dev-Server**

Dev-Server starten (`npm run dev` bzw. Docker-Compose-dev, siehe `CLAUDE.md`), `/account.html` → Veranstaltung → Charaktere:
- Neuen Charakter mit Sheet-Feldern anlegen → Karte zeigt Tags + „Noch keinem Event zugeordnet.".
- Bearbeiten → alle Felder (nicht nur Name) vorbefüllt, Abbrechen setzt Formular zurück.
- Löschen entfernt die Karte.
- „Aus bestehendem Charakter kopieren" befüllt das Anlage-Formular mit Name+Daten einer bestehenden Karte, Speichern legt einen zweiten, unabhängigen Charakter an.

- [ ] **Step 6: Commit**

```bash
git add frontend/account.html
git commit -m "feat: character tab shows full sheet form, event status, delete, and copy-from-existing"
```

---

## Task 6: Frontend — `account.html` Anmelden-Unterschritt

**Files:**
- Modify: `frontend/account.html`

**Interfaces:**
- Consumes: `characters` array jetzt mit `registeredFor` (Task 2/5); `POST /events/:id/register` liefert neu ggf. `409 CHARACTER_ALREADY_REGISTERED` (Task 3).

- [ ] **Step 1: `<div id="dynamic-fields"></div>` aus dem Markup entfernen**

In `frontend/account.html`, im `registration-form` (ursprünglich Zeile 106), die Zeile

```html
          <div id="dynamic-fields"></div>
```

ersatzlos entfernen (die Zeile davor/danach — `character-select-wrap`-Block und die Überschrift „Weitere Angaben zu dieser Anmeldung" — bleiben unverändert).

- [ ] **Step 2: `dynamicFields`-Referenz, `populateCharacterOptions`, `renderDynamicFieldsForSelection` anpassen**

Die Konstante `const dynamicFields = document.getElementById('dynamic-fields');` (ursprünglich Zeile 282) entfernen.

`populateCharacterOptions()` (ursprünglich Zeilen 317-330) ersetzen durch:

```javascript
function populateCharacterOptions() {
  const conRole = conRoleSelect.value;
  const needsCharacter = ['sc', 'gsc', 'nsc'].includes(conRole);
  characterSelectWrap.style.display = needsCharacter ? '' : 'none';
  if (!needsCharacter) return;
  const expectedClass = classForConRole(conRole);
  const matching = characters.filter((c) => {
    if (c.class !== expectedClass) return false;
    if (expectedClass === 'sc' && c.registeredFor) return false;
    return true;
  });
  characterSelect.innerHTML = matching.map((c) => `<option value="${escapeHtml(c.id)}">${escapeHtml(c.name)}</option>`).join('');
  noCharacterHint.style.display = matching.length === 0 ? '' : 'none';
}
```

Die Funktion `renderDynamicFieldsForSelection` (ursprünglich Zeilen 332-341) komplett entfernen.

- [ ] **Step 3: Event-Listener anpassen, die `renderDynamicFieldsForSelection` aufriefen**

```javascript
conRoleSelect.addEventListener('change', populateCharacterOptions);
eventSelect.addEventListener('change', updateRegisterButtonLabel);
```

(ersetzt die ursprünglichen drei Listener-Registrierungen für `characterSelect.addEventListener('change', renderDynamicFieldsForSelection)` und den zweizeiligen `eventSelect`-Listener; `characterSelect` braucht ab jetzt keinen eigenen `change`-Listener mehr.)

- [ ] **Step 4: Submit-Handler vereinfachen**

`registrationForm.addEventListener('submit', ...)` (ursprünglich Zeilen 460-487) ersetzen durch:

```javascript
registrationForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  registrationMessage.textContent = '';
  registrationMessage.className = '';
  const eventId = eventSelect.value;
  const conRole = conRoleSelect.value;
  const needsCharacter = ['sc', 'gsc', 'nsc'].includes(conRole);
  const characterId = needsCharacter ? characterSelect.value : undefined;
  if (needsCharacter && !characterId) return;

  try {
    await api.post(`/events/${eventId}/register`, { conRole, characterId, otFields: collectOtFields() });
    registrationMessage.textContent = 'Angemeldet.';
    registrationMessage.className = 'success';
    renderOtFields();
    await loadRegistrations();
    await loadCharacters();
  } catch (err) {
    registrationMessage.textContent = err.status === 400 && err.body?.details
      ? err.body.details.join(', ')
      : err.message;
    registrationMessage.className = 'error';
  }
});
```

(`await loadCharacters();` ist neu: nach erfolgreicher Anmeldung muss das `character-select`-Dropdown den jetzt frisch belegten Charakter sofort ausschließen, ohne Reload.)

- [ ] **Step 5: Manuelle Verifikation im Dev-Server**

`/account.html` → Veranstaltung → Anmelden: Charakter für Event A anmelden, dann prüfen, dass er im Dropdown für ein zweites, aktives Event nicht mehr auftaucht; nach Abmelden (Status `pending`) taucht er wieder auf.

- [ ] **Step 6: Commit**

```bash
git add frontend/account.html
git commit -m "feat: registration form drops per-event character sheet fields, filters to unused characters"
```

---

## Task 7: Frontend — neue Admin-Seite `character-schema.html` (SC + NSC)

**Files:**
- Create: `frontend/admin/character-schema.html`
- Modify: `frontend/js/nav.js`
- Modify: `frontend/admin/events.html` (Schema-Editor entfernt)

**Interfaces:**
- Consumes: `GET/PUT /sc-schema`, `GET/PUT /nsc-schema`.

- [ ] **Step 1: `frontend/admin/character-schema.html` neu anlegen**

```html
<!DOCTYPE html>
<html lang="de">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Charakterschema – Pakyrion Admin</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
<link rel="stylesheet" href="/css/everest-registry.css">
</head>
<body>
<div class="app">
  <aside class="sidebar">
    <div class="sidebar-brand">Pakyrion<span>Admin</span></div>
    <nav id="nav-links"></nav>
    <div class="sidebar-foot"><a href="#" id="logout-link">Logout</a></div>
  </aside>
  <div class="main"><div class="content">
    <h1>Charakterschema</h1>
    <p class="sub">Legt fest, welche Sheet-Felder Charaktere haben. SC/GSC-Charaktere teilen sich ein Schema über alle Events hinweg; NSC-Charaktere haben ihr eigenes, ebenfalls app-weites Schema.</p>

    <div class="tabs" id="class-tabs">
      <button type="button" class="tab-btn active" data-tab="sc-schema-tab">SC/GSC</button>
      <button type="button" class="tab-btn" data-tab="nsc-schema-tab">NSC</button>
    </div>

    <div class="tab-panel card form-pad" id="sc-schema-tab">
      <div id="sc-schema-rows"></div>
      <button type="button" id="sc-add-field">Feld hinzufügen</button>
      <button type="button" id="sc-load-template">Standard-Vorlage laden</button>
      <button type="button" id="sc-schema-save">Speichern</button>
    </div>

    <div class="tab-panel card form-pad" id="nsc-schema-tab" hidden>
      <div id="nsc-schema-rows"></div>
      <button type="button" id="nsc-add-field">Feld hinzufügen</button>
      <button type="button" id="nsc-schema-save">Speichern</button>
    </div>

    <p id="message"></p>
  </div></div>
</div>

<script type="module">
import { api } from '/js/api.js';
import { applyBranding } from '/js/branding.js';
applyBranding();
import { escapeHtml } from '/js/formFields.js';
import { DEFAULT_CHARACTER_SCHEMA } from '/js/defaultCharacterSchema.js';
import { renderNavLinks } from '/js/nav.js';

const message = document.getElementById('message');

function initTabs(tabsEl) {
  const buttons = [...tabsEl.querySelectorAll('.tab-btn')];
  buttons.forEach((btn) => {
    btn.addEventListener('click', () => {
      buttons.forEach((b) => {
        b.classList.toggle('active', b === btn);
        document.getElementById(b.dataset.tab).hidden = b !== btn;
      });
    });
  });
}
initTabs(document.getElementById('class-tabs'));

function addSchemaRow(container, field = { key: '', label: '', type: 'text', required: false, public: false, options: [] }) {
  const row = document.createElement('div');
  row.className = 'schema-row';
  const optionsValue = Array.isArray(field.options) ? field.options.join(', ') : '';
  row.innerHTML = `
    <input type="text" placeholder="key" class="schema-key" value="${escapeHtml(field.key)}">
    <input type="text" placeholder="Label" class="schema-label" value="${escapeHtml(field.label)}">
    <select class="schema-type">
      <option value="text" ${field.type === 'text' ? 'selected' : ''}>Text</option>
      <option value="textarea" ${field.type === 'textarea' ? 'selected' : ''}>Textarea</option>
      <option value="select" ${field.type === 'select' ? 'selected' : ''}>Auswahl</option>
      <option value="number" ${field.type === 'number' ? 'selected' : ''}>Zahl</option>
      <option value="boolean" ${field.type === 'boolean' ? 'selected' : ''}>Ja/Nein</option>
      <option value="multiselect" ${field.type === 'multiselect' ? 'selected' : ''}>Mehrfachauswahl</option>
      <option value="link" ${field.type === 'link' ? 'selected' : ''}>Link</option>
    </select>
    <input type="text" placeholder="Optionen (kommagetrennt, nur bei Auswahl)" class="schema-options" value="${escapeHtml(optionsValue)}">
    <label><input type="checkbox" class="schema-required" ${field.required ? 'checked' : ''}> Pflichtfeld</label>
    <label><input type="checkbox" class="schema-public" ${field.public ? 'checked' : ''}> Öffentlich sichtbar</label>
    <button type="button" class="remove-row">Entfernen</button>
  `;
  row.querySelector('.remove-row').addEventListener('click', () => row.remove());
  container.appendChild(row);
}

function collectSchema(container) {
  return [...container.children].map((row) => {
    const type = row.querySelector('.schema-type').value;
    const field = {
      key: row.querySelector('.schema-key').value.trim(),
      label: row.querySelector('.schema-label').value.trim(),
      type,
      required: row.querySelector('.schema-required').checked,
      public: row.querySelector('.schema-public').checked,
    };
    if (type === 'select' || type === 'multiselect') {
      field.options = row.querySelector('.schema-options').value
        .split(',')
        .map((opt) => opt.trim())
        .filter((opt) => opt.length > 0);
    }
    return field;
  }).filter((field) => field.key.length > 0);
}

function setupSchemaEditor({ rowsId, addFieldId, saveId, endpoint, loadTemplateId }) {
  const rows = document.getElementById(rowsId);
  document.getElementById(addFieldId).addEventListener('click', () => addSchemaRow(rows));
  if (loadTemplateId) {
    document.getElementById(loadTemplateId).addEventListener('click', () => {
      rows.innerHTML = '';
      DEFAULT_CHARACTER_SCHEMA.forEach((field) => addSchemaRow(rows, field));
    });
  }
  document.getElementById(saveId).addEventListener('click', async () => {
    message.textContent = '';
    message.className = '';
    try {
      await api.put(endpoint, { schema: collectSchema(rows) });
      message.textContent = 'Gespeichert.';
      message.className = 'success';
    } catch (err) {
      message.textContent = err.status === 400 && err.body?.error ? err.body.error : err.message;
      message.className = 'error';
    }
  });
  return rows;
}

const scRows = setupSchemaEditor({ rowsId: 'sc-schema-rows', addFieldId: 'sc-add-field', saveId: 'sc-schema-save', endpoint: '/sc-schema', loadTemplateId: 'sc-load-template' });
const nscRows = setupSchemaEditor({ rowsId: 'nsc-schema-rows', addFieldId: 'nsc-add-field', saveId: 'nsc-schema-save', endpoint: '/nsc-schema' });

document.getElementById('logout-link').addEventListener('click', async (evt) => {
  evt.preventDefault();
  if (!confirm('Wirklich abmelden?')) return;
  await api.post('/auth/logout', {});
  window.location.href = '/login.html';
});

try {
  const account = await api.get('/account');
  document.getElementById('nav-links').innerHTML = renderNavLinks(account, window.location.pathname);
  if (account.group.key !== 'admin') {
    message.textContent = 'Kein Zugriff – nur für Admin.';
    message.className = 'error';
  } else {
    const [scSchema, nscSchema] = await Promise.all([api.get('/sc-schema'), api.get('/nsc-schema')]);
    scSchema.forEach((field) => addSchemaRow(scRows, field));
    nscSchema.forEach((field) => addSchemaRow(nscRows, field));
  }
} catch (err) {
  if (err.status === 401) window.location.href = '/login.html';
}
</script>
</body>
</html>
```

- [ ] **Step 2: Nav-Eintrag ergänzen**

In `frontend/js/nav.js`, nach der Zeile `links.push({ key: 'gruppen', label: 'Gruppen', href: '/admin/groups.html' });` ergänzen:

```javascript
    links.push({ key: 'charakterschema', label: 'Charakterschema', href: '/admin/character-schema.html' });
```

- [ ] **Step 3: Schema-Editor aus `frontend/admin/events.html` entfernen**

Im `<form id="event-form">` (ursprünglich Zeilen 33-47), den Block ab `<hr class="hr">` bis `<button type="button" id="load-template">Standard-Vorlage laden</button>` entfernen — das Formular endet danach direkt mit dem Speichern-Button:

```html
      <form id="event-form">
        <label for="event-name">Name</label>
        <input id="event-name" name="name" type="text" required>
        <label for="event-date">Datum</label>
        <input id="event-date" name="eventDate" type="date" required>
        <label for="event-code">QR-Code-Kennung <span style="opacity:0.6;font-size:12px;">optional, z.B. P17/2027</span></label>
        <input id="event-code" name="code" type="text" placeholder="P17/2027">
        <button type="submit">Speichern</button>
        <button type="button" id="event-cancel-edit" class="btn-ghost">Abbrechen</button>
      </form>
```

Im zugehörigen `<script type="module">`:
- Import `import { DEFAULT_CHARACTER_SCHEMA } from '/js/defaultCharacterSchema.js';` entfernen.
- Die Konstante `const schemaRows = document.getElementById('schema-rows');` entfernen.
- Die Funktionen `addSchemaRow`, `collectSchema` sowie die Listener für `add-field` und `load-template` komplett entfernen.
- In `startEdit(eventData)`: die Zeilen `schemaRows.innerHTML = ''; eventData.character_form_schema.forEach((field) => addSchemaRow(field));` entfernen.
- In `resetForm()`: die Zeile `schemaRows.innerHTML = '';` entfernen.
- Im Submit-Handler: `characterFormSchema: collectSchema(),` aus dem `payload`-Objekt entfernen.

- [ ] **Step 4: Manuelle Verifikation im Dev-Server**

Als Admin einloggen, `/admin/character-schema.html` öffnen: SC/GSC-Tab zeigt das über die Migration übernommene Schema, NSC-Tab das bestehende NSC-Schema; beide unabhängig speicherbar. `/admin/events.html`: Event-Formular hat keinen Schema-Editor mehr.

- [ ] **Step 5: Commit**

```bash
git add frontend/admin/character-schema.html frontend/js/nav.js frontend/admin/events.html
git commit -m "feat: add admin/character-schema.html (sc+nsc), remove per-event schema editor from admin/events.html"
```

---

## Task 8: Frontend — `admin/checkin.html` und `characters-browse.html` auf globales Schema umstellen

**Files:**
- Modify: `frontend/admin/checkin.html`
- Modify: `frontend/characters-browse.html`

**Interfaces:**
- Consumes: `GET /sc-schema`.

- [ ] **Step 1: `frontend/admin/checkin.html` — Schema einmalig global laden**

Die Funktion `onEventChanged()` (ursprünglich Zeilen 168-176) verliert ihre Schema-Zuweisung:

```javascript
function onEventChanged() {
  selectedColumns = loadSelectedColumns(eventSelect.value);
  selectedColumns.it = selectedColumns.it.filter((key) => currentSchema.some((f) => f.key === key));
  renderColumnCheckboxes();
  renderTableHead();
}
```

Im abschließenden Bootstrap-Block (`try { const account = await api.get('/account'); ... }`), vor dem ersten Aufruf, der `currentSchema` braucht (spätestens vor `onEventChanged()`/`renderColumnCheckboxes()`), ergänzen:

```javascript
  currentSchema = await api.get('/sc-schema');
```

(`let currentSchema = [];` in der Variablendeklaration bleibt bestehen als Initialwert vor dem Laden.)

- [ ] **Step 2: `frontend/characters-browse.html` — globales Schema statt `event.character_form_schema`**

Die Funktion `loadCharacters()` (ursprünglich Zeilen 54-74) wird:

```javascript
let scSchema = [];

async function loadCharacters() {
  message.textContent = '';
  const eventId = eventSelect.value;
  if (!eventId) { listBody.innerHTML = ''; return; }
  try {
    const characters = await api.get(`/events/${eventId}/characters/public`);
    if (characters.length === 0) {
      listBody.innerHTML = '<p>Keine Charaktere für dieses Event.</p>';
      return;
    }
    listBody.innerHTML = characters.map((c) => `<div class="char-card">
      <h3>${escapeHtml(c.name)}</h3>
      <div class="char-tags">${tagsForCharacter(c, scSchema)}</div>
    </div>`).join('');
  } catch (err) {
    message.textContent = err.message;
    message.className = 'error';
  }
}
```

Im abschließenden `try`-Block, vor `await loadCharacters();` (ursprünglich Zeile 90), ergänzen:

```javascript
  scSchema = await api.get('/sc-schema');
```

- [ ] **Step 3: Manuelle Verifikation im Dev-Server**

`/admin/checkin.html`: Spalten-Auswahl zeigt die globalen SC-Felder unabhängig vom gewählten Event. `/characters-browse.html`: Tags für durchsuchte Charaktere erscheinen unverändert korrekt.

- [ ] **Step 4: Commit**

```bash
git add frontend/admin/checkin.html frontend/characters-browse.html
git commit -m "refactor: checkin + characters-browse read the global sc schema instead of event.character_form_schema"
```

---

## Task 9: Vollständiger Testlauf

**Files:** keine (Verifikationsaufgabe)

- [ ] **Step 1: Kompletten Backend-Testlauf ausführen**

Run: `npm test`
Expected: alle Tests PASS (inklusive aller in Task 1-4 geänderten/neuen Dateien sowie aller unveränderten Tests im Projekt).

- [ ] **Step 2: Bei Fehlschlägen: root cause fixen, nicht den Test schwächen**

Falls ein bislang nicht betrachteter Test (außerhalb der in Task 1-4 gelisteten Dateien) `character_form_schema` referenziert oder von der Merge-Semantik abhängt, den zugrunde liegenden Code-/Datenpfad korrigieren, nicht die Assertion abschwächen.

- [ ] **Step 3: Manueller End-to-End-Rauchtest im Dev-Server**

`docker compose -f docker-compose.dev.yml up` (siehe `CLAUDE.md`), im Browser: neues Konto → Charakter mit Sheet-Feldern anlegen → für aktives Event anmelden → Charakter verschwindet aus der Auswahl für ein zweites Event → „Aus bestehendem Charakter kopieren" → neuer, unabhängiger Charakter → für das zweite Event anmelden.

- [ ] **Step 4: Commit (nur falls Step 2 Änderungen nötig machte)**

```bash
git add -A
git commit -m "fix: address test fallout from charakter-pro-event migration"
```

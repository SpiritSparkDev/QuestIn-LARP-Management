# Event-Kapazität & Warteliste Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Events get an optional maximum participant count; registrations beyond that count land on a `waitlisted` status instead of the normal `pending` approval flow, with automatic or manual promotion back to `pending` when a slot frees up.

**Architecture:** Extends the existing `registrations.status` state machine with one new value (`waitlisted`) instead of a parallel table. Capacity checks and promotion both run inside `withTransaction` with a `SELECT ... FOR UPDATE` lock on the `events` row to serialize concurrent registrations/cancellations for the same event. Manual promotion reuses the existing per-row status-override dropdown in `admin/checkin.html` rather than adding a new endpoint/button.

**Tech Stack:** Node.js (no framework — hand-rolled router), PostgreSQL (`pg`), `node --test` for tests, vanilla JS/HTML frontend (no build step), nodemailer.

**Spec:** `docs/superpowers/specs/2026-09-23-event-kapazitaet-warteliste-design.md`

## Global Constraints

- Zählbasis für `capacity`: `pending`, `confirmed`, `checked_in`, `checked_out` zählen; `cancelled` und `waitlisted` selbst zählen nicht.
- `capacity = NULL` bedeutet unbegrenzt — Standardverhalten für jedes bestehende Event bleibt unverändert.
- Ein nachträglich GESENKTES Limit wirkt nur auf neue Anmeldungen — nie automatisches Zurückstufen bestehender Registrierungen.
- Ein nachträglich ERHÖHTES Limit (oder auf `NULL`/unbegrenzt geändert) löst bei aktivem `waitlist_auto_promote` sofort eine Promotion-Runde aus.
- E-Mail bei "auf Warteliste gesetzt" (Anmeldung) UND bei "nachgerückt" (automatisch oder manuell) — jede fire-and-forget, eigener try/catch, nie ein 500.
- Teilnehmer sehen bei `waitlisted` nur "Warteliste" als Status-Label, keine Positionsnummer.
- `backend/appSettings/repository.js`s `setAppSettings`-COALESCE-Kette MUSS `waitlist_auto_promote` mit aufnehmen, sonst wird es von jeder anderen Settings-Karte, die nur ihre eigenen Felder sendet, beim Speichern stillschweigend zurückgesetzt.
- Manuelles Nachrücken läuft über den bestehenden Status-Override-Mechanismus (`PUT /events/:id/checkin/:userId`), kein neuer Endpoint.
- Letzter Task-Schritt: voller `npm test`-Lauf (Projektstandard, siehe Memory `project_pakyrion_plan_sequence`).

---

### Task 1: Datenbankschema + Statusmaschine

**Files:**
- Create: `db/migrations/039_event_capacity_waitlist.sql`
- Modify: `backend/registrations/statusMachine.js`
- Modify: `tests/unit/statusMachine.test.js`

**Interfaces:**
- Produces: `events.capacity` (integer, nullable), `app_settings.waitlist_auto_promote` (boolean, default true), `registrations.status` CHECK-Constraint erweitert um `'waitlisted'`, `statusMachine.js` neue Transition `waitlisted: { cancel: 'cancelled' }`. (Promotion `waitlisted → pending` läuft in Task 5 bewusst NICHT über `applyTransition` — weder die automatische Promotion noch die manuelle über den bestehenden `setStatus`-Override rufen diese Funktion auf, siehe Task 5 — daher gibt es keine `promote`-Aktion in der Statusmaschine, das wäre toter Code.)

- [ ] **Step 1: Migration schreiben**

```sql
-- db/migrations/039_event_capacity_waitlist.sql
ALTER TABLE events ADD COLUMN capacity integer;
ALTER TABLE app_settings ADD COLUMN waitlist_auto_promote boolean NOT NULL DEFAULT true;

ALTER TABLE registrations DROP CONSTRAINT registrations_status_check;
ALTER TABLE registrations ADD CONSTRAINT registrations_status_check
  CHECK (status IN ('pending', 'confirmed', 'checked_in', 'checked_out', 'cancelled', 'waitlisted'));
```

- [ ] **Step 2: Migration anwenden und verifizieren**

Run: `docker compose -f docker-compose.dev.yml up -d` (falls nicht bereits an), dann `docker compose -f docker-compose.dev.yml exec backend node db/migrate.js`
Expected: Ausgabe listet `039_event_capacity_waitlist.sql` als angewendet.

- [ ] **Step 3: `statusMachine.js` erweitern**

```javascript
// backend/registrations/statusMachine.js
const TRANSITIONS = {
  pending: { approve: 'confirmed', cancel: 'cancelled' },
  confirmed: { checkin: 'checked_in', cancel: 'cancelled' },
  checked_in: { checkout: 'checked_out' },
  checked_out: {},
  cancelled: {},
  waitlisted: { cancel: 'cancelled' },
};

export function applyTransition(currentStatus, action) {
  const next = TRANSITIONS[currentStatus]?.[action];
  if (!next) {
    const err = new Error(`Ungültiger Übergang: "${action}" nicht möglich von Status "${currentStatus}".`);
    err.code = 'INVALID_TRANSITION';
    throw err;
  }
  return next;
}
```

- [ ] **Step 4: Failing Tests für die neuen Transitions schreiben**

Anhängen an `tests/unit/statusMachine.test.js`:

```javascript
test('waitlisted -> cancelled via cancel', () => {
  assert.equal(applyTransition('waitlisted', 'cancel'), 'cancelled');
});

test('checkin/checkout/approve from waitlisted are rejected', () => {
  assert.throws(() => applyTransition('waitlisted', 'checkin'));
  assert.throws(() => applyTransition('waitlisted', 'checkout'));
  assert.throws(() => applyTransition('waitlisted', 'approve'));
});
```

- [ ] **Step 5: Tests laufen lassen**

Run: `node --test tests/unit/statusMachine.test.js`
Expected: alle Tests PASS (Step 3 lief vor Step 4, also kein Red-Green nötig — die Implementierung existiert bereits, Tests bestätigen sie).

- [ ] **Step 6: Commit**

```bash
git add db/migrations/039_event_capacity_waitlist.sql backend/registrations/statusMachine.js tests/unit/statusMachine.test.js
git commit -m "feat: add waitlisted status to registrations, capacity/waitlist-promote columns"
```

---

### Task 2: `app_settings.waitlistAutoPromote` + Mailer-Funktionen

**Files:**
- Modify: `backend/appSettings/repository.js`
- Modify: `backend/appSettings/routes.js`
- Modify: `backend/auth/mailer.js`
- Modify: `tests/integration/appSettings.test.js`

**Interfaces:**
- Consumes: nichts aus Task 1 direkt (nur die Migration muss angewendet sein).
- Produces: `getAppSettings()` liefert zusätzlich `waitlistAutoPromote: boolean`; `setAppSettings({..., waitlistAutoPromote})`; `sendWaitlistedEmail(to, { eventName }, { transporter, from })`; `sendWaitlistPromotedEmail(to, { eventName }, { transporter, from })` — beide von Task 5 konsumiert.

- [ ] **Step 1: Bestehenden `appSettings.test.js`-Test anpassen (er bricht sonst durch das neue Feld)**

In `tests/integration/appSettings.test.js`, beide `assert.deepEqual`-Aufrufe (Zeilen 33 und 52) um `waitlistAutoPromote: true` erweitern:

```javascript
// GET-Test (vorher Zeile 33)
assert.deepEqual(body, { logoUrl: null, appTitle: null, eventName: null, quotaMbPerCharacter: 100, invitationTtlDays: 3, characterBrowsingEnabled: true, waitlistAutoPromote: true, hasUploadedLogo: false, hasUploadedTicketBackground: false });

// PUT-Test (vorher Zeile 52)
assert.deepEqual(getBody, { logoUrl: 'https://example.com/logo.png', appTitle: 'P17 Check-In', eventName: 'P17/2027', quotaMbPerCharacter: 100, invitationTtlDays: 3, characterBrowsingEnabled: true, waitlistAutoPromote: true, hasUploadedLogo: false, hasUploadedTicketBackground: false });
```

- [ ] **Step 2: Neuen Test für das Feld schreiben (failing bis Step 3/4 implementiert sind)**

Anhängen an `tests/integration/appSettings.test.js`:

```javascript
test('PUT /app-settings sets waitlistAutoPromote without touching unrelated fields (COALESCE regression)', async () => {
  await withTestServer(async (port) => {
    const cookie = await makeUserAndSession('admin');

    await fetch(`http://localhost:${port}/app-settings`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ appTitle: 'Vor der Änderung', eventName: 'P17/2027' }),
    });

    const putRes = await fetch(`http://localhost:${port}/app-settings`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ waitlistAutoPromote: false }),
    });
    assert.equal(putRes.status, 200);
    const body = await putRes.json();
    assert.equal(body.waitlistAutoPromote, false);
    // The unrelated fields from the earlier PUT must survive untouched.
    assert.equal(body.appTitle, 'Vor der Änderung');
    assert.equal(body.eventName, 'P17/2027');
  });
});

test('PUT /app-settings rejects a non-boolean waitlistAutoPromote', async () => {
  await withTestServer(async (port) => {
    const cookie = await makeUserAndSession('admin');
    const res = await fetch(`http://localhost:${port}/app-settings`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ waitlistAutoPromote: 'yes' }),
    });
    assert.equal(res.status, 400);
  });
});
```

- [ ] **Step 3: Tests laufen lassen, um den Fail zu bestätigen**

Run: `node --test tests/integration/appSettings.test.js`
Expected: FAIL — `waitlistAutoPromote` fehlt in der Antwort / 400-Validierung existiert nicht.

- [ ] **Step 4: `backend/appSettings/repository.js` erweitern**

```javascript
export async function getAppSettings() {
  const { rows } = await query('SELECT logo_url, app_title, event_name, quota_mb_per_character, invitation_ttl_days, character_browsing_enabled, waitlist_auto_promote, logo_data IS NOT NULL AS has_uploaded_logo, ticket_bg_data IS NOT NULL AS has_uploaded_ticket_background FROM app_settings LIMIT 1');
  if (rows.length === 0) return { logoUrl: null, appTitle: null, eventName: null, quotaMbPerCharacter: 100, invitationTtlDays: 3, characterBrowsingEnabled: true, waitlistAutoPromote: true, hasUploadedLogo: false, hasUploadedTicketBackground: false };
  return {
    logoUrl: rows[0].logo_url,
    appTitle: rows[0].app_title,
    eventName: rows[0].event_name,
    quotaMbPerCharacter: rows[0].quota_mb_per_character,
    invitationTtlDays: rows[0].invitation_ttl_days,
    characterBrowsingEnabled: rows[0].character_browsing_enabled,
    waitlistAutoPromote: rows[0].waitlist_auto_promote,
    hasUploadedLogo: rows[0].has_uploaded_logo,
    hasUploadedTicketBackground: rows[0].has_uploaded_ticket_background,
  };
}

export async function setAppSettings({ logoUrl, appTitle, eventName, quotaMbPerCharacter, invitationTtlDays, characterBrowsingEnabled, waitlistAutoPromote }) {
  const id = await ensureSettingsRow();
  await query(
    'UPDATE app_settings SET logo_url = COALESCE($2, logo_url), app_title = COALESCE($3, app_title), event_name = COALESCE($4, event_name), quota_mb_per_character = COALESCE($5, quota_mb_per_character), invitation_ttl_days = COALESCE($6, invitation_ttl_days), character_browsing_enabled = COALESCE($7, character_browsing_enabled), waitlist_auto_promote = COALESCE($8, waitlist_auto_promote) WHERE id = $1',
    [id, logoUrl ?? null, appTitle ?? null, eventName ?? null, quotaMbPerCharacter ?? null, invitationTtlDays ?? null, characterBrowsingEnabled ?? null, waitlistAutoPromote ?? null]
  );
  return getAppSettings();
}
```

(`ensureSettingsRow` und die Logo/Ticket-Background-Funktionen bleiben unverändert.)

- [ ] **Step 5: `backend/appSettings/routes.js`s `PUT /app-settings`-Handler erweitern**

```javascript
router.put('/app-settings', requireAuth(requireAdminGroup(async ({ req }) => {
  const body = await readJsonBody(req);
  if (body === null) return { status: 400, body: { error: 'invalid JSON' } };
  const { logoUrl, appTitle, eventName, quotaMbPerCharacter, invitationTtlDays, characterBrowsingEnabled, waitlistAutoPromote } = body;
  if (quotaMbPerCharacter !== undefined && (!Number.isInteger(quotaMbPerCharacter) || quotaMbPerCharacter < 1)) {
    return { status: 400, body: { error: 'quotaMbPerCharacter must be a positive integer' } };
  }
  if (invitationTtlDays !== undefined && (!Number.isInteger(invitationTtlDays) || invitationTtlDays < 1)) {
    return { status: 400, body: { error: 'invitationTtlDays must be a positive integer' } };
  }
  if (characterBrowsingEnabled !== undefined && typeof characterBrowsingEnabled !== 'boolean') {
    return { status: 400, body: { error: 'characterBrowsingEnabled must be a boolean' } };
  }
  if (waitlistAutoPromote !== undefined && typeof waitlistAutoPromote !== 'boolean') {
    return { status: 400, body: { error: 'waitlistAutoPromote must be a boolean' } };
  }
  const saved = await setAppSettings({ logoUrl, appTitle, eventName, quotaMbPerCharacter, invitationTtlDays, characterBrowsingEnabled, waitlistAutoPromote });
  return { status: 200, body: saved };
})));
```

- [ ] **Step 6: Mailer-Funktionen ergänzen**

Anhängen an `backend/auth/mailer.js`:

```javascript
export async function sendWaitlistedEmail(to, { eventName }, { transporter, from }) {
  return transporter.sendMail({
    to,
    from,
    subject: `Warteliste: ${eventName}`,
    text: `Deine Anmeldung für "${eventName}" ist eingegangen, das Event ist aber bereits ausgebucht. Du stehst auf der Warteliste und wirst benachrichtigt, sobald ein Platz frei wird.`,
  });
}

export async function sendWaitlistPromotedEmail(to, { eventName }, { transporter, from }) {
  return transporter.sendMail({
    to,
    from,
    subject: `Ein Platz ist frei geworden: ${eventName}`,
    text: `Für "${eventName}" ist ein Platz frei geworden — deine Anmeldung wurde von der Warteliste in die reguläre Anmeldung übernommen und wird nun wie gewohnt von der Orga bearbeitet.`,
  });
}
```

- [ ] **Step 7: Tests laufen lassen**

Run: `node --test tests/integration/appSettings.test.js`
Expected: alle Tests PASS.

- [ ] **Step 8: Commit**

```bash
git add backend/appSettings/repository.js backend/appSettings/routes.js backend/auth/mailer.js tests/integration/appSettings.test.js
git commit -m "feat: add waitlistAutoPromote setting and waitlist mailer templates"
```

---

### Task 3: `events.capacity` — Datenmodell, Repository, Routes

**Files:**
- Modify: `backend/events/repository.js`
- Modify: `backend/events/routes.js`
- Modify: `tests/integration/events.test.js`

**Interfaces:**
- Consumes: nichts aus Task 1/2 direkt (nur die Migration).
- Produces: `getEvent(id)`/`listEvents()`/`createEvent(...)` liefern `capacity`; `updateEvent(id, { name, eventDate, code, capacity })` unterstützt `capacity` inkl. expliziter Clear-auf-unbegrenzt-Unterscheidung (gleiches Muster wie `code`). `PUT /events/:id` gibt das aktualisierte Event samt `capacity` zurück — die Promotion-Verkettung bei einer Erhöhung folgt in Task 5 (dieser Task legt nur die Datenbasis, noch keine Seiteneffekte).

- [ ] **Step 1: Failing Test schreiben**

Anhängen an `tests/integration/events.test.js`:

```javascript
test('capacity can be set on create, updated, and cleared back to unlimited', async () => {
  await withTestServer(async (port) => {
    const admin = await makeUserAndSession('admin');

    const createRes = await fetch(`http://localhost:${port}/events`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: admin.cookie },
      body: JSON.stringify({ name: 'Kapazitäts-Con', eventDate: '2027-09-01', capacity: 30 }),
    });
    const created = await createRes.json();
    assert.equal(created.capacity, 30);

    const raiseRes = await fetch(`http://localhost:${port}/events/${created.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Cookie: admin.cookie },
      body: JSON.stringify({ capacity: 50 }),
    });
    const raised = await raiseRes.json();
    assert.equal(raised.capacity, 50);

    const clearRes = await fetch(`http://localhost:${port}/events/${created.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Cookie: admin.cookie },
      body: JSON.stringify({ capacity: null, clearCapacity: true }),
    });
    const cleared = await clearRes.json();
    assert.equal(cleared.capacity, null);
  });
});

test('an event created without capacity defaults to unlimited (null)', async () => {
  await withTestServer(async (port) => {
    const admin = await makeUserAndSession('admin');
    const res = await fetch(`http://localhost:${port}/events`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: admin.cookie },
      body: JSON.stringify({ name: 'Unbegrenzt-Con', eventDate: '2027-09-02' }),
    });
    const created = await res.json();
    assert.equal(created.capacity, null);
  });
});
```

- [ ] **Step 2: Tests laufen lassen, Fail bestätigen**

Run: `node --test tests/integration/events.test.js`
Expected: FAIL — `capacity` ist `undefined` in der Antwort.

- [ ] **Step 3: `backend/events/repository.js` erweitern**

```javascript
import { query } from '../db.js';

const SELECT_COLUMNS = 'id, name, event_date, code, capacity, is_active, created_at';

export async function createEvent({ name, eventDate, code, capacity }) {
  const { rows } = await query(
    `INSERT INTO events (name, event_date, code, capacity)
     VALUES ($1, $2, $3, $4)
     RETURNING ${SELECT_COLUMNS}`,
    [name, eventDate, code ?? null, capacity ?? null]
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

export async function updateEvent(id, { name, eventDate, code, capacity, clearCapacity }) {
  // code/capacity are the fields a caller can legitimately want to CLEAR
  // (empty string / "unbegrenzt") rather than just omit -- COALESCE alone
  // can't tell those apart, since both arrive as a falsy value. $6/$7
  // carry that distinction explicitly: only skip the write when the field
  // was genuinely absent from the call.
  const { rows } = await query(
    `UPDATE events SET
       name = COALESCE($2, name),
       event_date = COALESCE($3, event_date),
       code = CASE WHEN $6 THEN $4 ELSE code END,
       capacity = CASE WHEN $7 THEN $5 ELSE capacity END
     WHERE id = $1
     RETURNING ${SELECT_COLUMNS}`,
    [id, name ?? null, eventDate ?? null, code ?? null, capacity ?? null, code !== undefined, capacity !== undefined || Boolean(clearCapacity)]
  );
  return rows[0] ?? null;
}
```

- [ ] **Step 4: `backend/events/routes.js`s `POST /events`-Handler erweitern**

```javascript
router.post('/events', requireAuth(requireMenu('events')(async ({ req }) => {
  const body = await readJsonBody(req);
  if (body === null) return { status: 400, body: { error: 'invalid JSON' } };
  const { name, eventDate, code, capacity } = body;
  if (!name || !eventDate) {
    return { status: 400, body: { error: 'name and eventDate are required' } };
  }
  if (capacity !== undefined && capacity !== null && (!Number.isInteger(capacity) || capacity < 1)) {
    return { status: 400, body: { error: 'capacity must be a positive integer or null' } };
  }
  const event = await createEvent({ name, eventDate, code, capacity });
  return { status: 201, body: event };
})));
```

`PUT /events/:id` braucht keine Signaturänderung (`updateEvent(params.id, body)` reicht bereits `capacity`/`clearCapacity` durch), nur dieselbe Validierung davor:

```javascript
router.put('/events/:id', requireAuth(requireMenu('events')(async ({ req, params }) => {
  const body = await readJsonBody(req);
  if (body === null) return { status: 400, body: { error: 'invalid JSON' } };
  if (body.capacity !== undefined && body.capacity !== null && (!Number.isInteger(body.capacity) || body.capacity < 1)) {
    return { status: 400, body: { error: 'capacity must be a positive integer or null' } };
  }
  const event = await updateEvent(params.id, body);
  if (!event) return { status: 404, body: { error: 'event not found' } };
  return { status: 200, body: event };
})));
```

- [ ] **Step 5: Tests laufen lassen**

Run: `node --test tests/integration/events.test.js`
Expected: alle Tests PASS.

- [ ] **Step 6: Commit**

```bash
git add backend/events/repository.js backend/events/routes.js tests/integration/events.test.js
git commit -m "feat: add optional capacity field to events"
```

---

### Task 4: Registrierungs-Flow — Kapazitätsprüfung, Warteliste-Insert, Abmelden

**Files:**
- Modify: `backend/registrations/repository.js`
- Modify: `backend/registrations/routes.js`
- Modify: `tests/integration/registrations.test.js`

**Interfaces:**
- Consumes: `withTransaction` aus `backend/db.js`; `getEvent`/`updateEvent` aus `backend/events/repository.js` (bereits importiert); `applyTransition` aus `statusMachine.js` (Task 1).
- Produces: `registerForEvent(...)` gibt bei erreichter Kapazität `status: 'waitlisted'` zurück statt `'pending'`; `unregisterFromEvent` löscht jetzt auch `waitlisted`-Zeilen; `COUNTED_STATUSES`-Export, von Task 5 (`maybePromoteFromWaitlist`) wiederverwendet.

- [ ] **Step 1: Failing Tests schreiben**

Anhängen an `tests/integration/registrations.test.js` (nutzt die bereits vorhandenen Helper `makeUserAndSession`, `makeEvent`, `makeCharacter`):

```javascript
async function makeEventWithCapacity(capacity) {
  const { rows } = await query(
    "INSERT INTO events (name, event_date, is_active, capacity) VALUES ('Kapazitäts-Test-Con', '2027-08-02', true, $1) RETURNING id",
    [capacity]
  );
  return rows[0].id;
}

test('registering at capacity lands on the waitlist instead of pending', async () => {
  await withTestServer(async (port) => {
    const eventId = await makeEventWithCapacity(1);

    const first = await makeUserAndSession();
    const firstCharacterId = await makeCharacter(port, first.cookie);
    const firstRes = await fetch(`http://localhost:${port}/events/${eventId}/register`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: first.cookie },
      body: JSON.stringify({ conRole: 'sc', characterId: firstCharacterId }),
    });
    assert.equal((await firstRes.json()).status, 'pending');

    const second = await makeUserAndSession();
    const secondCharacterId = await makeCharacter(port, second.cookie);
    const secondRes = await fetch(`http://localhost:${port}/events/${eventId}/register`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: second.cookie },
      body: JSON.stringify({ conRole: 'sc', characterId: secondCharacterId }),
    });
    assert.equal(secondRes.status, 201);
    assert.equal((await secondRes.json()).status, 'waitlisted');
  });
});

test('two simultaneous registrations at the last free slot: exactly one pending, one waitlisted', async () => {
  await withTestServer(async (port) => {
    const eventId = await makeEventWithCapacity(1);
    const a = await makeUserAndSession();
    const aCharacterId = await makeCharacter(port, a.cookie);
    const b = await makeUserAndSession();
    const bCharacterId = await makeCharacter(port, b.cookie);

    const [resA, resB] = await Promise.all([
      fetch(`http://localhost:${port}/events/${eventId}/register`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: a.cookie },
        body: JSON.stringify({ conRole: 'sc', characterId: aCharacterId }),
      }),
      fetch(`http://localhost:${port}/events/${eventId}/register`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: b.cookie },
        body: JSON.stringify({ conRole: 'sc', characterId: bCharacterId }),
      }),
    ]);
    const statuses = [(await resA.json()).status, (await resB.json()).status].sort();
    assert.deepEqual(statuses, ['pending', 'waitlisted']);
  });
});

test('an event without capacity never waitlists', async () => {
  await withTestServer(async (port) => {
    const eventId = await makeEvent();
    const { userId, cookie } = await makeUserAndSession();
    const characterId = await makeCharacter(port, cookie);
    const res = await fetch(`http://localhost:${port}/events/${eventId}/register`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ conRole: 'sc', characterId }),
    });
    assert.equal((await res.json()).status, 'pending');
  });
});

test('a waitlisted participant can unregister (row deleted, no error)', async () => {
  await withTestServer(async (port) => {
    const eventId = await makeEventWithCapacity(1);
    const filler = await makeUserAndSession();
    const fillerCharacterId = await makeCharacter(port, filler.cookie);
    await fetch(`http://localhost:${port}/events/${eventId}/register`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: filler.cookie },
      body: JSON.stringify({ conRole: 'sc', characterId: fillerCharacterId }),
    });

    const waitlisted = await makeUserAndSession();
    const waitlistedCharacterId = await makeCharacter(port, waitlisted.cookie);
    await fetch(`http://localhost:${port}/events/${eventId}/register`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: waitlisted.cookie },
      body: JSON.stringify({ conRole: 'sc', characterId: waitlistedCharacterId }),
    });

    const unregisterRes = await fetch(`http://localhost:${port}/events/${eventId}/register`, {
      method: 'DELETE', headers: { Cookie: waitlisted.cookie },
    });
    assert.equal(unregisterRes.status, 200);

    const { rows } = await query('SELECT status FROM registrations WHERE event_id = $1 AND user_id = $2', [eventId, waitlisted.userId]);
    assert.equal(rows.length, 0);
  });
});
```

- [ ] **Step 2: Tests laufen lassen, Fail bestätigen**

Run: `node --test tests/integration/registrations.test.js`
Expected: FAIL — Registrierung landet immer auf `pending`, Warteliste-Abmelden liefert 409 `CANNOT_UNREGISTER`.

- [ ] **Step 3: `registerForEvent` auf Transaktion + Kapazitätsprüfung umstellen**

In `backend/registrations/repository.js`, Import ergänzen:

```javascript
import { query, withTransaction } from '../db.js';
```

`registerForEvent` (ersetzt den bisherigen `INSERT`-Block am Ende der Funktion, der Rest der Funktion — Validierung von `conRole`/`resolveCharacterId`/`resolveNscAvailability` — bleibt unverändert davor):

```javascript
const COUNTED_STATUSES = ['pending', 'confirmed', 'checked_in', 'checked_out'];

export async function registerForEvent(userId, eventId, conRole, characterId, nscAvailable, nscCharacterId, otFields, requestingUser) {
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

  if (SELF_SERVICE_CON_ROLES.includes(conRole) && !requestingUser.group.canEditCharacters && !event.is_active) {
    const err = new Error('Anmeldung ist nur für das aktuell aktive Event möglich.');
    err.code = 'EVENT_NOT_ACTIVE';
    throw err;
  }

  const resolvedCharacterId = await resolveCharacterId(userId, conRole, characterId, eventId);
  const resolvedNsc = await resolveNscAvailability(userId, conRole, nscAvailable, nscCharacterId);

  const schema = await getRegistrationFieldSchema();
  const data = {};
  for (const field of schema) {
    if (otFields?.[field.key] !== undefined) data[field.key] = otFields[field.key];
  }

  try {
    return await withTransaction(async (client) => {
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
        `INSERT INTO registrations (user_id, event_id, con_role, character_id, nsc_available, nsc_character_id, registration_data_enc, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         RETURNING user_id, event_id, status, con_role, character_id, nsc_available, nsc_character_id, checked_in_at, checked_out_at`,
        [userId, eventId, conRole, resolvedCharacterId, resolvedNsc.nscAvailable, resolvedNsc.nscCharacterId, encryptFieldBlob(data), status]
      );
      return rows[0];
    });
  } catch (err) {
    if (err.code === '23505') {
      const dup = new Error('Bereits für dieses Event angemeldet.');
      dup.code = 'ALREADY_REGISTERED';
      throw dup;
    }
    throw err;
  }
}
```

- [ ] **Step 4: `unregisterFromEvent` erweitern, um auch `waitlisted` zu löschen**

```javascript
export async function unregisterFromEvent(userId, eventId) {
  const { rowCount } = await query(
    "DELETE FROM registrations WHERE user_id = $1 AND event_id = $2 AND status IN ('pending', 'waitlisted')",
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
    const err = new Error('Abmelden nach Check-In nicht mehr möglich.');
    err.code = 'CANNOT_UNREGISTER';
    throw err;
  }
}
```

- [ ] **Step 5: `COUNTED_STATUSES` exportieren**

Direkt vor `export async function registerForEvent` (Step 3) steht bereits `const COUNTED_STATUSES = [...]` — `const` durch `export const` ersetzen, damit Task 5 (`maybePromoteFromWaitlist`) sie importieren kann:

```javascript
export const COUNTED_STATUSES = ['pending', 'confirmed', 'checked_in', 'checked_out'];
```

- [ ] **Step 6: `backend/registrations/routes.js`s `VALID_STATUSES` erweitern**

```javascript
const VALID_STATUSES = ['pending', 'confirmed', 'checked_in', 'checked_out', 'cancelled', 'waitlisted'];
```

(Diese Liste gated den bestehenden `PUT /events/:id/checkin/:userId`-Override-Endpoint — mit `waitlisted` als gültigem Wert kann Staff eine Person darauf setzen ODER von dort auf `pending` promoten. Die Promotion-E-Mail dafür kommt in Task 5.)

- [ ] **Step 7: Tests laufen lassen**

Run: `node --test tests/integration/registrations.test.js`
Expected: alle Tests PASS.

- [ ] **Step 8: Commit**

```bash
git add backend/registrations/repository.js backend/registrations/routes.js tests/integration/registrations.test.js
git commit -m "feat: registrations respect event capacity, land on waitlist when full"
```

---

### Task 5: Promotion-Logik (auto + manuell) + Verkettung

**Files:**
- Modify: `backend/registrations/repository.js`
- Modify: `backend/registrations/routes.js`
- Modify: `backend/events/routes.js`
- Modify: `tests/integration/registrations.test.js`
- Modify: `tests/integration/events.test.js`

**Interfaces:**
- Consumes: `COUNTED_STATUSES` (Task 4), `waitlistAutoPromote` via `getAppSettings()` (Task 2), `sendWaitlistedEmail`/`sendWaitlistPromotedEmail` (Task 2), `applyTransition` (Task 1), `getTransporterAndFrom` (bestehend), `withTransaction` (bestehend).
- Produces: `maybePromoteFromWaitlist(eventId)` — exportiert, von `unregisterFromEvent`, `cancelRegistration`, `setStatus` (bei Ziel `cancelled`) und `events/routes.js`s `PUT /events/:id` (bei Kapazitätserhöhung) aufgerufen. `setStatus` verschickt zusätzlich `sendWaitlistPromotedEmail` bei `waitlisted → pending`.

- [ ] **Step 1: Failing Tests schreiben**

Anhängen an `tests/integration/registrations.test.js`:

```javascript
async function makeCustomOverrideUserAndSession() {
  return makeCustomGroupUserAndSession({ visibleMenus: ['checkin'], canOverrideCheckinStatus: true });
}

test('auto-promote: cancelling a confirmed registration promotes the oldest waitlisted person', async () => {
  await withTestServer(async (port) => {
    const eventId = await makeEventWithCapacity(1);
    const staff = await makeCustomOverrideUserAndSession();

    const first = await makeUserAndSession();
    const firstCharacterId = await makeCharacter(port, first.cookie);
    await fetch(`http://localhost:${port}/events/${eventId}/register`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: first.cookie },
      body: JSON.stringify({ conRole: 'sc', characterId: firstCharacterId }),
    });

    const second = await makeUserAndSession();
    const secondCharacterId = await makeCharacter(port, second.cookie);
    await fetch(`http://localhost:${port}/events/${eventId}/register`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: second.cookie },
      body: JSON.stringify({ conRole: 'sc', characterId: secondCharacterId }),
    });

    const cancelRes = await fetch(`http://localhost:${port}/events/${eventId}/cancel`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: staff.cookie },
      body: JSON.stringify({ userId: first.userId }),
    });
    assert.equal(cancelRes.status, 200);

    const { rows } = await query('SELECT status FROM registrations WHERE event_id = $1 AND user_id = $2', [eventId, second.userId]);
    assert.equal(rows[0].status, 'pending');
  });
});

test('auto-promote disabled: cancelling does not promote anyone', async () => {
  await withTestServer(async (port) => {
    const admin = await makeUserAndSession('admin');
    await fetch(`http://localhost:${port}/app-settings`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json', Cookie: admin.cookie },
      body: JSON.stringify({ waitlistAutoPromote: false }),
    });
    const eventId = await makeEventWithCapacity(1);
    const staff = await makeCustomOverrideUserAndSession();

    const first = await makeUserAndSession();
    const firstCharacterId = await makeCharacter(port, first.cookie);
    await fetch(`http://localhost:${port}/events/${eventId}/register`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: first.cookie },
      body: JSON.stringify({ conRole: 'sc', characterId: firstCharacterId }),
    });
    const second = await makeUserAndSession();
    const secondCharacterId = await makeCharacter(port, second.cookie);
    await fetch(`http://localhost:${port}/events/${eventId}/register`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: second.cookie },
      body: JSON.stringify({ conRole: 'sc', characterId: secondCharacterId }),
    });

    await fetch(`http://localhost:${port}/events/${eventId}/cancel`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: staff.cookie },
      body: JSON.stringify({ userId: first.userId }),
    });

    const { rows } = await query('SELECT status FROM registrations WHERE event_id = $1 AND user_id = $2', [eventId, second.userId]);
    assert.equal(rows[0].status, 'waitlisted');

    // reset for later tests in this file
    await fetch(`http://localhost:${port}/app-settings`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json', Cookie: admin.cookie },
      body: JSON.stringify({ waitlistAutoPromote: true }),
    });
  });
});

test('manual promote via the existing status-override endpoint', async () => {
  await withTestServer(async (port) => {
    const eventId = await makeEventWithCapacity(1);
    const staff = await makeCustomOverrideUserAndSession();

    const filler = await makeUserAndSession();
    const fillerCharacterId = await makeCharacter(port, filler.cookie);
    await fetch(`http://localhost:${port}/events/${eventId}/register`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: filler.cookie },
      body: JSON.stringify({ conRole: 'sc', characterId: fillerCharacterId }),
    });
    const waitlisted = await makeUserAndSession();
    const waitlistedCharacterId = await makeCharacter(port, waitlisted.cookie);
    await fetch(`http://localhost:${port}/events/${eventId}/register`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: waitlisted.cookie },
      body: JSON.stringify({ conRole: 'sc', characterId: waitlistedCharacterId }),
    });

    const promoteRes = await fetch(`http://localhost:${port}/events/${eventId}/checkin/${waitlisted.userId}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json', Cookie: staff.cookie },
      body: JSON.stringify({ status: 'pending', previousStatus: 'waitlisted' }),
    });
    assert.equal(promoteRes.status, 200);
    assert.equal((await promoteRes.json()).status, 'pending');
  });
});

test('raising an event capacity promotes as many waitlisted people as now fit', async () => {
  await withTestServer(async (port) => {
    const eventId = await makeEventWithCapacity(1);
    const admin = await makeUserAndSession('admin');

    const filler = await makeUserAndSession();
    const fillerCharacterId = await makeCharacter(port, filler.cookie);
    await fetch(`http://localhost:${port}/events/${eventId}/register`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: filler.cookie },
      body: JSON.stringify({ conRole: 'sc', characterId: fillerCharacterId }),
    });

    const waitlistedUsers = [];
    for (let i = 0; i < 2; i += 1) {
      const u = await makeUserAndSession();
      const characterId = await makeCharacter(port, u.cookie);
      await fetch(`http://localhost:${port}/events/${eventId}/register`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: u.cookie },
        body: JSON.stringify({ conRole: 'sc', characterId }),
      });
      waitlistedUsers.push(u);
    }

    await fetch(`http://localhost:${port}/events/${eventId}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json', Cookie: admin.cookie },
      body: JSON.stringify({ capacity: 3 }),
    });

    const { rows } = await query(
      'SELECT status FROM registrations WHERE event_id = $1 AND user_id = ANY($2::uuid[])',
      [eventId, waitlistedUsers.map((u) => u.userId)]
    );
    assert.deepEqual(rows.map((r) => r.status).sort(), ['pending', 'pending']);
  });
});
```

- [ ] **Step 2: Tests laufen lassen, Fail bestätigen**

Run: `node --test tests/integration/registrations.test.js`
Expected: FAIL — niemand wird promoviert, alle 4 neuen Tests schlagen fehl.

- [ ] **Step 3: `maybePromoteFromWaitlist` implementieren**

In `backend/registrations/repository.js`, Imports ergänzen:

```javascript
import { getAppSettings } from '../appSettings/repository.js';
import { sendWaitlistedEmail, sendWaitlistPromotedEmail, getTransporterAndFrom } from '../auth/mailer.js';
```

Neue Funktion (nach `unregisterFromEvent`):

```javascript
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
}
```

- [ ] **Step 4: `registerForEvent` verschickt `sendWaitlistedEmail`, wenn die Anmeldung auf der Warteliste landet**

Ersetzt den `try`/`catch`-Block am Ende von `registerForEvent` (alles davor — die Validierung von `conRole`/`resolveCharacterId`/`resolveNscAvailability`/`schema`/`data` aus Task 4 Step 3 — bleibt unverändert):

```javascript
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
        `INSERT INTO registrations (user_id, event_id, con_role, character_id, nsc_available, nsc_character_id, registration_data_enc, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         RETURNING user_id, event_id, status, con_role, character_id, nsc_available, nsc_character_id, checked_in_at, checked_out_at`,
        [userId, eventId, conRole, resolvedCharacterId, resolvedNsc.nscAvailable, resolvedNsc.nscCharacterId, encryptFieldBlob(data), status]
      );
      return rows[0];
    });
    if (registration.status === 'waitlisted') {
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
```

(`logger` ist in dieser Datei noch nicht importiert — `import { logger } from '../logger.js';` oben ergänzen, falls nicht bereits vorhanden. Ein Blick in den aktuellen Dateikopf zeigt: es fehlt, also hinzufügen.)

- [ ] **Step 5: `cancelRegistration` und `setStatus` an die Promotion anschließen**

```javascript
export async function cancelRegistration(eventId, userId) {
  const result = await transitionStatus(eventId, userId, 'cancel');
  await maybePromoteFromWaitlist(eventId);
  return result;
}
```

`setStatus` bekommt zwei Ergänzungen: (a) nach einem Übergang ZU `cancelled` von einem gezählten Status aus die Promotion-Kette anstoßen, (b) bei manuellem Nachrücken (`waitlisted → pending`) die Promoted-Mail verschicken. Ersetzt die bisherige Funktion vollständig:

```javascript
export async function setStatus(eventId, userId, status, expectedStatus) {
  const { rows } = await query(
    `UPDATE registrations SET
       status = $4,
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
    const err = new Error('Status wurde zwischenzeitlich geändert.');
    err.code = 'STATUS_CONFLICT';
    throw err;
  }

  if (status === 'cancelled' && COUNTED_STATUSES.includes(expectedStatus)) {
    await maybePromoteFromWaitlist(eventId);
  }
  if (expectedStatus === 'waitlisted' && status === 'pending') {
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
  }

  return rows[0];
}
```

`unregisterFromEvent` bekommt den Aufruf ebenfalls, aber nur für den `pending`-Fall (siehe Spec — ein gelöschter `waitlisted`-Datensatz gibt nie einen Platz frei):

```javascript
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
```

- [ ] **Step 6: `backend/events/routes.js`s `PUT /events/:id` an die Promotion anschließen**

```javascript
import { createEvent, getEvent, listEvents, updateEvent, activateEvent, deleteEvent } from './repository.js';
import { maybePromoteFromWaitlist } from '../registrations/repository.js';

// ...

router.put('/events/:id', requireAuth(requireMenu('events')(async ({ req, params }) => {
  const body = await readJsonBody(req);
  if (body === null) return { status: 400, body: { error: 'invalid JSON' } };
  if (body.capacity !== undefined && body.capacity !== null && (!Number.isInteger(body.capacity) || body.capacity < 1)) {
    return { status: 400, body: { error: 'capacity must be a positive integer or null' } };
  }
  const before = await getEvent(params.id);
  if (!before) return { status: 404, body: { error: 'event not found' } };
  const event = await updateEvent(params.id, body);

  const effective = (c) => (c === null ? Infinity : c);
  if (effective(event.capacity) > effective(before.capacity)) {
    await maybePromoteFromWaitlist(params.id);
  }
  return { status: 200, body: await getEvent(params.id) };
})));
```

(Am Ende `getEvent` erneut aufgerufen, damit eine eventuelle Promotion-Runde nicht relevant ist für die Response — `capacity` selbst ändert sich durch Promotion nicht, aber es hält die Antwort konsistent mit dem tatsächlichen DB-Stand ohne Annahmen über Nebenwirkungen zu treffen.)

- [ ] **Step 7: Tests laufen lassen**

Run: `node --test tests/integration/registrations.test.js tests/integration/events.test.js`
Expected: alle Tests PASS.

- [ ] **Step 8: Commit**

```bash
git add backend/registrations/repository.js backend/registrations/routes.js backend/events/routes.js tests/integration/registrations.test.js tests/integration/events.test.js
git commit -m "feat: auto/manual waitlist promotion on cancellation and capacity changes"
```

---

### Task 6: Frontend + voller Testlauf

**Files:**
- Modify: `frontend/js/formFields.js`
- Modify: `frontend/admin/events.html`
- Modify: `frontend/admin/settings.html`
- Modify: `frontend/admin/checkin.html`
- Modify: `frontend/account.html`
- Modify: `frontend/css/sahara.css`

**Interfaces:**
- Consumes: `capacity` von `GET/POST/PUT /events` (Task 3), `waitlistAutoPromote` von `GET/PUT /app-settings` (Task 2), `status: 'waitlisted'` überall dort, wo Registrierungen gerendert werden (Task 4/5).
- Produces: keine neuen Backend-Schnittstellen — reiner UI-Task.

- [ ] **Step 1: `STATUS_LABELS` um `waitlisted` erweitern**

In `frontend/js/formFields.js`:

```javascript
export const STATUS_LABELS = {
  notified: 'Benachrichtigt', pending: 'Vorgemerkt', confirmed: 'Angemeldet',
  checked_in: 'Eingecheckt', checked_out: 'Ausgecheckt', cancelled: 'Abgesagt',
  waitlisted: 'Warteliste',
};
```

- [ ] **Step 2: `.status-waitlisted`-Pill in `frontend/css/sahara.css` ergänzen**

Direkt nach `.status-pending` (vor `.status-confirmed`):

```css
.status-waitlisted {
  background: #e6dcf5;
  color: #5b3a8a;
}
```

- [ ] **Step 3: `frontend/admin/events.html` — Kapazitätsfeld im Formular**

Im `<form id="event-form">`, nach dem `event-code`-Feld einfügen:

```html
<label for="event-capacity">Max. Teilnehmerzahl <span style="opacity:0.6;font-size:12px;">optional, leer = unbegrenzt</span></label>
<input id="event-capacity" name="capacity" type="number" min="1" placeholder="unbegrenzt">
```

`startEdit` ergänzen:

```javascript
function startEdit(eventData) {
  editingEventId = eventData.id;
  formTitle.textContent = `Event bearbeiten: ${eventData.name}`;
  form.elements.name.value = eventData.name;
  form.elements.eventDate.value = eventData.event_date;
  form.elements.code.value = eventData.code ?? '';
  form.elements.capacity.value = eventData.capacity ?? '';
  form.querySelector('button[type="submit"]').textContent = 'Änderungen speichern';
}
```

Submit-Handler ergänzen (`clearCapacity` signalisiert dem Backend, ein geleertes Feld tatsächlich zu übernehmen, statt es als "nicht gesendet" zu ignorieren — gleiches Muster wie `code`, das schon per leerem String löscht):

```javascript
form.addEventListener('submit', async (event) => {
  event.preventDefault();
  const capacityValue = form.elements.capacity.value;
  const payload = {
    name: form.elements.name.value,
    eventDate: form.elements.eventDate.value,
    code: form.elements.code.value || null,
    capacity: capacityValue ? Number(capacityValue) : null,
    clearCapacity: true,
  };
  try {
    if (editingEventId) {
      await api.put(`/events/${editingEventId}`, payload);
    } else {
      await api.post('/events', payload);
    }
    notify('Gespeichert.', 'success');
    resetForm();
    await loadEvents();
  } catch (err) {
    notify(err.message, 'error');
  }
});
```

- [ ] **Step 4: `frontend/admin/settings.html` — Schalter für `waitlistAutoPromote`**

Neue Karte nach der "Einladungen"-Karte einfügen:

```html
<div class="card form-pad">
  <h2>Warteliste</h2>
  <p class="sub">Wenn ein Platz frei wird (z.B. durch eine Absage), rückt automatisch die am längsten wartende Person nach. Ist der Schalter aus, muss Staff im Check-In-Bereich manuell nachrücken lassen.</p>
  <label><input type="checkbox" id="waitlist-auto-promote-toggle"> Automatisch nachrücken lassen</label>
</div>
```

Script-Ergänzungen (analog zu `loadCharacterBrowsingSetting`):

```javascript
async function loadWaitlistSetting() {
  const settings = await api.get('/app-settings');
  document.getElementById('waitlist-auto-promote-toggle').checked = settings.waitlistAutoPromote;
}

document.getElementById('waitlist-auto-promote-toggle').addEventListener('change', async (event) => {
  try {
    await api.put('/app-settings', { waitlistAutoPromote: event.target.checked });
    notify('Gespeichert.', 'success');
  } catch (err) {
    event.target.checked = !event.target.checked;
    notify(err.message, 'error');
  }
});
```

Im abschließenden `try`-Block (wo `loadCharacterBrowsingSetting()` bereits aufgerufen wird) ergänzen:

```javascript
  await loadCharacterBrowsingSetting();
  await loadWaitlistSetting();
```

- [ ] **Step 5: `frontend/admin/checkin.html` — `waitlisted` in `STATUS_ORDER`**

```javascript
const STATUS_ORDER = ['waitlisted', 'pending', 'confirmed', 'checked_in', 'checked_out', 'cancelled'];
```

(`waitlisted` bewusst VOR `pending` — damit `waitlisted → pending` per Index ein Vorwärts-Schritt ist und keinen unnötigen Bestätigungsdialog auslöst, während `pending → waitlisted` als Rückwärts-Schritt korrekt bestätigt werden muss. `renderOverrideCell`/`overrideStatus` selbst brauchen keine Änderung — sie iterieren bereits generisch über `STATUS_ORDER`.)

- [ ] **Step 6: `frontend/account.html` — Abmelden-Button auch für `waitlisted` anzeigen**

Zeile ~850, den bestehenden Status-Check erweitern:

```javascript
      const unregisterBtn = document.getElementById("active-registration-unregister-btn");
      if (registration.status === "pending" || registration.status === "waitlisted") {
        unregisterBtn.style.display = "";
        unregisterBtn.onclick = () => unregister(activeEvent.id);
      } else {
        unregisterBtn.style.display = "none";
      }
```

- [ ] **Step 7: Manuelle Browser-Verifikation**

Da diese Seiten keine automatisierte DOM-Testabdeckung haben (Projektstandard, siehe Memory `project_pakyrion_plan_sequence`), händisch über die `preview_start`/Browser-Tools verifizieren:
- Event mit `capacity: 1` anlegen, zwei Accounts anmelden → zweiter landet auf Warteliste, Status-Pill zeigt "Warteliste".
- In `admin/checkin.html`: wartende Person erscheint mit Warteliste-Pill; Override-Dropdown auf "Vorgemerkt" setzen → kein Bestätigungsdialog, Status wechselt sofort.
- In `admin/settings.html`: Warteliste-Schalter togglen, Seite neu laden → Zustand bleibt erhalten.
- In `admin/events.html`: Kapazitätsfeld setzen/leeren, Event neu laden → Wert korrekt übernommen bzw. auf "unbegrenzt" zurückgesetzt.
- Als wartender Teilnehmer in `account.html`: "Abmelden"-Button sichtbar, Abmelden entfernt die Anmeldung.

- [ ] **Step 8: Voller Testlauf (Projektstandard: letzter Schritt jedes Plans)**

Run: `npm test`
Expected: alle Tests PASS (voraussichtlich ~350+ Tests je nach aktuellem Stand — Zahl mit dem tatsächlichen Output abgleichen, nicht raten).

- [ ] **Step 9: Commit**

```bash
git add frontend/js/formFields.js frontend/admin/events.html frontend/admin/settings.html frontend/admin/checkin.html frontend/account.html frontend/css/sahara.css
git commit -m "feat: frontend for event capacity, waitlist status, and the auto-promote toggle"
```

---

## Self-Review Notes (vom Plan-Autor, nicht vom Ausführenden)

- **Spec-Abdeckung geprüft:** Datenmodell (Task 1/3), Registrierungs-Flow inkl. Concurrency (Task 4), Promotion inkl. Kapazitäts-Erhöhung (Task 5), Benachrichtigungen (Task 2/5), Admin-Einstellungen inkl. COALESCE (Task 2), UI (Task 6), Tests durchgehend pro Task statt gesammelt am Ende — plus expliziter `npm test`-Gate in Task 6.
- **Platzhalter-Scan:** keine TBD/TODO; jeder Code-Block ist vollständig, keine "ähnlich wie oben"-Verweise.
- **Typkonsistenz geprüft:** `maybePromoteFromWaitlist(eventId)` einheitlich ohne Rückgabewert-Erwartung bei den Aufrufern verwendet; `COUNTED_STATUSES` einmal in Task 4 exportiert, in Task 5 importiert, keine zweite Definition.
- **Bekannte Abhängigkeit zwischen Task 4 und Task 5:** Task 5 Step 4 modifiziert denselben `registerForEvent`-Funktionskörper, den Task 4 Step 3 geschrieben hat — der Task-5-Implementer muss die Funktion nach dem `withTransaction`-Aufruf erweitern, nicht neu schreiben; im Plan-Text explizit als "unverändert aus Task 4 Step 3" markiert, um Verwechslung zu vermeiden.

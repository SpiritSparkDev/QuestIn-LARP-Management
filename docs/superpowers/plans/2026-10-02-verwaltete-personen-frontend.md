# Verwaltete Personen (Frontend) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give an account a "Verwaltete Personen" section on `account.html`
(list/add/edit/delete/convert their dependents), and a new, dedicated
`managed-person.html?id=<uuid>` page where the owner manages one
dependent's membership data, characters (SC/NSC), and event registration —
reusing the already-merged backend (`docs/superpowers/plans/
2026-10-02-verwaltete-personen-backend.md`, merged to master 2026-10-02).

**Architecture:** `managed-person.html` is a deliberately SEPARATE page
from `account.html`, not a mode of it — confirmed with the user after
weighing the DRY-vs-risk tradeoff (duplicating the registration/character
form logic vs. retrofitting account.html's ~15 self-scoped fetch call
sites and its login/password/OAuth/dashboard/DSGVO-export/ticket-QR
sections that don't apply to a login-less dependent). It reuses the same
shared helpers account.html already uses (`/js/formFields.js`, `/js/api.js`,
`/js/notifications.js`, `/js/branding.js`, `/js/loading.js`) and mirrors
account.html's "Anmelden"/"Charaktere" tab logic closely (same schemas,
same validation, same error handling), pointed at the `/managed-persons/:id/...`
endpoints instead of the self-service ones. It has NO sidebar/nav, login,
password, OAuth/Discord, logout, DSGVO export, or ticket/QR-code UI — a
managed person has no login, and check-in staff identify them by name on
the existing participant list, not a personal QR code.

**Tech Stack:** Static HTML + vanilla JS modules (no framework), reusing
`frontend/js/formFields.js` and `frontend/js/api.js` exactly as
`frontend/account.html` already does. No automated test framework exists
for HTML pages in this project (confirmed in `docs/superpowers/plans/
*-06-frontend.md`'s history) — verification is manual, via Claude Browser
tooling against the dev server, same as every prior frontend plan in this
project.

**Spec:** `docs/superpowers/specs/2026-10-02-verwaltete-personen-design.md`,
section 6 (6.1: account.html section; 6.2: the new page) — sections 1-5/7-9
are the backend plan's concern, already merged.

## Global Constraints

- `managed-person.html` has NO nav sidebar, login/password/OAuth/Discord
  UI, logout button, DSGVO export, or ticket/QR-code display. It is reached
  only from account.html's "Verwaltete Personen" section, for an already
  logged-in owner.
- Every fetch on `managed-person.html` targets `/managed-persons/:id/...`
  (characters, registrations) or `/managed-persons/:id` (membership data),
  using the `id` from this page's own `?id=` query param — NEVER the
  logged-in owner's own id.
- `PUT`/`DELETE /characters/:id` and the `/characters/:id/files` routes
  are NOT re-scoped under `/managed-persons/:id/...` — they already accept
  an owner acting on their managed person's character via the ownership
  extension merged in the backend plan's Task 2. Only character
  CREATION and LISTING go through the `/managed-persons/:id/characters`
  wrapper routes.
- Reuse `frontend/js/formFields.js`'s existing rendering/collection
  functions (`renderAccountFieldInput`, `collectAccountFieldValues`,
  `renderField`, `collectFieldValues`, `attachLiveValidation`,
  `renderEventOptions`, `escapeHtml`, `otFieldValuesEqual`,
  `nullifyBlankNumberFields`, `STATUS_LABELS`) exactly as-is — no new
  rendering helpers, no modifications to that file.
- No automated tests for these two HTML pages (matches this project's
  established pattern — `frontend/js/api.js`/`frontend/js/formFields.js`
  are unit-tested, HTML pages are verified manually). Each task's
  verification step is a manual Claude-Browser-tool pass against the dev
  server, not a `node --test` run. The plan's very last task still runs
  the backend's full `npm test` once, to confirm nothing on the backend
  side regressed from any incidental touch.
- Follow this project's existing frontend conventions throughout: German
  UI text, `escapeHtml` on every interpolated value, `notify(message,
  "error"|"success")` for feedback, `<dialog>` for modals, the `.card`/
  `.char-grid`/`.char-card`/`.field-grid`/`.dialog-actions` CSS classes
  already defined in `/css/sahara.css` (no new CSS file).

---

### Task 1: "Verwaltete Personen" section on account.html

**Files:**
- Modify: `frontend/account.html` (new section in the `konto-tab` panel, plus its script block)

**Interfaces:**
- Consumes (all already merged, unchanged): `GET/POST/PATCH/DELETE /managed-persons`, `GET /managed-persons/:id`, `POST /managed-persons/:id/convert`, `GET /account-schema` (already loaded by this page as `accountSchema`).
- Produces: nothing new for later tasks — this section only links to `managed-person.html?id=<id>` (Task 2), it doesn't share any JS state with it (different page load).

- [ ] **Step 1: Add the HTML section**

In `frontend/account.html`, inside the `konto-tab` panel (after the
`<div class="card form-pad">...DSGVO-Auskunft...</div>` block that ends
around line 107, i.e. right before that panel's closing `</div>` at
line 108), add:

```html
          <div class="card form-pad">
            <h2>Verwaltete Personen</h2>
            <p class="sub">Melde zusätzliche Personen an, die sich nicht selbst einloggen können oder wollen — z.B. Familienmitglieder oder Kinder. Du verwaltest ihre Daten, Charaktere und Anmeldungen stellvertretend.</p>
            <div id="managed-persons-list"></div>
            <button type="button" id="new-managed-person-btn" class="btn-ghost">Person hinzufügen</button>

            <dialog id="managed-person-dialog">
              <h3 id="managed-person-dialog-title">Person hinzufügen</h3>
              <form id="managed-person-form">
                <div class="field-grid">
                  <div><input id="managed-person-firstName" name="firstName" type="text" required><label for="managed-person-firstName">Vorname *</label></div>
                  <div><input id="managed-person-lastName" name="lastName" type="text" required><label for="managed-person-lastName">Nachname *</label></div>
                  <div><input id="managed-person-nickname" name="nickname" type="text"><label for="managed-person-nickname">Rufname</label></div>
                  <div><input id="managed-person-email" name="email" type="email"><label for="managed-person-email">E-Mail (optional, für spätere Umwandlung in einen eigenen Account)</label></div>
                </div>
                <div id="managed-person-ot-fields"></div>
                <div class="dialog-actions">
                  <button type="submit">Speichern</button>
                  <button type="button" id="managed-person-dialog-cancel" class="btn-ghost">Abbrechen</button>
                </div>
              </form>
            </dialog>

            <dialog id="managed-person-delete-dialog">
              <h3>Person löschen</h3>
              <p class="lede">Diese Aktion kann nicht rückgängig gemacht werden.</p>
              <div class="dialog-actions">
                <button type="button" id="managed-person-delete-confirm">Löschen</button>
                <button type="button" id="managed-person-delete-cancel" class="btn-ghost">Abbrechen</button>
              </div>
            </dialog>
          </div>
```

- [ ] **Step 2: Add the script logic**

In `frontend/account.html`'s `<script type="module">` block, add this
code right after the existing `accountForm.addEventListener("submit", ...)`
block (ends around line 747, i.e. right before the `const CON_ROLE_LABELS
= {...}` line):

```javascript
    let managedPersons = [];

    function managedPersonStatusLabel(p) {
      if (!p.email) return "Platzhalter (keine E-Mail hinterlegt)";
      return "Platzhalter";
    }

    function renderManagedPersonsList() {
      const container = document.getElementById("managed-persons-list");
      if (managedPersons.length === 0) {
        container.innerHTML = '<p class="sub">Noch keine verwalteten Personen angelegt.</p>';
        return;
      }
      container.innerHTML = managedPersons
        .map((p) => `<div class="card form-pad" data-managed-person-card="${p.id}">
      <h3>${escapeHtml(p.name)}</h3>
      <p class="sub">${escapeHtml(managedPersonStatusLabel(p))}</p>
      <div class="action-row">
        <a href="/managed-person.html?id=${encodeURIComponent(p.id)}" class="btn-ghost">Charaktere &amp; Anmeldung verwalten</a>
        <button type="button" data-managed-person-edit="${p.id}" class="btn-ghost">Bearbeiten</button>
        <button type="button" data-managed-person-delete="${p.id}" class="btn-ghost" ${p.canDelete ? "" : "disabled title=\"Diese Person hat bereits Event-Anmeldungen und kann nicht gelöscht werden.\""}>Löschen</button>
        ${p.email ? `<button type="button" data-managed-person-convert="${p.id}" class="btn-ghost">In eigenen Account umwandeln</button>` : ""}
      </div>
    </div>`)
        .join("");

      container.querySelectorAll("[data-managed-person-edit]").forEach((btn) => {
        btn.addEventListener("click", () => openManagedPersonDialog(btn.dataset.managedPersonEdit));
      });
      container.querySelectorAll("[data-managed-person-delete]:not([disabled])").forEach((btn) => {
        btn.addEventListener("click", () => openManagedPersonDeleteDialog(btn.dataset.managedPersonDelete));
      });
      container.querySelectorAll("[data-managed-person-convert]").forEach((btn) => {
        btn.addEventListener("click", () => convertManagedPerson(btn.dataset.managedPersonConvert));
      });
    }

    async function loadManagedPersons() {
      managedPersons = await api.get("/managed-persons");
      renderManagedPersonsList();
    }

    const managedPersonDialog = document.getElementById("managed-person-dialog");
    const managedPersonForm = document.getElementById("managed-person-form");
    attachLiveValidation(managedPersonForm);
    const managedPersonOtFieldsContainer = document.getElementById("managed-person-ot-fields");
    let editingManagedPersonId = null;

    function renderManagedPersonOtFields(values = {}) {
      managedPersonOtFieldsContainer.innerHTML = accountSchema
        .map((field) => renderAccountFieldInput(field, values[field.key], { idPrefix: "managed-person-" }))
        .join("");
      attachLiveValidation(managedPersonOtFieldsContainer);
    }

    function openManagedPersonDialog(id) {
      const person = id ? managedPersons.find((p) => p.id === id) : null;
      editingManagedPersonId = person ? person.id : null;
      document.getElementById("managed-person-dialog-title").textContent =
        person ? `Person bearbeiten: ${person.name}` : "Person hinzufügen";
      managedPersonForm.elements.firstName.value = person?.firstName ?? "";
      managedPersonForm.elements.lastName.value = person?.lastName ?? "";
      managedPersonForm.elements.nickname.value = person?.nickname ?? "";
      managedPersonForm.elements.email.value = person?.email ?? "";
      renderManagedPersonOtFields(person ?? {});
      managedPersonDialog.showModal();
    }

    document.getElementById("new-managed-person-btn").addEventListener("click", () => openManagedPersonDialog(null));
    document.getElementById("managed-person-dialog-cancel").addEventListener("click", () => managedPersonDialog.close());

    managedPersonForm.addEventListener("submit", async (event) => {
      event.preventDefault();
      const data = {
        ...Object.fromEntries(new FormData(managedPersonForm)),
        ...nullifyBlankNumberFields(accountSchema, collectAccountFieldValues(managedPersonOtFieldsContainer, accountSchema)),
      };
      try {
        if (editingManagedPersonId) {
          await api.patch(`/managed-persons/${editingManagedPersonId}`, data);
        } else {
          await api.post("/managed-persons", data);
        }
        notify("Gespeichert.", "success");
        managedPersonDialog.close();
        await loadManagedPersons();
      } catch (err) {
        notify(err.message, "error");
      }
    });

    const managedPersonDeleteDialog = document.getElementById("managed-person-delete-dialog");
    let deletingManagedPersonId = null;

    function openManagedPersonDeleteDialog(id) {
      deletingManagedPersonId = id;
      managedPersonDeleteDialog.showModal();
    }

    document.getElementById("managed-person-delete-cancel").addEventListener("click", () => {
      deletingManagedPersonId = null;
      managedPersonDeleteDialog.close();
    });

    document.getElementById("managed-person-delete-confirm").addEventListener("click", async () => {
      try {
        await api.delete(`/managed-persons/${deletingManagedPersonId}`);
        notify("Gelöscht.", "success");
        managedPersonDeleteDialog.close();
        await loadManagedPersons();
      } catch (err) {
        notify(err.message, "error");
      }
    });

    async function convertManagedPerson(id) {
      if (!confirm("Diese Person erhält eine E-Mail mit einem Link, um ein eigenes Passwort zu setzen. Danach hast du keinen Zugriff mehr auf ihre Daten. Fortfahren?")) return;
      try {
        await api.post(`/managed-persons/${id}/convert`, {});
        notify("Einladung verschickt.", "success");
        await loadManagedPersons();
      } catch (err) {
        notify(err.message, "error");
      }
    }
```

- [ ] **Step 3: Load managed persons on page init**

In the same file's final `try { ... }` init block (the one starting
`const account = await api.get("/account");` near the end of the file),
add `await loadManagedPersons();` right after the existing
`renderDashboardAccountHint(account);` line (this runs after
`accountSchema` is loaded, which `renderManagedPersonOtFields` depends on).

- [ ] **Step 4: Manual verification**

Start the dev server (`preview_start` with this project's dev
configuration — `docker compose -f docker-compose.dev.yml up`, per
`CLAUDE.md`) and, using the Claude Browser tool, log in as a test
participant account and verify on `account.html#konto`:
1. "Verwaltete Personen" section renders with an empty state.
2. "Person hinzufügen" opens the dialog; submitting with only
   Vorname/Nachname (no email) succeeds, dialog closes, the new person
   appears in the list with "Platzhalter (keine E-Mail hinterlegt)" and
   an enabled "Löschen" button.
3. "Bearbeiten" on that person opens the dialog pre-filled, changing the
   Nachname and saving updates the list.
4. Adding an email, saving, then clicking "In eigenen Account umwandeln"
   shows the confirm dialog and (after confirming) a success toast — check
   the dev server's mail log/console (SMTP is likely unconfigured in dev,
   same no-op-JSON-transport behavior as every other invitation flow in
   this project) rather than expecting a real email.
5. "Löschen" removes a person with no registrations; take a screenshot of
   the final state for the report.

- [ ] **Step 5: Commit**

```bash
git add frontend/account.html
git commit -m "feat: add Verwaltete Personen management section to account.html"
```

---

### Task 2: managed-person.html — membership data + SC characters

**Files:**
- Create: `frontend/managed-person.html`

**Interfaces:**
- Consumes: `GET/PATCH /managed-persons/:id`, `GET /account-schema`, `GET /sc-schema`, `GET/POST /managed-persons/:id/characters`, `GET/PUT/DELETE /characters/:id`, `GET/POST/DELETE /characters/:id/files` (all already merged backend routes).
- Produces: the page-level `managedPersonId` constant and `apiGet`/import
  setup that Task 3 (same file) builds on directly — Task 3 is a second
  pass over this SAME file, not a separate module.

This task establishes the page skeleton and its two simplest sections
(membership data, SC characters with file upload) end-to-end. Task 3 adds
NSC characters + event registration to the same file, following the
exact same patterns this task sets up.

- [ ] **Step 1: Create the page shell + membership-data section**

Create `frontend/managed-person.html`:

```html
<!DOCTYPE html>
<html lang="de">

<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Verwaltete Person – Pakyrion</title>
  <link rel="stylesheet" href="/css/fonts.css">
  <link rel="stylesheet" href="/css/sahara.css">
  <link rel="shortcut icon" href="/favicon.ico" type="image/x-icon">
</head>

<body>
  <div id="page-loader" class="page-loader"><div class="page-loader-spinner"></div></div>
  <div class="app">
    <div class="main">
      <div class="content account-page">
        <p><a href="/account.html#konto">&larr; Zurück zu meinem Konto</a></p>
        <h1 id="managed-person-heading">Person verwalten</h1>

        <div class="tab-panel" id="daten-tab">
          <h2>Mitgliedsdaten</h2>
          <form id="data-form">
            <div class="field-grid">
              <div><input id="firstName" name="firstName" type="text" required><label for="firstName">Vorname *</label></div>
              <div><input id="lastName" name="lastName" type="text" required><label for="lastName">Nachname *</label></div>
              <div><input id="nickname" name="nickname" type="text"><label for="nickname">Rufname</label></div>
              <div><input id="email" name="email" type="email"><label for="email">E-Mail (optional)</label></div>
            </div>
            <div id="data-ot-fields"></div>
            <button type="submit">Speichern</button>
          </form>
        </div>

        <div class="tabs" id="char-class-tabs">
          <button type="button" class="tab-btn active" data-tab="sc-tab">Charaktere</button>
          <button type="button" class="tab-btn" data-tab="nsc-tab" id="nsc-tab-btn" style="display:none;">NSC-Charaktere</button>
          <button type="button" class="tab-btn" data-tab="anmelden-tab">Anmeldung</button>
        </div>

        <div class="tab-panel" id="sc-tab">
          <div class="dashboard-layout">
            <div class="dashboard-main">
              <div class="action-row">
                <button type="button" id="new-character-btn">Neuen Charakter anlegen</button>
              </div>

              <div id="sc-form-section" class="card" style="display:none;">
                <h3 id="form-title">Neuen Charakter anlegen</h3>
                <hr class="rule">
                <form id="character-form">
                  <h3>1. Charaktername</h3>
                  <input id="character-name" name="name" type="text" required>
                  <label for="character-name">Charaktername</label>
                  <h3>2. Charakterdaten</h3>
                  <div id="character-dynamic-fields" class="field-grid"></div>
                  <div class="dialog-actions">
                    <button type="submit">Speichern</button>
                    <button type="button" id="character-cancel-edit" class="btn-ghost">Abbrechen</button>
                  </div>
                </form>
              </div>
            </div>
            <div>
              <div id="character-list" class="char-grid"></div>
            </div>
          </div>
        </div>

        <dialog id="delete-character-dialog">
          <h3>Charakter löschen</h3>
          <p class="lede">Diese Aktion kann nicht rückgängig gemacht werden. Gib zur Bestätigung den Namen "<strong id="delete-character-name"></strong>" ein.</p>
          <input type="text" id="delete-character-input" autocomplete="off">
          <label for="delete-character-input">Charaktername</label>
          <div class="dialog-actions">
            <button type="button" id="delete-character-confirm">Löschen</button>
            <button type="button" id="delete-character-cancel" class="btn-ghost">Abbrechen</button>
          </div>
        </dialog>

        <dialog id="photo-upload-dialog">
          <h3>Foto hochladen</h3>
          <form id="photo-upload-form">
            <input type="file" id="photo-upload-input" accept="image/jpeg,image/png,image/webp" required>
            <label><input type="checkbox" id="photo-upload-consent" required> Ich habe den Hinweis gelesen</label>
            <p class="sub">Mit dem Hochladen bestätigst du, dass du die Rechte an diesem Bild besitzt und einverstanden bist, dass es im Rahmen der Veranstaltung von berechtigten Personen eingesehen werden kann.</p>
            <div class="dialog-actions">
              <button type="submit">Hochladen</button>
              <button type="button" id="photo-upload-cancel" class="btn-ghost">Abbrechen</button>
            </div>
          </form>
        </dialog>

        <div class="tab-panel" id="nsc-tab" hidden>
          <!-- filled in by Task 3 -->
        </div>
        <div class="tab-panel" id="anmelden-tab" hidden>
          <!-- filled in by Task 3 -->
        </div>
      </div>
    </div>
  </div>

  <script type="module">
    import { api } from "/js/api.js";
    import { applyBranding } from "/js/branding.js";
    import { hideLoading } from "/js/loading.js";
    applyBranding();
    import {
      escapeHtml,
      renderField,
      collectFieldValues,
      attachLiveValidation,
      renderAccountFieldInput,
      collectAccountFieldValues,
      nullifyBlankNumberFields,
    } from "/js/formFields.js";
    import { notify } from "/js/notifications.js";

    const managedPersonId = new URLSearchParams(window.location.search).get("id");
    if (!managedPersonId) {
      document.body.innerHTML = '<p class="error">Keine Person angegeben.</p>';
      throw new Error("missing id");
    }

    function initTabs(tabsEl) {
      const buttons = [...tabsEl.querySelectorAll(".tab-btn")];
      buttons.forEach((btn) => {
        btn.addEventListener("click", () => {
          buttons.forEach((b) => {
            b.classList.toggle("active", b === btn);
            document.getElementById(b.dataset.tab).hidden = b !== btn;
          });
        });
      });
    }
    initTabs(document.getElementById("char-class-tabs"));

    const dataForm = document.getElementById("data-form");
    attachLiveValidation(dataForm);
    const dataOtFieldsContainer = document.getElementById("data-ot-fields");
    let accountSchema = [];

    dataForm.addEventListener("submit", async (event) => {
      event.preventDefault();
      const data = {
        ...Object.fromEntries(new FormData(dataForm)),
        ...nullifyBlankNumberFields(accountSchema, collectAccountFieldValues(dataOtFieldsContainer, accountSchema)),
      };
      try {
        const updated = await api.patch(`/managed-persons/${managedPersonId}`, data);
        document.getElementById("managed-person-heading").textContent = `${updated.name} verwalten`;
        notify("Gespeichert.", "success");
      } catch (err) {
        notify(err.message, "error");
      }
    });

    let characters = [];
    let scSchema = [];
    let editingCharacterId = null;

    const scFormSection = document.getElementById("sc-form-section");
    function hideCharacterForm() { scFormSection.style.display = "none"; }
    function showCharacterForm() { scFormSection.style.display = ""; scFormSection.scrollIntoView({ behavior: "smooth" }); }
    const characterForm = document.getElementById("character-form");
    attachLiveValidation(characterForm);
    const characterListBody = document.getElementById("character-list");
    const characterFormTitle = document.getElementById("form-title");
    const characterDynamicFields = document.getElementById("character-dynamic-fields");

    function renderScSchemaFields(data = {}) {
      characterDynamicFields.innerHTML = scSchema
        .map((field) => `<div class="form-group">${renderField(field, data[field.key], "sc-char-", { readOnly: field.staffOnly === true })}</div>`)
        .join("");
      attachLiveValidation(characterDynamicFields);
    }

    function readFileAsBase64(file) {
      return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result.split(",")[1]);
        reader.onerror = () => reject(reader.error);
        reader.readAsDataURL(file);
      });
    }

    function kindForMimeType(mimeType) {
      if (["image/jpeg", "image/png", "image/webp"].includes(mimeType)) return "image";
      if (mimeType === "application/pdf") return "document";
      return null;
    }

    async function loadPhotoInto(characterId) {
      const container = document.querySelector(`[data-photo-for="${characterId}"]`);
      if (!container) return;
      const imageSlot = container.querySelector("[data-photo-image]");
      try {
        const files = await api.get(`/characters/${characterId}/files`);
        const photo = files.find((f) => f.kind === "image");
        if (photo) imageSlot.innerHTML = `<img src="/characters/${characterId}/files/${photo.id}" alt="">`;
      } catch {
        // fail-quiet: card keeps its placeholder icon
      }
    }

    const photoUploadDialog = document.getElementById("photo-upload-dialog");
    const photoUploadForm = document.getElementById("photo-upload-form");
    const photoUploadInput = document.getElementById("photo-upload-input");
    const photoUploadConsent = document.getElementById("photo-upload-consent");
    let photoUploadCharacterId = null;

    function openPhotoUploadDialog(characterId) {
      photoUploadCharacterId = characterId;
      photoUploadForm.reset();
      photoUploadDialog.showModal();
    }
    document.getElementById("photo-upload-cancel").addEventListener("click", () => photoUploadDialog.close());
    photoUploadForm.addEventListener("submit", async (event) => {
      event.preventDefault();
      const file = photoUploadInput.files[0];
      if (!file) return;
      try {
        const dataBase64 = await readFileAsBase64(file);
        await api.post(`/characters/${photoUploadCharacterId}/files`, {
          kind: "image", filename: file.name, mimeType: file.type, dataBase64,
          isPublic: false, gdprConsent: photoUploadConsent.checked,
        });
        photoUploadDialog.close();
        await loadPhotoInto(photoUploadCharacterId);
      } catch (err) {
        notify(err.message, "error");
      }
    });

    function renderCharacterList() {
      const scCharacters = characters.filter((c) => c.class !== "nsc");
      characterListBody.innerHTML = scCharacters
        .map((c) => `<div class="char-card" data-card-for="${c.id}">
      <button type="button" class="char-card-delete" data-delete="${c.id}" aria-label="Charakter löschen"><span class="material-symbols-outlined" aria-hidden="true">close</span></button>
      <div class="char-photo" data-photo-for="${c.id}">
        <div class="char-photo-image" data-photo-image><span class="char-photo-placeholder material-symbols-outlined" aria-hidden="true">person</span></div>
        <button type="button" class="char-photo-upload" aria-label="Foto hochladen"><span class="material-symbols-outlined" aria-hidden="true">photo_camera</span></button>
      </div>
      <h3>${escapeHtml(c.name)}</h3>
    </div>`)
        .join("");

      characterListBody.querySelectorAll("[data-card-for]").forEach((card) => {
        card.addEventListener("click", () => startEdit(card.dataset.cardFor));
      });
      characterListBody.querySelectorAll("[data-delete]").forEach((button) => {
        button.addEventListener("click", (event) => {
          event.stopPropagation();
          openDeleteCharacterDialog(button.dataset.delete);
        });
      });
      characterListBody.querySelectorAll(".char-photo-upload").forEach((button) => {
        button.addEventListener("click", (event) => {
          event.stopPropagation();
          openPhotoUploadDialog(button.closest("[data-card-for]").dataset.cardFor);
        });
      });
      scCharacters.forEach((c) => loadPhotoInto(c.id));
    }

    async function loadCharacters() {
      characters = await api.get(`/managed-persons/${managedPersonId}/characters`);
      renderCharacterList();
    }

    function startEdit(characterId) {
      const character = characters.find((c) => c.id === characterId);
      if (!character) return;
      editingCharacterId = characterId;
      characterFormTitle.textContent = `Charakter bearbeiten: ${character.name}`;
      characterForm.elements.name.value = character.name;
      renderScSchemaFields(character.data);
      characterForm.querySelector('button[type="submit"]').textContent = "Änderungen speichern";
      showCharacterForm();
    }

    function resetCharacterForm() {
      editingCharacterId = null;
      characterFormTitle.textContent = "Neuen Charakter anlegen";
      characterForm.reset();
      renderScSchemaFields();
      characterForm.querySelector('button[type="submit"]').textContent = "Speichern";
    }

    document.getElementById("new-character-btn").addEventListener("click", () => {
      resetCharacterForm();
      showCharacterForm();
    });
    document.getElementById("character-cancel-edit").addEventListener("click", () => {
      resetCharacterForm();
      hideCharacterForm();
    });

    const deleteCharacterDialog = document.getElementById("delete-character-dialog");
    let deleteCharacterId = null;
    function openDeleteCharacterDialog(characterId) {
      const character = characters.find((c) => c.id === characterId);
      if (!character) return;
      deleteCharacterId = characterId;
      document.getElementById("delete-character-name").textContent = character.name;
      document.getElementById("delete-character-input").value = "";
      deleteCharacterDialog.showModal();
    }
    document.getElementById("delete-character-cancel").addEventListener("click", () => {
      deleteCharacterDialog.close();
      deleteCharacterId = null;
    });
    document.getElementById("delete-character-confirm").addEventListener("click", async () => {
      const character = characters.find((c) => c.id === deleteCharacterId);
      if (!character) return;
      if (document.getElementById("delete-character-input").value.trim() !== character.name) {
        notify("Name stimmt nicht überein.", "error");
        return;
      }
      const characterId = deleteCharacterId;
      try {
        await api.delete(`/characters/${characterId}`);
        if (editingCharacterId === characterId) { resetCharacterForm(); hideCharacterForm(); }
        deleteCharacterDialog.close();
        deleteCharacterId = null;
        await loadCharacters();
      } catch (err) {
        notify(err.message, "error");
      }
    });

    characterForm.addEventListener("submit", async (event) => {
      event.preventDefault();
      const name = characterForm.elements.name.value;
      const data = collectFieldValues(characterForm, scSchema);
      try {
        if (editingCharacterId) {
          await api.put(`/characters/${editingCharacterId}`, { name, data });
        } else {
          await api.post(`/managed-persons/${managedPersonId}/characters`, { class: "sc", name, data });
        }
        notify("Gespeichert.", "success");
        resetCharacterForm();
        hideCharacterForm();
        await loadCharacters();
      } catch (err) {
        notify(err.status === 400 && err.body?.details ? err.body.details.join(", ") : err.message, "error");
      }
    });

    try {
      const person = await api.get(`/managed-persons/${managedPersonId}`);
      document.getElementById("managed-person-heading").textContent = `${person.name} verwalten`;
      dataForm.elements.firstName.value = person.firstName ?? "";
      dataForm.elements.lastName.value = person.lastName ?? "";
      dataForm.elements.nickname.value = person.nickname ?? "";
      dataForm.elements.email.value = person.email ?? "";
      accountSchema = await api.get("/account-schema");
      dataOtFieldsContainer.innerHTML = accountSchema
        .map((field) => renderAccountFieldInput(field, person[field.key], {
          sealedBadge: ' <span class="sealed" title="Dieses Feld ist verschlüsselt gespeichert"><span class="material-symbols-outlined" aria-hidden="true">lock</span></span>',
        }))
        .join("");
      attachLiveValidation(dataOtFieldsContainer);

      scSchema = await api.get("/sc-schema");
      renderScSchemaFields();
      await loadCharacters();
    } catch (err) {
      if (err.status === 401) window.location.href = "/login.html";
      else if (err.status === 404) document.body.innerHTML = '<p class="error">Diese Person existiert nicht oder gehört nicht zu deinem Konto.</p>';
    } finally {
      hideLoading();
    }
  </script>
</body>

</html>
```

- [ ] **Step 2: No static-file registration needed**

Verified during planning: `backend/staticFiles.js`'s `serveStaticFile`
serves any `.html` file under `frontend/` generically by path (path-
traversal-safe via its `resolved.startsWith(resolvedBase + path.sep)`
check) — there is no per-page registration list. `managed-person.html`
is reachable at `/managed-person.html` as soon as the file exists on
disk; nothing else to do for this step.

- [ ] **Step 3: Manual verification**

Using the Claude Browser tool, with a managed person already created via
Task 1's UI: navigate to `managed-person.html?id=<that person's id>` and
verify:
1. Heading shows the person's name; membership data form is pre-filled.
2. Editing a field (e.g. Rufname) and saving persists (reload the page,
   confirm it's still there).
3. "Neuen Charakter anlegen" opens the SC character form with the real
   `sc-schema` fields rendered; saving creates a character that appears
   in the list.
4. Editing that character, uploading a photo, and deleting it (typing the
   exact name to confirm) all work.
5. Navigating directly to this page with a `?id=` belonging to a DIFFERENT
   account's managed person (or a random UUID) shows the "existiert
   nicht" message, not a crash or someone else's data.
Take a screenshot of the character list with at least one character for
the report.

- [ ] **Step 4: Commit**

```bash
git add frontend/managed-person.html
git commit -m "feat: add managed-person.html with membership data and SC character management"
```

---

### Task 3: NSC characters + event registration on managed-person.html

**Files:**
- Modify: `frontend/managed-person.html` (fills in the `nsc-tab` and `anmelden-tab` panels Task 2 left as placeholders, extends the script)

**Interfaces:**
- Consumes: `GET /nsc-schema`, `GET /events`, `GET /registration-schema`, `GET/POST/DELETE /managed-persons/:id/events/:eventId/register`, `GET /managed-persons/:id/registrations`, `PUT /events/:eventId/registrations/:userId/ot-fields` (existing route, needs one small ownership-check fix — see Step 1 below; it was never touched by the backend plan since neither the spec nor that plan's task list named it, but the spec's "same form as account.html's Anmelden section" requirement for THIS task implies the edit dialog must work for a managed person's registration too).
- Produces: nothing for later tasks — Task 4 only adds the payment button to the registration section this task builds.

- [ ] **Step 1: Extend the `ot-fields` route's ownership check**

Verified during planning: `backend/registrations/routes.js:213-216`
(`PUT /events/:eventId/registrations/:userId/ot-fields`) currently reads:

```javascript
router.put('/events/:id/registrations/:userId/ot-fields', requireAuth(async ({ req, params, user }) => {
  const isOwner = params.userId === user.id;
  const isStaff = user.group.visibleMenus.includes('mitglieder');
  if (!isOwner && !isStaff) return { status: 403, body: { error: 'forbidden' } };
```

This has no managed-person allowance — an owner editing their managed
person's registration OT-fields would 403 here today (neither
`params.userId === user.id` nor staff). Fix it the same way the backend
plan's Task 2/3 extended the 3 other ownership checks: add the import

```javascript
import { isManagedBy } from '../managedPersons/repository.js';
```

near the top of `backend/registrations/routes.js` (alongside its other
imports), and change line 214-215 to:

```javascript
  const isOwner = params.userId === user.id || await isManagedBy(params.userId, user.id);
  const isStaff = user.group.visibleMenus.includes('mitglieder');
```

Write a focused backend test for this in `tests/integration/
managedPersons.test.js` (a Postgres test DB is already running at
`postgres://app:app@localhost:5433/pakyrion_test` — start it via `docker
compose -f docker-compose.dev.yml up -d db-test` if it isn't): create an
owner + managed person + a registration for that person, `PUT
.../ot-fields` as the owner succeeds (200) and actually updates the
field, the same call as a third unrelated account 403s. Run `node --test
tests/integration/managedPersons.test.js` to confirm, then run `npm test`
once at the end of this step to confirm nothing else broke (small,
well-isolated change, but this touches a route every self-service
registration edit also goes through — worth the one full-suite check
right here rather than waiting for Task 4's final gate to find out).
Commit this fix on its own before starting the frontend work below:
`git add backend/registrations/routes.js tests/integration/
managedPersons.test.js && git commit -m "fix: let an owner edit their managed person's registration OT-fields"`.

- [ ] **Step 2: Fill in the NSC tab**

Replace the `<!-- filled in by Task 3 -->` placeholder inside
`<div class="tab-panel" id="nsc-tab" hidden>...</div>` in
`frontend/managed-person.html` with:

```html
          <div id="nsc-section" style="display:none;">
            <div class="dashboard-layout">
              <div class="dashboard-main">
                <div class="action-row">
                  <button type="button" id="new-nsc-character-btn" class="btn-ghost">Neuen NSC-Charakter anlegen</button>
                </div>
                <div id="nsc-form-section" class="card" style="display:none;">
                  <h3 id="nsc-form-title">Neuen NSC-Charakter anlegen</h3>
                  <hr class="rule">
                  <form id="nsc-character-form">
                    <h3>1. Charaktername</h3>
                    <input id="nsc-character-name" name="name" type="text" required>
                    <label for="nsc-character-name">Charaktername</label>
                    <h3>2. Charakterdaten</h3>
                    <div id="nsc-dynamic-fields" class="field-grid"></div>
                    <div class="dialog-actions">
                      <button type="submit">Speichern</button>
                      <button type="button" id="nsc-cancel-edit" class="btn-ghost">Abbrechen</button>
                    </div>
                  </form>
                </div>
              </div>
              <div>
                <div id="nsc-character-list" class="char-grid"></div>
              </div>
            </div>
          </div>
```

- [ ] **Step 3: Fill in the Anmeldung tab**

Replace `<!-- filled in by Task 3 -->` inside
`<div class="tab-panel" id="anmelden-tab" hidden>...</div>` with:

```html
          <h2>Anmeldungen</h2>
          <dialog id="edit-ot-dialog">
            <h3>Anmeldungsdaten bearbeiten</h3>
            <div id="edit-flags"></div>
            <div id="edit-ot-fields"></div>
            <div class="dialog-actions">
              <button type="button" id="edit-ot-save">Speichern</button>
              <button type="button" id="edit-ot-cancel" class="btn-ghost">Abbrechen</button>
            </div>
          </dialog>

          <div id="registrations-list"></div>

          <div id="registration-card" class="card">
            <h2>Neu anmelden</h2>
            <form id="registration-form">
              <h3>1. Veranstaltung</h3>
              <select id="event-select" required></select>
              <label for="event-select">Event</label>

              <h3>2. Wie nimmt die Person am Event teil?</h3>
              <div class="role-cards" id="registration-role-tabs">
                <button type="button" class="role-card active" data-role="sc">
                  <span class="role-card-title">Als Spielercharakter (SC)</span>
                </button>
                <button type="button" class="role-card" data-role="nsc" id="nsc-role-tab-btn" style="display:none;">
                  <span class="role-card-title">Als Nichtspieler (NSC)</span>
                </button>
              </div>

              <div id="sc-role-panel">
                <select id="character-select" style="display:none;"></select>
                <label for="character-select" id="character-select-label" style="display:none;">Als welcher Charakter?</label>
                <p id="no-character-hint" class="sub" style="display:none;">Noch kein passender Charakter angelegt.</p>
              </div>
              <div id="nsc-role-panel" hidden>
                <select id="nsc-character-select"></select>
                <label for="nsc-character-select">NSC-Charakter (optional)</label>
              </div>

              <div id="registration-price-group"></div>
              <div id="registration-flags"></div>

              <h3>3. Weitere Angaben</h3>
              <div id="ot-fields" class="field-grid"></div>

              <div id="registration-waiver" style="display:none;">
                <h3>4. Einverständniserklärung</h3>
                <p class="sub" id="registration-waiver-text" style="white-space:pre-wrap;"></p>
                <label><input type="checkbox" id="registration-waiver-checkbox" required> Einverständniserklärung gelesen und akzeptiert.</label>
              </div>

              <div class="dialog-actions">
                <button type="submit" id="register-button">Anmelden</button>
              </div>
            </form>
          </div>
```

- [ ] **Step 4: Extend the script**

Append to `frontend/managed-person.html`'s script, right before the
final `try { ... } catch ... finally { hideLoading(); }` init block:

```javascript
    let nscSchema = [];
    let nscSchemaAvailable = false;
    let nscCharacters = [];
    let editingNscCharacterId = null;
    const nscSection = document.getElementById("nsc-section");
    const nscTabButton = document.getElementById("nsc-tab-btn");
    const nscRoleTabButton = document.getElementById("nsc-role-tab-btn");

    function renderNscSchemaFields(data = {}) {
      document.getElementById("nsc-dynamic-fields").innerHTML = nscSchema
        .map((field) => `<div class="form-group">${renderField(field, data[field.key], "nsc-", { readOnly: field.staffOnly === true })}</div>`)
        .join("");
      attachLiveValidation(document.getElementById("nsc-dynamic-fields"));
    }

    function renderNscList() {
      const nscListBody = document.getElementById("nsc-character-list");
      nscListBody.innerHTML = nscCharacters
        .map((c) => `<div class="char-card" data-card-for="${c.id}">
      <button type="button" class="char-card-delete" data-delete="${c.id}" aria-label="Charakter löschen"><span class="material-symbols-outlined" aria-hidden="true">close</span></button>
      <h3>${escapeHtml(c.name)}</h3>
    </div>`)
        .join("");
      nscListBody.querySelectorAll("[data-card-for]").forEach((card) => {
        card.addEventListener("click", () => startNscEdit(card.dataset.cardFor));
      });
      nscListBody.querySelectorAll("[data-delete]").forEach((button) => {
        button.addEventListener("click", (event) => {
          event.stopPropagation();
          openDeleteCharacterDialog(button.dataset.delete);
        });
      });
    }

    function startNscEdit(characterId) {
      const character = nscCharacters.find((c) => c.id === characterId);
      if (!character) return;
      editingNscCharacterId = characterId;
      document.getElementById("nsc-form-title").textContent = `NSC-Charakter bearbeiten: ${character.name}`;
      document.getElementById("nsc-character-form").elements.name.value = character.name;
      renderNscSchemaFields(character.data);
      document.getElementById("nsc-form-section").style.display = "";
    }

    function resetNscForm() {
      editingNscCharacterId = null;
      document.getElementById("nsc-form-title").textContent = "Neuen NSC-Charakter anlegen";
      document.getElementById("nsc-character-form").reset();
      renderNscSchemaFields();
    }

    document.getElementById("new-nsc-character-btn").addEventListener("click", () => {
      resetNscForm();
      document.getElementById("nsc-form-section").style.display = "";
    });
    document.getElementById("nsc-cancel-edit").addEventListener("click", () => {
      resetNscForm();
      document.getElementById("nsc-form-section").style.display = "none";
    });
    document.getElementById("nsc-character-form").addEventListener("submit", async (event) => {
      event.preventDefault();
      const name = document.getElementById("nsc-character-form").elements.name.value;
      const data = collectFieldValues(document.getElementById("nsc-character-form"), nscSchema);
      try {
        if (editingNscCharacterId) {
          await api.put(`/characters/${editingNscCharacterId}`, { name, data });
        } else {
          await api.post(`/managed-persons/${managedPersonId}/characters`, { class: "nsc", name, data });
        }
        notify("Gespeichert.", "success");
        resetNscForm();
        document.getElementById("nsc-form-section").style.display = "none";
        await loadCharacters();
      } catch (err) {
        notify(err.status === 400 && err.body?.details ? err.body.details.join(", ") : err.message, "error");
      }
    });

    // registration section
    let events = [];
    let currentRegistrations = [];
    let registrationSchema = [];
    let selectedRegistrationRole = "sc";
    const eventSelect = document.getElementById("event-select");
    const characterSelect = document.getElementById("character-select");
    const nscCharacterSelect = document.getElementById("nsc-character-select");
    const scRolePanel = document.getElementById("sc-role-panel");
    const nscRolePanel = document.getElementById("nsc-role-panel");
    const otFieldsContainer = document.getElementById("ot-fields");
    const registrationFlagsContainer = document.getElementById("registration-flags");
    const registrationPriceGroupContainer = document.getElementById("registration-price-group");
    const registrationWaiverSection = document.getElementById("registration-waiver");
    const registrationWaiverCheckbox = document.getElementById("registration-waiver-checkbox");

    function flagsFieldFor(event) {
      return { key: "flags", label: "Sonderrollen", type: "multiselect", options: event?.flags ?? [] };
    }
    function renderRegistrationFlags() {
      const event = events.find((e) => e.id === eventSelect.value);
      const field = flagsFieldFor(event);
      registrationFlagsContainer.innerHTML = field.options.length > 0 ? renderAccountFieldInput(field, [], { idPrefix: "register-" }) : "";
    }
    function collectRegistrationFlags() {
      return collectAccountFieldValues(registrationFlagsContainer, [flagsFieldFor(events.find((e) => e.id === eventSelect.value))]).flags ?? [];
    }
    function priceGroupFieldFor(event) {
      const groups = event?.pricing?.groups ?? [];
      return { key: "priceGroup", label: "Teilnahmegruppe", type: "select", options: groups, required: groups.length > 0 };
    }
    function renderRegistrationPriceGroup() {
      const event = events.find((e) => e.id === eventSelect.value);
      const field = priceGroupFieldFor(event);
      registrationPriceGroupContainer.innerHTML = field.options.length > 0 ? renderAccountFieldInput(field, "", { idPrefix: "register-" }) : "";
    }
    function collectRegistrationPriceGroup() {
      const value = collectAccountFieldValues(registrationPriceGroupContainer, [priceGroupFieldFor(events.find((e) => e.id === eventSelect.value))]).priceGroup;
      return value || undefined;
    }
    function isNscRoleSelected() { return selectedRegistrationRole === "nsc"; }

    [...document.querySelectorAll("#registration-role-tabs .role-card")].forEach((btn) => {
      btn.addEventListener("click", () => {
        selectedRegistrationRole = btn.dataset.role;
        document.querySelectorAll("#registration-role-tabs .role-card").forEach((b) => b.classList.toggle("active", b === btn));
        scRolePanel.hidden = isNscRoleSelected();
        nscRolePanel.hidden = !isNscRoleSelected();
      });
    });

    function renderOtFields(values = {}) {
      otFieldsContainer.innerHTML = registrationSchema.map((field) => renderAccountFieldInput(field, values[field.key], { idPrefix: "register-" })).join("");
      attachLiveValidation(otFieldsContainer);
    }
    function collectOtFields() {
      return collectAccountFieldValues(otFieldsContainer, registrationSchema);
    }

    function populateRegistrationCharacterFields() {
      const matchingSc = characters.filter((c) => c.class === "sc" && !c.registeredFor);
      characterSelect.innerHTML = ['<option value="">Bitte wählen</option>'].concat(matchingSc.map((c) => `<option value="${escapeHtml(c.id)}">${escapeHtml(c.name)}</option>`)).join("");
      const hasNone = matchingSc.length === 0;
      document.getElementById("no-character-hint").style.display = hasNone ? "" : "none";
      characterSelect.style.display = hasNone ? "none" : "";
      document.getElementById("character-select-label").style.display = hasNone ? "none" : "";

      const matchingNsc = characters.filter((c) => c.class === "nsc");
      nscCharacterSelect.innerHTML = ['<option value="">Kein bestimmter NSC-Charakter</option>'].concat(matchingNsc.map((c) => `<option value="${escapeHtml(c.id)}">${escapeHtml(c.name)}</option>`)).join("");
    }

    eventSelect.addEventListener("change", () => {
      renderRegistrationFlags();
      renderRegistrationPriceGroup();
    });

    async function loadEvents() {
      events = (await api.get("/events")).filter((e) => e.is_active);
      eventSelect.innerHTML = renderEventOptions(events);
      renderRegistrationFlags();
      renderRegistrationPriceGroup();
    }

    async function loadRegistrationWaiver() {
      const { waiverText } = await api.get("/app-settings");
      if (waiverText) {
        document.getElementById("registration-waiver-text").textContent = waiverText;
        registrationWaiverSection.style.display = "";
        registrationWaiverCheckbox.required = true;
      } else {
        registrationWaiverSection.style.display = "none";
        registrationWaiverCheckbox.required = false;
      }
    }

    const CON_ROLE_LABELS = { sc: "SC", nsc: "NSC", helfer: "Helfer" };
    function labelForRegisteredAs(r) {
      const flagsSuffix = r.flags && r.flags.length > 0 ? ` (${r.flags.join(", ")})` : "";
      if (r.conRole === "sc") return `Angemeldet als SC${flagsSuffix}: ${r.characterName}`;
      if (r.conRole === "nsc") return r.characterName ? `Angemeldet als NSC${flagsSuffix}: ${r.characterName}` : `Angemeldet als NSC${flagsSuffix}`;
      return `Angemeldet als ${CON_ROLE_LABELS[r.conRole] ?? r.conRole}${flagsSuffix}`;
    }

    function renderRegistrationsList() {
      const container = document.getElementById("registrations-list");
      if (currentRegistrations.length === 0) {
        container.innerHTML = '<p class="sub">Noch keine Anmeldungen.</p>';
        return;
      }
      container.innerHTML = currentRegistrations.map((r) => `<div class="card form-pad" data-reg-for="${r.eventId}">
      <h3>${escapeHtml(r.eventName)}</h3>
      <p>${escapeHtml(labelForRegisteredAs(r))} &ndash; <span class="status-pill status-${escapeHtml(r.status)}">${escapeHtml(STATUS_LABELS[r.status] ?? r.status)}</span></p>
      <div class="action-row">
        <button type="button" data-reg-edit="${r.eventId}" class="btn-ghost">Bearbeiten</button>
        ${(r.status === "pending" || r.status === "waitlisted") ? `<button type="button" data-reg-unregister="${r.eventId}" class="btn-secondary">Abmelden</button>` : ""}
      </div>
    </div>`).join("");
      container.querySelectorAll("[data-reg-edit]").forEach((btn) => btn.addEventListener("click", () => openEditOtDialog(btn.dataset.regEdit)));
      container.querySelectorAll("[data-reg-unregister]").forEach((btn) => btn.addEventListener("click", () => unregister(btn.dataset.regUnregister)));
    }

    async function loadRegistrations() {
      currentRegistrations = await api.get(`/managed-persons/${managedPersonId}/registrations`);
      renderRegistrationsList();
      const wantsNsc = nscSchemaAvailable;
      nscSection.style.display = wantsNsc ? "" : "none";
      nscTabButton.style.display = wantsNsc ? "" : "none";
      nscRoleTabButton.style.display = wantsNsc ? "" : "none";
    }

    async function unregister(eventId) {
      if (!confirm("Diese Person wirklich von diesem Event abmelden?")) return;
      try {
        await api.delete(`/managed-persons/${managedPersonId}/events/${eventId}/register`);
        await loadRegistrations();
      } catch (err) {
        notify(err.message, "error");
      }
    }

    const editOtDialog = document.getElementById("edit-ot-dialog");
    let editingEventId = null;
    function openEditOtDialog(eventId) {
      const registration = currentRegistrations.find((r) => r.eventId === eventId);
      if (!registration) return;
      editingEventId = eventId;
      const event = events.find((e) => e.id === eventId);
      const flagsField = flagsFieldFor(event);
      document.getElementById("edit-flags").innerHTML = flagsField.options.length > 0 ? renderAccountFieldInput(flagsField, registration.flags ?? [], { idPrefix: "edit-" }) : "";
      document.getElementById("edit-ot-fields").innerHTML = registrationSchema.map((field) => renderAccountFieldInput(field, registration[field.key], { idPrefix: "edit-" })).join("");
      attachLiveValidation(document.getElementById("edit-ot-fields"));
      editOtDialog.showModal();
    }
    document.getElementById("edit-ot-cancel").addEventListener("click", () => editOtDialog.close());
    document.getElementById("edit-ot-save").addEventListener("click", async () => {
      const registration = currentRegistrations.find((r) => r.eventId === editingEventId);
      const collected = nullifyBlankNumberFields(registrationSchema, collectAccountFieldValues(document.getElementById("edit-ot-fields"), registrationSchema));
      const payload = {};
      for (const field of registrationSchema) {
        if (otFieldValuesEqual(field, registration?.[field.key] ?? (field.type === "boolean" ? false : ""), collected[field.key])) continue;
        payload[field.key] = collected[field.key];
      }
      const flagsField = flagsFieldFor(events.find((e) => e.id === editingEventId));
      const collectedFlags = collectAccountFieldValues(document.getElementById("edit-flags"), [flagsField]).flags;
      const representableCurrentFlags = (registration?.flags ?? []).filter((f) => flagsField.options.includes(f));
      if (!otFieldValuesEqual(flagsField, representableCurrentFlags, collectedFlags ?? [])) payload.flags = collectedFlags ?? [];
      if (Object.keys(payload).length === 0) { editOtDialog.close(); return; }
      try {
        await api.put(`/events/${editingEventId}/registrations/${managedPersonId}/ot-fields`, payload);
        editOtDialog.close();
        notify("Gespeichert.", "success");
        await loadRegistrations();
      } catch (err) {
        notify(err.message, "error");
      }
    });

    document.getElementById("registration-form").addEventListener("submit", async (event) => {
      event.preventDefault();
      const eventId = eventSelect.value;
      let conRole, characterId;
      if (isNscRoleSelected()) {
        conRole = "nsc";
        characterId = nscCharacterSelect.value || undefined;
      } else {
        characterId = characterSelect.value || undefined;
        if (!characterId) { notify("Wähle einen Charakter.", "error"); return; }
        conRole = "sc";
      }
      try {
        await api.post(`/managed-persons/${managedPersonId}/events/${eventId}/register`, {
          conRole, characterId,
          flags: collectRegistrationFlags(),
          priceGroup: collectRegistrationPriceGroup(),
          otFields: collectOtFields(),
          waiverAccepted: registrationWaiverCheckbox.checked,
        });
        notify("Angemeldet.", "success");
        renderOtFields();
        await loadRegistrations();
        await loadCharacters();
      } catch (err) {
        notify(err.status === 400 && err.body?.details ? err.body.details.join(", ") : err.message, "error");
      }
    });
```

Then, inside this same file's existing final `try { ... }` init block (the
one Task 2 wrote, starting `const person = await api.get(...)`), add
after the existing `await loadCharacters();` line:

```javascript
      try {
        nscSchema = await api.get("/nsc-schema");
        nscSchemaAvailable = true;
        renderNscSchemaFields();
      } catch {
        // NSC schema is optional-ish, same as account.html's own bootstrap.
      }
      registrationSchema = await api.get("/registration-schema");
      renderOtFields();
      await loadEvents();
      await loadRegistrationWaiver();
      await loadRegistrations();
```

And change `loadCharacters`'s body (written in Task 2) to also call
`populateRegistrationCharacterFields();` and, when the NSC section is
visible, `nscCharacters = characters.filter((c) => c.class === "nsc");
renderNscList();` — mirroring account.html's own `loadCharacters`/
`renderCharacterList` split exactly (see `frontend/account.html`'s
`loadCharacters`/`renderCharacterList` for the reference you're matching).

- [ ] **Step 5: Manual verification**

Using the Claude Browser tool:
1. On a managed person whose owner's group permits NSC characters
   (`character_classes` includes `'nsc'` — check via `admin/groups.html`
   or the test fixture group you're using), confirm the "NSC-Charaktere"
   tab and the NSC role-tab button become visible once at least one
   relevant condition is met, and creating an NSC character works.
2. On the "Anmeldung" tab: select the currently active event (seed one
   via `admin/events.html` if none is active), choose "Als
   Spielercharakter", pick the SC character created in Task 2, submit —
   confirm it appears in "Anmeldungen" with the right status.
3. Click "Bearbeiten" on that registration, change an OT field, save —
   confirm the change persists (reload and reopen the edit dialog).
4. Click "Abmelden" — confirm it disappears (status was `pending`/
   `waitlisted`).
5. If the event has configured flags or price groups, confirm those
   render as checkboxes/a select and get submitted correctly (check via
   the admin participant list or a direct DB query if easier).
Take a screenshot of the completed registration card for the report.

- [ ] **Step 6: Commit**

```bash
git add frontend/managed-person.html
git commit -m "feat: add NSC characters and event registration to managed-person.html"
```

---

### Task 4: Payment button + full regression pass

**Files:**
- Modify: `frontend/managed-person.html` (payment button on a registration with an amount due)

**Interfaces:**
- Consumes: `POST /events/:eventId/registrations/:userId/checkout-session` (already ownership-extended in the backend plan's Task 3 — accepts the owner acting for their managed person).

- [ ] **Step 1: Add the payment button**

In `frontend/managed-person.html`'s `renderRegistrationsList` function
(written in Task 3), add a payment button for any registration with an
unpaid amount due. Change the card template from:

```javascript
      <div class="action-row">
        <button type="button" data-reg-edit="${r.eventId}" class="btn-ghost">Bearbeiten</button>
        ${(r.status === "pending" || r.status === "waitlisted") ? `<button type="button" data-reg-unregister="${r.eventId}" class="btn-secondary">Abmelden</button>` : ""}
      </div>
```

to:

```javascript
      <div class="action-row">
        <button type="button" data-reg-edit="${r.eventId}" class="btn-ghost">Bearbeiten</button>
        ${(r.status === "pending" || r.status === "waitlisted") ? `<button type="button" data-reg-unregister="${r.eventId}" class="btn-secondary">Abmelden</button>` : ""}
        ${(r.amountDueCents != null && !r.paidAt) ? `<button type="button" data-reg-pay="${r.eventId}">Jetzt zahlen (${(r.amountDueCents / 100).toFixed(2).replace(".", ",")} &euro;)</button>` : ""}
      </div>
```

and in the same function, after the existing `container.querySelectorAll("[data-reg-unregister]")...` line, add:

```javascript
      container.querySelectorAll("[data-reg-pay]").forEach((btn) => btn.addEventListener("click", () => payForRegistration(btn.dataset.regPay)));
```

Then add this function near `unregister` (same section of the script):

```javascript
    async function payForRegistration(eventId) {
      try {
        const { url } = await api.post(`/events/${eventId}/registrations/${managedPersonId}/checkout-session`, { method: "card" });
        window.location.href = url;
      } catch (err) {
        notify(err.message, "error");
      }
    }
```

(Only a card-payment button, no PayPal/bank-transfer/Girocode choice
dialog — the spec's section 6.2 asks for "ein Zahlungs-Button", singular,
not the full payment-method picker account.html has; account.html's own
IBAN/Girocode flows are for the SELF-service page and out of scope here,
per the Global Constraints.)

- [ ] **Step 2: Manual verification**

Using the Claude Browser tool: register the managed person (from Task 3)
for an event that has a price configured (set one via `admin/events.html`
if needed), confirm the "Jetzt zahlen" button appears with the right
amount, and clicking it redirects toward Stripe checkout (or shows the
"Zahlungen sind aktuell nicht konfiguriert" error if Stripe isn't set up
in this dev environment — either outcome confirms the request reached
the real route rather than 403ing).

- [ ] **Step 3: Full end-to-end walkthrough**

Using the Claude Browser tool, walk through the complete feature once,
start to finish, as a single logged-in test account: create a managed
person (Task 1 UI) → open `managed-person.html` for them (Task 2) →
create an SC character → register them for the active event (Task 3) →
confirm the registration shows up → convert the person to a real account
(Task 1 UI) → confirm the former owner's `managed-person.html?id=...` for
that person now shows the "existiert nicht" message. Screenshot each
major step for the final report.

- [ ] **Step 4: Full backend test suite**

Run: `npm test`
Expected: all tests pass (this plan's own changes are frontend-only, but
this project's convention is to run the full suite as the last step of
the last task of every plan — confirms nothing was accidentally broken,
e.g. by the `backend/staticFiles.js` check in Task 2 Step 2 if that turned
out to need a real code change).

- [ ] **Step 5: Commit**

```bash
git add frontend/managed-person.html
git commit -m "feat: add payment button to managed-person.html registrations"
```

## Self-Review Notes (filled in during plan writing, not execution)

- **Spec coverage:** Section 6.1 (account.html section: list/add/edit/
  delete/convert) → Task 1. Section 6.2 (dedicated page: membership data,
  SC+NSC characters, file upload, event registration/unregistration,
  payment button, explicitly no login/OAuth/Discord/logout UI) → Tasks
  2-4. No spec requirement found without a task.
- **Type/signature consistency check:** `managedPersonId` (from the page's
  `?id=` query param) is threaded identically through every fetch added
  in Tasks 2-4. `loadCharacters()` is defined once in Task 2 and extended
  (not redefined) in Task 3 — Task 3's Step 4 explicitly calls out
  changing its body rather than silently assuming two different versions
  coexist. `characters`/`events`/`currentRegistrations`/`accountSchema`/
  `scSchema`/`nscSchema` are each declared exactly once (Task 2 or Task 3,
  never both).
- **Backend gap found and closed during planning, not left for the
  implementer to discover:** `PUT .../ot-fields` was never touched by the
  backend plan (neither the spec nor that plan's task list named it), but
  this frontend plan's edit-registration-data dialog needs it to accept a
  managed-person owner. Traced and confirmed during plan-writing (read
  `backend/registrations/routes.js:213-216` directly) that it would 403
  today; Task 3 Step 1 now carries the exact fix instead of an
  investigate-and-maybe-escalate instruction.

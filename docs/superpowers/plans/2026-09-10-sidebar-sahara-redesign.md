# Sidebar-Navigation + Sahara-Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the app's two parallel design systems (`chronicle-crest.css` + `everest-registry.css`) with one unified stylesheet (`sahara.css`), give every authenticated page a sidebar (the 7 admin pages already have one, structurally; 2 chronicle pages don't), and move `account.html`'s Konto/Veranstaltung tab switcher into that sidebar.

**Architecture:** One new CSS file replaces both old ones — old class names stay valid in the markup wherever practical (aliased onto the same new rules), so most of the 15 HTML files need only a `<link>`/font swap, not a rewrite. `account.html` and `characters-browse.html` get a real structural rewrite (from the centered "folio card" shell to the `.app`/`.sidebar`/`.main`/`.content` shell the admin pages already use). `frontend/js/nav.js` gains icons per nav item, a `renderSidebarUser` helper, and a mobile hamburger-toggle helper — used by all 9 nav-bearing pages.

**Tech Stack:** Vanilla CSS custom properties (no Tailwind/build step), vanilla JS ES modules, Material Symbols Outlined (already loaded on 2 of 15 pages, extended to all 9 nav pages), Google Fonts (EB Garamond + Manrope, replacing Work Sans/Inter).

**Spec:** `docs/superpowers/specs/2026-09-10-sidebar-sahara-redesign-design.md`

## Global Constraints

- No backend changes anywhere in this plan — `/account`'s response shape (`account.name`, `account.group.name`, `account.menus`) is already sufficient for everything the sidebar needs.
- Old CSS class names stay in the markup wherever the spec's component table (spec §8) says so — do not rename markup classes as a side effect of restyling them, except the one explicit exception in spec §8 (`.ribbon` → `.status-pill` in `account.html`'s registration table).
- `account.html`'s Konto/Veranstaltung/Anmelden/Charaktere tab-switching stays 100% client-side (no page reload, no URL change) — only the trigger buttons' markup/location changes, `initTabs`'s click-toggle mechanics do not change.
- The deeper in-page tab levels (SC/NSC switcher, NSC Allgemein/Merkmale switcher) stay ordinary horizontal `.tabs` bars in the content area — they are not sidebar items.
- No Tailwind, no CDN framework, no build step — plain CSS in one file, same convention as today.
- This repo has no frontend test framework — every frontend task's verification is a manual/static checklist (browser preview where practical, careful reading otherwise), not automated tests. Backend is untouched, so `npm test` is only ever a smoke check in this plan, not a target of new tests.

---

## Task 1: `sahara.css` foundation + `nav.js` sidebar helpers, proven on `admin/groups.html`

**Files:**
- Create: `frontend/css/sahara.css`
- Modify: `frontend/js/nav.js`
- Modify: `frontend/admin/groups.html`

**Interfaces:**
- Consumes: nothing from other tasks.
- Produces: `sahara.css`'s full selector set (Task 2 relies on `.sidebar`, `.sidebar-nav-item`, `.sidebar-foot`, `.sidebar-toggle`, `.card`, `.badge`/`.badge-active`/`.badge-inactive`, `.status-pill`+`.status-*`, `.toggle-group`, `.checkbox-group`, `.schema-row`, `.stat-row`/`.stat`, `.toolbar`/`.search`, `.field-below`, `.table-scroll`, `.hr` existing exactly as defined here — Task 2 does not redefine any of these, only reuses them). `nav.js`'s exports `renderNavLinks(account, currentPath)` (existing signature, now emits icons), `renderSidebarUser(account)` (new), `initSidebarToggle()` (new) — Tasks 2-4 call all three with these exact names/signatures.

- [ ] **Step 1: Write `frontend/css/sahara.css`**

```css
:root {
  --surface: #faf5ee;
  --surface-container-lowest: #ffffff;
  --surface-container-low: #f6f0e8;
  --surface-container: #f2ece4;
  --surface-container-high: #ece6dc;
  --surface-container-highest: #e6e0d6;
  --on-surface: #3a302a;
  --on-surface-variant: #605850;
  --outline: #9a9088;
  --outline-variant: #d8d0c8;
  --primary: #c2652a;
  --primary-deep: #8a4518;
  --primary-container: #fbe8d8;
  --on-primary: #ffffff;
  --on-primary-container: #8a4518;
  --gold: #8c3c3c;
  --gold-container: #fce0e0;
  --on-gold-container: #3a2020;
  --secondary: #78706a;
  --secondary-container: #eae2da;
  --error: #c0392b;
  --success: #2c5223;
  --shadow: rgba(58, 48, 42, 0.06);
}

* {
  box-sizing: border-box;
}

body {
  margin: 0;
  background: var(--surface);
  color: var(--on-surface);
  font-family: "Manrope", system-ui, sans-serif;
  min-height: 100vh;
}

h1, h2, h3 {
  font-family: "EB Garamond", Georgia, serif;
  text-wrap: balance;
  margin: 0;
}

/* ---------- Auth-page shell (login, register, verify, reset/set-password, index) ---------- */

.shell {
  max-width: 920px;
  margin: 0 auto;
  padding: 48px 20px 80px;
}

.brand {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 14px;
  margin-bottom: 8px;
}

.brand-seal {
  display: none;
  height: 108px;
  height: 6cap;
  font-family: "EB Garamond", serif;
  font-size: 26px;
}

.brand-seal img {
  width: 100%;
  height: 100%;
  object-fit: contain;
}

.brand-name {
  color: var(--primary);
  font-family: "EB Garamond", serif;
  font-size: 26px;
  font-weight: 600;
  letter-spacing: 0.01em;
}

.brand-sub {
  text-align: center;
  color: var(--on-surface-variant);
  font-size: 13px;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  margin: -4px 0 36px;
  opacity: 0.8;
}

.folio--narrow {
  max-width: 460px;
  margin: 0 auto;
}

.folio--wide {
  max-width: 880px;
  margin: 0 auto;
}

/* ---------- Card (both ".folio" and ".card" -- same look, one rule) ---------- */

.folio,
.card {
  background: var(--surface-container-lowest);
  border: 1px solid var(--outline-variant);
  border-radius: 12px;
  box-shadow: 0 1px 3px var(--shadow);
  padding: 32px;
}

.card + .card {
  margin-top: 24px;
}

.form-pad {
  padding: 24px;
}

/* ---------- Sidebar app shell ---------- */

.app {
  display: flex;
  min-height: 100vh;
}

.sidebar {
  width: 260px;
  flex: none;
  background: var(--surface-container-lowest);
  border-right: 1px solid var(--outline-variant);
  padding: 24px 16px;
  display: flex;
  flex-direction: column;
  height: 100vh;
  max-height: 100vh;
  position: fixed;
  z-index: 30;
  transition: transform 0.2s ease;
}

.sidebar-top {
  padding: 0 8px 20px;
}

.sidebar-brand {
  font-family: "EB Garamond", serif;
  font-size: 20px;
  font-weight: 600;
  color: var(--primary);
  letter-spacing: 0.01em;
}

.sidebar-brand span {
  display: block;
  font-size: 11px;
  font-weight: 500;
  font-family: "Manrope", sans-serif;
  color: var(--on-surface-variant);
  text-transform: uppercase;
  letter-spacing: 0.06em;
  margin-top: 2px;
}

.sidebar nav {
  display: flex;
  flex-direction: column;
  gap: 2px;
  overflow-y: auto;
}

.sidebar-nav-item {
  display: flex;
  align-items: center;
  gap: 12px;
  color: var(--on-surface-variant);
  text-decoration: none;
  font-size: 14px;
  font-weight: 500;
  font-family: "Manrope", sans-serif;
  padding: 10px 14px;
  border-radius: 8px;
  border: none;
  background: none;
  cursor: pointer;
  width: 100%;
  text-align: left;
}

.sidebar-nav-item:hover {
  background: var(--surface-container-low);
  color: var(--on-surface);
}

.sidebar-nav-item.current,
.sidebar-nav-item.active {
  background: var(--primary-container);
  color: var(--primary-deep);
  font-weight: 600;
}

.sidebar-nav-item .material-symbols-outlined {
  font-size: 20px;
}

.sidebar-nav-nested {
  display: flex;
  flex-direction: column;
  gap: 2px;
  margin: 2px 0 6px 20px;
  padding-left: 12px;
  border-left: 1px solid var(--outline-variant);
}

.sidebar-nav-nested[hidden] {
  display: none;
}

.sidebar-foot {
  margin-top: auto;
  padding-top: 16px;
  border-top: 1px solid var(--outline-variant);
}

.sidebar-event-badge:empty {
  display: none;
}

.sidebar-event-badge {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 10px;
  border-radius: 8px;
  background: var(--surface-container-low);
  border: 1px solid var(--outline-variant);
  font-size: 12px;
  color: var(--on-surface-variant);
  margin-bottom: 12px;
}

.sidebar-event-badge::before {
  content: "";
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--primary);
  flex: none;
}

.sidebar-user {
  display: flex;
  align-items: center;
  gap: 10px;
}

.sidebar-user-avatar {
  width: 34px;
  height: 34px;
  border-radius: 50%;
  background: var(--surface-container-high);
  color: var(--on-surface);
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 12px;
  font-weight: 600;
  flex: none;
}

.sidebar-user-text {
  min-width: 0;
}

.sidebar-user-name {
  font-size: 13px;
  font-weight: 600;
  color: var(--on-surface);
  margin: 0;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.sidebar-user-role {
  font-size: 11px;
  color: var(--on-surface-variant);
  margin: 0;
}

.sidebar-foot #logout-link {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-top: 12px;
  font-size: 13px;
  font-weight: 600;
  color: var(--on-surface-variant);
  text-decoration: none;
  background: none;
  border: none;
  padding: 0;
  cursor: pointer;
}

.sidebar-foot #logout-link:hover {
  color: var(--error);
}

.sidebar-toggle {
  display: none;
  position: fixed;
  top: 16px;
  left: 16px;
  z-index: 40;
  background: var(--surface-container-lowest);
  border: 1px solid var(--outline-variant);
  border-radius: 8px;
  padding: 8px;
  cursor: pointer;
}

.main {
  flex: 1;
  min-width: 0;
  margin-left: 260px;
}

.content {
  padding: 40px 48px;
  max-width: 960px;
}

@media (max-width: 900px) {
  .sidebar {
    transform: translateX(-100%);
    box-shadow: 0 0 24px var(--shadow);
  }

  .sidebar.sidebar--open {
    transform: translateX(0);
  }

  .sidebar-toggle {
    display: flex;
  }

  .main {
    margin-left: 0;
  }

  .content {
    padding: 72px 20px 32px;
  }
}

/* ---------- Headings, copy ---------- */

.eyebrow {
  font-family: "Manrope", sans-serif;
  font-size: 12px;
  font-weight: 600;
  letter-spacing: 0.12em;
  text-transform: uppercase;
  color: var(--outline);
  margin: 0 0 6px;
}

h1 {
  font-size: 32px;
  font-weight: 600;
  color: var(--on-surface);
  margin: 0 0 6px;
}

h2 {
  font-size: 20px;
  font-weight: 600;
  color: var(--on-surface);
  margin: 36px 0 16px;
}

h2:first-child {
  margin-top: 0;
}

h3 {
  font-size: 16px;
  font-weight: 600;
  color: var(--on-surface);
}

.lede,
.sub {
  color: var(--on-surface-variant);
  font-size: 14px;
  margin: 0 0 28px;
  font-style: normal;
}

.rule,
.hr {
  border: none;
  height: 1px;
  margin: 24px 0;
  background: var(--outline-variant);
}

.text-center {
  text-align: center;
}

/* ---------- Tabs (SC/NSC switcher, NSC Allgemein/Merkmale -- in-page only, not sidebar) ---------- */

.tabs {
  display: flex;
  gap: 24px;
  margin-bottom: 28px;
  border-bottom: 1px solid var(--outline-variant);
}

.tabs--sub {
  margin-bottom: 20px;
}

.tab-btn {
  background: none;
  border: none;
  cursor: pointer;
  font: inherit;
  font-family: "Manrope", sans-serif;
  font-size: 14px;
  font-weight: 600;
  color: var(--on-surface-variant);
  padding: 0 0 14px;
  margin-bottom: -1px;
  border-bottom: 2px solid transparent;
}

.tab-btn.active {
  color: var(--primary);
  border-bottom-color: var(--primary);
}

.tab-btn:not(.active):hover {
  color: var(--primary-deep);
}

/* ---------- Forms ---------- */

form {
  display: block;
}

label {
  display: block;
  font-size: 12px;
  font-weight: 600;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  color: var(--on-surface-variant);
  margin: 18px 0 6px;
}

#dynamic-fields label,
#nsc-dynamic-fields label {
  margin: 4px 0 14px;
}

label:first-child {
  margin-top: 0;
}

input,
select,
textarea {
  display: block;
  width: 100%;
  border: 1px solid var(--outline-variant);
  border-radius: 8px;
  background: var(--surface-container-low);
  padding: 10px 12px;
  font: 14px "Manrope", sans-serif;
  color: var(--on-surface);
}

input[type="checkbox"] {
  display: inline-block;
  width: auto;
}

input::placeholder,
textarea::placeholder {
  color: var(--outline);
}

textarea {
  min-height: 76px;
  resize: vertical;
}

input:focus,
select:focus,
textarea:focus {
  outline: none;
  border-color: var(--primary);
  background: var(--surface-container-lowest);
}

input.invalid,
select.invalid,
textarea.invalid {
  border-color: var(--error);
  border-width: 1.5px;
}

.field-error {
  color: var(--error);
  font-size: 12px;
  margin: 2px 0 0;
  min-height: 14px;
}

.field-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 0 24px;
}

@media (max-width: 560px) {
  .field-grid {
    grid-template-columns: 1fr;
  }
}

.field-grid > div > label {
  margin-top: 18px;
}

.field-below label {
  margin-bottom: 0;
  margin-top: 6px;
  order: 2;
}

.field-below input,
.field-below select {
  margin-bottom: 0;
  order: 1;
}

.field-below {
  display: flex;
  flex-direction: column;
  margin-bottom: 18px;
}

.checkbox-group {
  display: flex;
  flex-wrap: wrap;
  gap: 6px 18px;
  margin-bottom: 18px;
}

.checkbox-group label {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  text-transform: none;
  font-weight: 500;
  font-size: 13px;
  margin-bottom: 0;
}

.toggle-group {
  display: flex;
  border: 1px solid var(--outline-variant);
  border-radius: 8px;
  overflow: hidden;
  margin-bottom: 18px;
}

.toggle-btn {
  flex: 1;
  background: var(--surface-container-lowest);
  color: var(--on-surface-variant);
  border: none;
  border-radius: 0;
  padding: 9px 12px;
  font: 13px "Manrope", sans-serif;
  font-weight: 600;
  cursor: pointer;
}

.toggle-btn + .toggle-btn {
  border-left: 1px solid var(--outline-variant);
}

.toggle-btn.active {
  background: var(--primary);
  color: var(--on-primary);
}

.toggle-group-sm {
  margin-bottom: 0;
}

.toggle-group-sm .toggle-btn {
  flex: none;
  padding: 4px 10px;
  font-size: 11px;
}

.schema-row {
  display: grid;
  grid-template-columns: 1fr 1fr 120px 1fr auto auto;
  gap: 10px;
  align-items: center;
}

@media (max-width: 900px) {
  .schema-row {
    grid-template-columns: 1fr;
  }
}

/* ---------- Buttons ---------- */

button[type="submit"],
.btn-seal,
.btn,
button {
  font-family: "Manrope", sans-serif;
  font-size: 14px;
  font-weight: 600;
  background: var(--primary);
  color: var(--on-primary);
  border: 1px solid transparent;
  padding: 10px 20px;
  border-radius: 8px;
  cursor: pointer;
  letter-spacing: 0.01em;
}

button[type="submit"]:hover,
.btn-seal:hover,
.btn:hover,
button:hover {
  background: var(--primary-deep);
}

.btn-ghost,
.btn-secondary {
  background: none;
  border: 1px solid transparent;
  color: var(--on-surface-variant);
  font-size: 13px;
  font-weight: 600;
  text-decoration: none;
  cursor: pointer;
  padding: 8px 14px;
  border-radius: 8px;
}

.btn-ghost:hover,
.btn-secondary:hover {
  background: var(--surface-container-low);
  color: var(--on-surface);
}

.btn-secondary {
  border-color: var(--outline-variant);
}

.btn-sm {
  padding: 6px 10px;
  font-size: 12px;
}

.btn-danger {
  font-family: "Manrope", sans-serif;
  font-size: 14px;
  font-weight: 600;
  background: transparent;
  color: var(--error);
  border: 1.5px solid var(--error);
  padding: 9px 18px;
  border-radius: 8px;
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  gap: 6px;
}

.btn-danger:hover {
  background: var(--error);
  color: #fff;
}

.material-symbols-outlined {
  font-variation-settings: 'FILL' 0, 'wght' 400, 'GRAD' 0, 'opsz' 20;
  font-size: 20px;
  vertical-align: middle;
  line-height: 1;
  user-select: none;
}

/* ---------- Dialogs ---------- */

dialog {
  border: none;
  border-radius: 12px;
  padding: 28px;
  box-shadow: 0 8px 32px var(--shadow);
  width: clamp(30ch, 30vw, 50ch);
}

dialog::backdrop {
  background: rgba(58, 48, 42, 0.35);
}

.dialog-actions {
  display: flex;
  gap: 12px;
  margin-top: 20px;
}

/* ---------- Tables ---------- */

table {
  width: 100%;
  border-collapse: collapse;
  margin-bottom: 8px;
}

.table-scroll {
  overflow-x: auto;
}

.table-scroll table {
  width: auto;
  min-width: 100%;
}

@media (max-width: 560px) {
  table {
    display: block;
    overflow-x: auto;
    white-space: nowrap;
  }
}

th {
  text-align: left;
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.05em;
  text-transform: uppercase;
  color: var(--on-surface-variant);
  padding: 12px 10px;
  background: var(--surface-container-low);
  border-bottom: 1px solid var(--outline-variant);
}

td {
  padding: 14px 10px;
  border-bottom: 1px solid var(--outline-variant);
  font-size: 14px;
  font-variant-numeric: tabular-nums;
}

tbody tr:last-child td {
  border-bottom: none;
}

.actions-cell {
  text-align: right;
  white-space: nowrap;
}

.toolbar {
  display: flex;
  gap: 12px;
  align-items: center;
  padding: 16px;
  border-bottom: 1px solid var(--outline-variant);
}

.search {
  flex: 1;
  border: 1px solid var(--outline-variant);
  border-radius: 8px;
  padding: 9px 12px 9px 34px;
  font: 14px "Manrope", sans-serif;
  background: var(--surface-container-lowest) url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='16' height='16' fill='none' stroke='%239a9088' stroke-width='2'%3E%3Ccircle cx='7' cy='7' r='5.5'/%3E%3Cpath d='M11 11l4 4' stroke-linecap='round'/%3E%3C/svg%3E") no-repeat 10px center;
  margin-bottom: 0;
}

/* ---------- Status badges/pills (registrations, participants, events, members) ---------- */

.status-pill {
  display: inline-flex;
  align-items: center;
  font-family: "Manrope", sans-serif;
  font-size: 12px;
  font-weight: 600;
  padding: 4px 12px;
  border-radius: 999px;
}

.status-checked_in {
  background: #dceee0;
  color: var(--success);
}

.status-checked_out {
  background: var(--secondary-container);
  color: var(--secondary);
}

.status-notified {
  background: var(--secondary-container);
  color: var(--secondary);
}

.status-pending {
  background: #fbe6c8;
  color: #8a5a00;
}

.status-confirmed {
  background: var(--primary-container);
  color: var(--primary-deep);
}

.status-cancelled {
  background: var(--gold-container);
  color: var(--on-gold-container);
}

.badge {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font-family: "Manrope", sans-serif;
  font-size: 12px;
  font-weight: 600;
  padding: 4px 12px;
  border-radius: 999px;
}

.badge-active {
  background: #dceee0;
  color: var(--success);
}

.badge-active::before {
  content: "";
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--success);
}

.badge-inactive {
  background: var(--surface-container-high);
  color: var(--on-surface-variant);
}

/* ---------- Character cards, tags, file uploads ---------- */

.char-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 20px;
  margin-bottom: 8px;
}

@media (max-width: 560px) {
  .char-grid {
    grid-template-columns: 1fr;
  }
}

.char-card {
  background: var(--surface-container-low);
  border: 1px solid var(--outline-variant);
  border-radius: 12px;
  padding: 20px;
}

.char-card h3 {
  margin: 0 0 4px;
  font-size: 18px;
}

.char-meta {
  font-size: 13px;
  color: var(--on-surface-variant);
  margin-bottom: 14px;
}

.char-tags {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}

.tag {
  font-size: 11px;
  font-weight: 600;
  background: var(--surface-container-high);
  border: 1px solid var(--outline-variant);
  padding: 3px 10px;
  border-radius: 999px;
  color: var(--on-surface-variant);
}

.sealed {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 11px;
  font-weight: 600;
  color: var(--primary);
  text-transform: none;
  letter-spacing: 0;
}

.char-files {
  margin-top: 14px;
  padding-top: 14px;
  border-top: 1px solid var(--outline-variant);
}

.file-item {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 10px;
}

.file-upload-form {
  margin-top: 10px;
}

.file-upload-form button[type="submit"] {
  padding: 9px 20px;
  font-size: 14px;
  margin-top: 8px;
}

/* ---------- Stats (admin dashboards) ---------- */

.stat-row {
  display: flex;
  gap: 10px;
  margin-bottom: 20px;
  align-items: stretch;
}

.stat {
  background: var(--surface-container-lowest);
  border: 1px solid var(--outline-variant);
  border-radius: 8px;
  padding: 8px 14px;
}

.stat-num {
  font-size: 18px;
  font-weight: 700;
  font-variant-numeric: tabular-nums;
}

.stat-num.forest {
  color: var(--success);
}

.stat-label {
  font-size: 11px;
  color: var(--on-surface-variant);
  text-transform: uppercase;
  letter-spacing: 0.04em;
}

/* ---------- Auth-only bits (login/register) ---------- */

.divider-word {
  display: flex;
  align-items: center;
  gap: 14px;
  color: var(--outline);
  font-size: 12px;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  margin: 28px 0;
}

.divider-word::before,
.divider-word::after {
  content: "";
  flex: 1;
  height: 1px;
  background: var(--outline-variant);
}

.oauth-row {
  display: flex;
  gap: 12px;
}

.oauth-row a {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  border: 1px solid var(--outline-variant);
  background: var(--surface-container-low);
  padding: 11px;
  border-radius: 8px;
  font-size: 14px;
  font-weight: 600;
  color: var(--on-surface);
  text-decoration: none;
}

/* ---------- Status text ---------- */

.error {
  color: var(--error);
  font-size: 13px;
  font-weight: 600;
}

.success {
  color: var(--success);
  font-size: 13px;
  font-weight: 600;
}
```

- [ ] **Step 2: Add sidebar helpers to `frontend/js/nav.js`**

Replace the entire file with:

```js
import { escapeHtml } from './formFields.js';

const MENU_LINKS = [
  { key: 'konto', label: 'Konto', href: '/account.html', icon: 'manage_accounts' },
  { key: 'mitglieder', label: 'Mitglieder', href: '/admin/members.html', icon: 'group' },
  { key: 'events', label: 'Events', href: '/admin/events.html', icon: 'calendar_month' },
  { key: 'checkin', label: 'Check-In', href: '/admin/checkin.html', icon: 'qr_code_scanner' },
];

export function renderNavLinks(account, currentPath) {
  const links = MENU_LINKS.filter((item) => account.menus.includes(item.key));
  if (account.group.key === 'admin') {
    links.push({ key: 'gruppen', label: 'Gruppen', href: '/admin/groups.html', icon: 'groups' });
    links.push({ key: 'einstellungen', label: 'Einstellungen', href: '/admin/settings.html', icon: 'settings' });
    links.push({ key: 'branding', label: 'Branding', href: '/admin/branding.html', icon: 'palette' });
    links.push({ key: 'speicher', label: 'Speicher', href: '/admin/storage.html', icon: 'storage' });
  }
  return links.map(({ href, label, icon }) => {
    const current = href === currentPath ? 'sidebar-nav-item current' : 'sidebar-nav-item';
    return `<a href="${href}" class="${current}"><span class="material-symbols-outlined" aria-hidden="true">${icon}</span><span>${escapeHtml(label)}</span></a>`;
  }).join('');
}

// Renders the sidebar's bottom user-identity block (avatar initials, display
// name, group/role name) -- NOT the logout control, which stays a static,
// already-wired element in each page's own markup so this can be re-rendered
// (e.g. on account.html, alongside the tab-driven nav) without ever
// re-creating -- and so losing the listener on -- the logout button.
export function renderSidebarUser(account) {
  const initials = `${account.firstName?.[0] ?? ''}${account.lastName?.[0] ?? ''}`.toUpperCase();
  return `<div class="sidebar-user">
    <div class="sidebar-user-avatar">${escapeHtml(initials)}</div>
    <div class="sidebar-user-text">
      <p class="sidebar-user-name">${escapeHtml(account.name)}</p>
      <p class="sidebar-user-role">${escapeHtml(account.group.name)}</p>
    </div>
  </div>`;
}

// Wires the mobile hamburger button (#sidebar-toggle) to show/hide #sidebar
// as an overlay, and closes it on an outside click. No-ops if either element
// is missing (keeps this safe to call unconditionally on every page).
export function initSidebarToggle() {
  const toggle = document.getElementById('sidebar-toggle');
  const sidebar = document.getElementById('sidebar');
  if (!toggle || !sidebar) return;
  toggle.addEventListener('click', () => sidebar.classList.toggle('sidebar--open'));
  document.addEventListener('click', (event) => {
    if (!sidebar.classList.contains('sidebar--open')) return;
    if (sidebar.contains(event.target) || toggle.contains(event.target)) return;
    sidebar.classList.remove('sidebar--open');
  });
}
```

- [ ] **Step 3: Wire `frontend/admin/groups.html` to the new sidebar shell**

Change the `<head>` (lines 7-10) from:

```html
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
<link rel="stylesheet" href="/css/everest-registry.css">
```

to:

```html
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=EB+Garamond:ital,wght@0,400..700;1,400..600&family=Manrope:wght@400;500;600;700&display=swap" rel="stylesheet">
<link href="https://fonts.googleapis.com/css2?family=Material+Symbols+Outlined:opsz,wght,FILL,GRAD@20..48,400,0..1,0&display=block" rel="stylesheet">
<link rel="stylesheet" href="/css/sahara.css">
```

Change the sidebar markup (currently `<aside class="sidebar">` … `<div class="sidebar-foot"><a href="#" id="logout-link">Logout</a></div>` … `</aside>`) from:

```html
<div class="app">
  <aside class="sidebar">
    <div class="sidebar-brand">Pakyrion<span>Admin</span></div>
    <nav id="nav-links"></nav>
    <div class="sidebar-foot"><a href="#" id="logout-link">Logout</a></div>
  </aside>
```

to:

```html
<div class="app">
  <aside class="sidebar" id="sidebar">
    <div class="sidebar-top">
      <div class="sidebar-brand">Pakyrion<span>Admin</span></div>
    </div>
    <nav id="nav-links"></nav>
    <div class="sidebar-foot">
      <div id="sidebar-user-info"></div>
      <a href="#" id="logout-link">Logout</a>
    </div>
  </aside>
  <button type="button" id="sidebar-toggle" class="sidebar-toggle" aria-label="Menü öffnen">
    <span class="material-symbols-outlined" aria-hidden="true">menu</span>
  </button>
```

(Note the extra closing consideration: the existing `<div class="main">` line right after stays exactly where it is — you're only inserting the new `#sidebar-toggle` button between `</aside>` and `<div class="main">`, not touching anything past that point.)

In the `<script type="module">` section, change the import line from:

```js
import { renderNavLinks } from '/js/nav.js';
```

to:

```js
import { renderNavLinks, renderSidebarUser, initSidebarToggle } from '/js/nav.js';
```

Add `initSidebarToggle();` once, right after that import (module top level, doesn't need to wait for the account fetch).

Finally, change the bootstrap block from:

```js
try {
  const account = await api.get('/account');
  document.getElementById('nav-links').innerHTML = renderNavLinks(account, window.location.pathname);
  await loadGroups();
} catch (err) {
```

to:

```js
try {
  const account = await api.get('/account');
  document.getElementById('nav-links').innerHTML = renderNavLinks(account, window.location.pathname);
  document.getElementById('sidebar-user-info').innerHTML = renderSidebarUser(account);
  await loadGroups();
} catch (err) {
```

- [ ] **Step 4: Manual verification**

Start the dev server (`docker compose -f docker-compose.dev.yml up`) and open `/admin/groups.html` as an admin user:

1. Sidebar renders white, left-aligned, with the Sahara cream/white look — nav items have icons, current page ("Gruppen") is highlighted.
2. User name + role show at the bottom of the sidebar, above "Logout".
3. Page content (the groups table/cards) renders in the new light theme — no leftover dark-blue Everest styling.
4. Resize the browser below ~900px width (or use a mobile viewport preset): sidebar disappears, a hamburger button appears top-left; clicking it slides the sidebar in as an overlay; clicking outside it (on the content) closes it again.
5. Click "Logout" — still works (confirms the listener attached before the innerHTML swap survived).

- [ ] **Step 5: Commit**

```bash
git add frontend/css/sahara.css frontend/js/nav.js frontend/admin/groups.html
git commit -m "$(cat <<'EOF'
feat: add sahara.css design system + sidebar nav helpers, prove on admin/groups.html

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: Wire the remaining 6 admin pages to the new sidebar shell

**Files:**
- Modify: `frontend/admin/events.html`
- Modify: `frontend/admin/members.html`
- Modify: `frontend/admin/checkin.html`
- Modify: `frontend/admin/storage.html`
- Modify: `frontend/admin/branding.html`
- Modify: `frontend/admin/settings.html`

**Interfaces:**
- Consumes: `sahara.css` (Task 1), `nav.js`'s `renderNavLinks`/`renderSidebarUser`/`initSidebarToggle` (Task 1).
- Produces: nothing further tasks depend on.

This is the exact same edit as Task 1's Step 3, repeated identically across these 6 files — apply it to each:

- [ ] **Step 1: Apply the head/sidebar/script edit to all 6 files**

For **each** of the 6 files, make these 4 changes (identical pattern to Task 1 Step 3; `admin/members.html` has 2-space-deeper indentation than the others and already has the Material Symbols `<link>` — match each file's own existing indentation style, and skip re-adding the Material Symbols link where it's already present):

1. **Font/stylesheet links** — change:
   ```html
   <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
   <link rel="stylesheet" href="/css/everest-registry.css">
   ```
   to (add the Material Symbols line only in the 5 files that don't already have it — every file except `members.html`):
   ```html
   <link href="https://fonts.googleapis.com/css2?family=EB+Garamond:ital,wght@0,400..700;1,400..600&family=Manrope:wght@400;500;600;700&display=swap" rel="stylesheet">
   <link href="https://fonts.googleapis.com/css2?family=Material+Symbols+Outlined:opsz,wght,FILL,GRAD@20..48,400,0..1,0&display=block" rel="stylesheet">
   <link rel="stylesheet" href="/css/sahara.css">
   ```
   For `members.html` specifically, its existing Material Symbols `<link>` (already present, split across 3 lines) stays as-is — only its Inter-font line and its `everest-registry.css` line change, matching the pattern above minus the now-redundant Material Symbols insertion.

2. **Sidebar markup** — change:
   ```html
   <aside class="sidebar">
     <div class="sidebar-brand">Pakyrion<span>Admin</span></div>
     <nav id="nav-links"></nav>
     <div class="sidebar-foot"><a href="#" id="logout-link">Logout</a></div>
   </aside>
   ```
   to:
   ```html
   <aside class="sidebar" id="sidebar">
     <div class="sidebar-top">
       <div class="sidebar-brand">Pakyrion<span>Admin</span></div>
     </div>
     <nav id="nav-links"></nav>
     <div class="sidebar-foot">
       <div id="sidebar-user-info"></div>
       <a href="#" id="logout-link">Logout</a>
     </div>
   </aside>
   <button type="button" id="sidebar-toggle" class="sidebar-toggle" aria-label="Menü öffnen">
     <span class="material-symbols-outlined" aria-hidden="true">menu</span>
   </button>
   ```
   (preserve each file's own indentation level — `members.html`'s block is indented 2 spaces deeper than the other 5).

3. **Import line** — change:
   ```js
   import { renderNavLinks } from '/js/nav.js';
   ```
   to:
   ```js
   import { renderNavLinks, renderSidebarUser, initSidebarToggle } from '/js/nav.js';
   ```
   Add `initSidebarToggle();` once, right after this import line.

4. **Bootstrap block** — every one of these 6 files has a line reading exactly:
   ```js
   document.getElementById('nav-links').innerHTML = renderNavLinks(account, window.location.pathname);
   ```
   Add immediately after it:
   ```js
   document.getElementById('sidebar-user-info').innerHTML = renderSidebarUser(account);
   ```

- [ ] **Step 2: Manual verification**

Spot-check 3 of the 6 pages in the browser (pick ones with different content shapes — e.g. `admin/events.html` (table + form), `admin/checkin.html` (scanner UI), `admin/storage.html` (settings form)):

1. Sidebar renders identically to `admin/groups.html` from Task 1 (same nav, same user info, same icons).
2. Page-specific content (tables, forms, badges) renders correctly in the new light theme.
3. Hamburger/mobile behavior works the same as Task 1's check.
4. Logout still works on each.

- [ ] **Step 3: Commit**

```bash
git add frontend/admin/events.html frontend/admin/members.html frontend/admin/checkin.html frontend/admin/storage.html frontend/admin/branding.html frontend/admin/settings.html
git commit -m "$(cat <<'EOF'
feat: wire remaining admin pages to the sahara sidebar shell

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: `account.html` — Konto/Veranstaltung tabs move into the sidebar

**Files:**
- Modify: `frontend/account.html`

**Interfaces:**
- Consumes: `sahara.css` (Task 1), `nav.js`'s `renderNavLinks`/`renderSidebarUser`/`initSidebarToggle` (Task 1). Does NOT depend on Task 2.
- Produces: nothing further tasks depend on.

- [ ] **Step 1: Replace the file's markup shell**

`frontend/account.html` currently opens with (lines 1-30, up to and including the `#page-tabs` div):

```html
<!DOCTYPE html>
<html lang="de">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Mein Konto – Pakyrion</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=EB+Garamond:ital,wght@0,400..700;1,400..600&family=Work+Sans:wght@400;500;600&display=swap" rel="stylesheet">
<link href="https://fonts.googleapis.com/css2?family=Material+Symbols+Outlined:opsz,wght,FILL,GRAD@20..48,400,0..1,0&display=block" rel="stylesheet">
<link rel="stylesheet" href="/css/chronicle-crest.css">
<script src="https://cdn.jsdelivr.net/npm/qrcode-generator@1/qrcode.min.js"></script>
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

    <div class="tabs" id="page-tabs">
      <button type="button" class="tab-btn active" data-tab="konto-tab">Konto</button>
      <button type="button" class="tab-btn" data-tab="veranstaltung-tab">Veranstaltung</button>
    </div>

    <div class="tab-panel" id="konto-tab">
```

Replace it with:

```html
<!DOCTYPE html>
<html lang="de">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Mein Konto – Pakyrion</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=EB+Garamond:ital,wght@0,400..700;1,400..600&family=Manrope:wght@400;500;600;700&display=swap" rel="stylesheet">
<link href="https://fonts.googleapis.com/css2?family=Material+Symbols+Outlined:opsz,wght,FILL,GRAD@20..48,400,0..1,0&display=block" rel="stylesheet">
<link rel="stylesheet" href="/css/sahara.css">
<script src="https://cdn.jsdelivr.net/npm/qrcode-generator@1/qrcode.min.js"></script>
</head>
<body>
<div class="app">
  <aside class="sidebar" id="sidebar">
    <div class="sidebar-top">
      <div class="brand-seal"></div>
      <div class="sidebar-brand">Pakyrion<span>LARP Management</span></div>
    </div>
    <nav id="nav-links"></nav>
    <div class="sidebar-foot">
      <div class="sidebar-event-badge" id="sidebar-event-badge"></div>
      <div id="sidebar-user-info"></div>
      <button type="button" id="logout-link">
        <span class="material-symbols-outlined" aria-hidden="true">logout</span> Logout
      </button>
    </div>
  </aside>
  <button type="button" id="sidebar-toggle" class="sidebar-toggle" aria-label="Menü öffnen">
    <span class="material-symbols-outlined" aria-hidden="true">menu</span>
  </button>
  <div class="main"><div class="content">

    <div class="tab-panel" id="konto-tab">
```

(`.brand-seal` inside `.sidebar-top` keeps the existing `branding.js`-driven optional-logo-image behavior — `branding.js` already selects `.brand-seal` regardless of where it sits in the document.)

- [ ] **Step 2: Replace the Konto/Veranstaltung tab markup with sidebar nav buttons**

The file's `#veranstaltung-tab` panel currently opens with (right after `konto-tab`'s closing `</div>`):

```html
    <div class="tab-panel" id="veranstaltung-tab" hidden>
      <div class="tabs tabs--sub" id="veranstaltung-subtabs">
        <button type="button" class="tab-btn active" data-tab="anmelden-subtab">Anmelden</button>
        <button type="button" class="tab-btn" data-tab="charaktere-subtab">Charaktere</button>
      </div>

      <div class="tab-panel" id="anmelden-subtab">
```

Change it to (the sub-tab buttons are removed from here — they move into the sidebar in Step 3 — everything else in this block, starting with `<h2>Meine Anmeldungen</h2>`, is untouched):

```html
    <div class="tab-panel" id="veranstaltung-tab" hidden>
      <div class="tab-panel" id="anmelden-subtab">
```

At the very end of the file's markup, right before the `<script type="module">` line, the file currently reads (this exact block, anchored on the unique `<p id="nsc-message"></p>` line so the edit target is unambiguous — plain `</div>` lines alone are not unique in this file):

```html
            <p id="nsc-message"></p>
          </div>
        </div>
      </div>
    </div>
  </div>
</div>

<script type="module">
```

These 6 closing `</div>` tags close, in order: `#nsc-section`, `#nsc-tab`, `#charaktere-subtab`, `#veranstaltung-tab`, `.folio`, `.shell`. Step 1 replaced the two outermost openings (`.shell` + `.folio`, 2 divs) with THREE openings (`.app` + `.main` + `.content`), so the closing side needs one more `</div>` than before. Change the block to:

```html
            <p id="nsc-message"></p>
          </div>
        </div>
      </div>
    </div>
  </div></div>
</div>

<script type="module">
```

(Only the second-to-last line changes, from one `</div>` to two — closing `.content` then `.main` — before the final `</div>` that closes `.app`.)

- [ ] **Step 3: Add the sidebar nav buttons and event-badge script logic**

In the `<script type="module">` section, change the import line:

```js
import { renderNavLinks } from '/js/nav.js';
```

to:

```js
import { renderNavLinks, renderSidebarUser, initSidebarToggle } from '/js/nav.js';
```

Right after the existing `initTabs` function definition and its four `initTabs(...)` calls, add the sidebar-nav-button wiring. Change:

```js
initTabs(document.getElementById('page-tabs'));
initTabs(document.getElementById('veranstaltung-subtabs'));
initTabs(document.getElementById('char-class-tabs'));
initTabs(document.getElementById('nsc-form-tabs'));
```

to:

```js
initTabs(document.getElementById('char-class-tabs'));
initTabs(document.getElementById('nsc-form-tabs'));
initSidebarToggle();

const veranstaltungSubnav = document.createElement('div');
veranstaltungSubnav.className = 'sidebar-nav-nested';
veranstaltungSubnav.id = 'veranstaltung-subnav';
veranstaltungSubnav.hidden = true;
veranstaltungSubnav.innerHTML = `
  <button type="button" class="sidebar-nav-item active" data-tab="anmelden-subtab">Anmelden</button>
  <button type="button" class="sidebar-nav-item" data-tab="charaktere-subtab">Charaktere</button>
`;

function buildSidebarTopTabs() {
  const nav = document.getElementById('nav-links');
  // renderNavLinks() already rendered a real "Konto" link (href="/account.html",
  // from the 'konto' menu key -- account.html is the only page where that key's
  // target IS this page, so it's the one page where this generic link would be
  // redundant with the tab-button below). Remove it before adding the richer
  // tab-driven replacement, so "Konto" doesn't appear twice.
  nav.querySelector('a[href="/account.html"]')?.remove();

  const kontoBtn = document.createElement('button');
  kontoBtn.type = 'button';
  kontoBtn.className = 'sidebar-nav-item active';
  kontoBtn.dataset.tab = 'konto-tab';
  kontoBtn.innerHTML = '<span class="material-symbols-outlined" aria-hidden="true">manage_accounts</span><span>Konto</span>';

  const veranstaltungBtn = document.createElement('button');
  veranstaltungBtn.type = 'button';
  veranstaltungBtn.className = 'sidebar-nav-item';
  veranstaltungBtn.dataset.tab = 'veranstaltung-tab';
  veranstaltungBtn.innerHTML = '<span class="material-symbols-outlined" aria-hidden="true">event</span><span>Veranstaltung</span>';

  nav.prepend(veranstaltungSubnav);
  nav.prepend(veranstaltungBtn);
  nav.prepend(kontoBtn);

  // Deliberately NOT reusing the shared initTabs() helper here: it selects
  // by `.tab-btn`, a class with its own horizontal-underline-tab CSS that
  // would fight `.sidebar-nav-item`'s look if applied to the same button
  // (same selector specificity, source order would decide the winner --
  // fragile). Both toggle groups below use the identical active/hidden
  // mechanics as initTabs, just spelled out against `.sidebar-nav-item`.
  const topButtons = [kontoBtn, veranstaltungBtn];
  topButtons.forEach((btn) => {
    btn.addEventListener('click', () => {
      topButtons.forEach((b) => {
        b.classList.toggle('active', b === btn);
        document.getElementById(b.dataset.tab).hidden = b !== btn;
      });
      veranstaltungSubnav.hidden = btn !== veranstaltungBtn;
    });
  });

  const subButtons = [...veranstaltungSubnav.querySelectorAll('.sidebar-nav-item')];
  subButtons.forEach((btn) => {
    btn.addEventListener('click', () => {
      subButtons.forEach((b) => {
        b.classList.toggle('active', b === btn);
        document.getElementById(b.dataset.tab).hidden = b !== btn;
      });
    });
  });
}
```

Now find the `#no-character-hint-btn` click handler:

```js
document.getElementById('no-character-hint-btn').addEventListener('click', () => {
  document.querySelector('#veranstaltung-subtabs [data-tab="charaktere-subtab"]').click();
});
```

Change the selector (the `#veranstaltung-subtabs` container no longer exists — Step 2 removed it; the same two buttons now live in `veranstaltungSubnav`) to:

```js
document.getElementById('no-character-hint-btn').addEventListener('click', () => {
  document.querySelector('#nav-links [data-tab="veranstaltung-tab"]').click();
  document.querySelector('#veranstaltung-subnav [data-tab="charaktere-subtab"]').click();
});
```

(Clicking the hint button now needs to activate BOTH the outer "Veranstaltung" tab AND the nested "Charaktere" sub-tab, since a user could be sitting on the Konto tab when they hit this — the old code only had to switch the sub-tab because the Veranstaltung tab was already implicitly active in that flow.)

Now change `loadRegistrations()`'s ribbon markup — find:

```js
    <td><span class="ribbon status-${escapeHtml(r.status)}">${escapeHtml(label)}</span></td>
```

change to:

```js
    <td><span class="status-pill status-${escapeHtml(r.status)}">${escapeHtml(label)}</span></td>
```

- [ ] **Step 4: Add the event-badge and sidebar-user rendering to the bootstrap block**

Add a small helper function anywhere above the final bootstrap block (e.g. right after `loadQrCode`'s definition):

```js
function renderEventBadge(qrEvents) {
  const badge = document.getElementById('sidebar-event-badge');
  const activeEvent = qrEvents.find((e) => e.is_active);
  badge.textContent = activeEvent ? activeEvent.name : '';
}
```

Change the final bootstrap block's opening lines. Find:

```js
try {
  const account = await api.get('/account');
  document.getElementById('nav-links').innerHTML = renderNavLinks(account, window.location.pathname);

  for (const field of ['firstName', 'lastName', 'nickname', 'address', 'birthdate', 'phone', 'emergencyContactLastName', 'emergencyContactFirstName', 'emergencyContactPhone', 'medicalNotes']) {
```

Change to:

```js
try {
  const account = await api.get('/account');
  document.getElementById('nav-links').innerHTML = renderNavLinks(account, window.location.pathname);
  buildSidebarTopTabs();
  document.getElementById('sidebar-user-info').innerHTML = renderSidebarUser(account);

  for (const field of ['firstName', 'lastName', 'nickname', 'address', 'birthdate', 'phone', 'emergencyContactLastName', 'emergencyContactFirstName', 'emergencyContactPhone', 'medicalNotes']) {
```

(`buildSidebarTopTabs()` must run AFTER `renderNavLinks`'s `innerHTML` assignment, since it uses `nav.prepend(...)` on that same element — if it ran before, `renderNavLinks`'s `innerHTML =` would wipe it right back out.)

Finally, change the last line of the bootstrap block. Find:

```js
  await loadQrCode(account, events, currentRegistrations);
} catch (err) {
```

Change to:

```js
  await loadQrCode(account, events, currentRegistrations);
  renderEventBadge(events);
} catch (err) {
```

- [ ] **Step 5: Manual verification**

Open `/account.html` in the browser, logged in:

1. Sidebar shows "Konto" and "Veranstaltung" as the first two nav items (above whatever real menu links `renderNavLinks` added), both styled like the admin pages' sidebar items.
2. "Konto" is active by default, its panel shows the OT form.
3. Click "Veranstaltung" — its panel shows, AND two nested items ("Anmelden"/"Charaktere") appear indented under it in the sidebar; "Konto" and its panel hide.
4. Click "Charaktere" (nested) — the Charaktere panel shows, Anmelden's panel hides, both still nested under the visible "Veranstaltung".
5. Click back to "Konto" — the nested Anmelden/Charaktere items disappear again (since Veranstaltung is no longer active), Konto panel shows.
6. On Veranstaltung → Anmelden, pick a role needing a character you don't have (e.g. "SC" with none yet) — the hint button shows; click it — it correctly jumps to Veranstaltung (if you were on Konto) AND selects the Charaktere nested item, showing that panel.
7. If an active event exists, its name shows in the small badge above the user info at the sidebar's bottom.
8. Submit a registration, confirm the status column in "Meine Anmeldungen" renders as a pill (rounded, colored per status) instead of the old ribbon shape.
9. Mobile check: resize below 900px, hamburger appears, opens/closes the sidebar correctly, all the tab-buttons inside it still work while it's open.
10. Reload the page (F5) from a state where Veranstaltung/Charaktere was active — confirms it resets cleanly to Konto on a fresh load (expected, no state persistence across reloads, matches previous behavior).

- [ ] **Step 6: Commit**

```bash
git add frontend/account.html
git commit -m "$(cat <<'EOF'
feat: move account.html's Konto/Veranstaltung tabs into the sidebar

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: `characters-browse.html` — sidebar shell

**Files:**
- Modify: `frontend/characters-browse.html`

**Interfaces:**
- Consumes: `sahara.css`, `nav.js`'s three exports (Task 1). Independent of Tasks 2-3.
- Produces: nothing further tasks depend on.

- [ ] **Step 1: Replace the file's shell**

Current full file (`frontend/characters-browse.html`) opens:

```html
<!DOCTYPE html>
<html lang="de">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Charaktere durchsuchen – Pakyrion</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=EB+Garamond:ital,wght@0,400..700;1,400..600&family=Work+Sans:wght@400;500;600&display=swap" rel="stylesheet">
<link rel="stylesheet" href="/css/chronicle-crest.css">
</head>
<body>
<div class="shell">
  <div class="brand"><div class="brand-seal"></div><div class="brand-name">Pakyrion</div></div>
  <p class="brand-sub">QuestIn LARP Management</p>
  <div class="folio folio--wide">
    <nav class="app-nav" id="nav-links"></nav>
    <a href="#" id="logout-link">Logout</a>
    <h1>Charaktere durchsuchen</h1>
    <p><a href="/account.html">← Zurück zu meinen Charakteren</a></p>
    <label for="event-select">Event</label>
    <select id="event-select"></select>
    <div id="character-list" class="char-grid"></div>
    <p id="message"></p>
  </div>
</div>
```

Replace with:

```html
<!DOCTYPE html>
<html lang="de">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Charaktere durchsuchen – Pakyrion</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=EB+Garamond:ital,wght@0,400..700;1,400..600&family=Manrope:wght@400;500;600;700&display=swap" rel="stylesheet">
<link href="https://fonts.googleapis.com/css2?family=Material+Symbols+Outlined:opsz,wght,FILL,GRAD@20..48,400,0..1,0&display=block" rel="stylesheet">
<link rel="stylesheet" href="/css/sahara.css">
</head>
<body>
<div class="app">
  <aside class="sidebar" id="sidebar">
    <div class="sidebar-top">
      <div class="brand-seal"></div>
      <div class="sidebar-brand">Pakyrion<span>LARP Management</span></div>
    </div>
    <nav id="nav-links"></nav>
    <div class="sidebar-foot">
      <div id="sidebar-user-info"></div>
      <a href="#" id="logout-link">Logout</a>
    </div>
  </aside>
  <button type="button" id="sidebar-toggle" class="sidebar-toggle" aria-label="Menü öffnen">
    <span class="material-symbols-outlined" aria-hidden="true">menu</span>
  </button>
  <div class="main"><div class="content">
    <h1>Charaktere durchsuchen</h1>
    <p><a href="/account.html">← Zurück zu meinen Charakteren</a></p>
    <label for="event-select">Event</label>
    <select id="event-select"></select>
    <div id="character-list" class="char-grid"></div>
    <p id="message"></p>
  </div></div>
</div>
```

- [ ] **Step 2: Update the script**

Change the import line:

```js
import { renderNavLinks } from '/js/nav.js';
```

to:

```js
import { renderNavLinks, renderSidebarUser, initSidebarToggle } from '/js/nav.js';
```

Add `initSidebarToggle();` once, right after that import.

Change the bootstrap block. Find:

```js
try {
  const account = await api.get('/account');
  document.getElementById('nav-links').innerHTML = renderNavLinks(account, window.location.pathname);
  events = await api.get('/events');
```

Change to:

```js
try {
  const account = await api.get('/account');
  document.getElementById('nav-links').innerHTML = renderNavLinks(account, window.location.pathname);
  document.getElementById('sidebar-user-info').innerHTML = renderSidebarUser(account);
  events = await api.get('/events');
```

- [ ] **Step 3: Manual verification**

1. Open `/characters-browse.html` — sidebar renders like the other pages, user info shows, current page isn't highlighted in the nav (it's not one of `MENU_LINKS`, which is correct — it was never a nav destination before either).
2. Pick an event, confirm the character list still renders (tags, cards) in the new theme.
3. "← Zurück zu meinen Charakteren" link still goes to `/account.html`.
4. Logout still works.
5. Mobile hamburger check, same as prior tasks.

- [ ] **Step 4: Commit**

```bash
git add frontend/characters-browse.html
git commit -m "$(cat <<'EOF'
feat: wire characters-browse.html to the sahara sidebar shell

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: Auth pages — recolor only, no sidebar

**Files:**
- Modify: `frontend/login.html`
- Modify: `frontend/register.html`
- Modify: `frontend/reset-password.html`
- Modify: `frontend/set-password.html`
- Modify: `frontend/verify.html`
- Modify: `frontend/index.html`

**Interfaces:**
- Consumes: `sahara.css` (Task 1) — specifically its `.shell`/`.brand`/`.folio--narrow`/`.oauth-row`/`.divider-word` rules, unchanged in shape from the old `chronicle-crest.css`, just new tokens.
- Produces: nothing further tasks depend on.

None of these 6 pages have a sidebar (pre-login) — this task is a pure `<link>`/font swap, no markup restructuring, no script changes.

- [ ] **Step 1: Swap the font and stylesheet links in all 6 files**

For each of the 6 files, change:

```html
<link href="https://fonts.googleapis.com/css2?family=EB+Garamond:ital,wght@0,400..700;1,400..600&family=Work+Sans:wght@400;500;600&display=swap" rel="stylesheet">
<link rel="stylesheet" href="/css/chronicle-crest.css">
```

to:

```html
<link href="https://fonts.googleapis.com/css2?family=EB+Garamond:ital,wght@0,400..700;1,400..600&family=Manrope:wght@400;500;600;700&display=swap" rel="stylesheet">
<link rel="stylesheet" href="/css/sahara.css">
```

(This exact two-line pattern occurs once in each of the 6 files — `verify.html`, `set-password.html`, `index.html`, `reset-password.html`, `register.html`, `login.html` — confirmed identical via grep before writing this task.)

- [ ] **Step 2: Manual verification**

Open `/login.html`: cream background, sienna primary button, EB Garamond heading, Manrope body text, boxed (not underlined) input fields. Confirm the OAuth row and "oder anmelden mit" divider still render sensibly. Spot-check `/register.html` too (has more form fields).

- [ ] **Step 3: Commit**

```bash
git add frontend/login.html frontend/register.html frontend/reset-password.html frontend/set-password.html frontend/verify.html frontend/index.html
git commit -m "$(cat <<'EOF'
feat: recolor auth pages to the sahara design system

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: Delete the old stylesheets, final sweep

**Files:**
- Delete: `frontend/css/chronicle-crest.css`
- Delete: `frontend/css/everest-registry.css`

**Interfaces:**
- Consumes: every prior task (this is the final task — all 15 HTML files must already point at `sahara.css` before this runs).
- Produces: nothing — final task of the plan.

- [ ] **Step 1: Confirm nothing still references the old files**

```bash
grep -rn "chronicle-crest\|everest-registry" frontend/ --include="*.html"
```

Expected: no output. If anything shows up, stop and fix that file's `<link>` first — it means an earlier task missed it.

- [ ] **Step 2: Delete the old stylesheets**

```bash
git rm frontend/css/chronicle-crest.css frontend/css/everest-registry.css
```

- [ ] **Step 3: Full manual sweep**

With the dev server running, click through a representative sample covering every shape of page in the app:

1. `/login.html` → log in → lands on `/account.html`.
2. `/account.html`: full Konto → Veranstaltung → Anmelden → Charaktere flow (repeat the Task 3 checklist once more end-to-end, now that the old CSS is gone — confirms nothing was silently still relying on it).
3. `/characters-browse.html`.
4. `/admin/events.html`, `/admin/members.html`, `/admin/checkin.html` (as an admin/moderator user) — tables, forms, badges, the QR scanner UI.
5. `/admin/groups.html`, `/admin/settings.html`, `/admin/branding.html`, `/admin/storage.html`.
6. Resize to mobile width on at least 2 of the above (one sidebar page, one auth page) and confirm the hamburger/overlay behavior and the auth page's plain responsive stacking both still look right.
7. Toggle browser dark-mode / OS theme if easy to check — this app has no dark-mode media query today (confirm `sahara.css` doesn't accidentally pick one up either; it shouldn't, since none of the rules written in Task 1 reference `prefers-color-scheme`).

- [ ] **Step 4: Run the backend test suite as a smoke check**

```bash
npm test
```

Expected: passes (this plan touches no backend code). If the only failure is `tests/integration/scanLookup.test.js` (or any other single file) with no detail, that's the project's known pre-existing shared-test-DB flake — rerun once to confirm; not something this plan caused.

- [ ] **Step 5: Commit**

```bash
git commit -m "$(cat <<'EOF'
chore: remove chronicle-crest.css and everest-registry.css, fully replaced by sahara.css

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

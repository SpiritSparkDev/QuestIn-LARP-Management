import { isSensitiveField } from './exportCsv.js';
import { isValidEmail } from '../validation.js';

export const MAX_IMPORT_BYTES = 2 * 1024 * 1024;
export const MAX_IMPORT_ROWS = 5000;

// RFC-4180-ish parser: quoted cells, doubled quotes, newlines inside quotes.
// Delimiter is ";" (export format) or "," -- whichever the header line uses more.
export function parseCsv(text) {
  const src = text.replace(/^﻿/, '');
  const header = src.split(/\r?\n/, 1)[0];
  const delim = (header.match(/,/g) ?? []).length > (header.match(/;/g) ?? []).length ? ',' : ';';
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  const endRow = () => { row.push(cell); cell = ''; rows.push(row); row = []; };
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (quoted) {
      if (c === '"' && src[i + 1] === '"') { cell += '"'; i++; } else if (c === '"') quoted = false; else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === delim) { row.push(cell); cell = ''; } else if (c === '\n' || c === '\r') {
      if (c === '\r' && src[i + 1] === '\n') i++;
      endRow();
    } else cell += c;
  }
  if (cell !== '' || row.length) endRow();
  // line = record number (1 = header); only approximate for cells with embedded newlines
  return rows.map((cells, i) => ({ line: i + 1, cells }));
}

// The export prefixes formula-looking text with an apostrophe; strip it again.
// Nothing is ever evaluated -- every cell is stored as plain text.
const cellText = (v) => (/^'[=+\-@\t\r]/.test(v) ? v.slice(1) : v).trim();

const BASE = { nachname: 'lastName', vorname: 'firstName', rufname: 'nickname', 'e-mail': 'email', email: 'email', rolle: 'group' };
const READ_ONLY = new Set(['mitgliedsnummer', 'anzeigename', 'status', 'kontoart', 'verwaltet von', 'discord']);

// Pure analysis: header mapping + per-row validation against the current DB state.
// ctx: { accountSchema, groups: [{id,key,name}], existingByEmail: Map, openInvitationEmails: Set, mayImportSensitive }
export function analyzeImport(csv, ctx) {
  const table = parseCsv(csv);
  if (table.length === 0) return { error: 'Die Datei ist leer.' };
  const [head, ...data] = table;
  const fieldByLabel = new Map();
  for (const f of ctx.accountSchema) {
    fieldByLabel.set(String(f.label ?? f.key).toLowerCase(), f);
    fieldByLabel.set(f.key.toLowerCase(), f);
  }
  const columns = [];
  const ignoredColumns = [];
  head.cells.forEach((raw, idx) => {
    const name = cellText(raw);
    const lower = name.toLowerCase();
    if (BASE[lower]) columns.push({ idx, target: BASE[lower] });
    else if (fieldByLabel.has(lower)) {
      const field = fieldByLabel.get(lower);
      if (isSensitiveField(field) && !ctx.mayImportSensitive) ignoredColumns.push({ column: name, reason: 'Sensibles Feld, dafür fehlt das Recht.' });
      else columns.push({ idx, target: field.key, field });
    } else if (READ_ONLY.has(lower) || lower.startsWith('anmeldung:')) ignoredColumns.push({ column: name, reason: 'Nur im Export enthalten, wird nicht importiert.' });
    else ignoredColumns.push({ column: name, reason: 'Unbekannte Spalte.' });
  });
  if (!columns.some((c) => c.target === 'email')) return { error: 'Die Spalte "E-Mail" fehlt in der Kopfzeile.' };
  if (data.length > MAX_IMPORT_ROWS) return { tooMany: true };

  const seen = new Set();
  const rows = [];
  for (const { line, cells } of data) {
    if (cells.every((c) => c.trim() === '')) continue;
    const values = {};
    for (const { idx, target, field } of columns) {
      const text = cellText(cells[idx] ?? '');
      if (text === '') continue; // blank = leave unchanged
      values[target] = field?.type === 'boolean' ? /^(ja|true|1|x)$/i.test(text) : text;
    }
    const email = (values.email ?? '').toLowerCase();
    const fail = (message) => rows.push({ line, email, status: 'error', message });
    if (!email) { fail('E-Mail fehlt.'); continue; }
    if (!isValidEmail(email)) { fail('Ungültige E-Mail.'); continue; }
    if (seen.has(email)) { fail('E-Mail kommt in der Datei mehrfach vor.'); continue; }
    seen.add(email);
    let groupId;
    if (values.group !== undefined) {
      const wanted = values.group.toLowerCase();
      const g = ctx.groups.find((x) => x.key === wanted || x.name.toLowerCase() === wanted);
      if (!g) { fail(`Unbekannte Rolle "${values.group}".`); continue; }
      groupId = g.id;
    }
    const { group: _g, email: _e, ...rest } = values;
    const existing = ctx.existingByEmail.get(email);
    if (existing) { rows.push({ line, email, status: 'update', userId: existing, groupId, fields: rest }); continue; }
    if (ctx.openInvitationEmails.has(email)) { fail('Für diese E-Mail ist bereits eine Einladung offen.'); continue; }
    if (!rest.firstName || !rest.lastName) { fail('Neues Mitglied: Vorname und Nachname sind Pflicht.'); continue; }
    rows.push({ line, email, status: 'new', groupId, fields: rest });
  }
  const summary = { new: 0, update: 0, error: 0 };
  for (const r of rows) summary[r.status]++;
  return { rows, ignoredColumns, summary };
}

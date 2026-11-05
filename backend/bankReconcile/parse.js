// Bank statement -> incoming credits. Supports CSV (';' / ',' / tab), CAMT.053 XML and MT940.
// Returns [{ date: 'YYYY-MM-DD'|null, amountCents (>0), text, counterparty }]; debits are dropped.
// Throws an Error with a German message when the input is empty or not recognisable.

export function toCents(value) {
  let s = String(value ?? '').replace(/[^\d.,+-]/g, '');
  const sign = s.startsWith('-') ? -1 : 1;
  s = s.replace(/[+-]/g, '');
  const lastComma = s.lastIndexOf(','), lastDot = s.lastIndexOf('.');
  let int = s, frac = '';
  if (lastComma >= 0 || lastDot >= 0) {
    const sep = Math.max(lastComma, lastDot);
    const tail = s.slice(sep + 1);
    // Money never has three decimals, so "1.234" / "1,234" is a thousands separator.
    const thousandsOnly = /^\d{3}$/.test(tail) && sep > 0;
    if (!thousandsOnly) { int = s.slice(0, sep); frac = tail; }
  }
  int = int.replace(/[.,]/g, '');
  if (!/^\d*$/.test(int) || !/^\d*$/.test(frac) || (!int && !frac)) return null;
  return sign * (Number(int || 0) * 100 + Number((frac + '00').slice(0, 2)));
}

function toIsoDate(value) {
  const s = String(value ?? '').trim();
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = s.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4}|\d{2})\b/);
  if (m) return `${m[3].length === 2 ? `20${m[3]}` : m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  return null;
}

// ---- CAMT.053 -------------------------------------------------------------------------
const decodeXml = (s) => s
  .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
  .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
  .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
const squash = (s) => s.replace(/\s+/g, ' ').trim();
const P = String.raw`(?:[\w.-]+:)?`; // optional namespace prefix

function parseCamt(xml) {
  const entries = [];
  for (const [ntry] of xml.matchAll(new RegExp(String.raw`<${P}Ntry\b[\s\S]*?</${P}Ntry>`, 'g'))) {
    const amt = ntry.match(new RegExp(String.raw`<${P}Amt\b[^>]*>([^<]*)<`));
    const ind = ntry.match(new RegExp(String.raw`<${P}CdtDbtInd>\s*(\w+)`));
    if (!amt || ind?.[1] !== 'CRDT' || new RegExp(String.raw`<${P}RvslInd>\s*true`, 'i').test(ntry)) continue;
    const amountCents = toCents(amt[1]);
    if (!amountCents || amountCents <= 0) continue;
    const date = ntry.match(new RegExp(String.raw`<${P}BookgDt>\s*<${P}(?:Dt|DtTm)>([^<]*)<`));
    const text = [...ntry.matchAll(new RegExp(String.raw`<${P}Ustrd>([\s\S]*?)</${P}Ustrd>`, 'g'))].map((m) => squash(decodeXml(m[1]))).filter(Boolean).join(' ');
    const name = ntry.match(new RegExp(String.raw`<${P}Dbtr>[\s\S]*?<${P}Nm>([^<]*)<`));
    entries.push({ date: toIsoDate(date?.[1]), amountCents, text, counterparty: name ? squash(decodeXml(name[1])) : '' });
  }
  return entries;
}

// ---- CSV ------------------------------------------------------------------------------
function parseCsvRows(text, delimiter) {
  const rows = [];
  let row = [], cell = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else quoted = false; } else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === delimiter) { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(cell); cell = '';
      if (row.some((v) => v.trim())) rows.push(row);
      row = [];
    } else cell += c;
  }
  row.push(cell);
  if (row.some((v) => v.trim())) rows.push(row);
  return rows;
}

const norm = (h) => h.toLowerCase().replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss').trim();
const COLUMNS = {
  amount: /^(betrag|amount|umsatz$)/,
  text: /verwendungszweck|buchungstext|^zweck|reference|description|beschreibung/,
  date: /^(buchungstag|buchungsdatum|datum|valuta|date)/,
  who: /beguenstigter|zahlungspflichtiger|auftraggeber|^name|zahlungsbeteiligter/,
};
const findCols = (header, re) => header.map((h, i) => (re.test(norm(h)) ? i : -1)).filter((i) => i >= 0);

function parseCsv(text) {
  for (const delimiter of [';', '\t', ',']) {
    const rows = parseCsvRows(text, delimiter);
    const at = rows.findIndex((r) => findCols(r, COLUMNS.amount).length && findCols(r, COLUMNS.text).length);
    if (at < 0) continue;
    const header = rows[at];
    const [amountCol] = findCols(header, COLUMNS.amount);
    const textCols = findCols(header, COLUMNS.text), whoCols = findCols(header, COLUMNS.who);
    // Booking date wins over value date: order by the priority of the name, not the column position.
    const dateCols = findCols(header, COLUMNS.date).sort((a, b) => /valuta/.test(norm(header[a])) - /valuta/.test(norm(header[b])));
    const entries = [];
    for (const r of rows.slice(at + 1)) {
      const amountCents = toCents(r[amountCol]);
      if (!amountCents || amountCents <= 0) continue;
      entries.push({
        date: dateCols.length ? toIsoDate(r[dateCols[0]]) : null,
        amountCents,
        text: squash(textCols.map((i) => r[i] ?? '').join(' ')),
        counterparty: squash(whoCols.map((i) => r[i] ?? '').join(' ')),
      });
    }
    return entries;
  }
  throw new Error('Die Kopfzeile mit Betrags- und Verwendungszweck-Spalte wurde nicht gefunden. Unterstützt werden CSV, CAMT.053 (XML) und MT940.');
}

// ---- MT940 ----------------------------------------------------------------------------
// :61: = statement line (YYMMDD[MMDD]C|D|RC|RD[funds code]amount...), :86: = details of that line.
// Structured :86: carries subfields "?NN"; purpose lines ?20-?29 / ?60-?63 are fixed-width and
// wrap mid-word, so they are joined WITHOUT a separator.
const LINE61 = /^(\d{2})(\d{2})(\d{2})(\d{4})?(R?)([CD])[A-Z]?(\d+,\d*)/;

function mt940Date(yy, mm, dd, bookMmdd) {
  let year = 2000 + Number(yy);
  if (bookMmdd) { // booking date has no year: take the value-date year, fix a year-end wrap
    const diff = Number(bookMmdd.slice(0, 2)) - Number(mm);
    if (diff < -6) year++; else if (diff > 6) year--;
    return `${year}-${bookMmdd.slice(0, 2)}-${bookMmdd.slice(2)}`;
  }
  return `${year}-${mm}-${dd}`;
}

function parseMt940Details(raw) {
  if (!/\?\d\d/.test(raw)) return { text: squash(raw.replace(/\r?\n/g, ' ')), counterparty: '' };
  const parts = raw.replace(/\r?\n/g, '').split(/\?(\d\d)/); // [pre, '00', val, '20', val, ...]
  const sub = {};
  for (let i = 1; i < parts.length; i += 2) sub[parts[i]] = (sub[parts[i]] ?? '') + parts[i + 1];
  const join = (from, to) => Array.from({ length: to - from + 1 }, (_, k) => sub[String(from + k)] ?? '').join('');
  const n1 = sub['32'] ?? '', n2 = sub['33'] ?? '';
  return { text: squash(join(20, 29) + join(60, 63)), counterparty: squash(n1.length >= 27 ? n1 + n2 : `${n1} ${n2}`) };
}

function parseMt940(input) {
  const fields = []; // [tag, value]
  for (const line of input.split(/\r?\n/)) {
    const m = line.match(/^:(\d{2}[A-Z]?):(.*)$/);
    if (m) fields.push([m[1], m[2]]);
    else if (fields.length && !/^-}?$/.test(line.trim())) fields[fields.length - 1][1] += `\n${line}`;
  }
  const entries = [];
  fields.forEach(([tag, value], i) => {
    if (tag !== '61') return;
    const m = value.match(LINE61);
    if (!m || m[5] || m[6] !== 'C') return; // debits and reversals (RC/RD) are not incoming money
    const amountCents = toCents(m[7]);
    if (!amountCents || amountCents <= 0) return;
    const next = fields[i + 1];
    entries.push({ date: mt940Date(m[1], m[2], m[3], m[4]), amountCents, ...(next?.[0] === '86' ? parseMt940Details(next[1]) : { text: '', counterparty: '' }) });
  });
  return entries;
}

export function parseStatement(input) {
  const text = String(input ?? '').replace(/^﻿/, '').trim();
  if (!text) throw new Error('Der Kontoauszug ist leer.');
  if (text.startsWith('<') || /BkToCstmrStmt|Ntry/.test(text.slice(0, 5000))) {
    if (!/Ntry/.test(text)) throw new Error('Im XML wurden keine Buchungen (Ntry) gefunden. Erwartet wird CAMT.053.');
    return parseCamt(text);
  }
  if (/^:(20|25|60F|61):/m.test(text.slice(0, 5000))) return parseMt940(text);
  return parseCsv(text);
}

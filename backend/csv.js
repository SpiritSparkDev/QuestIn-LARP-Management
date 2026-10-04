// CSV helpers for the member export (German Excel conventions: ";" separator, UTF-8 with BOM).

// Spreadsheet programs run cells starting with = + - @ (or a tab/CR) as
// formulas -- names and notes come from users, so such cells are prefixed
// with an apostrophe to stay plain text.
function neutralizeFormula(text) {
  return /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
}

export function csvCell(value) {
  if (value === null || value === undefined) return '';
  let text = Array.isArray(value) ? value.join(', ') : typeof value === 'boolean' ? (value ? 'Ja' : 'Nein') : String(value);
  text = neutralizeFormula(text);
  return /[";\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

// columns: [{ label, value: (row) => any }]
export function toCsv(rows, columns) {
  const lines = [columns.map((c) => csvCell(c.label)).join(';')];
  for (const row of rows) lines.push(columns.map((c) => csvCell(c.value(row))).join(';'));
  return `﻿${lines.join('\r\n')}\r\n`;
}

// CSV export helpers (German Excel conventions: ";" separator, UTF-8 with BOM).

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

export function downloadCsv(filename, csvText) {
  const url = URL.createObjectURL(new Blob([csvText], { type: 'text/csv;charset=utf-8' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

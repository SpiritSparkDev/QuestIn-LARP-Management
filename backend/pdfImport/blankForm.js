import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';

const PAGE = [595.28, 841.89];
const MARGIN = 50;
const LABEL_W = 190;
const ROW_H = 22;

// Helvetica (WinAnsi) can't encode every character -- replace the rest.
const clean = (text) => String(text ?? '').replace(/[^\x20-\x7E -ÿ€„“”‚‘’–—…•]/g, '?');

// Builds a blank, fillable AcroForm PDF from the field sections
// ([{ title, fields: [{ label, type, options }] }]). Field names are the
// labels, so uploading it back as the import template auto-maps via
// suggestMapping. Returns the PDF bytes.
// With basePdf (a fillable PDF), its pages and fields are kept and only the
// app fields it doesn't have yet (matched by normalized name) are appended
// on new pages.
export async function buildBlankForm(title, sections, basePdf) {
  const doc = basePdf ? await PDFDocument.load(basePdf, { ignoreEncryption: true }) : await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const form = doc.getForm();
  const norm = (t) => String(t).toLowerCase().replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss').replace(/[^a-z0-9]/g, '');
  const taken = new Set(form.getFields().map((f) => f.getName()));
  const existing = new Set([...taken].map(norm));
  // Loose: the base calls it "Contage" where the schema says "Con-Tage des Spielers".
  // A bare "Name" in the base means the surname.
  const matches = (a, b) => a === b || (a === 'name' && b === 'nachname')
    || (Math.min(a.length, b.length) >= 5 && (a.includes(b) || b.includes(a)));
  if (basePdf) {
    sections = sections.map((s) => ({ ...s, fields: s.fields.filter((f) => ![...existing].some((e) => matches(e, norm(f.label)))) }));
    if (sections.every((s) => s.fields.length === 0)) return doc.save();
  }
  let page = doc.addPage(PAGE);
  let y = PAGE[1] - MARGIN;

  const ensure = (height) => {
    if (y - height >= MARGIN) return;
    page = doc.addPage(PAGE);
    y = PAGE[1] - MARGIN;
  };
  const uniqueName = (label) => {
    let name = clean(label); let n = 2;
    while (taken.has(name)) name = `${clean(label)} (${n++})`;
    taken.add(name);
    return name;
  };

  page.drawText(clean(basePdf ? 'Weitere Angaben' : title), { x: MARGIN, y: y - 18, size: 20, font: bold });
  y -= 44;

  for (const { title: heading, fields } of sections) {
    if (fields.length === 0) continue;
    ensure(60);
    y -= 10;
    page.drawText(clean(heading), { x: MARGIN, y: y - 12, size: 13, font: bold, color: rgb(0.3, 0.2, 0.1) });
    y -= 24;
    for (const field of fields) {
      const multiline = field.type === 'textarea' || field.type === 'document';
      const height = multiline ? ROW_H * 3 : ROW_H;
      ensure(height + 6);
      const label = field.type === 'multiselect' && field.options?.length
        ? `${field.label} (${field.options.join(', ')})` : field.label;
      page.drawText(clean(label).slice(0, 38), { x: MARGIN, y: y - 14, size: 9.5, font, maxWidth: LABEL_W - 8 });
      const box = { x: MARGIN + LABEL_W, y: y - height + 2, width: PAGE[0] - 2 * MARGIN - LABEL_W, height: height - 4 };
      const name = uniqueName(field.label);
      if (field.type === 'boolean') {
        const check = form.createCheckBox(name);
        check.addToPage(page, { ...box, width: 14, height: 14, borderWidth: 1 });
      } else if (field.type === 'select' && field.options?.length) {
        const dropdown = form.createDropdown(name);
        dropdown.addOptions(field.options.map(clean));
        dropdown.addToPage(page, { ...box, font, borderWidth: 1 });
      } else {
        const text = form.createTextField(name);
        if (multiline) text.enableMultiline();
        text.addToPage(page, { ...box, font, borderWidth: 1 });
      }
      y -= height;
    }
  }
  form.updateFieldAppearances(font);
  return doc.save();
}

import {
  PDFDocument, StandardFonts, rgb, pushGraphicsState, popGraphicsState, rectangle, clip, endPath,
} from 'pdf-lib';

const PAGE = [595.28, 841.89];

// Look of each sample. columns = how many fields sit side by side.
export const TEMPLATES = {
  klassisch: {
    name: 'Klassisch', description: 'Serifenschrift, eine Spalte, warme Akzentfarbe.',
    font: ['TimesRoman', 'TimesRomanBold'], accent: [0.62, 0.30, 0.11], columns: 1, margin: 56, heading: 'rule', size: 10.5,
  },
  modern: {
    name: 'Modern', description: 'Serifenlos, zwei Spalten, farbige Abschnittsbalken.',
    font: ['Helvetica', 'HelveticaBold'], accent: [0.10, 0.34, 0.42], columns: 2, margin: 50, heading: 'band', size: 10,
  },
  schlicht: {
    name: 'Schlicht', description: 'Schwarz-weiß, zwei Spalten, druckfreundlich.',
    font: ['Helvetica', 'HelveticaBold'], accent: [0.1, 0.1, 0.1], columns: 2, margin: 50, heading: 'rule', size: 10,
  },
  kompakt: {
    name: 'Kompakt', description: 'Drei Spalten, kleine Schrift, möglichst wenige Seiten.',
    font: ['Helvetica', 'HelveticaBold'], accent: [0.45, 0.22, 0.22], columns: 3, margin: 40, heading: 'band', size: 8.5,
  },
};

// Helvetica/Times (WinAnsi) can't encode every character -- replace the rest.
const clean = (text) => String(text ?? '').replace(/[^\x20-\x7E -ÿ€„“”‚‘’–—…•]/g, '?');

async function embedImage(doc, image) {
  if (!image) return null;
  try {
    if (image.mimeType === 'image/png') return await doc.embedPng(image.data);
    if (image.mimeType === 'image/jpeg') return await doc.embedJpg(image.data);
  } catch { /* unreadable image: leave it out */ }
  return null; // webp can't be embedded by pdf-lib
}

function wrap(font, text, size, width) {
  const lines = [];
  let line = '';
  for (const word of clean(text).split(/\s+/)) {
    const next = line ? `${line} ${word}` : word;
    if (line && font.widthOfTextAtSize(next, size) > width) { lines.push(line); line = word; } else line = next;
  }
  if (line) lines.push(line);
  return lines;
}

function fit(font, text, size, width) {
  let t = clean(text);
  while (t.length > 1 && font.widthOfTextAtSize(t, size) > width) t = `${t.slice(0, -2)}…`;
  return t;
}

// Builds a fillable AcroForm PDF: cover page (logo + ticket motif), then the
// field sections. Field names are the labels, so uploading it back as the
// import template auto-maps via suggestMapping.
// sections: [{ title, fields: [{ label, type, options }] }]
// opts: { template, title, subtitle, logo, motif } -- logo/motif: { data, mimeType }
export async function buildBlankForm(sections, { template = 'klassisch', title = 'Anmeldung', subtitle = '', logo, motif } = {}) {
  const t = TEMPLATES[template] ?? TEMPLATES.klassisch;
  const accent = rgb(...t.accent);
  const grey = rgb(0.38, 0.38, 0.38);
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts[t.font[0]]);
  const bold = await doc.embedFont(StandardFonts[t.font[1]]);
  const logoImg = await embedImage(doc, logo);
  const motifImg = await embedImage(doc, motif);
  const form = doc.getForm();
  const taken = new Set();
  const uniqueName = (label) => {
    // A period starts a sub-field in AcroForm names ("Ende." is invalid), and an empty name is too.
    const base = clean(label).replace(/\./g, '·').trim() || 'Feld';
    let name = base; let n = 2;
    while (taken.has(name)) name = `${base} (${n++})`;
    taken.add(name);
    return name;
  };

  const M = t.margin;
  const W = PAGE[0] - 2 * M;
  const TOP = PAGE[1] - 70;
  const BOTTOM = 56;

  const drawLogo = (page, x, yTop, maxH, maxW) => {
    if (!logoImg) return 0;
    const s = Math.min(maxH / logoImg.height, maxW / logoImg.width);
    page.drawImage(logoImg, { x, y: yTop - logoImg.height * s, width: logoImg.width * s, height: logoImg.height * s });
    return logoImg.width * s;
  };

  // ---- cover page ----
  const cover = doc.addPage(PAGE);
  cover.drawRectangle({ x: 0, y: PAGE[1] - 110, width: PAGE[0], height: 110, color: rgb(0.97, 0.95, 0.92) });
  cover.drawRectangle({ x: 0, y: PAGE[1] - 114, width: PAGE[0], height: 4, color: accent });
  const logoW = drawLogo(cover, M, PAGE[1] - 24, 62, 200);
  const brand = clean(subtitle || title);
  cover.drawText(fit(bold, brand, 16, W - logoW - 20), { x: M + logoW + (logoW ? 16 : 0), y: PAGE[1] - 62, size: 16, font: bold, color: accent });
  const boxH = 380;
  const boxTop = PAGE[1] - 150;
  if (motifImg) {
    const s = Math.max(W / motifImg.width, boxH / motifImg.height);
    const w = motifImg.width * s; const h = motifImg.height * s;
    cover.pushOperators(pushGraphicsState(), rectangle(M, boxTop - boxH, W, boxH), clip(), endPath());
    cover.drawImage(motifImg, { x: M + (W - w) / 2, y: boxTop - boxH + (boxH - h) / 2, width: w, height: h });
    cover.pushOperators(popGraphicsState());
    cover.drawRectangle({ x: M, y: boxTop - boxH, width: W, height: boxH, borderColor: accent, borderWidth: 1.5 });
  } else {
    cover.drawRectangle({ x: M, y: boxTop - boxH, width: W, height: boxH, color: accent });
  }
  cover.drawText(clean(title), { x: M, y: boxTop - boxH - 56, size: 34, font: bold, color: accent });
  if (subtitle) cover.drawText(fit(font, subtitle, 16, W), { x: M, y: boxTop - boxH - 80, size: 16, font, color: grey });
  const intro = wrap(font, 'Bitte alle Felder gut lesbar ausfüllen. Das Formular lässt sich am Computer ausfüllen und danach speichern oder ausdrucken.', 11, W);
  intro.forEach((line, i) => cover.drawText(line, { x: M, y: boxTop - boxH - 108 - i * 15, size: 11, font, color: grey }));

  // ---- content pages ----
  let page; let y; let col; let rowTop; let rowH;
  const newPage = () => {
    page = doc.addPage(PAGE);
    const w = drawLogo(page, M, PAGE[1] - 22, 26, 110);
    const label = fit(bold, title, 11, W - w - 12);
    page.drawText(label, { x: PAGE[0] - M - bold.widthOfTextAtSize(label, 11), y: PAGE[1] - 40, size: 11, font: bold, color: accent });
    page.drawLine({ start: { x: M, y: PAGE[1] - 52 }, end: { x: PAGE[0] - M, y: PAGE[1] - 52 }, thickness: 0.8, color: accent });
    y = TOP; col = 0; rowTop = y; rowH = 0;
  };
  const flush = () => { if (col > 0 || rowH > 0) y = rowTop - rowH - 10; col = 0; rowTop = y; rowH = 0; };
  newPage();

  const gap = 14;
  const colW = (W - (t.columns - 1) * gap) / t.columns;
  const S = t.size;

  for (const { title: heading, fields } of sections) {
    if (fields.length === 0) continue;
    flush();
    if (y - 70 < BOTTOM) { newPage(); }
    y -= 8;
    if (t.heading === 'band') {
      page.drawRectangle({ x: M, y: y - 20, width: W, height: 20, color: accent });
      page.drawText(clean(heading), { x: M + 8, y: y - 14, size: 11, font: bold, color: rgb(1, 1, 1) });
    } else {
      page.drawText(clean(heading), { x: M, y: y - 14, size: 13, font: bold, color: accent });
      page.drawLine({ start: { x: M, y: y - 20 }, end: { x: M + W, y: y - 20 }, thickness: 1, color: accent });
    }
    y -= 34; col = 0; rowTop = y; rowH = 0;

    for (const field of fields) {
      const area = field.type === 'textarea' || field.type === 'document';
      const multi = field.type === 'multiselect' && field.options?.length;
      const check = field.type === 'boolean';
      const span = (area || multi || check) ? t.columns : 1;
      const w = span * colW + (span - 1) * gap;
      const lh = S + 3;
      const labelLines = check ? wrap(font, field.label, S, w - 22) : [];
      const hint = multi ? wrap(font, `(${field.options.join(', ')})`, S - 1.5, w) : [];
      const boxH = area ? 64 : check ? Math.max(13, labelLines.length * lh) : 20;
      const itemH = check ? boxH : lh + 4 + hint.length * (lh - 1) + boxH;

      if (col + span > t.columns) { const bottom = rowTop - rowH - 10; col = 0; rowTop = bottom; rowH = 0; y = bottom; }
      if (rowTop - itemH < BOTTOM) { newPage(); }
      const x = M + col * (colW + gap);
      const name = uniqueName(field.label);
      let boxY;
      if (check) {
        boxY = rowTop - 13;
        form.createCheckBox(name).addToPage(page, { x, y: boxY, width: 13, height: 13, borderWidth: 1, borderColor: accent });
        labelLines.forEach((line, i) => page.drawText(line, { x: x + 22, y: rowTop - 10 - i * lh, size: S, font, color: rgb(0.1, 0.1, 0.1) }));
      } else {
        page.drawText(fit(bold, field.label, S - 1, w), { x, y: rowTop - S, size: S - 1, font: bold, color: grey });
        hint.forEach((line, i) => page.drawText(line, { x, y: rowTop - S - 2 - (i + 1) * (lh - 1), size: S - 1.5, font, color: grey }));
        boxY = rowTop - itemH;
        const opts = { x, y: boxY, width: w, height: boxH, font, borderWidth: 0.8, borderColor: accent, backgroundColor: rgb(0.99, 0.98, 0.96) };
        if (field.type === 'select' && field.options?.length) {
          const dd = form.createDropdown(name);
          dd.addOptions(field.options.map(clean));
          dd.addToPage(page, opts);
        } else {
          const tf = form.createTextField(name);
          if (area) tf.enableMultiline();
          tf.addToPage(page, opts);
        }
      }
      rowH = Math.max(rowH, itemH);
      col += span;
    }
  }

  // footer with page numbers on the content pages
  const pages = doc.getPages();
  pages.slice(1).forEach((p, i) => {
    const text = `Seite ${i + 2} von ${pages.length}`;
    p.drawText(text, { x: PAGE[0] - M - font.widthOfTextAtSize(text, 8), y: 30, size: 8, font, color: grey });
  });
  form.updateFieldAppearances(font);
  return doc.save();
}

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PDFDocument } from 'pdf-lib';

const { readPdfFields, applyMapping } = await import('../../backend/pdfImport/pdfFields.js');

async function makeFormPdf() {
  const doc = await PDFDocument.create();
  const page = doc.addPage();
  const form = doc.getForm();
  const name = form.createTextField('Name');
  name.addToPage(page, { x: 10, y: 700 });
  name.setText('Busch');
  const email = form.createTextField('Email');
  email.addToPage(page, { x: 10, y: 650 });
  email.setText('a@example.com');
  const check = form.createCheckBox('Datenschutz1');
  check.addToPage(page, { x: 10, y: 600 });
  check.check();
  const radio = form.createRadioGroup('Rolle');
  radio.addOptionToPage('Auswahl1', page, { x: 10, y: 550 });
  radio.addOptionToPage('Auswahl2', page, { x: 40, y: 550 });
  radio.select('Auswahl2');
  return Buffer.from(await doc.save());
}

test('readPdfFields reads text, checkbox and radio values with their types', async () => {
  const fields = await readPdfFields(await makeFormPdf());
  const byName = Object.fromEntries(fields.map((f) => [f.name, f]));
  assert.equal(byName.Name.value, 'Busch');
  assert.equal(byName.Name.type, 'text');
  assert.equal(byName.Datenschutz1.value, true);
  assert.equal(byName.Rolle.type, 'radio');
  assert.deepEqual(byName.Rolle.options, ['Auswahl1', 'Auswahl2']);
  assert.equal(byName.Rolle.value, 'Auswahl2');
});

test('readPdfFields rejects non-PDF data and PDFs without form fields', async () => {
  await assert.rejects(() => readPdfFields(Buffer.from('not a pdf')), { code: 'INVALID_PDF' });
  const empty = await PDFDocument.create();
  empty.addPage();
  const emptyBytes = Buffer.from(await empty.save());
  await assert.rejects(() => readPdfFields(emptyBytes), { code: 'INVALID_PDF' });
});

test('applyMapping groups values by target, translates option labels and skips empty/unmapped fields', async () => {
  const fields = await readPdfFields(await makeFormPdf());
  const { raw, mapped } = applyMapping(fields, {
    Name: { target: 'account:lastName' },
    Email: { target: 'sender:email' },
    Rolle: { target: 'registration:rolle', optionLabels: { Auswahl1: 'Spieler', Auswahl2: 'NSC' } },
    Datenschutz1: { target: 'registration:datenschutz' },
  });
  assert.equal(raw.Name, 'Busch');
  assert.equal(mapped.account.lastName, 'Busch');
  assert.equal(mapped.sender.email, 'a@example.com');
  assert.equal(mapped.registration.rolle, 'NSC');
  assert.equal(mapped.registration.datenschutz, true);
});

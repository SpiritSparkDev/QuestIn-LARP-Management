import {
  PDFDocument, PDFTextField, PDFCheckBox, PDFRadioGroup, PDFDropdown, PDFOptionList,
} from 'pdf-lib';

// Reads every fillable form field of an AcroForm PDF. Buttons and signature
// fields carry no submitted data and are skipped. Throws an error with
// code 'INVALID_PDF' if the buffer isn't a readable PDF or has no form.
export async function readPdfFields(buffer) {
  let doc;
  try {
    doc = await PDFDocument.load(buffer, { ignoreEncryption: true });
  } catch {
    const err = new Error('Die Datei ist kein lesbares PDF.');
    err.code = 'INVALID_PDF';
    throw err;
  }
  const fields = [];
  for (const field of doc.getForm().getFields()) {
    const name = field.getName();
    if (field instanceof PDFTextField) {
      fields.push({ name, type: 'text', options: [], value: field.getText() ?? '' });
    } else if (field instanceof PDFCheckBox) {
      fields.push({ name, type: 'checkbox', options: [], value: field.isChecked() });
    } else if (field instanceof PDFRadioGroup) {
      fields.push({ name, type: 'radio', options: field.getOptions(), value: field.getSelected() ?? '' });
    } else if (field instanceof PDFDropdown) {
      fields.push({ name, type: 'dropdown', options: field.getOptions(), value: field.getSelected().join(', ') });
    } else if (field instanceof PDFOptionList) {
      fields.push({ name, type: 'dropdown', options: field.getOptions(), value: field.getSelected().join(', ') });
    }
  }
  if (fields.length === 0) {
    const err = new Error('Das PDF enthält keine ausfüllbaren Formularfelder.');
    err.code = 'INVALID_PDF';
    throw err;
  }
  return fields;
}

// Applies the admin's mapping ({ [pdfFieldName]: { target, optionLabels? } })
// to the values read from one PDF. Targets look like "account:phone",
// "registration:contage", "character:name" or "sender:email". Radio/dropdown
// values go through optionLabels first (PDF export values like "Auswahl1"
// carry no meaning on their own). Returns { raw, mapped }.
export function applyMapping(fields, mapping) {
  const raw = {};
  const mapped = { account: {}, registration: {}, character: {}, sender: {} };
  for (const field of fields) {
    raw[field.name] = field.value;
    const rule = mapping?.[field.name];
    if (!rule?.target) continue;
    const [group, key] = rule.target.split(':');
    if (!mapped[group] || !key) continue;
    let value = field.value;
    if (typeof value === 'string' && rule.optionLabels && value in rule.optionLabels) {
      value = rule.optionLabels[value] || value;
    }
    if (value === '' || value === false) continue;
    mapped[group][key] = value;
  }
  return { raw, mapped };
}

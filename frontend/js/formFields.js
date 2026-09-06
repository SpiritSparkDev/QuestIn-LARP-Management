// OT (out-of-time) member fields: the encrypted, personal data columns a
// group's account_fields permission can grant access to.
export const ACCOUNT_FIELD_LABELS = {
  address: 'Adresse', birthdate: 'Geburtsdatum', phone: 'Telefon',
  emergencyContactLastName: 'Notfallkontakt: Name', emergencyContactFirstName: 'Notfallkontakt: Vorname', emergencyContactPhone: 'Notfallkontakt: Telefonnummer',
  medicalNotes: 'Gesundheitshinweise',
  conTage: 'Con-Tage des Spielers',
  accommodation: 'Unterbringung (Hütte/IT-Zelt/OT-Zelt, Anzahl, qm)',
  craftOffer: 'Angebotenes Handwerk',
  travelMethod: 'Anreise (Auto/Motorrad, Bahn, muss abgeholt werden)',
  dataSharingOptOut: 'Daten nicht an andere Teilnehmer weitergeben (Ja/Nein)',
  photoOptOut: 'Keine Fotoveröffentlichung (Ja/Nein)',
};

// Formats a character (IT) custom-field value for display, e.g. as a
// checkin-table cell or a browse-page tag. Returns undefined for values that
// shouldn't be shown at all (empty/absent).
export function formatFieldValue(field, rawValue) {
  if (rawValue === undefined || rawValue === null || rawValue === '') return undefined;
  if (Array.isArray(rawValue)) return rawValue.length > 0 ? rawValue.join(', ') : undefined;
  if (typeof rawValue === 'boolean') return rawValue ? 'Ja' : undefined;
  return rawValue;
}

export function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[ch]));
}

export function attachBirthdateFormatter(inputEl) {
  inputEl.addEventListener('input', () => {
    const digits = inputEl.value.replace(/\D/g, '').slice(0, 8);
    let formatted = digits.slice(0, 2);
    if (digits.length > 2) formatted += `.${digits.slice(2, 4)}`;
    if (digits.length > 4) formatted += `.${digits.slice(4, 8)}`;
    inputEl.value = formatted;
  });
}

export function renderField(field, value) {
  const val = escapeHtml(value);
  const label = escapeHtml(field.label ?? field.key);
  const key = escapeHtml(field.key);
  const required = field.required ? 'required' : '';
  const id = `field-${key}`;

  if (field.type === 'boolean') {
    const checked = value ? ' checked' : '';
    return `<label for="${id}"><input id="${id}" name="${key}" type="checkbox"${checked}> ${label}</label>`;
  }
  if (field.type === 'multiselect' && Array.isArray(field.options)) {
    const selected = Array.isArray(value) ? value : [];
    const checkboxes = field.options.map((opt, i) => {
      const escapedOpt = escapeHtml(opt);
      const checked = selected.includes(opt) ? ' checked' : '';
      return `<label for="${id}-${i}"><input id="${id}-${i}" name="${key}" type="checkbox" value="${escapedOpt}"${checked}> ${escapedOpt}</label>`;
    }).join('');
    return `<span>${label}</span>${checkboxes}`;
  }
  if (field.type === 'number') {
    return `<input id="${id}" name="${key}" type="number" value="${val}" ${required}><label for="${id}">${label}</label>`;
  }
  if (field.type === 'link') {
    return `<input id="${id}" name="${key}" type="url" value="${val}" ${required}><label for="${id}">${label}</label>`;
  }
  if (field.type === 'textarea') {
    return `<textarea id="${id}" name="${key}" ${required}>${val}</textarea><label for="${id}">${label}</label>`;
  }
  if (field.type === 'select' && Array.isArray(field.options)) {
    const blankOption = field.required ? '' : '<option value=""></option>';
    const options = field.options.map((opt) => {
      const escapedOpt = escapeHtml(opt);
      const selected = opt === value ? ' selected' : '';
      return `<option value="${escapedOpt}"${selected}>${escapedOpt}</option>`;
    }).join('');
    return `<select id="${id}" name="${key}" ${required}>${blankOption}${options}</select><label for="${id}">${label}</label>`;
  }
  return `<input id="${id}" name="${key}" type="text" value="${val}" ${required}><label for="${id}">${label}</label>`;
}

// Reads a schema-driven form's current values back into a plain object.
// Object.fromEntries(new FormData(form)) is NOT enough for schema-driven
// forms: it silently keeps only the LAST of several same-named entries
// (breaking multiselect, which renders one checkbox per option under the
// same name) and it can't distinguish "field absent from schema" from
// "checkbox unchecked" for booleans. This walks the schema explicitly
// instead of the form's raw entries.
export function collectFieldValues(form, schema) {
  const formData = new FormData(form);
  const result = {};
  for (const field of schema) {
    if (field.type === 'boolean') {
      result[field.key] = form.elements[field.key]?.checked ?? false;
    } else if (field.type === 'multiselect') {
      result[field.key] = formData.getAll(field.key);
    } else if (field.type === 'number') {
      const raw = formData.get(field.key);
      result[field.key] = raw === '' || raw === null ? undefined : Number(raw);
    } else {
      result[field.key] = formData.get(field.key) ?? '';
    }
  }
  return result;
}

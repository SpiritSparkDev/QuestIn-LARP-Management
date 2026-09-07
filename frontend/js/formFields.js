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

// Registration/participant status, keyed by the status column's DB value.
export const STATUS_LABELS = {
  notified: 'Benachrichtigt', pending: 'Vorgemerkt', confirmed: 'Angemeldet',
  checked_in: 'Eingechecked', checked_out: 'Ausgecheckt', cancelled: 'Abgesagt',
};

// True if a Ja/Nein opt-out field's raw stored value means "yes" (checked).
// These fields are free text at the DB layer, so this also accepts whatever
// case a user typed before the field became a checkbox.
export function isOptOutYes(value) {
  return typeof value === 'string' && value.trim().toLowerCase() === 'ja';
}

// Formats a character (IT) custom-field value for display, e.g. as a
// checkin-table cell or a browse-page tag. Returns undefined for values that
// shouldn't be shown at all (empty/absent).
export function formatFieldValue(field, rawValue) {
  if (rawValue === undefined || rawValue === null || rawValue === '') return undefined;
  if (Array.isArray(rawValue)) return rawValue.length > 0 ? rawValue.join(', ') : undefined;
  if (typeof rawValue === 'boolean') return rawValue ? 'Ja' : undefined;
  return rawValue;
}

// Renders <option> markup for an event dropdown, e.g. "Sommer-Con (2026-08-01)".
// `blankLabel`, if given, adds a leading blank/placeholder option.
export function renderEventOptions(events, blankLabel) {
  const blank = blankLabel !== undefined ? `<option value="">${escapeHtml(blankLabel)}</option>` : '';
  return blank + events.map((e) => `<option value="${escapeHtml(e.id)}">${escapeHtml(e.name)} (${escapeHtml(e.event_date)})</option>`).join('');
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

let liveValidationIdCounter = 0;

// Shows a field's native validation message only after the user has
// actually interacted with it -- otherwise every required-but-empty field
// on a freshly-loaded form would show as invalid immediately, before the
// user has had any chance to fill it in.
export function attachLiveValidation(formEl) {
  const controls = formEl.querySelectorAll('input, select, textarea');
  controls.forEach((el) => {
    // A checkbox rendered by renderField's boolean/multiselect branches is
    // wrapped INSIDE its own <label>...text</label> -- inserting a message
    // element next to it would land inside that label (invalid HTML, and
    // visually splits the checkbox from its own caption). These controls
    // keep only their existing native (submit-time) validation, same as
    // before this feature existed.
    if (el.closest('label')) return;

    let hasInteracted = false;
    const errorEl = document.createElement('p');
    errorEl.className = 'field-error';
    errorEl.id = `field-error-${liveValidationIdCounter++}`;
    el.setAttribute('aria-describedby', errorEl.id);
    // In this project's static forms, a label precedes its input, so the
    // error belongs right after the input. Schema-driven fields (renderField)
    // do the reverse -- input then label -- so putting it straight after the
    // input would wedge the error between an input and its own label; anchor
    // after the label instead, but only when that label is genuinely THIS
    // control's own (matching `for`) -- otherwise, on a flat static form, the
    // "next sibling label" belongs to the NEXT field entirely, and anchoring
    // there would attribute this field's error to the wrong one.
    const next = el.nextElementSibling;
    const anchor = (next?.tagName === 'LABEL' && next.htmlFor === el.id) ? next : el;
    anchor.insertAdjacentElement('afterend', errorEl);

    function refresh() {
      if (!hasInteracted) return;
      const valid = el.checkValidity();
      el.classList.toggle('invalid', !valid);
      el.setAttribute('aria-invalid', String(!valid));
      errorEl.textContent = valid ? '' : el.validationMessage;
    }

    el.addEventListener('blur', () => { hasInteracted = true; refresh(); });
    el.addEventListener('input', refresh);
  });
}

export function renderField(field, value) {
  const val = escapeHtml(value);
  const label = escapeHtml(field.label ?? field.key) + (field.required ? ' *' : '');
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

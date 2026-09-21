// Registration/participant status, keyed by the status column's DB value.
export const STATUS_LABELS = {
  notified: 'Benachrichtigt', pending: 'Vorgemerkt', confirmed: 'Angemeldet',
  checked_in: 'Eingecheckt', checked_out: 'Ausgecheckt', cancelled: 'Abgesagt',
};

// Renders one OT (account/registration) field from a schema-shaped field
// definition ({key, label, type, options}) -- same field shape as IT
// (character) schema fields. `sealedBadge`, if given, is raw HTML appended
// to the label (e.g. the lock-icon "Verschlüsselt" badge). Each field is
// wrapped in its own `<div class="${key}-container">` -- this wrapper
// carries no styling today and looks removable, but it's a deliberate
// per-field CSS/JS hook the user added for upcoming UI work. Do not delete
// it as "unused" or collapse it back to a bare label+input.
export function renderAccountFieldInput(field, value, { sealedBadge = '', idPrefix = '' } = {}) {
  const { key, type } = field;
  const escapedLabel = escapeHtml(field.label ?? key) + sealedBadge;
  const val = escapeHtml(value);
  const id = `${idPrefix}field-${key}`;
  const required = field.required ? 'required' : '';

  if (type === 'boolean') {
    const checked = value ? ' checked' : '';
    return `<div class="${key}-container"><label for="${id}"><input id="${id}" data-field="${key}" type="checkbox"${checked}> ${escapedLabel}</label></div>`;
  }
  if (type === 'multiselect' && Array.isArray(field.options)) {
    const selected = Array.isArray(value) ? value : [];
    const checkboxes = field.options.map((opt, i) => {
      const escapedOpt = escapeHtml(opt);
      const checked = selected.includes(opt) ? ' checked' : '';
      return `<label for="${id}-${i}"><input id="${id}-${i}" data-field="${key}" type="checkbox" value="${escapedOpt}"${checked}> ${escapedOpt}</label>`;
    }).join('');
    return `<div class="${key}-container"><span>${escapedLabel}</span>${checkboxes}</div>`;
  }
  if (type === 'number') {
    return `<div class="${key}-container"><input id="${id}" data-field="${key}" type="number" value="${val}" ${required}><label for="${id}">${escapedLabel}</label></div>`;
  }
  if (type === 'link') {
    return `<div class="${key}-container"><input id="${id}" data-field="${key}" type="url" value="${val}" ${required}><label for="${id}">${escapedLabel}</label></div>`;
  }
  if (type === 'date') {
    return `<div class="${key}-container"><input id="${id}" data-field="${key}" type="date" value="${val}" ${required}><label for="${id}">${escapedLabel}</label></div>`;
  }
  if (type === 'textarea') {
    return `<div class="${key}-container"><textarea id="${id}" data-field="${key}" ${required}>${val}</textarea><label for="${id}">${escapedLabel}</label></div>`;
  }
  if (type === 'select' && Array.isArray(field.options)) {
    const options = field.options.map((opt) => {
      const escapedOpt = escapeHtml(opt);
      const selected = opt === value ? ' selected' : '';
      return `<option value="${escapedOpt}"${selected}>${escapedOpt}</option>`;
    }).join('');
    return `<div class="${key}-container"><select id="${id}" data-field="${key}" ${required}><option value=""></option>${options}</select><label for="${id}">${escapedLabel}</label></div>`;
  }
  return `<div class="${key}-container"><input id="${id}" data-field="${key}" type="text" value="${val}" ${required}><label for="${id}">${escapedLabel}</label></div>`;
}

// Reads a schema-driven OT-field container's current values back into a
// plain object, keyed by field key. Mirrors collectFieldValues's per-type
// logic, but keys off [data-field] elements (this page family's existing
// DOM convention) instead of a <form>'s `name` attributes.
export function collectAccountFieldValues(container, schema) {
  const result = {};
  const inputsByKey = new Map();
  container.querySelectorAll('[data-field]').forEach((input) => {
    if (!inputsByKey.has(input.dataset.field)) inputsByKey.set(input.dataset.field, []);
    inputsByKey.get(input.dataset.field).push(input);
  });
  for (const field of schema) {
    const inputs = inputsByKey.get(field.key) ?? [];
    if (inputs.length === 0) continue;
    if (field.type === 'boolean') {
      result[field.key] = inputs[0].checked;
    } else if (field.type === 'multiselect') {
      result[field.key] = inputs.filter((i) => i.checked).map((i) => i.value);
    } else if (field.type === 'number') {
      result[field.key] = inputs[0].value === '' ? undefined : Number(inputs[0].value);
    } else {
      result[field.key] = inputs[0].value;
    }
  }
  return result;
}

// collectAccountFieldValues returns `undefined` for a blank number input --
// deliberately, since otFieldValuesEqual's own dirty-check comparisons rely
// on `undefined` meaning "no value" (it treats null the same way in that
// branch, so this is safe to apply before a dirty-check comparison too).
// But a payload that's actually SENT needs `null` for that same case,
// because every repository merge does `if (fields[key] !== undefined)
// nextData[key] = fields[key]` -- an `undefined` payload value is dropped
// by JSON.stringify entirely and silently skipped, so a numeric field once
// set could otherwise never be cleared back to blank via the UI. Only
// touches keys collectAccountFieldValues actually populated (a field the
// caller wasn't permitted/didn't render is correctly left absent).
export function nullifyBlankNumberFields(schema, values) {
  const result = { ...values };
  for (const field of schema) {
    if (field.type === 'number' && field.key in result && result[field.key] === undefined) {
      result[field.key] = null;
    }
  }
  return result;
}

// Compares an OT field's before/after value for the "did this actually
// change" guard used before PATCH /members/:id or PUT .../ot-fields (both
// of which mail every event orga/hilfs_orga plus every admin/moderator on
// success) -- plain === breaks for multiselect (a fresh array every
// collect) and for a blank number (undefined vs the '' default).
export function otFieldValuesEqual(field, a, b) {
  if (field.type === 'boolean') return Boolean(a) === Boolean(b);
  if (field.type === 'multiselect') {
    const arrA = Array.isArray(a) ? a : [];
    const arrB = Array.isArray(b) ? b : [];
    return arrA.length === arrB.length && arrA.every((v, i) => v === arrB[i]);
  }
  if (field.type === 'number') {
    const normA = a === undefined || a === null || a === '' ? undefined : Number(a);
    const normB = b === undefined || b === null || b === '' ? undefined : Number(b);
    return normA === normB;
  }
  return a === b;
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

export function renderField(field, value, idPrefix = '', { readOnly = false } = {}) {
  const val = escapeHtml(value);
  const label = escapeHtml(field.label ?? field.key) + (field.required ? ' *' : '') + (readOnly ? ' 🔒' : '');
  const key = escapeHtml(field.key);
  const required = field.required ? 'required' : '';
  const disabled = readOnly ? 'disabled' : '';
  const id = `${idPrefix}field-${key}`;

  if (field.type === 'boolean') {
    const checked = value ? ' checked' : '';
    return `<label for="${id}"><input id="${id}" name="${key}" type="checkbox"${checked} ${disabled}> ${label}</label>`;
  }
  if (field.type === 'multiselect' && Array.isArray(field.options)) {
    const selected = Array.isArray(value) ? value : [];
    const checkboxes = field.options.map((opt, i) => {
      const escapedOpt = escapeHtml(opt);
      const checked = selected.includes(opt) ? ' checked' : '';
      return `<label for="${id}-${i}"><input id="${id}-${i}" name="${key}" type="checkbox" value="${escapedOpt}"${checked} ${disabled}> ${escapedOpt}</label>`;
    }).join('');
    return `<span>${label}</span>${checkboxes}`;
  }
  if (field.type === 'number') {
    return `<input id="${id}" name="${key}" type="number" value="${val}" ${required} ${disabled}><label for="${id}">${label}</label>`;
  }
  if (field.type === 'link') {
    return `<input id="${id}" name="${key}" type="url" value="${val}" ${required} ${disabled}><label for="${id}">${label}</label>`;
  }
  if (field.type === 'date') {
    return `<input id="${id}" name="${key}" type="date" value="${val}" ${required} ${disabled}><label for="${id}">${label}</label>`;
  }
  if (field.type === 'textarea') {
    return `<textarea id="${id}" name="${key}" ${required} ${disabled}>${val}</textarea><label for="${id}">${label}</label>`;
  }
  if (field.type === 'select' && Array.isArray(field.options)) {
    const blankOption = field.required ? '' : '<option value=""></option>';
    const options = field.options.map((opt) => {
      const escapedOpt = escapeHtml(opt);
      const selected = opt === value ? ' selected' : '';
      return `<option value="${escapedOpt}"${selected}>${escapedOpt}</option>`;
    }).join('');
    return `<select id="${id}" name="${key}" ${required} ${disabled}>${blankOption}${options}</select><label for="${id}">${label}</label>`;
  }
  return `<input id="${id}" name="${key}" type="text" value="${val}" ${required} ${disabled}><label for="${id}">${label}</label>`;
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

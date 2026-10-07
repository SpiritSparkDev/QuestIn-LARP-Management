import { renderField, collectFieldValues, nullifyBlankNumberFields } from './formFields.js';

// NSC questionnaire (fields of the NSC schema) inside any container that may
// itself sit inside another <form>: the inputs are bound to a detached hidden
// form via the `form` attribute so collectFieldValues can read them.
function formFor(container) {
  const id = `${container.id}-form`;
  let form = document.getElementById(id);
  if (!form) {
    form = document.createElement('form');
    form.id = id;
    form.hidden = true;
    document.body.append(form);
  }
  return form;
}

export function renderNscFields(container, schema, data = {}, canEditStaff = false) {
  container.innerHTML = schema
    .map((f) => `<div class="form-group">${renderField(f, (data ?? {})[f.key], 'nsc-', { readOnly: f.staffOnly === true && !canEditStaff })}</div>`)
    .join('');
  const form = formFor(container);
  container.querySelectorAll('input,select,textarea').forEach((el) => el.setAttribute('form', form.id));
}

// staffOnly fields the viewer cannot edit are left out of the payload.
export function collectNscFields(container, schema, canEditStaff = false) {
  const editable = schema.filter((f) => !(f.staffOnly === true && !canEditStaff));
  return nullifyBlankNumberFields(editable, collectFieldValues(formFor(container), editable));
}

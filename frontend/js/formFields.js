export function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[ch]));
}

export function renderField(field, value) {
  const val = escapeHtml(value);
  const label = escapeHtml(field.label ?? field.key);
  const key = escapeHtml(field.key);
  const required = field.required ? 'required' : '';
  const id = `field-${key}`;

  if (field.type === 'textarea') {
    return `<label for="${id}">${label}</label><textarea id="${id}" name="${key}" ${required}>${val}</textarea>`;
  }
  if (field.type === 'select' && Array.isArray(field.options)) {
    const blankOption = field.required ? '' : '<option value=""></option>';
    const options = field.options.map((opt) => {
      const escapedOpt = escapeHtml(opt);
      const selected = opt === value ? ' selected' : '';
      return `<option value="${escapedOpt}"${selected}>${escapedOpt}</option>`;
    }).join('');
    return `<label for="${id}">${label}</label><select id="${id}" name="${key}" ${required}>${blankOption}${options}</select>`;
  }
  return `<label for="${id}">${label}</label><input id="${id}" name="${key}" type="text" value="${val}" ${required}>`;
}

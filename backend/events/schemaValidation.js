const MAX_VALUE_LENGTH = 5000;
const MAX_TOTAL_LENGTH = 20000;

const RESERVED_SCHEMA_KEYS = ['id', 'name', 'eventId'];

export function validateSchemaShape(schema) {
  if (!Array.isArray(schema)) return false;
  const seenKeys = new Set();
  for (const field of schema) {
    if (!field || typeof field !== 'object' || typeof field.key !== 'string' || field.key.length === 0) {
      return false;
    }
    if (RESERVED_SCHEMA_KEYS.includes(field.key)) return false;
    if (seenKeys.has(field.key)) return false;
    seenKeys.add(field.key);
  }
  return true;
}

export function validateCharacterData(schema, data) {
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    return ['Daten müssen ein Objekt sein.'];
  }

  const errors = [];
  const allowedKeys = new Set(schema.map((field) => field.key));

  for (const field of schema) {
    const label = field.key;
    const value = Object.hasOwn(data, field.key) ? data[field.key] : undefined;
    const isEmpty = value === undefined || value === null
      || (typeof value === 'string' && value.trim() === '')
      || (Array.isArray(value) && value.length === 0);

    if (field.required && isEmpty) {
      errors.push(`${label} ist erforderlich`);
      continue;
    }
    if (!isEmpty && (field.type === 'text' || field.type === 'textarea') && typeof value !== 'string') {
      errors.push(`${label} muss Text sein`);
    }
    if (!isEmpty && field.type === 'select' && Array.isArray(field.options) && !field.options.includes(value)) {
      errors.push(`${label} muss einer von: ${field.options.join(', ')} sein`);
    }
    if (!isEmpty && field.type === 'boolean' && typeof value !== 'boolean') {
      errors.push(`${label} muss ein Wahrheitswert sein`);
    }
    if (!isEmpty && field.type === 'multiselect') {
      const optionsOk = Array.isArray(field.options);
      if (!Array.isArray(value) || !optionsOk || !value.every((v) => field.options.includes(v))) {
        errors.push(`${label} muss eine Auswahl aus: ${optionsOk ? field.options.join(', ') : ''} sein`);
      }
    }
    if (!isEmpty && field.type === 'number' && (typeof value !== 'number' || !Number.isFinite(value))) {
      errors.push(`${label} muss eine Zahl sein`);
    }
    if (!isEmpty && field.type === 'link' && typeof value !== 'string') {
      errors.push(`${label} muss Text sein`);
    }
    if (!isEmpty && field.type === 'link' && typeof value === 'string' && !/^https?:\/\//.test(value)) {
      errors.push(`${label} muss mit http:// oder https:// beginnen`);
    }
    if (!isEmpty && field.type === 'date' && typeof value !== 'string') {
      errors.push(`${label} muss ein Datum sein`);
    }
    if (!isEmpty && typeof value === 'string' && value.length > MAX_VALUE_LENGTH) {
      errors.push(`${label} darf höchstens ${MAX_VALUE_LENGTH} Zeichen lang sein`);
    }
  }

  for (const key of Object.keys(data)) {
    if (!allowedKeys.has(key)) {
      errors.push(`unbekanntes Feld: ${key}`);
    }
  }

  if (JSON.stringify(data).length > MAX_TOTAL_LENGTH) {
    errors.push(`Daten dürfen serialisiert höchstens ${MAX_TOTAL_LENGTH} Zeichen lang sein`);
  }

  return errors;
}

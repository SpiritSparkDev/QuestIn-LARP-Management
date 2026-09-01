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
    return ['data must be an object'];
  }

  const errors = [];
  const allowedKeys = new Set(schema.map((field) => field.key));

  for (const field of schema) {
    const value = Object.hasOwn(data, field.key) ? data[field.key] : undefined;
    const isEmpty = value === undefined || value === null
      || (typeof value === 'string' && value.trim() === '')
      || (Array.isArray(value) && value.length === 0);

    if (field.required && isEmpty) {
      errors.push(`${field.key} is required`);
      continue;
    }
    if (!isEmpty && (field.type === 'text' || field.type === 'textarea') && typeof value !== 'string') {
      errors.push(`${field.key} must be a string`);
    }
    if (!isEmpty && field.type === 'select' && Array.isArray(field.options) && !field.options.includes(value)) {
      errors.push(`${field.key} must be one of: ${field.options.join(', ')}`);
    }
    if (!isEmpty && field.type === 'boolean' && typeof value !== 'boolean') {
      errors.push(`${field.key} must be a boolean`);
    }
    if (!isEmpty && field.type === 'multiselect') {
      const optionsOk = Array.isArray(field.options);
      if (!Array.isArray(value) || !optionsOk || !value.every((v) => field.options.includes(v))) {
        errors.push(`${field.key} must be an array of: ${optionsOk ? field.options.join(', ') : ''}`);
      }
    }
    if (!isEmpty && field.type === 'number' && (typeof value !== 'number' || !Number.isFinite(value))) {
      errors.push(`${field.key} must be a number`);
    }
    if (!isEmpty && field.type === 'link' && typeof value !== 'string') {
      errors.push(`${field.key} must be a string`);
    }
    if (!isEmpty && field.type === 'link' && typeof value === 'string' && !/^https?:\/\//.test(value)) {
      errors.push(`${field.key} must start with http:// or https://`);
    }
    if (!isEmpty && typeof value === 'string' && value.length > MAX_VALUE_LENGTH) {
      errors.push(`${field.key} must be at most ${MAX_VALUE_LENGTH} characters`);
    }
  }

  for (const key of Object.keys(data)) {
    if (!allowedKeys.has(key)) {
      errors.push(`unknown field: ${key}`);
    }
  }

  if (JSON.stringify(data).length > MAX_TOTAL_LENGTH) {
    errors.push(`data must be at most ${MAX_TOTAL_LENGTH} characters when serialized`);
  }

  return errors;
}

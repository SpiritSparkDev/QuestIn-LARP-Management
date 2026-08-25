const MAX_VALUE_LENGTH = 5000;
const MAX_TOTAL_LENGTH = 20000;

export function validateCharacterData(schema, data) {
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    return ['data must be an object'];
  }

  const errors = [];
  const allowedKeys = new Set(schema.map((field) => field.key));

  for (const field of schema) {
    const value = Object.hasOwn(data, field.key) ? data[field.key] : undefined;
    const isEmpty = value === undefined || value === null
      || (typeof value === 'string' && value.trim() === '');

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

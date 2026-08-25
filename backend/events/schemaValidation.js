export function validateCharacterData(schema, data) {
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    return ['data must be an object'];
  }

  const errors = [];
  const allowedKeys = new Set(schema.map((field) => field.key));

  for (const field of schema) {
    const value = data[field.key];
    if (field.required && (value === undefined || value === null || value === '')) {
      errors.push(`${field.key} is required`);
    }
  }

  for (const key of Object.keys(data)) {
    if (!allowedKeys.has(key)) {
      errors.push(`unknown field: ${key}`);
    }
  }

  return errors;
}

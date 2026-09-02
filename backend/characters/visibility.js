export function filterCharacterFields(character, schema, viewer) {
  const isOwner = character.user_id === viewer.id;
  const isElevated = viewer.group.canOverrideCheckinStatus;
  if (isOwner || isElevated) return character.data;

  const publicKeys = new Set(schema.filter((field) => field.public === true).map((field) => field.key));
  const filtered = {};
  for (const key of Object.keys(character.data)) {
    if (publicKeys.has(key)) filtered[key] = character.data[key];
  }
  return filtered;
}

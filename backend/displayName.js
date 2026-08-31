export function displayName({ firstName, lastName, nickname }) {
  return nickname || `${firstName} ${lastName}`.trim();
}

export function splitFullName(fullName) {
  const trimmed = (fullName ?? '').trim();
  const spaceIndex = trimmed.indexOf(' ');
  if (spaceIndex === -1) return { firstName: trimmed, lastName: '' };
  return { firstName: trimmed.slice(0, spaceIndex), lastName: trimmed.slice(spaceIndex + 1) };
}

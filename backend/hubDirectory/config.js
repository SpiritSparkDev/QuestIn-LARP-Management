// Coupling to the QuestIn hub (questin.de) is optional: without HUB_URL the
// instance neither fetches the directory nor shows other orgs' events.
// The own feed is separate and only lists events an admin explicitly published.

export function hubUrl() {
  const raw = process.env.HUB_URL;
  if (!raw) return null;
  try {
    const url = new URL(raw);
    const httpAllowed = process.env.NODE_ENV !== 'production';
    if (url.protocol !== 'https:' && !(httpAllowed && url.protocol === 'http:')) return null;
    return url.origin;
  } catch {
    return null;
  }
}

// Coupling to the QuestIn hub (questin.de) is optional: without HUB_URL the
// instance neither fetches the directory nor shows other orgs' events.
// The own feed is separate and only lists events an admin explicitly published.
//
// Two ways to configure it: the environment (HUB_URL, HUB_ISSUER, HUB_CLIENT_ID,
// HUB_CLIENT_SECRET), or the add-on "QuestIn-Hub" (backend/hubConnection), which
// fetches the credentials from the hub and keeps them in the database. The
// environment wins. This module stays free of database imports; the add-on
// pushes its current state in with setStoredHubConnection().

let stored = null;

// { hubUrl, issuer, clientId, clientSecret } of an active add-on connection, or null.
export function setStoredHubConnection(value) {
  stored = value && value.hubUrl && value.issuer && value.clientId && value.clientSecret ? { ...value } : null;
}

export function envHubConfigured() {
  return Boolean(process.env.HUB_ISSUER || process.env.HUB_CLIENT_ID || process.env.HUB_CLIENT_SECRET);
}

function originOf(raw) {
  try {
    const url = new URL(raw);
    const httpAllowed = process.env.NODE_ENV !== 'production' || ['1', 'true', 'yes', 'on'].includes(String(process.env.HUB_ALLOW_HTTP ?? '').toLowerCase());
    if (url.protocol !== 'https:' && !(httpAllowed && url.protocol === 'http:')) return null;
    return url.origin;
  } catch {
    return null;
  }
}

export function hubUrl() {
  const raw = process.env.HUB_URL;
  if (raw) return originOf(raw);
  if (envHubConfigured() || !stored) return null;
  return originOf(stored.hubUrl);
}

// OIDC client of this instance at the hub (login, profile, stats).
export function hubConfig() {
  if (envHubConfigured()) {
    const issuer = process.env.HUB_ISSUER?.trim().replace(/\/+$/, '');
    const clientId = process.env.HUB_CLIENT_ID;
    const clientSecret = process.env.HUB_CLIENT_SECRET;
    return issuer && clientId && clientSecret ? { issuer, clientId, clientSecret } : null;
  }
  if (!stored) return null;
  return { issuer: stored.issuer.replace(/\/+$/, ''), clientId: stored.clientId, clientSecret: stored.clientSecret };
}

// Origin check for hub URLs typed into the add-on (same rule as hubUrl()).
export const hubOriginOf = originOf;

export const SESSION_COOKIE_NAME = 'session';

export function parseCookies(header) {
  const cookies = {};
  if (!header) return cookies;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    const key = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (key) cookies[key] = decodeURIComponent(value);
  }
  return cookies;
}

function secureFlag() {
  return process.env.NODE_ENV === 'production' ? '; Secure' : '';
}

export function serializeSessionCookie(token, expiresAt) {
  return `${SESSION_COOKIE_NAME}=${token}; HttpOnly; Path=/; SameSite=Lax; Expires=${expiresAt.toUTCString()}${secureFlag()}`;
}

export function clearSessionCookie() {
  return `${SESSION_COOKIE_NAME}=; HttpOnly; Path=/; SameSite=Lax; Expires=Thu, 01 Jan 1970 00:00:00 GMT${secureFlag()}`;
}

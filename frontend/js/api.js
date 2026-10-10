async function request(path, options = {}) {
  let res;
  try {
    res = await fetch(path, {
      ...options,
      credentials: 'include',
      headers: { 'Content-Type': 'application/json', ...options.headers },
    });
  } catch {
    // fetch only rejects when no answer arrived (offline, server unreachable).
    const error = new Error('Keine Verbindung zum Server.');
    error.network = true;
    throw error;
  }

  let body = null;
  try {
    body = await res.json();
  } catch {
    // no/invalid JSON body — fine for 204s and similar
  }

  if (!res.ok) {
    // 502/503/504 without a JSON error: the proxy answered because the app is
    // down, usually a deploy restarting it (see docs/deploy.md).
    const restarting = !body?.error && [502, 503, 504].includes(res.status);
    const error = new Error(body?.error || (restarting
      ? 'Der Server wird gerade neu gestartet (Update). Bitte versuche es in ein bis zwei Minuten noch einmal.'
      : `request failed with status ${res.status}`));
    error.status = res.status;
    error.body = body;
    throw error;
  }

  return body;
}

export const api = {
  get: (path) => request(path),
  post: (path, data) => request(path, { method: 'POST', body: JSON.stringify(data) }),
  put: (path, data) => request(path, { method: 'PUT', body: JSON.stringify(data) }),
  patch: (path, data) => request(path, { method: 'PATCH', body: JSON.stringify(data) }),
  delete: (path, data) => request(path, { method: 'DELETE', ...(data ? { body: JSON.stringify(data) } : {}) }),
};

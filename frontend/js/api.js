async function request(path, options = {}) {
  const res = await fetch(path, {
    ...options,
    credentials: 'include',
    headers: { 'Content-Type': 'application/json', ...options.headers },
  });

  let body = null;
  try {
    body = await res.json();
  } catch {
    // no/invalid JSON body — fine for 204s and similar
  }

  if (!res.ok) {
    const error = new Error(body?.error || `request failed with status ${res.status}`);
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
  delete: (path) => request(path, { method: 'DELETE' }),
};

export async function withTestServer(fn) {
  // Dynamic on purpose: backend/server.js transitively fail-fasts at import
  // time if ENCRYPTION_KEY is unset. Every test file sets its own fallback
  // for that var AFTER this module's own (hoisted) static import resolves,
  // so importing server.js here — at call time, not load time — is what
  // makes those fallbacks actually take effect. Do not hoist to a static
  // top-level import.
  const { createServer } = await import('../backend/server.js');
  const server = createServer().listen(0);
  try {
    const { port } = server.address();
    return await fn(port);
  } finally {
    server.close();
  }
}

export async function withTestServer(fn) {
  const { createServer } = await import('../backend/server.js');
  const server = createServer().listen(0);
  try {
    const { port } = server.address();
    return await fn(port);
  } finally {
    server.close();
  }
}

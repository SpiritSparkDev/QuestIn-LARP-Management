import { createServer } from '../backend/server.js';

export async function withTestServer(fn) {
  const server = createServer().listen(0);
  try {
    const { port } = server.address();
    return await fn(port);
  } finally {
    server.close();
  }
}

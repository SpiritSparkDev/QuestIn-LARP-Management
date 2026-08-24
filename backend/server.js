import http from 'node:http';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Router } from './router.js';
import { logger } from './logger.js';
import { query } from './db.js';

export const router = new Router();

router.get('/health', async () => {
  await query('SELECT 1');
  return { status: 200, body: { status: 'ok' } };
});

async function handleRequest(req, res) {
  const requestId = crypto.randomUUID();
  const start = Date.now();
  const { pathname } = new URL(req.url, 'http://localhost');
  res.setHeader('X-Request-Id', requestId);

  const match = router.match(req.method, pathname);
  if (!match) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'not found', requestId }));
    logger.info('request', { requestId, method: req.method, path: pathname, status: 404, durationMs: Date.now() - start });
    return;
  }

  try {
    const result = await match.handler({ req, params: match.params, requestId });
    const status = result?.status ?? 200;
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(result?.body ?? {}));
    logger.info('request', { requestId, method: req.method, path: pathname, status, durationMs: Date.now() - start });
  } catch (err) {
    logger.error('request failed', { requestId, method: req.method, path: pathname, error: err.message, stack: err.stack });
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'internal server error', requestId }));
  }
}

export function createServer() {
  return http.createServer(handleRequest);
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMain) {
  const port = process.env.PORT || 3000;
  createServer().listen(port, () => {
    logger.info('server started', { port });
  });
}

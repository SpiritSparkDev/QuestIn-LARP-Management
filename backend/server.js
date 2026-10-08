import http from 'node:http';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { logger } from './logger.js';
import { router } from './routes.js';
import { serveStaticFile } from './staticFiles.js';
import './auth/register.js';
import './auth/login.js';
import './auth/passwordReset.js';
import './auth/oauth.js';
import './auth/invite.js';
import './auth/groupInvite.js';
import './accounts/routes.js';
import './accounts/export.js';
import './events/routes.js';
import './mailings/routes.js';
import './privacy/routes.js';
import { runDueAutoDeletions } from './privacy/repository.js';
import './characters/routes.js';
import './characterReviews/routes.js';
import './characterFiles/routes.js';
import './accountFiles/routes.js';
import './registrations/routes.js';
import './lodging/routes.js';
import './groupTree/routes.js';
import './viewAs/routes.js';
import './groups/routes.js';
import './members/routes.js';
import './managedPersons/routes.js';
import './managedPersons/characterRoutes.js';
import './managedPersons/registrationRoutes.js';
import './managedPersons/convertRoutes.js';
import './nscSchema/routes.js';
import './scSchema/routes.js';
import './groupSchema/routes.js';
import { runUnpaidReminders } from './registrations/unpaidReminders.js';
import { runConPayerAutomation } from './registrations/conPayerAutomation.js';
import './accountFieldSchema/routes.js';
import './registrationFieldSchema/routes.js';
import './smtpSettings/routes.js';
import './appSettings/routes.js';
import './paymentSettings/routes.js';
import './payments/routes.js';
import './guestRegistrations/routes.js';
import './comingSoon/routes.js';
import './storageSettings/routes.js';
import './emailTemplates/routes.js';
import './pdfImport/routes.js';
import './tavern/routes.js';
import './testMode/routes.js';
import './audit/routes.js';
import './appModeRoutes.js';
import './offlineRoutes.js';
import { isOffline, warnIfWrongDatabase } from './appMode.js';
import { checkWriteGuard } from './instanceAuthority/guard.js';

// Route modules import `router` from ./routes.js directly (importing it from
// here would create an ESM cycle); this re-export is for the app entry point only.
export { router };

async function handleRequest(req, res) {
  const requestId = crypto.randomUUID();
  const start = Date.now();
  const { pathname } = new URL(req.url, 'http://localhost');
  res.setHeader('X-Request-Id', requestId);

  // The embeddable ticket widget (frontend/widget.js) calls /public/* from
  // other websites. Those endpoints are unauthenticated and never read
  // cookies, so any origin may use them.
  if (pathname.startsWith('/public/')) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    if (req.method === 'OPTIONS') {
      res.writeHead(204, { 'Access-Control-Allow-Methods': 'GET, POST', 'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Max-Age': '86400' });
      res.end();
      return;
    }
  }

  const match = router.match(req.method, pathname);
  if (!match) {
    if (req.method === 'GET') {
      const file = await serveStaticFile(pathname);
      if (file) {
        res.writeHead(200, { 'Content-Type': file.contentType });
        res.end(file.data);
        logger.info('request', { requestId, method: req.method, path: pathname, status: 200, durationMs: Date.now() - start });
        return;
      }
    }
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'not found', requestId }));
    logger.info('request', { requestId, method: req.method, path: pathname, status: 404, durationMs: Date.now() - start });
    return;
  }

  try {
    const result = await checkWriteGuard(req.method, pathname) ?? await match.handler({ req, params: match.params, requestId });
    const status = result?.status ?? 200;
    if (result?.isBinary) {
      res.writeHead(status, result?.headers);
      res.end(result.body);
    } else {
      const payload = JSON.stringify(result?.body ?? {});
      res.writeHead(status, { 'Content-Type': 'application/json', ...result?.headers });
      res.end(payload);
    }
    logger.info('request', { requestId, method: req.method, path: pathname, status, durationMs: Date.now() - start });
  } catch (err) {
    const CLIENT_ERROR_CODES = new Set(['22P02', '22P05', '22007', '22008']);
    const status = CLIENT_ERROR_CODES.has(err.code) ? 400 : 500;
    logger.error('request failed', { requestId, method: req.method, path: pathname, status, durationMs: Date.now() - start, error: err.message, stack: err.stack });
    if (!res.headersSent) {
      const body = status === 400
        ? { error: 'invalid request', requestId }
        : { error: 'internal server error', requestId };
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
    }
  }
}

export function createServer() {
  return http.createServer(handleRequest);
}

// Offline: no jobs at all -- reminders/automation would mail or delete in parallel to the online instance.
export function startBackgroundJobs() {
  if (isOffline()) return [];
  const runCleanup = () => runDueAutoDeletions().catch((err) => logger.error('privacy cleanup failed', { error: err.message }));
  const every = 6 * 60 * 60 * 1000;
  return [
    [runCleanup, 60_000], [runUnpaidReminders, 120_000], [runConPayerAutomation, 180_000],
  ].flatMap(([job, delay]) => [setTimeout(job, delay).unref(), setInterval(job, every).unref()]);
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMain) {
  const port = process.env.PORT || 3000;
  createServer().listen(port, () => {
    logger.info('server started', { port });
  });
  startBackgroundJobs();
  warnIfWrongDatabase();
}

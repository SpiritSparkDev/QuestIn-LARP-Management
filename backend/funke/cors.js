import { getAppSettings } from '../appSettings/repository.js';

// Lets the Funke web app (settings.funkeOrigin) call the API from its own
// origin. It authenticates with a Bearer header, never cookies, so no
// Allow-Credentials. Returns true when it already answered a preflight.
// ponytail: one settings query per cross-origin request, cache if it shows up in profiles.
export async function applyFunkeCors(req, res) {
  const origin = req.headers.origin;
  if (!origin) return false;
  const { funkeEnabled, funkeOrigin } = await getAppSettings();
  if (!funkeEnabled || !funkeOrigin || origin !== funkeOrigin) return false;
  res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Vary', 'Origin');
  if (req.method !== 'OPTIONS') return false;
  res.writeHead(204, { 'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE', 'Access-Control-Allow-Headers': 'Authorization, Content-Type', 'Access-Control-Max-Age': '86400' });
  res.end();
  return true;
}

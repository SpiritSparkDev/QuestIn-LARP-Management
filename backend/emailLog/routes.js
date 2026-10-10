import { router } from '../routes.js';
import { requireAuth } from '../middleware/authenticate.js';
import { requireAdminGroup } from '../middleware/authorize.js';
import { getMember } from '../members/repository.js';
import { isOffline } from '../appMode.js';
import { resolveSmtpConfig, baseUrl } from '../auth/mailer.js';
import { listEmailLog, listEmailLogForMember, countEmailLogSince, EMAIL_LOG_STATUSES, EMAIL_LOG_RETENTION_DAYS } from './repository.js';
import { countQueuedOutbox } from './outbox.js';

const RECENT_DAYS = 7;
const UUID = /^[0-9a-f-]{36}$/i;

const domainOf = (address) => String(address ?? '').split('@')[1]?.replace(/>.*$/, '').trim().toLowerCase() || null;

// Everything that makes mails silently not arrive, phrased for the admin:
// `error` = no mail reaches anyone / every link is broken, `warn` = some
// mails are lost or likely land in spam. Shown on the Versandprotokoll page
// and as a dot in the admin navigation (frontend/js/nav.js).
export async function mailHealth() {
  const problems = [];
  const { host, username, from } = await resolveSmtpConfig();
  const offline = isOffline();
  if (!offline && !host) {
    problems.push({ level: 'error', text: 'Kein SMTP-Server eingerichtet: Es wird keine einzige E-Mail verschickt. Unter Einstellungen → Reiter „E-Mail“ eintragen.' });
  }
  if (!from || domainOf(from) === 'pakyrion.local') {
    problems.push({ level: 'error', text: 'Keine Absenderadresse eingetragen: Mails gehen als „no-reply@pakyrion.local“ raus und werden von den meisten Anbietern abgelehnt oder als Spam aussortiert.' });
  } else if (username?.includes('@') && domainOf(username) !== domainOf(from)) {
    problems.push({ level: 'warn', text: `Absenderadresse (${from}) gehört zu einer anderen Domain als das SMTP-Konto (${username}). Viele Server lehnen das ab oder die Mails landen im Spam.` });
  }
  const base = await baseUrl();
  if (!offline && /\/\/(localhost|127\.0\.0\.1|\[::1\])([:/]|$)/i.test(base)) {
    problems.push({ level: 'error', text: `Die Basis-URL ist ${base}: Alle Links in Mails zeigen auf „localhost“ und funktionieren bei den Empfängern nicht. Unter Einstellungen → Reiter „Allgemein“ → Basis-URL die öffentliche Adresse eintragen.` });
  } else if (!offline && base.startsWith('http://')) {
    problems.push({ level: 'warn', text: `Die Basis-URL (${base}) nutzt kein https – Links in Mails werden oft als unsicher markiert.` });
  }

  const counts = await countEmailLogSince(RECENT_DAYS, ['sent', 'failed', 'not_configured']);
  if (counts.failed) problems.push({ level: 'warn', text: `${counts.failed} E-Mail(s) sind in den letzten ${RECENT_DAYS} Tagen am Mailserver gescheitert. Details unten im Protokoll (Status „Fehlgeschlagen“).` });
  if (counts.not_configured) problems.push({ level: 'warn', text: `${counts.not_configured} E-Mail(s) wurden in den letzten ${RECENT_DAYS} Tagen nicht verschickt, weil kein SMTP-Server eingerichtet war.` });
  if (!offline) {
    const queued = await countQueuedOutbox();
    if (queued) problems.push({ level: 'warn', text: `${queued} E-Mail(s) aus der Offline-Version warten noch auf den Versand.` });
  }
  return {
    problems,
    offline,
    recentDays: RECENT_DAYS,
    retentionDays: EMAIL_LOG_RETENTION_DAYS,
    recent: { sent: counts.sent ?? 0, failed: counts.failed ?? 0, notConfigured: counts.not_configured ?? 0 },
  };
}

router.get('/admin/email-log/health', requireAuth(requireAdminGroup(async () => ({ status: 200, body: await mailHealth() }))));

router.get('/admin/email-log', requireAuth(requireAdminGroup(async ({ req }) => {
  const { searchParams } = new URL(req.url, 'http://localhost');
  const status = searchParams.get('status') || undefined;
  if (status && !EMAIL_LOG_STATUSES.includes(status)) return { status: 400, body: { error: 'unknown status' } };
  const userId = searchParams.get('userId') || undefined;
  if (userId && !UUID.test(userId)) return { status: 400, body: { error: 'invalid userId' } };
  const before = searchParams.get('before') || undefined;
  if (before && Number.isNaN(Date.parse(before))) return { status: 400, body: { error: 'invalid before' } };
  const entries = await listEmailLog({
    search: searchParams.get('search')?.trim() || undefined,
    status,
    userId,
    before,
    limit: searchParams.get('limit') ?? undefined,
  });
  return { status: 200, body: entries };
})));

router.get('/admin/email-log/members/:id', requireAuth(requireAdminGroup(async ({ params }) => {
  if (!UUID.test(params.id)) return { status: 404, body: { error: 'member not found' } };
  const member = await getMember(params.id);
  if (!member) return { status: 404, body: { error: 'member not found' } };
  return { status: 200, body: await listEmailLogForMember(params.id, member.email) };
})));

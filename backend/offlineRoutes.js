import crypto from 'node:crypto';
import { router } from './routes.js';
import { query } from './db.js';
import * as db from './db.js';
import { requireAuth } from './middleware/authenticate.js';
import { requireAdminGroup } from './middleware/authorize.js';
import { readJsonBody } from './httpBody.js';
import { toCsv } from './csv.js';
import { logAudit } from './audit/repository.js';
import { isOffline } from './appMode.js';
import * as authority from './instanceAuthority/repository.js';
import { exportSnapshot, exportReturnPackage, readPackage } from './offlinePackage/snapshot.js';
import { open, returnToken } from './offlinePackage/container.js';
import { mergeReturnPackage, resolveConflict, emergencyRelease, listConflicts } from './offlineMerge/merge.js';

/*
 * Offline mode HTTP API. All routes need the admin group (session cookie) except
 * POST /offline/return-import-token (token auth). Errors: { error: "<German text>", code: "<CODE>" }.
 * Passphrases are strings of at least 8 characters. Binary downloads are .qpkg files
 * (Content-Type application/octet-stream, Content-Disposition attachment).
 *
 * GET  /offline/status
 *   -> 200 { mode: 'online'|'offline', instanceId,
 *            instance: { role, snapshotTakenAt, delegatedSince, openConflicts },     // same shape as /account.instance
 *            events: [{ eventId, eventName, role: 'delegated'|'offline_primary'|'retired', snapshotId,
 *                       snapshotTakenAt, delegatedAt, delegatedByName, generation }],
 *            conflicts: [<conflict>] }                                               // open ones only
 *
 * POST /offline/snapshot            (online)   body { eventId, passphrase }
 *   delegates the event (check-in/tavern writes locked, 423) and answers with the .qpkg download.
 *   -> 200 binary, headers X-Snapshot-Id | 400 bad input | 404 unknown event | 409 already delegated (INVALID_TRANSITION)
 *
 * POST /offline/release             (online)   body { eventId }
 *   cancels the delegation without a return package; later packages of that snapshot become forced_release conflicts.
 *   -> 200 { released: true } | 409 OPEN_CONFLICTS (use release-force) | 409 INVALID_TRANSITION (not delegated)
 *
 * POST /offline/release-force       (online)   body { eventId, confirm: true }
 *   emergency release although conflicts are open (they stay open and resolvable).
 *   -> 200 { released: true, openConflicts: n } | 400 without confirm
 *
 * POST /offline/return-package      (offline)  body { passphrase, final?: boolean }
 *   .qpkg download with the offline domain; every export raises the generation (interim export).
 *   final: true also retires this instance (read-only afterwards).
 *   -> 200 binary | 409 NOT_OFFLINE
 *
 * POST /offline/return-import       (online)   body { file: "<base64 .qpkg>", passphrase, interim?: boolean }
 *   interim: true = Zwischenabgleich (online stays delegated, offline keeps working); default = final return.
 *   -> 200 <merge result>
 *   <merge result> = { status: 'released'|'interim'|'conflicts'|'forced_release'|'clock_skew'|'already_applied',
 *                      report: { checkIns, checkOuts, newAccounts, updatedAccounts, newTransactions,
 *                                balanceSumCents, auditEntries, conflicts } | null,
 *                      conflicts: [{ id, type, entity, entityId }] }
 *   Errors 400 BAD_FORMAT|BAD_PASSPHRASE|BAD_SIGNATURE|WRONG_KIND|SCHEMA_MISMATCH,
 *          409 NOT_DELEGATED|WRONG_SNAPSHOT|OUTDATED_GENERATION|SNAPSHOT_RETIRED.
 *
 * POST /offline/return-import-token (online, NO login) header X-Return-Token, body as return-import plus
 *   optional sentAt (ISO time of the sender, for the clock check). The token comes from the package manifest and
 *   is usable once per package (snapshot + generation): a repeat answers 409 TOKEN_USED. Unknown token -> 401.
 *   -> 200 <merge result>
 *
 * POST /offline/return-push         (offline)  body { onlineUrl, passphrase, final?: boolean }
 *   checks GET <onlineUrl>/health, builds the package and sends it with its token to <onlineUrl>/offline/return-import-token.
 *   -> 200 { reachable: true, result: <merge result> }; final: true retires this instance once the package was delivered
 *   -> 502 { reachable: false, error } when the online server cannot be reached (use the file download instead)
 *   -> remote errors keep their status: { reachable: true, error, code }
 *
 * GET  /offline/conflicts?status=open|resolved&type=<type>   (offline instance may read, too)
 *   -> 200 { conflicts: [<conflict>] }
 *   <conflict> = { id, snapshotId, generation, type, entity, entityId, offlineValue, onlineValue, status,
 *                  resolution, resolvedBy, resolvedAt, note, createdAt, allowedResolutions: [...] }
 *   types: registration_changed_online, account_deleted_online, tavern_number_collision, balance_mismatch,
 *          duplicate_walkin, forced_release, unknown_entity, clock_skew
 *   offlineValue.kind: registration | account | transactions | renumbered | duplicate | clock
 *
 * POST /offline/conflicts/:id/resolve   (online)  body { resolution: 'offline'|'online'|'merged'|'ignored', note? }
 *   only the allowedResolutions of that conflict are accepted (otherwise 400 INVALID_RESOLUTION).
 *   -> 200 { conflict: <db row>, released: boolean }   // released: last conflict of a final return closed, online is primary again
 *   -> 404 CONFLICT_NOT_FOUND | 409 ALREADY_RESOLVED | 409 CANNOT_APPLY
 *
 * GET  /offline/conflicts.csv?status=  -> 200 text/csv download of the list
 */

const STATUS = {
  BAD_FORMAT: 400, BAD_PASSPHRASE: 400, BAD_SIGNATURE: 400, WRONG_KIND: 400, SCHEMA_MISMATCH: 400, INVALID_RESOLUTION: 400,
  NOT_DELEGATED: 409, WRONG_SNAPSHOT: 409, OUTDATED_GENERATION: 409, SNAPSHOT_RETIRED: 409, INVALID_TRANSITION: 409,
  NOT_OFFLINE: 409, ALREADY_RESOLVED: 409, CANNOT_APPLY: 409, TOKEN_USED: 409, OPEN_CONFLICTS: 409, CONFLICT_NOT_FOUND: 404,
};
const MAX_PACKAGE_BODY = 100_000_000;
const err = (status, error, code) => ({ status, body: { error, ...(code && { code }) } });

async function guarded(fn) {
  try {
    return await fn();
  } catch (e) {
    if (STATUS[e.code]) return err(STATUS[e.code], e.message, e.code);
    throw e;
  }
}

const admin = (handler) => requireAuth(requireAdminGroup(({ ...ctx }) => guarded(() => handler(ctx))));
const validPassphrase = (p) => typeof p === 'string' && p.length >= 8;
const safeEqual = (a, b) => a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));

function download(buffer, filename, extra = {}) {
  return {
    status: 200, isBinary: true, body: buffer,
    headers: { 'Content-Type': 'application/octet-stream', 'Content-Disposition': `attachment; filename="${filename}"`, 'X-Content-Type-Options': 'nosniff', ...extra },
  };
}

const present = (r) => ({ status: r.status, report: r.report ?? null, conflicts: r.conflicts.map((c) => ({ id: c.id, type: c.type, entity: c.entity, entityId: c.entity_id })) });
const today = () => new Date().toISOString().slice(0, 10);

router.get('/offline/status', admin(async () => {
  const { rows } = await query(
    `SELECT ia.event_id, e.name, ia.role, ia.snapshot_id, ia.snapshot_taken_at, ia.delegated_at, ia.generation,
            concat_ws(' ', u.first_name, u.last_name) AS delegated_by_name
     FROM instance_authority ia JOIN events e ON e.id = ia.event_id LEFT JOIN users u ON u.id = ia.delegated_by
     WHERE ia.role <> 'primary' ORDER BY ia.delegated_at`);
  return {
    status: 200,
    body: {
      mode: isOffline() ? 'offline' : 'online',
      instanceId: await authority.getInstanceId(),
      instance: await authority.getSummary(),
      events: rows.map((r) => ({
        eventId: r.event_id, eventName: r.name, role: r.role, snapshotId: r.snapshot_id, snapshotTakenAt: r.snapshot_taken_at,
        delegatedAt: r.delegated_at, delegatedByName: r.delegated_by_name || null, generation: r.generation,
      })),
      conflicts: await listConflicts({ status: 'open' }),
    },
  };
}));

router.post('/offline/snapshot', admin(async ({ req, user }) => {
  const { eventId, passphrase } = (await readJsonBody(req)) ?? {};
  if (typeof eventId !== 'string' || !validPassphrase(passphrase)) return err(400, 'eventId und eine Passphrase (mind. 8 Zeichen) sind erforderlich.');
  const { rows: [event] } = await query('SELECT name FROM events WHERE id = $1', [eventId]);
  if (!event) return err(404, 'Event nicht gefunden.');
  const state = await authority.delegate(eventId, user.id);
  let buffer;
  try {
    buffer = await exportSnapshot(db, eventId, passphrase);
  } catch (e) {
    await authority.returnToPrimary(eventId, user.id).catch(() => {});
    throw e;
  }
  await logAudit({ actorId: user.id, action: 'offline_snapshot', details: { eventId, snapshotId: state.snapshotId, generation: state.generation } });
  const slug = event.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'event';
  return download(buffer, `questin-offline-${slug}-${today()}.qpkg`, { 'X-Snapshot-Id': state.snapshotId });
}));

router.post('/offline/release', admin(async ({ req, user }) => {
  const { eventId } = (await readJsonBody(req)) ?? {};
  if (typeof eventId !== 'string') return err(400, 'eventId ist erforderlich.');
  const state = await authority.getState(eventId);
  const { rows: [open] } = await query("SELECT count(*)::int AS n FROM sync_conflicts WHERE status = 'open' AND snapshot_id = $1", [state.snapshotId]);
  if (open.n > 0) return err(409, `Es sind noch ${open.n} Konflikte offen. Notfall-Freigabe verwenden oder erst lösen.`, 'OPEN_CONFLICTS');
  await emergencyRelease(eventId, user.id);
  return { status: 200, body: { released: true } };
}));

router.post('/offline/release-force', admin(async ({ req, user }) => {
  const { eventId, confirm } = (await readJsonBody(req)) ?? {};
  if (typeof eventId !== 'string' || confirm !== true) return err(400, 'eventId und confirm: true sind erforderlich.');
  const { openConflicts } = await emergencyRelease(eventId, user.id);
  return { status: 200, body: { released: true, openConflicts } };
}));

async function offlineState() {
  const { rows: [s] } = await query("SELECT event_id, role FROM instance_authority WHERE event_id IS NOT NULL AND role IN ('offline_primary', 'retired') LIMIT 1");
  return s;
}

async function buildReturnPackage(passphrase, final) {
  const state = await offlineState();
  const buffer = await exportReturnPackage(db, passphrase);
  return { buffer, finish: async () => { if (final && state?.role === 'offline_primary') await authority.retire(state.event_id); } };
}

router.post('/offline/return-package', admin(async ({ req, user }) => {
  const { passphrase, final } = (await readJsonBody(req)) ?? {};
  if (!validPassphrase(passphrase)) return err(400, 'Eine Passphrase (mind. 8 Zeichen) ist erforderlich.');
  const { buffer, finish } = await buildReturnPackage(passphrase, final === true);
  await finish();
  await logAudit({ actorId: user.id, action: 'offline_return_package', details: { final: final === true } });
  return download(buffer, `questin-rueckgabe-${today()}.qpkg`);
}));

function decodeFile(file) {
  return typeof file === 'string' && file ? Buffer.from(file, 'base64') : null;
}

router.post('/offline/return-import', admin(async ({ req, user }) => {
  const { file, passphrase, interim } = (await readJsonBody(req, MAX_PACKAGE_BODY)) ?? {};
  const buffer = decodeFile(file);
  if (!buffer || typeof passphrase !== 'string') return err(400, 'file (Base64) und passphrase sind erforderlich.');
  const pkg = await readPackage(db, buffer, passphrase, 'return');
  return { status: 200, body: present(await mergeReturnPackage(db, pkg, { userId: user.id, interim: interim === true })) };
}));

// Token auth instead of login: the offline laptop pushes its package directly.
router.post('/offline/return-import-token', async ({ req }) => {
  return guarded(async () => {
    const token = req.headers['x-return-token'];
    if (typeof token !== 'string' || !token) return err(401, 'Rückgabe-Token fehlt.');
    const { rows } = await query("SELECT snapshot_id FROM instance_authority WHERE role = 'delegated' AND snapshot_id IS NOT NULL");
    if (!rows.some((r) => safeEqual(returnToken(r.snapshot_id), token))) return err(401, 'Rückgabe-Token ungültig oder Delegation beendet.');
    const { file, passphrase, interim, sentAt } = (await readJsonBody(req, MAX_PACKAGE_BODY)) ?? {};
    const buffer = decodeFile(file);
    if (!buffer || typeof passphrase !== 'string') return err(400, 'file (Base64) und passphrase sind erforderlich.');
    const pkg = await readPackage(db, buffer, passphrase, 'return');
    if (!safeEqual(String(pkg.manifest.return_token), token)) return err(401, 'Rückgabe-Token passt nicht zum Paket.');
    const result = await mergeReturnPackage(db, pkg, { interim: interim === true, via: 'token', sentAt: sentAt ?? null });
    if (result.alreadyApplied) return err(409, 'Das Rückgabe-Token wurde für dieses Paket bereits verwendet.', 'TOKEN_USED');
    return { status: 200, body: present(result) };
  });
});

router.post('/offline/return-push', admin(async ({ req, user }) => {
  const { onlineUrl, passphrase, final } = (await readJsonBody(req)) ?? {};
  let base;
  try {
    const u = new URL(onlineUrl);
    if (!['http:', 'https:'].includes(u.protocol)) throw new Error('protocol');
    base = u.href.replace(/\/+$/, '');
  } catch {
    return err(400, 'onlineUrl muss eine http(s)-Adresse sein.');
  }
  if (!validPassphrase(passphrase)) return err(400, 'Eine Passphrase (mind. 8 Zeichen) ist erforderlich.');
  try {
    const health = await fetch(`${base}/health`, { signal: AbortSignal.timeout(5000) });
    if (!health.ok) throw new Error(`HTTP ${health.status}`);
  } catch (e) {
    return { status: 502, body: { reachable: false, error: `Online-Server nicht erreichbar (${e.message}). Bitte Datei-Export verwenden.` } };
  }
  const { buffer, finish } = await buildReturnPackage(passphrase, final === true);
  const token = open(buffer, passphrase).manifest.return_token;
  let response;
  try {
    response = await fetch(`${base}/offline/return-import-token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Return-Token': token },
      body: JSON.stringify({ file: buffer.toString('base64'), passphrase, interim: final !== true, sentAt: new Date().toISOString() }),
      signal: AbortSignal.timeout(120_000),
    });
  } catch (e) {
    return { status: 502, body: { reachable: false, error: `Übertragung fehlgeschlagen (${e.message}). Bitte Datei-Export verwenden.` } };
  }
  const body = await response.json().catch(() => ({}));
  if (!response.ok) return { status: response.status, body: { reachable: true, error: body.error ?? 'Online-Server hat das Paket abgelehnt.', code: body.code } };
  if (body.status !== 'clock_skew') await finish();
  await logAudit({ actorId: user.id, action: 'offline_return_package', details: { final: final === true, pushed: true, status: body.status } });
  return { status: 200, body: { reachable: true, result: body } };
}));

router.get('/offline/conflicts', admin(async ({ req }) => {
  const q = new URL(req.url, 'http://localhost').searchParams;
  return { status: 200, body: { conflicts: await listConflicts({ status: q.get('status') || undefined, type: q.get('type') || undefined }) } };
}));

router.get('/offline/conflicts.csv', admin(async ({ req }) => {
  const q = new URL(req.url, 'http://localhost').searchParams;
  const rows = await listConflicts({ status: q.get('status') || undefined, type: q.get('type') || undefined });
  const csv = toCsv(rows, [
    { label: 'ID', value: (r) => r.id },
    { label: 'Typ', value: (r) => r.type },
    { label: 'Objekt', value: (r) => r.entity },
    { label: 'Objekt-ID', value: (r) => r.entityId },
    { label: 'Status', value: (r) => r.status },
    { label: 'Lösung', value: (r) => r.resolution },
    { label: 'Offline-Stand', value: (r) => JSON.stringify(r.offlineValue) },
    { label: 'Online-Stand', value: (r) => JSON.stringify(r.onlineValue) },
    { label: 'Notiz', value: (r) => r.note },
    { label: 'Erstellt', value: (r) => new Date(r.createdAt).toLocaleString('de-DE', { timeZone: 'Europe/Berlin' }) },
    { label: 'Gelöst', value: (r) => (r.resolvedAt ? new Date(r.resolvedAt).toLocaleString('de-DE', { timeZone: 'Europe/Berlin' }) : '') },
  ]);
  return {
    status: 200, isBinary: true, body: Buffer.from(csv, 'utf8'),
    headers: { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="datenabgleich-konflikte-${today()}.csv"`, 'X-Content-Type-Options': 'nosniff' },
  };
}));

router.post('/offline/conflicts/:id/resolve', admin(async ({ req, params, user }) => {
  if (isOffline()) return err(409, 'Konflikte werden online gelöst.');
  const { resolution, note } = (await readJsonBody(req)) ?? {};
  if (typeof resolution !== 'string') return err(400, 'resolution ist erforderlich.');
  return { status: 200, body: await resolveConflict(params.id, resolution, user.id, typeof note === 'string' ? note : null) };
}));

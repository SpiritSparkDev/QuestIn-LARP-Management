import crypto from 'node:crypto';
import { query, withTransaction } from '../db.js';

// Which database may write check-in/tavern data of an event. No row = primary.
// ponytail: delegation is per event, but tavern writes are guarded instance-wide (see guard.js).
const TRANSITIONS = {
  primary: ['delegated', 'offline_primary'],
  delegated: ['primary'],
  offline_primary: ['retired'],
  retired: [],
};

const COLUMNS = `role, snapshot_id, snapshot_taken_at, delegated_at, delegated_by, generation, instance_id`;

function toState(row) {
  if (!row) return { role: 'primary', snapshotId: null, snapshotTakenAt: null, delegatedAt: null, delegatedBy: null, generation: 0 };
  return {
    role: row.role, snapshotId: row.snapshot_id, snapshotTakenAt: row.snapshot_taken_at,
    delegatedAt: row.delegated_at, delegatedBy: row.delegated_by, generation: row.generation,
  };
}

function invalid(from, to) {
  return Object.assign(new Error(`Übergang ${from} -> ${to} ist nicht erlaubt.`), { code: 'INVALID_TRANSITION' });
}

export async function getInstanceId() {
  await query('INSERT INTO instance_authority (event_id) VALUES (NULL) ON CONFLICT DO NOTHING');
  const { rows } = await query('SELECT instance_id FROM instance_authority WHERE event_id IS NULL');
  return rows[0].instance_id;
}

export async function getState(eventId) {
  const { rows } = await query(`SELECT ${COLUMNS} FROM instance_authority WHERE event_id = $1`, [eventId]);
  return toState(rows[0]);
}

// Locks the event's row (creating the primary default if missing), checks the
// transition and applies `set`; the optional log entry is written in the same transaction.
async function transition(eventId, to, { set = {}, log, userId = null } = {}) {
  return withTransaction(async (client) => {
    await client.query('INSERT INTO instance_authority (event_id) VALUES ($1) ON CONFLICT DO NOTHING', [eventId]);
    const { rows } = await client.query('SELECT * FROM instance_authority WHERE event_id = $1 FOR UPDATE', [eventId]);
    const from = rows[0].role;
    if (!TRANSITIONS[from].includes(to)) throw invalid(from, to);
    const next = { role: to, generation: rows[0].generation, ...set };
    if (typeof next.generation === 'function') next.generation = next.generation(rows[0].generation);
    const keys = Object.keys(next);
    const { rows: updated } = await client.query(
      `UPDATE instance_authority SET ${keys.map((k, i) => `${k} = $${i + 2}`).join(', ')} WHERE event_id = $1 RETURNING ${COLUMNS}`,
      [eventId, ...keys.map((k) => next[k])]
    );
    if (log) {
      await client.query(
        'INSERT INTO snapshot_log (event_id, snapshot_id, generation, created_by, result) VALUES ($1, $2, $3, $4, $5)',
        [eventId, log.snapshotId ?? updated[0].snapshot_id, updated[0].generation, userId, log.result]
      );
    }
    return toState(updated[0]);
  });
}

async function currentSnapshotId(eventId) {
  return (await getState(eventId)).snapshotId;
}

export function delegate(eventId, userId) {
  return transition(eventId, 'delegated', {
    userId, log: { result: 'delegated' },
    set: { snapshot_id: crypto.randomUUID(), snapshot_taken_at: new Date(), delegated_at: new Date(), delegated_by: userId, generation: (g) => g + 1 },
  });
}

const RELEASE = { snapshot_id: null, snapshot_taken_at: null, delegated_at: null, delegated_by: null, generation: (g) => g + 1 };

export async function returnToPrimary(eventId, userId) {
  const snapshotId = await currentSnapshotId(eventId);
  return transition(eventId, 'primary', { userId, log: { result: 'returned', snapshotId }, set: RELEASE });
}

// Emergency path: online takes over again; later return packages of that snapshot are rejected.
export async function forceRelease(eventId, userId) {
  const snapshotId = await currentSnapshotId(eventId);
  return transition(eventId, 'primary', { userId, log: { result: 'forced', snapshotId }, set: RELEASE });
}

// Offline instance after importing a snapshot.
export function becomeOfflinePrimary(eventId, { snapshotId, snapshotTakenAt }) {
  return transition(eventId, 'offline_primary', { set: { snapshot_id: snapshotId, snapshot_taken_at: snapshotTakenAt, delegated_at: snapshotTakenAt } });
}

// Offline instance after creating the return package.
export function retire(eventId) {
  return transition(eventId, 'retired');
}

// Instance-wide view for /account: the first non-primary event decides.
export async function getSummary() {
  const { rows } = await query(
    `SELECT role, snapshot_taken_at, delegated_at FROM instance_authority
     WHERE event_id IS NOT NULL AND role <> 'primary' ORDER BY delegated_at NULLS LAST LIMIT 1`
  );
  const { rows: conflicts } = await query("SELECT count(*)::int AS n FROM sync_conflicts WHERE status = 'open'");
  const row = rows[0];
  return {
    role: row?.role ?? 'primary',
    snapshotTakenAt: row?.snapshot_taken_at ?? null,
    delegatedSince: row?.delegated_at ?? null,
    openConflicts: conflicts[0].n,
  };
}

// Newest delegation across all events, for the instance-wide tavern guard and for messages.
export async function getDelegation(eventId) {
  const { rows } = await query(
    `SELECT snapshot_taken_at FROM instance_authority
     WHERE role = 'delegated' AND ($1::uuid IS NULL OR event_id = $1) ORDER BY delegated_at DESC LIMIT 1`,
    [eventId ?? null]
  );
  return rows[0] ?? null;
}

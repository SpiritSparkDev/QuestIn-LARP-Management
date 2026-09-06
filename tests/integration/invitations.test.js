import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

process.env.DATABASE_URL = process.env.TEST_DATABASE_URL
  || 'postgres://app:app@localhost:5433/pakyrion_test';
process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'a'.repeat(64);
delete process.env.SMTP_HOST;

const { runMigrations } = await import('../../db/migrate.js');
await runMigrations();

const { seedGroups } = await import('../../db/seedGroups.js');
await seedGroups();

const { query, closePool } = await import('../../backend/db.js');
const { createServer } = await import('../../backend/server.js');
const { createInvitation, getInvitationByToken, regenerateToken, markRedeemed, getInvitationById, cancelInvitation } = await import('../../backend/invitations/repository.js');

async function makeAdmin() {
  const { rows } = await query(
    "INSERT INTO users (email, first_name, last_name, group_id, email_verified) VALUES ($1, 'Inviter', '', (SELECT id FROM groups WHERE key = 'admin'), true) RETURNING id",
    [`inviter-${crypto.randomUUID()}@example.com`]
  );
  return rows[0].id;
}

async function scGroupId() {
  const { rows } = await query("SELECT id FROM groups WHERE key = 'sc'");
  return rows[0].id;
}

test('createInvitation stores encrypted fields that decrypt back correctly', async () => {
  const invitedBy = await makeAdmin();
  const groupId = await scGroupId();
  const invitation = await createInvitation({
    email: `invitee-${crypto.randomUUID()}@example.com`,
    firstName: 'Invited',
    lastName: 'Person',
    groupId,
    invitedBy,
    medicalNotes: 'keine',
  });
  assert.equal(invitation.medicalNotes, 'keine');
  const { rows } = await query('SELECT medical_notes_enc FROM invitations WHERE id = $1', [invitation.id]);
  assert.notEqual(rows[0].medical_notes_enc.toString('utf8'), 'keine');
});

test('POST /auth/invite/redeem creates a real user, logs them in, and marks the invitation redeemed', async () => {
  const server = createServer().listen(0);
  try {
    const { port } = server.address();
    const invitedBy = await makeAdmin();
    const groupId = await scGroupId();
    const invitation = await createInvitation({
      email: `redeem-${crypto.randomUUID()}@example.com`,
      firstName: 'Redeemer',
      lastName: '',
      groupId,
      invitedBy,
      address: 'Teststraße 1',
    });

    const res = await fetch(`http://localhost:${port}/auth/invite/redeem`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: invitation.token, password: 'correct horse battery staple' }),
    });
    assert.equal(res.status, 200);
    assert.ok(res.headers.get('set-cookie'));

    const { rows } = await query('SELECT email_verified, group_id, address_enc FROM users WHERE id = $1', [(await res.json()).id]);
    assert.equal(rows[0].email_verified, true);
    assert.equal(rows[0].group_id, groupId);
    assert.notEqual(rows[0].address_enc.toString('utf8'), 'Teststraße 1');

    const redeemed = await getInvitationByToken(invitation.token);
    assert.ok(redeemed.redeemedAt);
  } finally {
    server.close();
  }
});

test('POST /auth/invite/redeem rejects an already-redeemed token', async () => {
  const server = createServer().listen(0);
  try {
    const { port } = server.address();
    const invitedBy = await makeAdmin();
    const groupId = await scGroupId();
    const invitation = await createInvitation({
      email: `redeem-twice-${crypto.randomUUID()}@example.com`,
      firstName: 'Twice',
      lastName: '',
      groupId,
      invitedBy,
    });
    await fetch(`http://localhost:${port}/auth/invite/redeem`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: invitation.token, password: 'correct horse battery staple' }),
    });
    const res = await fetch(`http://localhost:${port}/auth/invite/redeem`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: invitation.token, password: 'correct horse battery staple' }),
    });
    assert.equal(res.status, 400);
  } finally {
    server.close();
  }
});

test('POST /auth/invite/redeem rejects an unknown token', async () => {
  const server = createServer().listen(0);
  try {
    const { port } = server.address();
    const res = await fetch(`http://localhost:${port}/auth/invite/redeem`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: 'not-a-real-token', password: 'correct horse battery staple' }),
    });
    assert.equal(res.status, 400);
  } finally {
    server.close();
  }
});

test('markRedeemed is a compare-and-swap: the second call on an already-redeemed invitation returns false', async () => {
  const invitedBy = await makeAdmin();
  const groupId = await scGroupId();
  const invitation = await createInvitation({
    email: `invitee-${crypto.randomUUID()}@example.com`,
    firstName: 'CAS',
    lastName: 'Check',
    groupId,
    invitedBy,
  });
  const first = await markRedeemed(invitation.id);
  const second = await markRedeemed(invitation.id);
  assert.equal(first, true);
  assert.equal(second, false);
});

test('regenerateToken changes the token and invalidates the old one', async () => {
  const invitedBy = await makeAdmin();
  const groupId = await scGroupId();
  const invitation = await createInvitation({
    email: `resend-${crypto.randomUUID()}@example.com`,
    firstName: 'Resend',
    lastName: 'Me',
    groupId,
    invitedBy,
  });
  const updated = await regenerateToken(invitation.id);
  assert.notEqual(updated.token, invitation.token);
  const oldLookup = await getInvitationByToken(invitation.token);
  assert.equal(oldLookup, null);
});

test('createInvitation stores an eventId and it round-trips', async () => {
  const invitedBy = await makeAdmin();
  const groupId = await scGroupId();
  const { rows: eventRows } = await query(
    "INSERT INTO events (name, event_date) VALUES ('Invite Test Con', '2027-05-01') RETURNING id"
  );
  const invitation = await createInvitation({
    email: `invitee-event-${crypto.randomUUID()}@example.com`,
    firstName: 'Invited',
    lastName: 'Person',
    groupId,
    invitedBy,
    eventId: eventRows[0].id,
  });
  assert.equal(invitation.eventId, eventRows[0].id);
});

test('cancelInvitation marks an open invitation cancelled and rejects a second call', async () => {
  const invitedBy = await makeAdmin();
  const groupId = await scGroupId();
  const invitation = await createInvitation({
    email: `invitee-cancel-${crypto.randomUUID()}@example.com`,
    firstName: 'To',
    lastName: 'Cancel',
    groupId,
    invitedBy,
  });
  const first = await cancelInvitation(invitation.id);
  assert.equal(first, true);
  const second = await cancelInvitation(invitation.id);
  assert.equal(second, false);
  const reloaded = await getInvitationById(invitation.id);
  assert.ok(reloaded.cancelledAt);
});

test('POST /auth/invite/redeem rejects a cancelled invitation', async () => {
  const server = createServer().listen(0);
  try {
    const { port } = server.address();
    const invitedBy = await makeAdmin();
    const groupId = await scGroupId();
    const invitation = await createInvitation({
      email: `redeem-cancelled-${crypto.randomUUID()}@example.com`,
      firstName: 'Cancelled',
      lastName: 'Invite',
      groupId,
      invitedBy,
    });
    await cancelInvitation(invitation.id);

    const res = await fetch(`http://localhost:${port}/auth/invite/redeem`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: invitation.token, password: 'correct horse battery staple' }),
    });
    assert.equal(res.status, 400);
  } finally {
    server.close();
  }
});

test('cancelInvitation still succeeds on an already-redeemed invitation', async () => {
  const invitedBy = await makeAdmin();
  const groupId = await scGroupId();
  const invitation = await createInvitation({
    email: `redeem-then-cancel-${crypto.randomUUID()}@example.com`,
    firstName: 'Redeem',
    lastName: 'ThenCancel',
    groupId,
    invitedBy,
  });
  await markRedeemed(invitation.id);
  const cancelled = await cancelInvitation(invitation.id);
  assert.equal(cancelled, true);
});

test.after(async () => {
  await query("DELETE FROM invitations");
  await query("DELETE FROM users WHERE email LIKE 'inviter-%' OR email LIKE 'invitee-%' OR email LIKE 'redeem-%' OR email LIKE 'resend-%'");
  await closePool();
});

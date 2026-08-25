import { test } from 'node:test';
import assert from 'node:assert/strict';

delete process.env.SMTP_HOST; // force the no-network jsonTransport fallback

const { sendVerificationEmail, sendPasswordResetEmail } = await import('../../backend/auth/mailer.js');

test('sendVerificationEmail resolves and includes the token in the message', async () => {
  const info = await sendVerificationEmail('user@example.com', 'abc123');
  assert.ok(info.message.includes('abc123'));
  assert.ok(info.message.includes('user@example.com'));
});

test('sendVerificationEmail links to verify.html, not the extensionless route', async () => {
  const info = await sendVerificationEmail('user@example.com', 'abc123');
  assert.ok(info.message.includes('.html?token=abc123'));
});

test('sendPasswordResetEmail resolves and includes the token in the message', async () => {
  const info = await sendPasswordResetEmail('user@example.com', 'reset-token-xyz');
  assert.ok(info.message.includes('reset-token-xyz'));
});

test('sendPasswordResetEmail links to reset-password.html, not the extensionless route', async () => {
  const info = await sendPasswordResetEmail('user@example.com', 'reset-token-xyz');
  assert.ok(info.message.includes('.html?token=reset-token-xyz'));
});

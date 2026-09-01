import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'a'.repeat(64); // backend/smtpSettings/repository.js -> fieldCrypto.js fail-fasts at import time if unset
delete process.env.SMTP_HOST; // force the no-network jsonTransport fallback
delete process.env.DATABASE_URL; // this unit test must never attempt a real DB connection — see backend/auth/mailer.js's DATABASE_URL guard

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

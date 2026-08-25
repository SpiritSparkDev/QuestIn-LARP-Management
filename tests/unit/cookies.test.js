import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCookies, serializeSessionCookie, clearSessionCookie, SESSION_COOKIE_NAME } from '../../backend/auth/cookies.js';

test('parses a single cookie', () => {
  assert.deepEqual(parseCookies('session=abc123'), { session: 'abc123' });
});

test('parses multiple cookies', () => {
  assert.deepEqual(parseCookies('a=1; session=abc123; b=2'), { a: '1', session: 'abc123', b: '2' });
});

test('an empty or missing header yields an empty object', () => {
  assert.deepEqual(parseCookies(''), {});
  assert.deepEqual(parseCookies(undefined), {});
});

test('serializeSessionCookie includes the token, HttpOnly, and an expiry', () => {
  const cookie = serializeSessionCookie('tok123', new Date('2030-01-01T00:00:00Z'));
  assert.ok(cookie.startsWith(`${SESSION_COOKIE_NAME}=tok123;`));
  assert.ok(cookie.includes('HttpOnly'));
  assert.ok(cookie.includes('SameSite=Lax'));
  assert.ok(cookie.includes('2030'));
});

test('clearSessionCookie expires in the past', () => {
  const cookie = clearSessionCookie();
  assert.ok(cookie.includes('1970'));
});

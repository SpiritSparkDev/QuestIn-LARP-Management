import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cameraErrorMessage } from '../../frontend/js/cameraErrors.js';

test('each failure gets its own explanation', () => {
  const messages = ['NotAllowedError', 'NotFoundError', 'NotReadableError', 'Weird']
    .map((name) => cameraErrorMessage({ name }));
  assert.equal(new Set(messages).size, 4);
  assert.match(messages[0], /verweigert/);
  assert.match(messages[1], /Keine Kamera/);
  assert.match(messages[2], /anderen App/);
});

test('an insecure page or a missing API is named before the browser error', () => {
  assert.match(cameraErrorMessage({ name: 'NotAllowedError' }, { secureContext: false }), /HTTPS/);
  assert.match(cameraErrorMessage(null, { hasMediaDevices: false }), /unterstützt keinen/);
});

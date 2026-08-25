import { test } from 'node:test';
import assert from 'node:assert/strict';
import { escapeHtml, renderField } from '../../frontend/js/formFields.js';

test('escapeHtml escapes the five dangerous characters', () => {
  assert.equal(escapeHtml(`<script>&"'`), '&lt;script&gt;&amp;&quot;&#39;');
});

test('escapeHtml treats null/undefined as an empty string', () => {
  assert.equal(escapeHtml(null), '');
  assert.equal(escapeHtml(undefined), '');
});

test('renderField renders a text input with the escaped value', () => {
  const html = renderField({ key: 'fraction', label: 'Fraktion', type: 'text', required: true }, 'Nord<mark>');
  assert.ok(html.includes('name="fraction"'));
  assert.ok(html.includes('value="Nord&lt;mark&gt;"'));
  assert.ok(html.includes('required'));
});

test('renderField renders a textarea for type "textarea"', () => {
  const html = renderField({ key: 'background', label: 'Hintergrund', type: 'textarea' }, 'some <b>text</b>');
  assert.ok(html.includes('<textarea'));
  assert.ok(html.includes('some &lt;b&gt;text&lt;/b&gt;'));
});

test('renderField handles a missing value as empty', () => {
  const html = renderField({ key: 'notes', label: 'Notizen', type: 'text' }, undefined);
  assert.ok(html.includes('value=""'));
});

test('renderField escapes a field key containing a double-quote', () => {
  const html = renderField({ key: 'weird"key', label: 'Weird', type: 'text' }, 'x');
  assert.ok(!html.includes('weird"key'));
  assert.ok(html.includes('weird&quot;key'));
});

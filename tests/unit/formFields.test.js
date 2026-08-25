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

test('renderField renders a select with an option per entry and marks the current value selected', () => {
  const field = { key: 'magischBegabt', label: 'Magisch begabt', type: 'select', options: ['Arkan', 'Bardisch'] };
  const html = renderField(field, 'Bardisch');
  assert.ok(html.includes('<select'));
  assert.ok(html.includes('<option value="Arkan">Arkan</option>'));
  assert.ok(html.includes('<option value="Bardisch" selected>Bardisch</option>'));
});

test('renderField adds a blank option to an optional select with no value chosen', () => {
  const field = { key: 'magischBegabt', label: 'Magisch begabt', type: 'select', options: ['Arkan'], required: false };
  const html = renderField(field, undefined);
  assert.ok(html.includes('<option value=""></option>'));
});

test('renderField required select has no blank option', () => {
  const field = { key: 'magischBegabt', label: 'Magisch begabt', type: 'select', options: ['Arkan'], required: true };
  const html = renderField(field, undefined);
  assert.ok(!html.includes('<option value=""></option>'));
});

test('renderField escapes select option labels', () => {
  const field = { key: 'x', label: 'X', type: 'select', options: ['<b>evil</b>'] };
  const html = renderField(field, undefined);
  assert.ok(!html.includes('<b>evil</b>'));
  assert.ok(html.includes('&lt;b&gt;evil&lt;/b&gt;'));
});

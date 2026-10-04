import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeRichText, sanitizeDocumentValue, sanitizeDocumentFields, richTextToPlain } from '../../backend/richText.js';

test('keeps allowed formatting tags and strips their attributes', () => {
  assert.equal(
    sanitizeRichText('<p style="color:red" onclick="x()">Hallo <strong class="a">Welt</strong></p>'),
    '<p>Hallo <strong>Welt</strong></p>',
  );
});

test('removes script/style blocks including their content', () => {
  assert.equal(sanitizeRichText('<p>a</p><script>alert(1)</script><style>p{}</style>'), '<p>a</p>');
});

test('drops unknown tags but keeps their text', () => {
  assert.equal(sanitizeRichText('<img src=x onerror=alert(1)>text<marquee>m</marquee>'), 'textm');
});

test('only http, https and mailto links survive, with safe rel/target', () => {
  assert.equal(
    sanitizeRichText('<a href="https://example.com/a?b=1&c=2" onclick="x">x</a>'),
    '<a href="https://example.com/a?b=1&amp;c=2" target="_blank" rel="noopener noreferrer">x</a>',
  );
  assert.equal(sanitizeRichText('<a href="javascript:alert(1)">x</a>'), 'x');
  assert.equal(sanitizeRichText('<a href="  JaVaScRiPt:alert(1)">x</a>'), 'x');
  assert.equal(sanitizeRichText('<a href="data:text/html,<b>">x</a>'), 'x');
});

test('escapes stray angle brackets in text and balances unclosed tags', () => {
  assert.equal(sanitizeRichText('1 < 2 > 0'), '1 &lt; 2 &gt; 0');
  assert.equal(sanitizeRichText('<ul><li>eins'), '<ul><li>eins</li></ul>');
  assert.equal(sanitizeRichText('text</p></b>'), 'text');
});

test('maps div and h1/h2 onto the allowed block tags', () => {
  assert.equal(sanitizeRichText('<div>a</div><h1>t</h1>'), '<p>a</p><h3>t</h3>');
});

test('sanitizeDocumentValue collapses empty editors to an empty string', () => {
  assert.equal(sanitizeDocumentValue('<p><br></p>'), '');
  assert.equal(sanitizeDocumentValue('<p>x</p>'), '<p>x</p>');
  assert.equal(sanitizeDocumentValue(null), null);
});

test('sanitizeDocumentFields only touches document-type fields', () => {
  const schema = [{ key: 'story', type: 'document' }, { key: 'note', type: 'text' }];
  assert.deepEqual(
    sanitizeDocumentFields(schema, { story: '<p onclick="x">a</p>', note: '<b>keep</b>' }),
    { story: '<p>a</p>', note: '<b>keep</b>' },
  );
});

test('richTextToPlain turns blocks into lines and decodes entities', () => {
  assert.equal(richTextToPlain('<p>a &amp; b</p><p>c</p>').trim(), 'a & b\nc');
});

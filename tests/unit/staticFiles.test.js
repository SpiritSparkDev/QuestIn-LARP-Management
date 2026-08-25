import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { serveStaticFile } from '../../backend/staticFiles.js';

test('serves an existing html file with the right content type', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'static-'));
  await writeFile(path.join(dir, 'index.html'), '<h1>hi</h1>');
  const result = await serveStaticFile('/index.html', dir);
  assert.equal(result.contentType, 'text/html; charset=utf-8');
  assert.equal(result.data.toString('utf8'), '<h1>hi</h1>');
  await rm(dir, { recursive: true, force: true });
});

test('serves a nested css file', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'static-'));
  await mkdir(path.join(dir, 'css'), { recursive: true });
  await writeFile(path.join(dir, 'css', 'style.css'), 'body{color:red}');
  const result = await serveStaticFile('/css/style.css', dir);
  assert.equal(result.contentType, 'text/css; charset=utf-8');
  assert.equal(result.data.toString('utf8'), 'body{color:red}');
  await rm(dir, { recursive: true, force: true });
});

test('an unknown extension returns null', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'static-'));
  await writeFile(path.join(dir, 'data.json'), '{}');
  assert.equal(await serveStaticFile('/data.json', dir), null);
  await rm(dir, { recursive: true, force: true });
});

test('a missing file returns null', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'static-'));
  assert.equal(await serveStaticFile('/does-not-exist.html', dir), null);
  await rm(dir, { recursive: true, force: true });
});

test('path traversal outside the base directory is blocked', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'static-'));
  const result = await serveStaticFile('/../../../../../../etc/passwd', dir);
  assert.equal(result, null);
  await rm(dir, { recursive: true, force: true });
});

test('/ serves index.html', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'static-'));
  await writeFile(path.join(dir, 'index.html'), 'root');
  const result = await serveStaticFile('/', dir);
  assert.equal(result.data.toString('utf8'), 'root');
  await rm(dir, { recursive: true, force: true });
});

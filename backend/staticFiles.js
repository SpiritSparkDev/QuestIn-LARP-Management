import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_FRONTEND_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'frontend');

const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
};

export async function serveStaticFile(pathname, baseDir = DEFAULT_FRONTEND_DIR) {
  const relativePath = pathname === '/' ? '/index.html' : pathname;
  const resolvedBase = path.resolve(baseDir);
  const resolved = path.resolve(resolvedBase, `.${relativePath}`);
  if (resolved !== resolvedBase && !resolved.startsWith(resolvedBase + path.sep)) {
    return null;
  }

  const ext = path.extname(resolved);
  const contentType = CONTENT_TYPES[ext];
  if (!contentType) return null;

  try {
    const data = await readFile(resolved);
    return { data, contentType };
  } catch {
    return null;
  }
}

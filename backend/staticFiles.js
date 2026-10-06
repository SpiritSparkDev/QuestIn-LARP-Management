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
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
};

// Short, bookmarkable addresses for pages that are used on their own (e.g. a
// tablet at the check-in desk or behind the bar). The page itself notices it
// was opened through one of these and switches to its full-screen layout.
const PAGE_ALIASES = {
  '/checkin': '/admin/checkin.html',
  '/taverne': '/admin/tavern.html',
};

export async function serveStaticFile(pathname, baseDir = DEFAULT_FRONTEND_DIR) {
  const relativePath = pathname === '/' ? '/index.html' : (PAGE_ALIASES[pathname] ?? pathname);
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

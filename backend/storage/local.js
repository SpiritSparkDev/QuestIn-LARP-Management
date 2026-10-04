import fs from 'node:fs/promises';
import path from 'node:path';

export function localStorage({ uploadsDir } = {}) {
  const dir = uploadsDir || process.env.UPLOADS_DIR || './uploads';
  return {
    // `id` may be a nested key like "<characterId>/<fileId>" (one folder per
    // character); legacy files still use a flat id.
    async upload(id, buffer) {
      const target = path.join(dir, id);
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, buffer);
    },
    async download(id) {
      return fs.readFile(path.join(dir, id));
    },
    async remove(id) {
      const target = path.join(dir, id);
      await fs.unlink(target);
      // Tidy up an emptied character folder; rmdir refuses non-empty ones.
      if (path.dirname(target) !== path.resolve(dir) && path.dirname(id) !== '.') {
        await fs.rmdir(path.dirname(target)).catch(() => {});
      }
    },
    async testConnection() {
      await fs.mkdir(dir, { recursive: true });
    },
  };
}

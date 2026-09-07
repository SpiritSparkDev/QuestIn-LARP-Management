import fs from 'node:fs/promises';
import path from 'node:path';

export function localStorage({ uploadsDir } = {}) {
  const dir = uploadsDir || process.env.UPLOADS_DIR || './uploads';
  return {
    async upload(id, buffer) {
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(path.join(dir, id), buffer);
    },
    async download(id) {
      return fs.readFile(path.join(dir, id));
    },
    async remove(id) {
      await fs.unlink(path.join(dir, id));
    },
    async testConnection() {
      await fs.mkdir(dir, { recursive: true });
    },
  };
}

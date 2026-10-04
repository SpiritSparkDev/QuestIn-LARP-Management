import { Client } from 'basic-ftp';
import { Readable, PassThrough } from 'node:stream';

async function withClient(config, fn) {
  const client = new Client();
  try {
    await client.access({
      host: config.host,
      port: config.port || 21,
      user: config.username,
      password: config.password,
      secure: config.secure !== false,
    });
    return await fn(client);
  } finally {
    client.close();
  }
}

function remotePath(baseDir, id) {
  return `${(baseDir || '').replace(/\/$/, '')}/${id}`;
}

export function ftpStorage(config) {
  return {
    async upload(id, buffer) {
      await withClient(config, async (client) => {
        const target = remotePath(config.baseDir, id);
        // Nested keys ("<characterId>/<fileId>") need their folder first.
        const folder = target.slice(0, target.lastIndexOf('/'));
        if (folder) await client.ensureDir(folder);
        await client.uploadFrom(Readable.from(buffer), target);
      });
    },
    async download(id) {
      return withClient(config, async (client) => {
        const chunks = [];
        const sink = new PassThrough();
        sink.on('data', (chunk) => chunks.push(chunk));
        await client.downloadTo(sink, remotePath(config.baseDir, id));
        return Buffer.concat(chunks);
      });
    },
    async remove(id) {
      await withClient(config, (client) => client.remove(remotePath(config.baseDir, id)));
    },
    async testConnection() {
      await withClient(config, (client) => client.list(config.baseDir || '/'));
    },
  };
}

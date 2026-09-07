import { localStorage } from './local.js';
import { ftpStorage } from './ftp.js';
import { s3Storage } from './s3.js';

export function getStorage(backend, settings) {
  if (backend === 'ftp') return ftpStorage(settings.ftp);
  if (backend === 's3') return s3Storage(settings.s3);
  return localStorage(settings.local ?? {});
}

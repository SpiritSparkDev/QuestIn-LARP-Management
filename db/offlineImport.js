import { readFile } from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import * as db from '../backend/db.js';
import { runMigrations } from './migrate.js';
import { importSnapshot } from '../backend/offlinePackage/snapshot.js';

const MESSAGES = {
  NOT_EMPTY: 'Die Datenbank ist nicht leer. Import nur in eine frische Offline-Instanz möglich (docker compose ... down -v, dann neu starten).',
  BAD_PASSPHRASE: 'Falsche Passphrase oder beschädigte Datei.',
  BAD_SIGNATURE: 'Signatur ungültig: Der ENCRYPTION_KEY dieser Instanz passt nicht zum Paket, oder die Datei wurde verändert.',
  SCHEMA_MISMATCH: 'Die App-Version dieser Instanz passt nicht zum Paket. Gleiche Version wie online bereitstellen.',
};

// Reads the passphrase without echoing it.
function askPassphrase() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  rl._writeToOutput = (s) => { if (s.includes('Passphrase')) process.stdout.write(s); };
  return new Promise((resolve) => rl.question('Passphrase: ', (a) => { rl.close(); process.stdout.write('\n'); resolve(a); }));
}

export async function offlineImport(file, passphrase) {
  const buffer = await readFile(file);
  await runMigrations();
  const { rows } = await db.query("SELECT 1 FROM instance_authority WHERE role = 'offline_primary' LIMIT 1");
  if (rows.length) {
    const e = new Error('Diese Instanz ist bereits eine Offline-Version und nimmt keinen weiteren Snapshot an.');
    e.code = 'ALREADY_OFFLINE';
    throw e;
  }
  return importSnapshot(db, buffer, passphrase);
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMain) {
  const file = process.argv[2];
  if (!file) {
    console.error('Aufruf: npm run offline:import -- <datei.qpkg>');
    process.exit(2);
  }
  let code = 0;
  try {
    const res = await offlineImport(file, process.env.OFFLINE_PASSPHRASE || await askPassphrase());
    console.log(`Import erfolgreich. Event ${res.eventId}, Snapshot vom ${new Date(res.manifest.taken_at).toISOString()}. Diese Instanz ist jetzt die Offline-Version.`);
  } catch (err) {
    console.error(`Import fehlgeschlagen${err.code ? ` (${err.code})` : ''}: ${MESSAGES[err.code] || err.message}`);
    code = 1;
  } finally {
    await db.closePool();
  }
  process.exit(code);
}

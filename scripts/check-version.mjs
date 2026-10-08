// Fails when the app version differs between the places CLAUDE.md says must
// stay in sync: frontend/js/version.js, package.json and the two root entries
// of package-lock.json.
import { readFileSync } from 'node:fs';

const root = new URL('../', import.meta.url);
const read = (file) => readFileSync(new URL(file, root), 'utf8');

const appVersion = /APP_VERSION\s*=\s*['"]([^'"]+)['"]/.exec(read('frontend/js/version.js'))?.[1];
const pkg = JSON.parse(read('package.json'));
const lock = JSON.parse(read('package-lock.json'));

const versions = {
  'frontend/js/version.js (APP_VERSION)': appVersion,
  'package.json': pkg.version,
  'package-lock.json (root)': lock.version,
  'package-lock.json (packages[""])': lock.packages?.['']?.version,
};

const distinct = new Set(Object.values(versions));
if (distinct.size !== 1 || distinct.has(undefined)) {
  console.error('Version mismatch:');
  for (const [where, version] of Object.entries(versions)) console.error(`  ${where}: ${version ?? 'missing'}`);
  process.exit(1);
}
console.log(`Version ${appVersion} is consistent.`);

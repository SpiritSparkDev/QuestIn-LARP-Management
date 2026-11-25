// Zusatzangaben für das QuestIn-Verzeichnis (Feed v1.1, siehe questin-hub
// docs/feed-format.md). Schlüssel identisch mit dem Hub.
import { query } from '../db.js';
import { loadCapacity } from '../registrations/capacity.js';
import { resolvePriceForGroup } from '../events/repository.js';

export const DIRECTORY_REGIONS = {
  'DE-BW': 'Baden-Württemberg', 'DE-BY': 'Bayern', 'DE-BE': 'Berlin', 'DE-BB': 'Brandenburg', 'DE-HB': 'Bremen',
  'DE-HH': 'Hamburg', 'DE-HE': 'Hessen', 'DE-MV': 'Mecklenburg-Vorpommern', 'DE-NI': 'Niedersachsen',
  'DE-NW': 'Nordrhein-Westfalen', 'DE-RP': 'Rheinland-Pfalz', 'DE-SL': 'Saarland', 'DE-SN': 'Sachsen',
  'DE-ST': 'Sachsen-Anhalt', 'DE-SH': 'Schleswig-Holstein', 'DE-TH': 'Thüringen',
  AT: 'Österreich', CH: 'Schweiz', OTHER: 'Anderes Land',
};

export const DIRECTORY_GENRES = {
  fantasy: 'Fantasy', mittelalter: 'Mittelalter', endzeit: 'Endzeit', horror: 'Horror', scifi: 'Science-Fiction',
  steampunk: 'Steampunk', vampire: 'Vampire', historisch: 'Historisch', sonstiges: 'Sonstiges',
};

export const MAX_GENRES = 3;
export const MAX_TEASER = 300;

const DETAIL_KEYS = ['directoryRegion', 'directoryGenres', 'registrationOpensAt', 'directoryTeaser'];
export const hasDirectoryDetails = (body) => DETAIL_KEYS.some((k) => body[k] !== undefined);

// Prüft nur die Felder, die im Body stehen. Gibt einen Fehlertext oder null zurück.
export function validateDirectoryDetails(body) {
  const region = body.directoryRegion;
  if (region !== undefined && region !== null && region !== '' && !Object.hasOwn(DIRECTORY_REGIONS, region)) {
    return 'directoryRegion is not a known region';
  }
  const genres = body.directoryGenres;
  if (genres !== undefined) {
    if (!Array.isArray(genres) || genres.some((g) => !Object.hasOwn(DIRECTORY_GENRES, g))) return 'directoryGenres must be a list of known genres';
    if (new Set(genres).size > MAX_GENRES) return `at most ${MAX_GENRES} genres`;
  }
  const teaser = body.directoryTeaser;
  if (teaser !== undefined && teaser !== null && (typeof teaser !== 'string' || teaser.trim().length > MAX_TEASER)) {
    return `directoryTeaser must be a text of at most ${MAX_TEASER} characters`;
  }
  const opens = body.registrationOpensAt;
  if (opens !== undefined && opens !== null && opens !== '') {
    if (typeof opens !== 'string' || Number.isNaN(Date.parse(opens))) return 'registrationOpensAt must be a date';
  }
  return null;
}

export async function setDirectoryDetails(id, body) {
  const sets = [];
  const params = [id];
  const add = (column, value) => {
    params.push(value);
    sets.push(`${column} = $${params.length}`);
  };
  if (body.directoryRegion !== undefined) add('directory_region', body.directoryRegion || null);
  if (body.directoryGenres !== undefined) add('directory_genres', [...new Set(body.directoryGenres)]);
  if (body.directoryTeaser !== undefined) add('directory_teaser', body.directoryTeaser?.trim() || null);
  if (body.registrationOpensAt !== undefined) {
    add('registration_opens_at', body.registrationOpensAt ? new Date(body.registrationOpensAt).toISOString() : null);
  }
  if (sets.length) await query(`UPDATE events SET ${sets.join(', ')} WHERE id = $1`, params);
}

// Titelbild fürs Verzeichnis (v1.2). PNG, JPEG oder WebP, höchstens 1 MB, wie
// der Hub es annimmt; der Typ kommt aus den Bytes, nicht aus der Angabe.
export const MAX_DIRECTORY_IMAGE_BYTES = 1024 * 1024;

export function imageTypeOf(bytes) {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes.length >= 12 && bytes.subarray(0, 4).toString('latin1') === 'RIFF' && bytes.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  return null;
}

export async function setDirectoryImage(id, data, type) {
  const { rowCount } = await query(
    'UPDATE events SET directory_image = $2, directory_image_type = $3, directory_image_updated_at = CASE WHEN $2::bytea IS NULL THEN NULL ELSE now() END WHERE id = $1',
    [id, data, type]);
  return rowCount > 0;
}

export async function getDirectoryImage(id, { published = true } = {}) {
  const { rows } = await query(
    `SELECT directory_image AS data, directory_image_type AS type FROM events
     WHERE id = $1 AND directory_image IS NOT NULL${published ? ' AND directory_published AND NOT is_test' : ''}`, [id]);
  return rows[0] ?? null;
}

// Platzstatus fürs Verzeichnis: closed (Anmeldung noch nicht offen),
// waitlist (Obergrenze erreicht), few ("Nur noch wenige Plätze"), open.
export async function availabilityOf(event, now = new Date()) {
  if (event.registration_opens_at && new Date(event.registration_opens_at) > now) return 'closed';
  const { limits, counts } = await loadCapacity(query, event.id);
  if (limits.total !== null && counts.total >= limits.total) return 'waitlist';
  if (event.low_seats) return 'few';
  return 'open';
}

// Günstigster Preis der heute gültigen Preisstufe (über alle Teilnahmegruppen), in Cent.
export function priceFromCents(pricing, now = new Date()) {
  const prices = (pricing?.groups ?? [])
    .map((g) => resolvePriceForGroup(pricing, g, now)?.amountCents)
    .filter((c) => Number.isInteger(c) && c >= 0);
  return prices.length ? Math.min(...prices) : null;
}

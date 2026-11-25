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

const DETAIL_KEYS = ['directoryRegion', 'directoryGenres', 'registrationOpensAt'];
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
  if (body.registrationOpensAt !== undefined) {
    add('registration_opens_at', body.registrationOpensAt ? new Date(body.registrationOpensAt).toISOString() : null);
  }
  if (sets.length) await query(`UPDATE events SET ${sets.join(', ')} WHERE id = $1`, params);
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

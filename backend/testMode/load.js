import { query, withTransaction } from '../db.js';
import { getAccountFieldSchema } from '../accountFieldSchema/repository.js';
import { getRegistrationFieldSchema } from '../registrationFieldSchema/repository.js';
import { getScCharacterSchema } from '../scSchema/repository.js';
import { getNscProfileSchema } from '../nscSchema/repository.js';
import { getAppSettings } from '../appSettings/repository.js';
import { encryptFieldBlob } from '../accountFields.js';
import { encryptFieldBlob as encryptRegistrationBlob } from '../registrationFields.js';
import { createCharacter } from '../characters/repository.js';
import { createAccount as createTavernAccount, topUp as tavernTopUp } from '../tavern/repository.js';
import { buildTestDataset } from './dataset.js';

function testModeError(message, code) {
  const err = new Error(message);
  err.code = code;
  return err;
}

// ---- generic field filling -------------------------------------------
// The account / registration / character forms are admin-editable schemas,
// so test values are generated from each field's type (and a few well-known
// keys) instead of hardcoding field names.

const TEXT_BY_KEY = {
  klasse: ['Krieger', 'Magier', 'Heiler', 'Schurke', 'Barde', 'Jäger'],
  volk: ['Mensch', 'Zwerg', 'Elf', 'Halbork', 'Gnom'],
  beruf: ['Schmied', 'Kräuterkundige', 'Händlerin', 'Söldner', 'Schreiber', 'Gaukler'],
  gruppe: ['Haus Falkenstein', 'Die Rabenschar', 'Eisenwolf', 'Silberne Feder'],
  religion: ['Der Eine', 'Naturgeister', 'Ahnenkult', 'Keine'],
  gesinnung: ['rechtschaffen', 'neutral', 'chaotisch'],
  heimatland: ['Ravenmoor', 'Nordmark', 'Sonnental', 'Aschenfeld'],
  titel: ['', '', 'Ritter', 'Magister', 'Hauptmann'],
  conTage: ['Do–So', 'Fr–So', 'Sa–So'],
  accommodation: ['Hütte', 'IT-Zelt, 2 Personen, 12 qm', 'OT-Zelt, 1 Person, 6 qm'],
  craftOffer: ['', '', 'Schmieden', 'Lederarbeiten', 'Kerzenziehen'],
  travelMethod: ['Auto', 'Bahn', 'Motorrad', 'muss abgeholt werden'],
  address: ['Musterstraße 12, 12345 Teststadt', 'Am Fiktivweg 7, 54321 Beispielburg', 'Beispielallee 3, 10115 Testhausen'],
};

function pick(list, seed) {
  return list[Math.abs(seed) % list.length];
}

function fillValue(field, seed) {
  switch (field.type) {
    case 'boolean': return seed % 5 === 0;
    case 'number': return 100 + (seed % 900);
    case 'date': return `19${70 + (seed % 30)}-0${1 + (seed % 9)}-1${seed % 9}`;
    case 'link': return 'https://example.com/test';
    case 'select':
      return Array.isArray(field.options) && field.options.length ? pick(field.options, seed) : '';
    case 'multiselect':
      return Array.isArray(field.options) && field.options.length ? [pick(field.options, seed)] : [];
    case 'textarea': return 'Fiktiver Testtext für den Test-Modus.';
    default: {
      const known = TEXT_BY_KEY[field.key];
      if (known) return pick(known, seed);
      if (/phone|telefon/i.test(field.key)) return `0151 ${String(1000000 + (seed * 7919) % 8999999)}`;
      return field.required ? 'Testwert' : '';
    }
  }
}

function fillSchema(schema, seed, { skipKeys = [] } = {}) {
  const data = {};
  schema.forEach((field, i) => {
    if (skipKeys.includes(field.key)) return;
    const value = fillValue(field, seed + i * 3);
    const empty = value === '' || (Array.isArray(value) && value.length === 0);
    if (!empty || field.required) data[field.key] = empty ? 'Testwert' : value;
  });
  return data;
}

// ---- status / load / remove --------------------------------------------

export async function getTestModeStatus() {
  const { rows } = await query(
    `SELECT (SELECT COUNT(*)::int FROM users WHERE is_test) AS people,
            (SELECT COUNT(*)::int FROM events WHERE is_test) AS events,
            (SELECT COUNT(*)::int FROM characters c JOIN users u ON u.id = c.user_id WHERE u.is_test) AS characters,
            COALESCE((SELECT test_mode_enabled FROM app_settings LIMIT 1), false) AS enabled`
  );
  const r = rows[0];
  return { enabled: r.enabled || r.people > 0 || r.events > 0, people: r.people, events: r.events, characters: r.characters };
}

export async function isTestModeEnabled() {
  return (await getTestModeStatus()).enabled;
}

async function setTestModeFlag(enabled) {
  const { rows } = await query('SELECT id FROM app_settings LIMIT 1');
  if (rows.length === 0) await query('INSERT INTO app_settings (test_mode_enabled) VALUES ($1)', [enabled]);
  else await query('UPDATE app_settings SET test_mode_enabled = $1', [enabled]);
}

export async function loadTestData() {
  if ((await getTestModeStatus()).enabled) {
    throw testModeError('Die Testdaten sind bereits geladen.', 'ALREADY_LOADED');
  }
  const dataset = buildTestDataset();
  const [accountSchema, registrationSchema, scSchema, nscSchema, settings] = await Promise.all([
    getAccountFieldSchema(), getRegistrationFieldSchema(), getScCharacterSchema(), getNscProfileSchema(), getAppSettings(),
  ]);

  try {
    // Event: only becomes the active one if no real event is active.
    const { rows: activeRows } = await query('SELECT 1 FROM events WHERE is_active LIMIT 1');
    const { event } = dataset;
    const { rows: eventRows } = await query(
      `INSERT INTO events (name, event_date, code, capacity, flags, pricing, directions, briefing, address, is_active, is_test)
       VALUES ($1, '2027-12-11', $2, $3, $4, $5, $6, $7, $8, $9, true) RETURNING id`,
      [event.name, event.code, event.capacity, event.flags, JSON.stringify(event.pricing), event.directions, event.briefing, event.address, activeRows.length === 0]
    );
    const eventId = eventRows[0].id;

    // People, in two passes so group members can point at their owner.
    const ownerIdByGroup = new Map();
    const userIdByIndex = new Map();
    for (const phase of ['owners-and-singles', 'members']) {
      for (const p of dataset.persons) {
        if ((phase === 'members') !== p.isManaged) continue;
        const accountData = fillSchema(accountSchema, p.index + 1, { skipKeys: ['group'] });
        const { rows } = await query(
          `INSERT INTO users (email, group_id, first_name, last_name, nickname, is_guest, email_verified, account_data_enc, managed_by_user_id, is_test)
           VALUES ($1, (SELECT id FROM groups WHERE key = 'mitglied'), $2, $3, $4, $5, true, $6, $7, true) RETURNING id`,
          [p.isManaged ? null : p.email, p.firstName, p.lastName, p.nickname, p.isGuest, encryptFieldBlob(accountData), p.isManaged ? ownerIdByGroup.get(p.groupIndex) : null]
        );
        userIdByIndex.set(p.index, rows[0].id);
        if (p.isGroupOwner) ownerIdByGroup.set(p.groupIndex, rows[0].id);
      }
    }

    // Characters and registrations.
    let waitlistPosition = 0;
    for (const p of dataset.persons) {
      const userId = userIdByIndex.get(p.index);
      const group = p.groupIndex !== null ? dataset.groups[p.groupIndex].name : null;
      const scData = fillSchema(scSchema, p.index + 11);
      if (group && scSchema.some((f) => f.key === 'gruppe')) scData.gruppe = group;
      const sc = await createCharacter(userId, { characterClass: 'sc', name: p.characterName, data: scData });
      let nscId = null;
      if (p.hasNscCharacter) {
        const nsc = await createCharacter(userId, { characterClass: 'nsc', name: p.nscCharacterName, data: fillSchema(nscSchema, p.index + 21) });
        nscId = nsc.id;
      }

      const characterId = p.role === 'sc' ? sc.id : p.role === 'nsc' ? nscId : null;
      const tier = event.pricing.tiers[1];
      const listCents = tier.amounts[p.priceGroup];
      const regData = fillSchema(registrationSchema, p.index + 31);
      const createdAt = new Date(Date.now() - (dataset.persons.length - p.index) * 3_600_000);
      await query(
        `INSERT INTO registrations (user_id, event_id, con_role, character_id, flags, price_group, price_tier, price_list_cents, amount_due_cents,
                                    registration_data_enc, status, paid_at, checked_in_at, waiver_version_accepted, waiver_accepted_at, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $8, $9, $10, $11, $12, $13, $14, $15)`,
        [
          userId, eventId, p.role, characterId, p.flags, p.priceGroup, tier.name, listCents,
          encryptRegistrationBlob(regData), p.status,
          p.paid ? createdAt : null,
          p.status === 'checked_in' ? new Date() : null,
          settings.waiverText ? settings.waiverVersion : null, settings.waiverText ? createdAt : null, createdAt,
        ]
      );
      if (p.status === 'waitlisted') waitlistPosition += 1;
    }

    // Tavern accounts for every other participant, when that add-on is on.
    if (settings.tavernEnabled) {
      for (const p of dataset.persons.filter((x) => x.index % 2 === 0 && x.status !== 'cancelled')) {
        const account = await createTavernAccount({ eventId, userId: userIdByIndex.get(p.index) });
        await tavernTopUp(account.id, { amountCents: 1000 + (p.index % 5) * 500, method: p.index % 4 === 0 ? 'card' : 'cash' });
      }
    }

    await setTestModeFlag(true);
    return { ...(await getTestModeStatus()), eventId, groups: dataset.groups.length, waitlisted: waitlistPosition };
  } catch (err) {
    // A half-loaded data set is worse than none: undo whatever was created.
    await removeTestData().catch(() => {});
    throw err;
  }
}

// Everything flagged is_test goes: the event (with registrations, payments,
// tavern accounts via cascade) and the people (with characters, sessions).
export async function removeTestData() {
  await withTransaction(async (client) => {
    await client.query('DELETE FROM events WHERE is_test');
    await client.query('DELETE FROM users WHERE is_test');
  });
  await setTestModeFlag(false);
  return getTestModeStatus();
}

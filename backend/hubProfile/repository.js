// Gemeinsames Stammprofil aus dem QuestIn-Hub (Phase 4): lokale Kopie je
// Kategorie, Zuordnung Hub-Schlüssel -> Kontofeld, Abgleich mit dem Konto.
import { query } from '../db.js';
import { encryptField, decryptField } from '../crypto/fieldCrypto.js';
import { PRIVACY_CATEGORIES } from '../privacy/repository.js';
import { getAccountFieldSchema } from '../accountFieldSchema/repository.js';
import { getAccount, updateAccount } from '../accounts/repository.js';
import { logAudit } from '../audit/repository.js';
import { logger } from '../logger.js';

// Must match the hub (docs/login.md im Repo questin-hub).
export const HUB_PROFILE_FIELDS = {
  birth_date: { category: 'persoenlich', label: 'Geburtsdatum' },
  phone: { category: 'kontakt', label: 'Telefon' },
  address_street: { category: 'kontakt', label: 'Straße und Hausnummer' },
  address_zip: { category: 'kontakt', label: 'PLZ' },
  address_city: { category: 'kontakt', label: 'Ort' },
  address_country: { category: 'kontakt', label: 'Land' },
  emergency_contact_name: { category: 'notfall', label: 'Notfallkontakt: Name' },
  emergency_contact_phone: { category: 'notfall', label: 'Notfallkontakt: Telefon' },
  allergies: { category: 'gesundheit', label: 'Allergien' },
  medications: { category: 'gesundheit', label: 'Medikamente' },
  intolerances: { category: 'gesundheit', label: 'Unverträglichkeiten' },
};
const HUB_CATEGORIES = [...new Set(Object.values(HUB_PROFILE_FIELDS).map((f) => f.category))];

export async function getMapping() {
  const { rows } = await query('SELECT hub_key, account_field_key FROM hub_profile_mapping');
  return Object.fromEntries(rows.map((r) => [r.hub_key, r.account_field_key]));
}

// mapping: { hubKey: accountFieldKey | '' }. Unknown keys or fields are rejected.
export async function setMapping(mapping) {
  const fieldKeys = new Set((await getAccountFieldSchema()).map((f) => f.key));
  const entries = Object.entries(mapping ?? {}).filter(([, v]) => v);
  for (const [hubKey, fieldKey] of entries) {
    if (!Object.hasOwn(HUB_PROFILE_FIELDS, hubKey)) return { error: `Unbekannter Hub-Schlüssel: ${hubKey}` };
    if (!fieldKeys.has(fieldKey)) return { error: `Unbekanntes Kontofeld: ${fieldKey}` };
  }
  await query('DELETE FROM hub_profile_mapping');
  for (const [hubKey, fieldKey] of entries) {
    await query('INSERT INTO hub_profile_mapping (hub_key, account_field_key) VALUES ($1, $2)', [hubKey, fieldKey]);
  }
  return { mapping: Object.fromEntries(entries) };
}

// Stores what the hub returned: one row per consented category; categories
// without consent (any more) are removed.
export async function storeSnapshot(userId, { categories = [], profile = {}, updatedAt = null }) {
  const allowed = categories.filter((c) => HUB_CATEGORIES.includes(c));
  for (const category of allowed) {
    const values = {};
    for (const [key, field] of Object.entries(HUB_PROFILE_FIELDS)) {
      if (field.category === category && typeof profile[key] === 'string') values[key] = profile[key];
    }
    await query(
      `INSERT INTO hub_profile_snapshots (user_id, category, data, hub_updated_at, fetched_at) VALUES ($1, $2, $3, $4, now())
       ON CONFLICT (user_id, category) DO UPDATE SET data = EXCLUDED.data, hub_updated_at = EXCLUDED.hub_updated_at, fetched_at = now()`,
      [userId, category, encryptField(JSON.stringify(values)), updatedAt]
    );
  }
  await query('DELETE FROM hub_profile_snapshots WHERE user_id = $1 AND NOT (category = ANY($2))', [userId, allowed]);
}

export async function deleteSnapshots(userId, categories = null) {
  if (categories) await query('DELETE FROM hub_profile_snapshots WHERE user_id = $1 AND category = ANY($2)', [userId, categories]);
  else await query('DELETE FROM hub_profile_snapshots WHERE user_id = $1', [userId]);
}

async function snapshotValues(userId) {
  const { rows } = await query('SELECT data, fetched_at FROM hub_profile_snapshots WHERE user_id = $1', [userId]);
  const values = {};
  let fetchedAt = null;
  for (const row of rows) {
    Object.assign(values, JSON.parse(decryptField(row.data)));
    if (!fetchedAt || row.fetched_at > fetchedAt) fetchedAt = row.fetched_at;
  }
  return { values, fetchedAt };
}

// Abweichungen zwischen Hub-Kopie und Konto, nur für zugeordnete Felder.
export async function profileOffer(userId) {
  const [mapping, schema, account, { values, fetchedAt }] = await Promise.all([
    getMapping(), getAccountFieldSchema(), getAccount(userId), snapshotValues(userId),
  ]);
  const fields = new Map(schema.map((f) => [f.key, f]));
  const items = [];
  for (const [hubKey, fieldKey] of Object.entries(mapping)) {
    if (values[hubKey] === undefined || !fields.has(fieldKey)) continue;
    const local = account?.[fieldKey] ?? '';
    items.push({
      hubKey, fieldKey, label: fields.get(fieldKey).label ?? fieldKey,
      local: local == null ? '' : String(local), hub: values[hubKey], same: String(local ?? '') === values[hubKey],
    });
  }
  return { fetchedAt, mapped: Object.keys(mapping).length > 0, items };
}

// Übernahme ausgewählter Felder = Änderung durch die Person selbst (wie PATCH /account) + Audit.
export async function applyProfile(userId, hubKeys) {
  const { items } = await profileOffer(userId);
  const chosen = items.filter((i) => hubKeys.includes(i.hubKey) && !i.same);
  if (chosen.length === 0) return { applied: [] };
  await updateAccount(userId, Object.fromEntries(chosen.map((i) => [i.fieldKey, i.hub])));
  await logAudit({ actorId: userId, action: 'hub.fields_applied', subjectUserId: userId, details: { fields: chosen.map((i) => i.fieldKey) } });
  return { applied: chosen.map((i) => i.fieldKey) };
}

// Frist je Kategorie wie die Datenschutz-Löschung (PRIVACY_CATEGORIES.days).
export async function purgeExpiredHubSnapshots() {
  for (const category of HUB_CATEGORIES) {
    const days = PRIVACY_CATEGORIES[category]?.days;
    if (!days) continue;
    const { rowCount } = await query(
      'DELETE FROM hub_profile_snapshots WHERE category = $1 AND fetched_at < now() - make_interval(days => $2)',
      [category, days]
    );
    if (rowCount) logger.info('hub profile snapshots purged', { category, count: rowCount });
  }
}

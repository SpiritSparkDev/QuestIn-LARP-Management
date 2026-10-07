import { query } from '../db.js';
import { getEvent } from '../events/repository.js';
import { getAccountFieldSchema } from '../accountFieldSchema/repository.js';
import { getRegistrationFieldSchema } from '../registrationFieldSchema/repository.js';
import { getScCharacterSchema } from '../scSchema/repository.js';
import { getNscProfileSchema } from '../nscSchema/repository.js';
import { encryptFieldBlob as encryptAccountBlob, decryptFieldBlob as decryptAccountBlob } from '../accountFields.js';
import { encryptFieldBlob as encryptRegistrationBlob, decryptFieldBlob as decryptRegistrationBlob } from '../registrationFields.js';
import { logAudit } from '../audit/repository.js';

// Default retention (days after the event ended) follows the privacy policy:
// health data 4 weeks, everything else 6 months.
export const PRIVACY_CATEGORIES = {
  persoenlich: { label: 'Persönliche Daten', days: 180 },
  kontakt: { label: 'Kontaktdaten', days: 180 },
  notfall: { label: 'Notfallkontakt', days: 180 },
  gesundheit: { label: 'Gesundheitsdaten', days: 28 },
  teilnahme: { label: 'Angaben zur Teilnahme', days: 180 },
  charakter: { label: 'Charakterdaten', days: 180 },
};

// Field keys are scoped because the four schemas are independent.
export const PRIVACY_SCOPES = { account: 'Konto', registration: 'Anmeldung', sc: 'SC/GSC', nsc: 'NSC' };

export async function listPrivacyFields() {
  const [account, registration, sc, nsc] = await Promise.all([getAccountFieldSchema(), getRegistrationFieldSchema(), getScCharacterSchema(), getNscProfileSchema()]);
  return Object.entries({ account, registration, sc, nsc }).flatMap(([scope, schema]) =>
    schema.map((f) => ({ id: `${scope}:${f.key}`, scope, scopeLabel: PRIVACY_SCOPES[scope], label: f.label || f.key })));
}

export function validatePrivacyDeletion(config) {
  if (typeof config !== 'object' || config === null || Array.isArray(config)) return 'privacyDeletion must be an object';
  const { fields = {}, rules = {} } = config;
  for (const [id, cat] of Object.entries(fields)) {
    if (!PRIVACY_SCOPES[id.split(':')[0]] || !PRIVACY_CATEGORIES[cat]) return `privacyDeletion.fields: invalid entry "${id}"`;
  }
  for (const [cat, rule] of Object.entries(rules)) {
    if (!PRIVACY_CATEGORIES[cat]) return `privacyDeletion.rules: unknown category "${cat}"`;
    if (!['auto', 'notify'].includes(rule?.mode) || !Number.isInteger(rule?.days) || rule.days < 0) return `privacyDeletion.rules.${cat}: mode auto|notify and days >= 0 required`;
  }
  return null;
}

function fieldsOf(event, category, scope) {
  return Object.entries(event.privacy_deletion?.fields ?? {})
    .filter(([id, cat]) => cat === category && id.startsWith(`${scope}:`))
    .map(([id]) => id.slice(scope.length + 1));
}

// One row per category that has at least one assigned field and a rule.
export function privacyStatus(event, now = new Date()) {
  const rules = event.privacy_deletion?.rules ?? {};
  return Object.entries(PRIVACY_CATEGORIES).flatMap(([category, { label }]) => {
    const rule = rules[category];
    const fieldCount = Object.values(event.privacy_deletion?.fields ?? {}).filter((c) => c === category).length;
    if (!rule || fieldCount === 0) return [];
    const dueAt = event.ended_at ? new Date(new Date(event.ended_at).getTime() + rule.days * 86400000) : null;
    const doneAt = event.privacy_deleted?.[category] ?? null;
    const state = doneAt ? 'done' : dueAt && dueAt <= now ? 'due' : 'pending';
    return [{ category, label, mode: rule.mode, days: rule.days, fieldCount, dueAt, doneAt, state }];
  });
}

// Registration fields are wiped for everyone; account and character fields
// only for users who did not consent to keep their data -- and never while
// the user is registered for another event that is still running.
const OTHER_OPEN_EVENT = `NOT EXISTS (SELECT 1 FROM registrations r2 JOIN events e2 ON e2.id = r2.event_id WHERE r2.user_id = u.id AND r2.event_id <> $1 AND e2.ended_at IS NULL)`;

// 'sc' wipes characters.data of the registrations' sc characters. 'nsc' wipes
// characters.nsc_data of every character attached to a registration (as sc or nsc
// character) plus the Springer values on the registration itself.
async function wipeCharacterFields(event, category, scope) {
  const keys = fieldsOf(event, category, scope);
  if (keys.length === 0) return;
  const column = scope === 'nsc' ? 'nsc_data' : 'data';
  const idCondition = scope === 'nsc' ? '(r.character_id = c.id OR r.nsc_character_id = c.id)' : 'r.character_id = c.id';
  await query(
    `UPDATE characters c SET ${column} = c.${column} - $2::text[]
     WHERE EXISTS (SELECT 1 FROM registrations r JOIN users u ON u.id = r.user_id
                   WHERE r.event_id = $1 AND ${idCondition} AND NOT u.keep_data_consent AND ${OTHER_OPEN_EVENT})`,
    [event.id, keys]
  );
  if (scope === 'nsc') {
    await query(
      `UPDATE registrations r SET nsc_data = r.nsc_data - $2::text[]
       FROM users u WHERE u.id = r.user_id AND r.event_id = $1 AND NOT u.keep_data_consent AND ${OTHER_OPEN_EVENT}`,
      [event.id, keys]
    );
  }
}

export async function runPrivacyDeletion(eventId, category, actor = null) {
  const event = await getEvent(eventId);
  const row = event && privacyStatus(event).find((s) => s.category === category);
  if (!row || row.state !== 'due') return false;

  const regKeys = fieldsOf(event, category, 'registration');
  if (regKeys.length > 0) {
    const { rows } = await query('SELECT user_id, registration_data_enc FROM registrations WHERE event_id = $1', [eventId]);
    for (const r of rows) {
      const data = decryptRegistrationBlob(r.registration_data_enc);
      for (const k of regKeys) delete data[k];
      await query('UPDATE registrations SET registration_data_enc = $3 WHERE event_id = $1 AND user_id = $2', [eventId, r.user_id, encryptRegistrationBlob(data)]);
    }
  }
  const accKeys = fieldsOf(event, category, 'account');
  if (accKeys.length > 0) {
    const { rows } = await query(
      `SELECT u.id, u.account_data_enc FROM users u JOIN registrations r ON r.user_id = u.id
       WHERE r.event_id = $1 AND NOT u.keep_data_consent AND ${OTHER_OPEN_EVENT}`, [eventId]);
    for (const u of rows) {
      const data = decryptAccountBlob(u.account_data_enc);
      for (const k of accKeys) delete data[k];
      await query('UPDATE users SET account_data_enc = $2 WHERE id = $1', [u.id, encryptAccountBlob(data)]);
    }
  }
  await wipeCharacterFields(event, category, 'sc');
  await wipeCharacterFields(event, category, 'nsc');

  await query(`UPDATE events SET privacy_deleted = privacy_deleted || jsonb_build_object($2::text, now()::text) WHERE id = $1`, [eventId, category]);
  await logAudit({ actorId: actor, action: 'privacy.deletion', details: { eventId, category } });
  return true;
}

// Called periodically: runs every due category whose mode is "auto".
export async function runDueAutoDeletions() {
  const { rows } = await query('SELECT id FROM events WHERE ended_at IS NOT NULL');
  for (const { id } of rows) {
    const event = await getEvent(id);
    for (const s of privacyStatus(event)) {
      if (s.state === 'due' && s.mode === 'auto') await runPrivacyDeletion(id, s.category);
    }
  }
}

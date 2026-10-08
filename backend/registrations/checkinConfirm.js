import { router } from '../routes.js';
import { requireAuth } from '../middleware/authenticate.js';
import { requireMenu } from '../middleware/authorize.js';
import { readJsonBody } from '../httpBody.js';
import { query } from '../db.js';
import { getAccountFieldSchema } from '../accountFieldSchema/repository.js';
import { getRegistrationFieldSchema } from '../registrationFieldSchema/repository.js';
import { getScCharacterSchema } from '../scSchema/repository.js';
import { getAccount, updateAccount } from '../accounts/repository.js';
import { getCharacter, updateCharacter } from '../characters/repository.js';
import { decryptFieldBlob } from '../registrationFields.js';
import { updateRegistrationOtFields } from './repository.js';
import { logAudit } from '../audit/repository.js';

// Fields flagged "Beim Check-in erneut abfragen" in the schemas, with the
// participant's current values -- shown (editable) before checking in.
async function loadConfirmFields(eventId, userId) {
  const { rows } = await query('SELECT registration_data_enc, character_id FROM registrations WHERE event_id = $1 AND user_id = $2', [eventId, userId]);
  if (rows.length === 0) return null;
  const confirm = (schema) => schema.filter((f) => f.checkinConfirm);
  const character = rows[0].character_id ? await getCharacter(rows[0].character_id) : null;
  return {
    account: { fields: confirm(await getAccountFieldSchema()), values: await getAccount(userId) },
    registration: { fields: confirm(await getRegistrationFieldSchema()), values: decryptFieldBlob(rows[0].registration_data_enc) },
    character: character
      ? { id: character.id, name: character.name, fields: confirm(await getScCharacterSchema()), values: character.data ?? {} }
      : { id: null, fields: [], values: {} },
  };
}

router.get('/events/:id/checkin-confirm/:userId', requireAuth(requireMenu('checkin')(async ({ params }) => {
  const result = await loadConfirmFields(params.id, params.userId);
  if (!result) return { status: 404, body: { error: 'registration not found' } };
  return { status: 200, body: result };
})));

// Saves the (possibly corrected) answers; only keys of flagged fields are written.
router.put('/events/:id/checkin-confirm/:userId', requireAuth(requireMenu('checkin')(async ({ req, params, user }) => {
  const body = await readJsonBody(req);
  if (body === null) return { status: 400, body: { error: 'invalid JSON' } };
  const current = await loadConfirmFields(params.id, params.userId);
  if (!current) return { status: 404, body: { error: 'registration not found' } };
  const only = (section, values) => Object.fromEntries(
    current[section].fields.filter((f) => values && f.key in values).map((f) => [f.key, values[f.key]])
  );
  const account = only('account', body.account);
  const registration = only('registration', body.registration);
  const character = only('character', body.character);
  try {
    if (Object.keys(account).length) await updateAccount(params.userId, account);
    if (Object.keys(registration).length) await updateRegistrationOtFields(params.id, params.userId, registration);
    if (Object.keys(character).length && current.character.id) {
      const owner = (await getCharacter(current.character.id)).user_id;
      await updateCharacter(current.character.id, owner, { data: { ...current.character.values, ...character } }, { isElevated: true, actorId: user.id });
    }
  } catch (err) {
    if (err.code === 'INVALID_CHARACTER_DATA') return { status: 400, body: { error: err.details.join(', ') } };
    throw err;
  }
  await logAudit({ actorId: user.id, action: 'checkin.confirm', subjectUserId: params.userId, details: { eventId: params.id } });
  return { status: 200, body: { saved: true } };
})));

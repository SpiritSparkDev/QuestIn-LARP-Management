// Merge-field catalog and context builder for email templates. "OT" fields
// come from the account (out-of-time, real-person data); "IT" fields come
// from a character (in-time, roleplay data) -- same vocabulary as
// frontend/js/formFields.js. A template's Handlebars source addresses these
// as {{account.<key>}} / {{character.<key>}}.
import { getAccountFieldSchema } from '../accountFieldSchema/repository.js';
import { getScCharacterSchema } from '../scSchema/repository.js';
import { getMember } from '../members/repository.js';
import { getCharacter } from '../characters/repository.js';

const BUILTIN_ACCOUNT_FIELDS = [
  { key: 'firstName', label: 'Vorname' },
  { key: 'lastName', label: 'Nachname' },
  { key: 'nickname', label: 'Rufname' },
  { key: 'name', label: 'Anzeigename' },
  { key: 'email', label: 'E-Mail' },
];

const BUILTIN_CHARACTER_FIELDS = [
  { key: 'name', label: 'Charaktername' },
];

export async function listAvailableMergeFields() {
  const [accountSchema, scSchema] = await Promise.all([getAccountFieldSchema(), getScCharacterSchema()]);
  return {
    account: [...BUILTIN_ACCOUNT_FIELDS, ...accountSchema.map((f) => ({ key: f.key, label: f.label ?? f.key }))],
    character: [...BUILTIN_CHARACTER_FIELDS, ...scSchema.map((f) => ({ key: f.key, label: f.label ?? f.key }))],
  };
}

// Builds the {account, character} context a template is rendered against.
// `characterId`, if given, must belong to `userId` -- callers (the
// send-test/preview routes) are expected to have already resolved it from
// that user's own character list, but this re-checks ownership itself so it
// can never be used to leak another member's character data into a preview.
export async function buildMergeContext(userId, { characterId } = {}) {
  const member = await getMember(userId);
  if (!member) {
    const err = new Error('member not found');
    err.code = 'MEMBER_NOT_FOUND';
    throw err;
  }
  const account = { ...member };

  let character = {};
  if (characterId) {
    const found = await getCharacter(characterId);
    if (!found || found.user_id !== userId) {
      const err = new Error('character not found for this member');
      err.code = 'CHARACTER_NOT_FOUND';
      throw err;
    }
    character = { name: found.name, ...found.data };
  }

  return { account, character };
}

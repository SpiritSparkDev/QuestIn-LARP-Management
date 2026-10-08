import { query } from '../db.js';
import { getAccountFieldSchema } from '../accountFieldSchema/repository.js';
import { encryptFieldBlob, decryptFieldBlob } from '../accountFields.js';
import { sanitizeFieldValue } from '../richText.js';
import { logAudit } from '../audit/repository.js';
import { diffForReview, recordReview } from '../characterReviews/repository.js';
import { isGroupAncestorOf } from './repository.js';

const groupManagedFields = async () => (await getAccountFieldSchema()).filter((f) => f.groupManaged);

// The account fields marked "Gruppenverwaltung" of someone below the actor, or null if not allowed.
export async function getGroupAccountFields(actorId, targetId) {
  if (!(await isGroupAncestorOf(actorId, targetId))) return null;
  const fields = await groupManagedFields();
  if (fields.length === 0) return { fields, data: {} };
  const { rows } = await query('SELECT account_data_enc FROM users WHERE id = $1', [targetId]);
  const stored = decryptFieldBlob(rows[0]?.account_data_enc);
  return { fields, data: Object.fromEntries(fields.map((f) => [f.key, stored[f.key] ?? null])) };
}

// Writes only the groupManaged fields; the owner (the person, or their manager)
// gets the change on the dashboard to accept or reject.
export async function updateGroupAccountFields(actorId, targetId, values) {
  if (!(await isGroupAncestorOf(actorId, targetId))) return null;
  const fields = await groupManagedFields();
  const { rows } = await query('SELECT account_data_enc, managed_by_user_id FROM users WHERE id = $1', [targetId]);
  if (!rows[0]) return null;
  const stored = decryptFieldBlob(rows[0].account_data_enc);
  const next = { ...stored };
  for (const f of fields) {
    if (values[f.key] !== undefined) next[f.key] = sanitizeFieldValue(f, values[f.key]);
  }
  const changes = diffForReview(fields, stored, next);
  if (changes.length === 0) return { changed: 0 };
  await query('UPDATE users SET account_data_enc = $2 WHERE id = $1', [targetId, encryptFieldBlob(next)]);
  const ownerId = rows[0].managed_by_user_id ?? targetId;
  await recordReview({ ownerId, actorId, column: 'account', subjectUserId: targetId, changes });
  await logAudit({ actorId, action: 'group_tree.account_fields_changed', subjectUserId: targetId, details: { fields: changes.map((c) => c.key) } });
  return { changed: changes.length };
}

import { query, withTransaction } from '../db.js';
import { displayName } from '../displayName.js';
import { encryptFieldBlob, decryptFieldBlob } from '../accountFields.js';
import { logAudit } from '../audit/repository.js';

const differs = (a, b) => JSON.stringify(a ?? null) !== JSON.stringify(b ?? null);

// Changed owner-visible fields (staffOnly ones are not the owner's to judge) plus the name.
export function diffForReview(schema, stored, next, oldName, newName) {
  const changes = schema
    .filter((f) => !f.staffOnly && differs(stored[f.key], next[f.key]))
    .map((f) => ({ key: f.key, label: f.label ?? f.key, from: stored[f.key] ?? null, to: next[f.key] ?? null }));
  if (newName != null && newName !== oldName) changes.unshift({ key: 'name', label: 'Name', from: oldName, to: newName });
  return changes;
}

export async function recordReview({ characterId = null, ownerId, actorId, column, changes, subjectUserId = null }) {
  if (changes.length === 0) return;
  await query(
    `INSERT INTO character_change_reviews (character_id, owner_id, actor_id, column_name, changes, subject_user_id)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [characterId, ownerId, actorId, column, JSON.stringify(changes), subjectUserId]
  );
}

export async function listPendingReviews(ownerId) {
  const { rows } = await query(
    `SELECT r.id, r.changes, r.created_at, r.column_name, c.name AS character_name,
            u.first_name, u.last_name, u.nickname,
            r.subject_user_id, s.first_name AS s_first, s.last_name AS s_last, s.nickname AS s_nick
     FROM character_change_reviews r
     LEFT JOIN characters c ON c.id = r.character_id
     LEFT JOIN users u ON u.id = r.actor_id
     LEFT JOIN users s ON s.id = r.subject_user_id
     WHERE r.owner_id = $1 AND r.status = 'pending'
     ORDER BY r.created_at`,
    [ownerId]
  );
  return rows.map((r) => ({
    id: r.id,
    characterName: r.character_name,
    account: r.column_name === 'account',
    // account reviews: whose account data it is (null = the owner's own)
    subjectName: r.subject_user_id && r.subject_user_id !== ownerId
      ? displayName({ firstName: r.s_first, lastName: r.s_last, nickname: r.s_nick }) : null,
    nsc: r.column_name === 'nsc_data',
    changes: r.changes,
    createdAt: r.created_at,
    actorName: r.first_name || r.last_name || r.nickname
      ? displayName({ firstName: r.first_name, lastName: r.last_name, nickname: r.nickname })
      : 'Jemand',
  }));
}

// Closes the review. 'reject' restores all previous values; 'accept' keeps them, except
// the fields listed in `rejectKeys` (partial rejection).
export async function resolveReview(id, ownerId, decision, rejectKeys = []) {
  const review = await withTransaction(async (client) => {
    const { rows } = await client.query(
      `SELECT * FROM character_change_reviews WHERE id = $1 AND owner_id = $2 AND status = 'pending' FOR UPDATE`,
      [id, ownerId]
    );
    const review = rows[0];
    if (!review) return null;
    const revert = decision === 'reject' ? review.changes : review.changes.filter((c) => rejectKeys.includes(c.key));
    if (revert.length > 0 && review.column_name === 'account') {
      const { rows: users } = await client.query('SELECT account_data_enc FROM users WHERE id = $1 FOR UPDATE', [review.subject_user_id]);
      if (users[0]) {
        const blob = decryptFieldBlob(users[0].account_data_enc);
        for (const c of revert) {
          if (c.from === null) delete blob[c.key];
          else blob[c.key] = c.from;
        }
        await client.query('UPDATE users SET account_data_enc = $2 WHERE id = $1', [review.subject_user_id, encryptFieldBlob(blob)]);
      }
    } else if (revert.length > 0) {
      const col = review.column_name === 'nsc_data' ? 'nsc_data' : 'data';
      const { rows: chars } = await client.query(`SELECT name, ${col} AS blob FROM characters WHERE id = $1 FOR UPDATE`, [review.character_id]);
      if (chars[0]) {
        const blob = { ...(chars[0].blob ?? {}) };
        let name = chars[0].name;
        for (const c of revert) {
          if (c.key === 'name') name = c.from;
          else if (c.from === null) delete blob[c.key];
          else blob[c.key] = c.from;
        }
        await client.query(`UPDATE characters SET name = $2, ${col} = $3 WHERE id = $1`, [review.character_id, name, JSON.stringify(blob)]);
      }
    }
    await client.query(
      `UPDATE character_change_reviews SET status = $2, resolved_at = now() WHERE id = $1`,
      [id, revert.length === review.changes.length ? 'rejected' : 'accepted']
    );
    return { ...review, revertedKeys: revert.map((c) => c.key) };
  });
  if (!review) return null;
  // Outside the transaction: the audit write uses its own connection and would wait on our row locks.
  await logAudit({
    actorId: ownerId,
    action: review.revertedKeys.length === review.changes.length ? 'character.change_rejected' : 'character.change_accepted',
    subjectUserId: ownerId,
    details: { characterId: review.character_id, subjectUserId: review.subject_user_id, reviewId: id, changedBy: review.actor_id, rejectedFields: review.revertedKeys },
  });
  return { id, status: review.revertedKeys.length === review.changes.length ? 'rejected' : 'accepted', rejectedFields: review.revertedKeys };
}

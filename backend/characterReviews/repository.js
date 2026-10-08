import { query, withTransaction } from '../db.js';
import { displayName } from '../displayName.js';
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

export async function recordReview({ characterId, ownerId, actorId, column, changes }) {
  if (changes.length === 0) return;
  await query(
    `INSERT INTO character_change_reviews (character_id, owner_id, actor_id, column_name, changes)
     VALUES ($1, $2, $3, $4, $5)`,
    [characterId, ownerId, actorId, column, JSON.stringify(changes)]
  );
}

export async function listPendingReviews(ownerId) {
  const { rows } = await query(
    `SELECT r.id, r.changes, r.created_at, r.column_name, c.name AS character_name,
            u.first_name, u.last_name, u.nickname
     FROM character_change_reviews r
     JOIN characters c ON c.id = r.character_id
     LEFT JOIN users u ON u.id = r.actor_id
     WHERE r.owner_id = $1 AND r.status = 'pending'
     ORDER BY r.created_at`,
    [ownerId]
  );
  return rows.map((r) => ({
    id: r.id,
    characterName: r.character_name,
    nsc: r.column_name === 'nsc_data',
    changes: r.changes,
    createdAt: r.created_at,
    actorName: r.first_name || r.last_name || r.nickname
      ? displayName({ firstName: r.first_name, lastName: r.last_name, nickname: r.nickname })
      : 'Jemand',
  }));
}

// 'accept' just closes the review; 'reject' restores the previous values.
export async function resolveReview(id, ownerId, decision) {
  return withTransaction(async (client) => {
    const { rows } = await client.query(
      `SELECT * FROM character_change_reviews WHERE id = $1 AND owner_id = $2 AND status = 'pending' FOR UPDATE`,
      [id, ownerId]
    );
    const review = rows[0];
    if (!review) return null;
    if (decision === 'reject') {
      const col = review.column_name === 'nsc_data' ? 'nsc_data' : 'data';
      const { rows: chars } = await client.query(`SELECT name, ${col} AS blob FROM characters WHERE id = $1 FOR UPDATE`, [review.character_id]);
      if (chars[0]) {
        const blob = { ...(chars[0].blob ?? {}) };
        let name = chars[0].name;
        for (const c of review.changes) {
          if (c.key === 'name') name = c.from;
          else if (c.from === null) delete blob[c.key];
          else blob[c.key] = c.from;
        }
        await client.query(`UPDATE characters SET name = $2, ${col} = $3 WHERE id = $1`, [review.character_id, name, JSON.stringify(blob)]);
      }
    }
    await client.query(
      `UPDATE character_change_reviews SET status = $2, resolved_at = now() WHERE id = $1`,
      [id, decision === 'reject' ? 'rejected' : 'accepted']
    );
    await logAudit({
      actorId: ownerId,
      action: decision === 'reject' ? 'character.change_rejected' : 'character.change_accepted',
      subjectUserId: ownerId,
      details: { characterId: review.character_id, reviewId: id, changedBy: review.actor_id },
    });
    return { id, status: decision === 'reject' ? 'rejected' : 'accepted' };
  });
}

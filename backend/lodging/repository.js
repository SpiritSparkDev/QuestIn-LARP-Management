import { query, withTransaction } from '../db.js';
import { displayName } from '../displayName.js';
import { COUNTED_STATUSES } from '../registrations/repository.js';

function lodgingError(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

// Every lodging of the event with its beds and free beds. Who sleeps there:
// staff (`showNames`) see the real (OT) names; everyone else only gets the
// count, plus the character (IT) names of occupants who belong to a group, so
// groups can find each other without exposing anybody's real name.
export async function listLodgings(eventId, { showNames }) {
  const { rows: lodgings } = await query(
    'SELECT id, name, description, beds, price_cents, kind, is_default FROM event_lodgings WHERE event_id = $1 ORDER BY position, name',
    [eventId]
  );
  const { rows: occupants } = await query(
    `SELECT r.lodging_id, r.lodging_details, r.user_id, u.first_name, u.last_name, u.nickname,
            COALESCE(c.name, nc.name) AS character_name,
            (u.managed_by_user_id IS NOT NULL OR u.group_parent_id IS NOT NULL
              OR EXISTS (SELECT 1 FROM users m WHERE m.managed_by_user_id = u.id OR m.group_parent_id = u.id)) AS in_group
     FROM registrations r JOIN users u ON u.id = r.user_id
     LEFT JOIN characters c ON c.id = r.character_id
     LEFT JOIN characters nc ON nc.id = r.nsc_character_id
     WHERE r.event_id = $1 AND r.lodging_id IS NOT NULL AND r.status = ANY($2::text[])
     ORDER BY u.last_name, u.first_name`,
    [eventId, COUNTED_STATUSES]
  );
  return lodgings.map((l) => {
    const sleeping = occupants.filter((o) => o.lodging_id === l.id);
    return {
      id: l.id,
      name: l.name,
      description: l.description,
      kind: l.kind,
      isDefault: l.is_default,
      beds: l.beds,
      priceCents: l.price_cents,
      taken: sleeping.length,
      unlimited: l.kind === 'pitch' && l.beds === 0,
      free: l.kind === 'pitch' && l.beds === 0 ? null : Math.max(l.beds - sleeping.length, 0),
      occupants: showNames
        ? sleeping.map((o) => ({ userId: o.user_id, name: displayName({ firstName: o.first_name, lastName: o.last_name, nickname: o.nickname }), details: o.lodging_details ?? null }))
        : sleeping.filter((o) => o.in_group && o.character_name).map((o) => ({ name: o.character_name, details: o.lodging_details ?? null })),
    };
  });
}

// Makes the event's lodgings equal to `list` ([{ id?, name, description,
// beds, priceCents }] in display order): entries with a known id are updated,
// new ones created, missing ones deleted. A lodging people sleep in can't be
// deleted or shrunk below its occupants.
export async function replaceLodgings(eventId, list) {
  return withTransaction(async (client) => {
    await client.query('SELECT 1 FROM events WHERE id = $1 FOR UPDATE', [eventId]);
    const { rows: existing } = await client.query('SELECT id, name, kind FROM event_lodgings WHERE event_id = $1', [eventId]);
    const { rows: counts } = await client.query(
      `SELECT lodging_id, count(*)::int AS n FROM registrations
       WHERE event_id = $1 AND lodging_id IS NOT NULL AND status = ANY($2::text[]) GROUP BY lodging_id`,
      [eventId, COUNTED_STATUSES]
    );
    const occupied = new Map(counts.map((c) => [c.lodging_id, c.n]));
    const keepIds = new Set(list.map((l) => l.id).filter(Boolean));

    for (const old of existing) {
      if (!keepIds.has(old.id) && (occupied.get(old.id) ?? 0) > 0) {
        throw lodgingError('LODGING_OCCUPIED', `„${old.name}“ ist bereits belegt und kann nicht entfernt werden.`);
      }
    }
    // Free the names first so renaming/reordering can't trip the unique constraint.
    await client.query('DELETE FROM event_lodgings WHERE event_id = $1 AND NOT (id = ANY($2::uuid[]))', [eventId, [...keepIds].filter((id) => existing.some((e) => e.id === id))]);
    const knownIds = new Set(existing.map((e) => e.id));
    await client.query('UPDATE event_lodgings SET is_default = false WHERE event_id = $1', [eventId]);
    for (const [index, l] of list.entries()) {
      const name = l.name.trim();
      if (l.id && knownIds.has(l.id)) {
        if (l.beds !== 0 && l.beds < (occupied.get(l.id) ?? 0)) {
          throw lodgingError('LODGING_OCCUPIED', `„${name}“ hat schon ${occupied.get(l.id)} Belegungen und kann nicht auf ${l.beds} Betten verkleinert werden.`);
        }
        const oldKind = existing.find((e) => e.id === l.id).kind;
        if ((l.kind ?? 'beds') !== oldKind && (occupied.get(l.id) ?? 0) > 0) {
          throw lodgingError('LODGING_OCCUPIED', `„${name}“ ist schon belegt – die Art (Betten/Zeltplatz) lässt sich nicht mehr ändern.`);
        }
        await client.query('UPDATE event_lodgings SET name = $2, description = $3, beds = $4, price_cents = $5, position = $6 WHERE id = $1', [l.id, `__tmp_${l.id}`, '', l.beds, l.priceCents ?? 0, index]);
      }
    }
    for (const [index, l] of list.entries()) {
      const name = l.name.trim();
      const description = (l.description ?? '').trim();
      if (l.id && knownIds.has(l.id)) {
        await client.query('UPDATE event_lodgings SET name = $2, description = $3, price_cents = $4, beds = $5, position = $6, kind = $7, is_default = $8 WHERE id = $1', [l.id, name, description, l.priceCents ?? 0, l.beds, index, l.kind ?? 'beds', l.isDefault === true]);
      } else {
        await client.query(
          'INSERT INTO event_lodgings (event_id, name, description, beds, price_cents, position, kind, is_default) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)',
          [eventId, name, description, l.beds, l.priceCents ?? 0, index, l.kind ?? 'beds', l.isDefault === true]
        );
      }
    }
  }).then(() => undefined);
}

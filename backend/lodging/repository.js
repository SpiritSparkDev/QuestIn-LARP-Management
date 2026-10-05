import { query, withTransaction } from '../db.js';
import { displayName } from '../displayName.js';
import { COUNTED_STATUSES } from '../registrations/repository.js';

function lodgingError(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

// Every lodging of the event with its beds, free beds and -- when allowed --
// who sleeps there, so families and groups can find each other.
export async function listLodgings(eventId, { showNames }) {
  const { rows: lodgings } = await query(
    'SELECT id, name, description, beds, price_cents FROM event_lodgings WHERE event_id = $1 ORDER BY position, name',
    [eventId]
  );
  const { rows: occupants } = await query(
    `SELECT r.lodging_id, r.user_id, u.first_name, u.last_name, u.nickname
     FROM registrations r JOIN users u ON u.id = r.user_id
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
      beds: l.beds,
      priceCents: l.price_cents,
      taken: sleeping.length,
      free: Math.max(l.beds - sleeping.length, 0),
      occupants: showNames
        ? sleeping.map((o) => ({ userId: o.user_id, name: displayName({ firstName: o.first_name, lastName: o.last_name, nickname: o.nickname }) }))
        : [],
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
    const { rows: existing } = await client.query('SELECT id, name FROM event_lodgings WHERE event_id = $1', [eventId]);
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
    for (const [index, l] of list.entries()) {
      const name = l.name.trim();
      if (l.id && knownIds.has(l.id)) {
        if (l.beds < (occupied.get(l.id) ?? 0)) {
          throw lodgingError('LODGING_OCCUPIED', `„${name}“ hat schon ${occupied.get(l.id)} Belegungen und kann nicht auf ${l.beds} Betten verkleinert werden.`);
        }
        await client.query('UPDATE event_lodgings SET name = $2, description = $3, beds = $4, price_cents = $5, position = $6 WHERE id = $1', [l.id, `__tmp_${l.id}`, '', l.beds, l.priceCents ?? 0, index]);
      }
    }
    for (const [index, l] of list.entries()) {
      const name = l.name.trim();
      const description = (l.description ?? '').trim();
      if (l.id && knownIds.has(l.id)) {
        await client.query('UPDATE event_lodgings SET name = $2, description = $3, price_cents = $4, beds = $5, position = $6 WHERE id = $1', [l.id, name, description, l.priceCents ?? 0, l.beds, index]);
      } else {
        await client.query(
          'INSERT INTO event_lodgings (event_id, name, description, beds, price_cents, position) VALUES ($1, $2, $3, $4, $5, $6)',
          [eventId, name, description, l.beds, l.priceCents ?? 0, index]
        );
      }
    }
  }).then(() => undefined);
}

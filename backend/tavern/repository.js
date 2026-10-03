import { query, withTransaction } from '../db.js';

const TOPUP_METHODS = ['cash', 'card', 'paypal', 'bank_transfer'];
export { TOPUP_METHODS };

function tavernError(message, code) {
  const err = new Error(message);
  err.code = code;
  return err;
}

// ---------- menu ----------

function rowToItem(row) {
  return { id: row.id, name: row.name, category: row.category, priceCents: row.price_cents, sortOrder: row.sort_order, active: row.active };
}

export async function listItems({ onlyActive = false } = {}) {
  const { rows } = await query(
    `SELECT * FROM tavern_items ${onlyActive ? 'WHERE active' : ''} ORDER BY category NULLS LAST, sort_order, name`
  );
  return rows.map(rowToItem);
}

export async function createItem({ name, category, priceCents, sortOrder = 0 }) {
  const { rows } = await query(
    'INSERT INTO tavern_items (name, category, price_cents, sort_order) VALUES ($1, $2, $3, $4) RETURNING *',
    [name, category || null, priceCents, sortOrder]
  );
  return rowToItem(rows[0]);
}

export async function updateItem(id, { name, category, priceCents, sortOrder, active }) {
  const { rows } = await query(
    `UPDATE tavern_items SET
       name = COALESCE($2, name),
       category = CASE WHEN $3::boolean THEN $4 ELSE category END,
       price_cents = COALESCE($5, price_cents),
       sort_order = COALESCE($6, sort_order),
       active = COALESCE($7, active)
     WHERE id = $1 RETURNING *`,
    [id, name ?? null, category !== undefined, category || null, priceCents ?? null, sortOrder ?? null, active ?? null]
  );
  return rows[0] ? rowToItem(rows[0]) : null;
}

export async function deleteItem(id) {
  const { rowCount } = await query('DELETE FROM tavern_items WHERE id = $1', [id]);
  return rowCount > 0;
}

// ---------- accounts ----------

// Account plus the names it can be found by: tavern number, OT name (the
// linked person) and IT names (that person's characters).
const ACCOUNT_SELECT = `
  SELECT a.id, a.event_id, a.number, a.user_id, a.label, a.balance_cents, a.locked, a.created_at,
         u.first_name, u.last_name, u.nickname,
         COALESCE((SELECT json_agg(c.name ORDER BY c.created_at) FROM characters c WHERE c.user_id = a.user_id), '[]') AS character_names
  FROM tavern_accounts a
  LEFT JOIN users u ON u.id = a.user_id`;

function rowToAccount(row) {
  const otName = [row.first_name, row.last_name].filter(Boolean).join(' ') || null;
  return {
    id: row.id,
    eventId: row.event_id,
    number: row.number,
    userId: row.user_id,
    label: row.label,
    otName,
    nickname: row.nickname ?? null,
    characterNames: row.character_names ?? [],
    displayName: otName ?? row.label ?? `Konto ${row.number}`,
    balanceCents: row.balance_cents,
    locked: row.locked,
    createdAt: row.created_at,
  };
}

const escapeLike = (text) => text.replace(/[\\%_]/g, (ch) => `\\${ch}`);

export async function listAccounts(eventId, search) {
  const term = (search ?? '').trim();
  const params = [eventId];
  let where = 'a.event_id = $1';
  if (term) {
    params.push(term, `%${escapeLike(term)}%`);
    where += ` AND (a.number::text = $2 OR a.label ILIKE $3
      OR concat_ws(' ', u.first_name, u.last_name) ILIKE $3 OR u.nickname ILIKE $3
      OR EXISTS (SELECT 1 FROM characters c WHERE c.user_id = a.user_id AND c.name ILIKE $3))`;
  }
  const { rows } = await query(`${ACCOUNT_SELECT} WHERE ${where} ORDER BY a.number`, params);
  return rows.map(rowToAccount);
}

export async function getAccount(id) {
  const { rows } = await query(`${ACCOUNT_SELECT} WHERE a.id = $1`, [id]);
  return rows[0] ? rowToAccount(rows[0]) : null;
}

export async function createAccount({ eventId, userId, label }) {
  // The next number is taken inside a transaction; a concurrent insert that
  // grabs the same number trips the unique index and is retried.
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      return await withTransaction(async (client) => {
        const { rows: next } = await client.query('SELECT COALESCE(MAX(number), 0) + 1 AS n FROM tavern_accounts WHERE event_id = $1', [eventId]);
        const { rows } = await client.query(
          'INSERT INTO tavern_accounts (event_id, number, user_id, label) VALUES ($1, $2, $3, $4) RETURNING id',
          [eventId, next[0].n, userId ?? null, label || null]
        );
        return rows[0].id;
      }).then(getAccount);
    } catch (err) {
      if (err.code !== '23505') throw err;
      if (String(err.constraint).includes('event_user')) throw tavernError('Diese Person hat für das Event bereits ein Tavernenkonto.', 'ACCOUNT_EXISTS');
    }
  }
  throw tavernError('Es konnte keine freie Tavernen-Nummer vergeben werden.', 'NUMBER_UNAVAILABLE');
}

export async function setLocked(id, locked) {
  const { rowCount } = await query('UPDATE tavern_accounts SET locked = $2 WHERE id = $1', [id, locked]);
  return rowCount > 0 ? getAccount(id) : null;
}

// Registered participants of an event who don't have a tavern account yet --
// what staff pick from when linking an account to a person.
export async function listParticipantsWithoutAccount(eventId, search) {
  const term = (search ?? '').trim();
  const params = [eventId];
  let filter = '';
  if (term) {
    params.push(`%${escapeLike(term)}%`);
    filter = `AND (concat_ws(' ', u.first_name, u.last_name) ILIKE $2 OR u.nickname ILIKE $2
      OR EXISTS (SELECT 1 FROM characters c WHERE c.user_id = u.id AND c.name ILIKE $2))`;
  }
  const { rows } = await query(
    `SELECT u.id, u.first_name, u.last_name, u.nickname,
            COALESCE((SELECT json_agg(c.name ORDER BY c.created_at) FROM characters c WHERE c.user_id = u.id), '[]') AS character_names
     FROM registrations r
     JOIN users u ON u.id = r.user_id
     WHERE r.event_id = $1 AND r.status <> 'cancelled'
       AND NOT EXISTS (SELECT 1 FROM tavern_accounts a WHERE a.event_id = r.event_id AND a.user_id = u.id)
       ${filter}
     ORDER BY u.last_name, u.first_name
     LIMIT 30`,
    params
  );
  return rows.map((row) => ({
    userId: row.id,
    name: [row.first_name, row.last_name].filter(Boolean).join(' '),
    nickname: row.nickname,
    characterNames: row.character_names,
  }));
}

// ---------- ledger ----------

function rowToTransaction(row) {
  return {
    id: row.id,
    type: row.type,
    amountCents: row.amount_cents,
    method: row.method,
    note: row.note,
    items: row.items,
    reversesId: row.reverses_id,
    voidedAt: row.voided_at,
    createdAt: row.created_at,
  };
}

export async function listTransactions(accountId, limit = 50) {
  const { rows } = await query(
    'SELECT * FROM tavern_transactions WHERE account_id = $1 ORDER BY created_at DESC, id LIMIT $2',
    [accountId, limit]
  );
  return rows.map(rowToTransaction);
}

// Applies a signed amount to an account and records it, atomically: the
// account row is locked for the duration, so two tablets charging the same
// account at once can never both pass the balance check.
async function applyEntry(client, account, { type, amountCents, method, note, items, reversesId, createdBy }) {
  const newBalance = account.balance_cents + amountCents;
  if (amountCents < 0 && newBalance < 0) {
    throw tavernError('Das Guthaben reicht nicht aus.', 'INSUFFICIENT_FUNDS');
  }
  const { rows } = await client.query(
    `INSERT INTO tavern_transactions (account_id, type, amount_cents, method, note, items, reverses_id, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
    [account.id, type, amountCents, method ?? null, note || null, items ? JSON.stringify(items) : null, reversesId ?? null, createdBy ?? null]
  );
  await client.query('UPDATE tavern_accounts SET balance_cents = $2 WHERE id = $1', [account.id, newBalance]);
  return rows[0];
}

async function lockAccount(client, id) {
  const { rows } = await client.query('SELECT * FROM tavern_accounts WHERE id = $1 FOR UPDATE', [id]);
  if (rows.length === 0) throw tavernError('Konto nicht gefunden.', 'ACCOUNT_NOT_FOUND');
  return rows[0];
}

export async function topUp(accountId, { amountCents, method, note, createdBy }) {
  return withTransaction(async (client) => {
    const account = await lockAccount(client, accountId);
    const row = await applyEntry(client, account, { type: 'topup', amountCents, method, note, createdBy });
    return rowToTransaction(row);
  });
}

// Charges the listed items at their CURRENT menu price (prices come from the
// database, never from the client). The item names/prices are snapshotted
// onto the entry so later menu edits don't rewrite history.
export async function charge(accountId, { items = [], customAmountCents = 0, note, createdBy }) {
  return withTransaction(async (client) => {
    const account = await lockAccount(client, accountId);
    if (account.locked) throw tavernError('Dieses Konto ist gesperrt.', 'ACCOUNT_LOCKED');

    const snapshot = [];
    let total = 0;
    if (items.length > 0) {
      const { rows } = await client.query('SELECT * FROM tavern_items WHERE id = ANY($1::uuid[]) AND active', [items.map((i) => i.itemId)]);
      const byId = new Map(rows.map((r) => [r.id, r]));
      for (const { itemId, quantity } of items) {
        const item = byId.get(itemId);
        if (!item) throw tavernError('Ein Artikel existiert nicht mehr oder ist nicht aktiv.', 'ITEM_NOT_FOUND');
        snapshot.push({ itemId, name: item.name, quantity, priceCents: item.price_cents });
        total += item.price_cents * quantity;
      }
    }
    if (customAmountCents > 0) {
      snapshot.push({ itemId: null, name: note || 'Sonstiges', quantity: 1, priceCents: customAmountCents });
      total += customAmountCents;
    }
    if (total <= 0) throw tavernError('Es wurde nichts zum Abbuchen ausgewählt.', 'NOTHING_TO_CHARGE');

    const row = await applyEntry(client, account, { type: 'charge', amountCents: -total, note, items: snapshot, createdBy });
    return rowToTransaction(row);
  });
}

// Storno: books the exact opposite of an entry and marks the original, so
// the ledger stays complete. Voiding a top-up is refused if the money has
// already been spent.
export async function voidTransaction(transactionId, { createdBy }) {
  return withTransaction(async (client) => {
    const { rows } = await client.query('SELECT * FROM tavern_transactions WHERE id = $1 FOR UPDATE', [transactionId]);
    const original = rows[0];
    if (!original) throw tavernError('Buchung nicht gefunden.', 'TRANSACTION_NOT_FOUND');
    if (original.type === 'void' || original.voided_at) throw tavernError('Diese Buchung wurde bereits storniert oder ist eine Stornobuchung.', 'ALREADY_VOIDED');
    const account = await lockAccount(client, original.account_id);
    const row = await applyEntry(client, account, {
      type: 'void', amountCents: -original.amount_cents, note: 'Storno', reversesId: original.id, createdBy,
    });
    await client.query('UPDATE tavern_transactions SET voided_at = now() WHERE id = $1', [original.id]);
    return rowToTransaction(row);
  });
}

// Balances of one person, newest event first -- the self-service lookup.
export async function listBalancesForUser(userId) {
  const { rows } = await query(
    `SELECT a.number, a.balance_cents, a.locked, e.id AS event_id, e.name AS event_name, e.is_active
     FROM tavern_accounts a JOIN events e ON e.id = a.event_id
     WHERE a.user_id = $1 ORDER BY e.event_date DESC`,
    [userId]
  );
  return rows.map((r) => ({ number: r.number, balanceCents: r.balance_cents, locked: r.locked, eventId: r.event_id, eventName: r.event_name, isActive: r.is_active }));
}

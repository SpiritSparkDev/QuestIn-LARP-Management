import { query } from '../db.js';

// Admin puts a full account into a play group (= the group of a group manager) or takes it out (managerId null).
// Same rules as joining by code, except that the admin decides: a group manager cannot join another group, a
// managed person always belongs to its manager's group, and the target must be a top-level, active account.
// Returns null on success, else an error text.
export async function setPlayGroup(memberId, managerId) {
  const { rows } = await query(
    `SELECT managed_by_user_id, is_guest, deactivated_at,
            (coalesce(group_name, '') <> ''
             OR EXISTS (SELECT 1 FROM users m WHERE m.managed_by_user_id = u.id OR m.group_parent_id = u.id)
             OR EXISTS (SELECT 1 FROM group_join_codes c WHERE c.manager_user_id = u.id)) AS manager
       FROM users u WHERE id = $1`, [memberId]);
  if (rows.length === 0) return 'member not found';
  const member = rows[0];
  if (member.managed_by_user_id) return 'Verwaltete Personen gehören zur Gruppe ihres Verwalters – verschiebe den Verwalter.';
  if (member.is_guest) return 'Gast-Konten können keiner Gruppe angehören.';
  if (managerId === null) {
    await query('UPDATE users SET group_parent_id = NULL WHERE id = $1', [memberId]);
    return null;
  }
  if (managerId === memberId) return 'Ein Konto kann nicht seiner eigenen Gruppe angehören.';
  if (member.manager) return 'Das Konto leitet selbst eine Gruppe (Personen, Mitglieder, Gruppenname oder Codes) und kann nicht in eine andere wechseln.';
  const { rowCount } = await query(
    'SELECT 1 FROM users WHERE id = $1 AND group_parent_id IS NULL AND managed_by_user_id IS NULL AND NOT is_guest AND deactivated_at IS NULL', [managerId]);
  if (rowCount === 0) return 'Die Gruppenleitung muss ein aktives Konto sein, das selbst in keiner Gruppe ist.';
  await query('UPDATE users SET group_parent_id = $2 WHERE id = $1', [memberId, managerId]);
  return null;
}

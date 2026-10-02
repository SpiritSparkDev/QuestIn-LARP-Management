import { query } from '../db.js';

const SELECT_COLUMNS = 'id, name, subject, body, is_html, created_at, updated_at';

function mapRow(row) {
  return {
    id: row.id,
    name: row.name,
    subject: row.subject,
    body: row.body,
    isHtml: row.is_html,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function listEmailTemplates() {
  const { rows } = await query(`SELECT ${SELECT_COLUMNS} FROM email_templates ORDER BY name`);
  return rows.map(mapRow);
}

export async function getEmailTemplate(id) {
  const { rows } = await query(`SELECT ${SELECT_COLUMNS} FROM email_templates WHERE id = $1`, [id]);
  return rows[0] ? mapRow(rows[0]) : null;
}

export async function createEmailTemplate({ name, subject, body, isHtml }) {
  const { rows } = await query(
    `INSERT INTO email_templates (name, subject, body, is_html) VALUES ($1, $2, $3, $4) RETURNING ${SELECT_COLUMNS}`,
    [name, subject ?? '', body ?? '', Boolean(isHtml)]
  );
  return mapRow(rows[0]);
}

export async function updateEmailTemplate(id, { name, subject, body, isHtml }) {
  const { rows } = await query(
    `UPDATE email_templates SET name = $2, subject = $3, body = $4, is_html = $5, updated_at = now()
     WHERE id = $1 RETURNING ${SELECT_COLUMNS}`,
    [id, name, subject ?? '', body ?? '', Boolean(isHtml)]
  );
  return rows[0] ? mapRow(rows[0]) : null;
}

export async function deleteEmailTemplate(id) {
  const { rowCount } = await query('DELETE FROM email_templates WHERE id = $1', [id]);
  return rowCount > 0;
}

export async function listSlotAssignments() {
  const { rows } = await query('SELECT slot, template_id FROM email_slot_assignments');
  return Object.fromEntries(rows.map((r) => [r.slot, r.template_id]));
}

export async function getSlotAssignment(slot) {
  const { rows } = await query('SELECT template_id FROM email_slot_assignments WHERE slot = $1', [slot]);
  return rows[0]?.template_id ?? null;
}

export async function setSlotAssignment(slot, templateId) {
  if (templateId) {
    await query(
      `INSERT INTO email_slot_assignments (slot, template_id) VALUES ($1, $2)
       ON CONFLICT (slot) DO UPDATE SET template_id = $2`,
      [slot, templateId]
    );
  } else {
    await query('DELETE FROM email_slot_assignments WHERE slot = $1', [slot]);
  }
  return { slot, templateId: templateId ?? null };
}

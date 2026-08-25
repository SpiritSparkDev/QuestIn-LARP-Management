import { query } from '../db.js';
import { encryptField, decryptField } from '../crypto/fieldCrypto.js';

function decryptAccount(row) {
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    role: row.role,
    emailVerified: row.email_verified,
    address: decryptField(row.address_enc),
    birthdate: decryptField(row.birthdate_enc),
    phone: decryptField(row.phone_enc),
    emergencyContact: decryptField(row.emergency_contact_enc),
    medicalNotes: decryptField(row.medical_notes_enc),
  };
}

const SELECT_COLUMNS = `
  id, email, name, role, email_verified,
  address_enc, birthdate_enc, phone_enc, emergency_contact_enc, medical_notes_enc
`;

export async function getAccount(userId) {
  const { rows } = await query(`SELECT ${SELECT_COLUMNS} FROM users WHERE id = $1`, [userId]);
  if (rows.length === 0) return null;
  return decryptAccount(rows[0]);
}

export async function updateAccount(userId, fields) {
  const { rows } = await query(
    `UPDATE users SET
       name = COALESCE($2, name),
       address_enc = COALESCE($3, address_enc),
       birthdate_enc = COALESCE($4, birthdate_enc),
       phone_enc = COALESCE($5, phone_enc),
       emergency_contact_enc = COALESCE($6, emergency_contact_enc),
       medical_notes_enc = COALESCE($7, medical_notes_enc)
     WHERE id = $1
     RETURNING ${SELECT_COLUMNS}`,
    [
      userId,
      fields.name ?? null,
      fields.address !== undefined ? encryptField(fields.address) : null,
      fields.birthdate !== undefined ? encryptField(fields.birthdate) : null,
      fields.phone !== undefined ? encryptField(fields.phone) : null,
      fields.emergencyContact !== undefined ? encryptField(fields.emergencyContact) : null,
      fields.medicalNotes !== undefined ? encryptField(fields.medicalNotes) : null,
    ]
  );
  return decryptAccount(rows[0]);
}

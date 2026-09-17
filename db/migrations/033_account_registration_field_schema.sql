-- Admin-editable OT-field schemas, mirroring sc_character_schema/
-- nsc_profile_schema exactly. Seeded with the 7 + 6 fields that exist
-- today as hardcoded columns (see backend/accountFields.js,
-- backend/registrationFields.js) so existing groups.account_fields
-- permission lists keep working unchanged once the data migration lands.
CREATE TABLE account_field_schema (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  schema jsonb NOT NULL DEFAULT '[]'
);

INSERT INTO account_field_schema (schema) VALUES ('[
  {"key": "address", "label": "Adresse", "type": "text", "required": false},
  {"key": "birthdate", "label": "Geburtsdatum", "type": "date", "required": false},
  {"key": "phone", "label": "Telefon", "type": "text", "required": false},
  {"key": "emergencyContactLastName", "label": "Notfallkontakt: Name", "type": "text", "required": false},
  {"key": "emergencyContactFirstName", "label": "Notfallkontakt: Vorname", "type": "text", "required": false},
  {"key": "emergencyContactPhone", "label": "Notfallkontakt: Telefonnummer", "type": "text", "required": false},
  {"key": "medicalNotes", "label": "Gesundheitshinweise", "type": "textarea", "required": false}
]'::jsonb);

CREATE TABLE registration_field_schema (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  schema jsonb NOT NULL DEFAULT '[]'
);

INSERT INTO registration_field_schema (schema) VALUES ('[
  {"key": "conTage", "label": "Con-Tage des Spielers", "type": "text", "required": false},
  {"key": "accommodation", "label": "Unterbringung (Hütte/IT-Zelt/OT-Zelt, Anzahl, qm)", "type": "text", "required": false},
  {"key": "craftOffer", "label": "Angebotenes Handwerk", "type": "text", "required": false},
  {"key": "travelMethod", "label": "Anreise (Auto/Motorrad, Bahn, muss abgeholt werden)", "type": "text", "required": false},
  {"key": "dataSharingOptOut", "label": "Daten nicht an andere Teilnehmer weitergeben", "type": "boolean", "required": false},
  {"key": "photoOptOut", "label": "Keine Fotoveröffentlichung", "type": "boolean", "required": false}
]'::jsonb);

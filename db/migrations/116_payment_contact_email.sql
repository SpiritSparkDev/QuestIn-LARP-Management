-- Where participants can ask about payments (shown in the "contact the Orga" hints).
ALTER TABLE payment_settings ADD COLUMN contact_email text;

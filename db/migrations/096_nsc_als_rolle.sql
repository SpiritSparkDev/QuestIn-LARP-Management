-- NSC is a registration role, not a character class: NSC questionnaire values
-- live on the character (reusable) or, for Springer, on the registration.
ALTER TABLE characters ADD COLUMN nsc_data jsonb NOT NULL DEFAULT '{}';
ALTER TABLE registrations ADD COLUMN nsc_data jsonb NOT NULL DEFAULT '{}';

UPDATE characters SET nsc_data = data, data = '{}' WHERE class = 'nsc';

ALTER TABLE characters DROP COLUMN class;
ALTER TABLE registrations DROP COLUMN nsc_wishes;

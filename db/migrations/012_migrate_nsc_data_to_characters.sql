INSERT INTO characters (user_id, event_id, class, name, data)
SELECT id, NULL, 'nsc', name, nsc_data
FROM users
WHERE nsc_data IS NOT NULL AND nsc_data::text != '{}';

ALTER TABLE users DROP COLUMN nsc_data;

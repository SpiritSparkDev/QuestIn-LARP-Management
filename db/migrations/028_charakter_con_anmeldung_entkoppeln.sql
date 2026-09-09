-- 1. registrations.character_id (nullable first, backfilled below -- the
--    backfill needs characters.event_id, which is dropped at the very end).
ALTER TABLE registrations ADD COLUMN character_id uuid REFERENCES characters(id);

-- 2a. Backfill sc/gsc registrations: link to the oldest sc-class character
--     the same user created for that same event.
UPDATE registrations r SET character_id = sub.character_id
FROM (
  SELECT DISTINCT ON (r2.user_id, r2.event_id) r2.user_id, r2.event_id, c.id AS character_id
  FROM registrations r2
  JOIN characters c ON c.user_id = r2.user_id AND c.event_id = r2.event_id AND c.class = 'sc'
  WHERE r2.con_role IN ('sc', 'gsc')
  ORDER BY r2.user_id, r2.event_id, c.created_at ASC
) sub
WHERE r.user_id = sub.user_id AND r.event_id = sub.event_id AND r.con_role IN ('sc', 'gsc');

-- 2b. Backfill nsc registrations: link to the oldest nsc-class character the
--     user owns (nsc characters were always account-wide, never event-bound).
UPDATE registrations r SET character_id = sub.character_id
FROM (
  SELECT DISTINCT ON (r2.user_id) r2.user_id, c.id AS character_id
  FROM registrations r2
  JOIN characters c ON c.user_id = r2.user_id AND c.class = 'nsc'
  WHERE r2.con_role = 'nsc'
  ORDER BY r2.user_id, c.created_at ASC
) sub
WHERE r.user_id = sub.user_id AND r.con_role = 'nsc';

-- 3. Enforce the invariant going forward.
ALTER TABLE registrations ADD CONSTRAINT registrations_character_con_role_check
  CHECK (
    (con_role IN ('sc', 'gsc', 'nsc') AND character_id IS NOT NULL)
    OR (con_role IN ('helfer', 'orga', 'hilfs_orga') AND character_id IS NULL)
  );

-- 4. characters.event_id is superseded by registrations.character_id.
ALTER TABLE characters DROP CONSTRAINT characters_class_event_check;
ALTER TABLE characters DROP COLUMN event_id;

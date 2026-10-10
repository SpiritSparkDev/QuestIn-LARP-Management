-- Member number: a permanent, unique, human-friendly ID per account,
-- assigned in order of account creation (users.created_at; id breaks ties).
-- Existing accounts are numbered once here, new ones draw from the sequence.
ALTER TABLE users ADD COLUMN member_number integer;
UPDATE users u SET member_number = n.rn
  FROM (SELECT id, row_number() OVER (ORDER BY created_at, id) AS rn FROM users) n
 WHERE n.id = u.id;
CREATE SEQUENCE users_member_number_seq OWNED BY users.member_number;
SELECT setval('users_member_number_seq', COALESCE((SELECT max(member_number) FROM users), 0) + 1, false);
ALTER TABLE users ALTER COLUMN member_number SET DEFAULT nextval('users_member_number_seq');
ALTER TABLE users ALTER COLUMN member_number SET NOT NULL;
ALTER TABLE users ADD CONSTRAINT users_member_number_key UNIQUE (member_number);

-- Registration lock (123): 'block' refuses a locked registration, 'waitlist'
-- takes it onto the waitlist instead. waitlisted_by_lock marks those entries
-- so lifting the lock moves exactly them up (backend/registrations/repository.js
-- maybePromoteFromWaitlist), not people waiting for a free place or put there by hand.
ALTER TABLE events ADD COLUMN registration_lock_mode text NOT NULL DEFAULT 'block'
  CHECK (registration_lock_mode IN ('block', 'waitlist'));
ALTER TABLE registrations ADD COLUMN waitlisted_by_lock boolean NOT NULL DEFAULT false;

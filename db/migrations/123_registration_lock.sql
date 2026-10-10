-- Manual registration lock per event, set by an admin (PUT
-- /events/:id/registration-lock, backend/registrations/lock.js): self-service
-- registrations are refused for the listed con roles (sc, nsc, ticket, ...)
-- and for members of the listed account roles (groups.key). Empty = open.
-- Admins and moderators registering someone are never locked out.
ALTER TABLE events ADD COLUMN registration_locked_con_roles text[] NOT NULL DEFAULT '{}';
ALTER TABLE events ADD COLUMN registration_locked_groups text[] NOT NULL DEFAULT '{}';

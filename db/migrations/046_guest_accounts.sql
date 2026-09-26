ALTER TABLE users ADD COLUMN is_guest boolean NOT NULL DEFAULT false;

-- NULL = today's "invite a brand-new member" mode (redeem INSERTs a new
-- users row). Set = "convert an existing guest" mode (redeem UPDATEs this
-- user row in place instead) -- see backend/auth/invite.js.
ALTER TABLE invitations ADD COLUMN user_id uuid REFERENCES users(id);

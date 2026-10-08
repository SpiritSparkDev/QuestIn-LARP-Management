-- Two-way dialog between an NSC registration (player) and staff.
-- Only NSC-related registrations get one (enforced in the app); rows vanish
-- with the registration (and so with the event or the account).
CREATE TABLE nsc_dialog_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id uuid NOT NULL,
  user_id uuid NOT NULL,
  author_id uuid REFERENCES users(id) ON DELETE SET NULL,
  author_side text NOT NULL CHECK (author_side IN ('player', 'staff')),
  body text NOT NULL CHECK (char_length(body) BETWEEN 1 AND 2000),
  proposal jsonb,
  proposal_status text CHECK (proposal_status IN ('open', 'accepted', 'declined')),
  created_at timestamptz NOT NULL DEFAULT now(),
  read_at timestamptz,
  FOREIGN KEY (user_id, event_id) REFERENCES registrations (user_id, event_id) ON DELETE CASCADE,
  CHECK ((proposal IS NULL) = (proposal_status IS NULL)),
  CHECK (proposal IS NULL OR author_side = 'staff')
);
CREATE INDEX nsc_dialog_messages_thread_idx ON nsc_dialog_messages (event_id, user_id, created_at);

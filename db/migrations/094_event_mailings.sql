-- Rundmails an die Teilnehmenden eines Events (Verlauf + Fortschritt des Versands).
CREATE TABLE event_mailings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id uuid NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  sent_by uuid REFERENCES users(id) ON DELETE SET NULL,
  subject text NOT NULL,
  body_html text NOT NULL,
  recipient_count integer NOT NULL,
  sent_count integer NOT NULL DEFAULT 0,
  failed_count integer NOT NULL DEFAULT 0,
  failed_addresses jsonb NOT NULL DEFAULT '[]',
  filter jsonb NOT NULL DEFAULT '{}',
  test_only boolean NOT NULL DEFAULT false,
  status text NOT NULL DEFAULT 'sending' CHECK (status IN ('sending', 'done')),
  created_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz
);
CREATE INDEX event_mailings_event_idx ON event_mailings (event_id, created_at DESC);

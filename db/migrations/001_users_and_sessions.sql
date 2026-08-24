CREATE TABLE users (
  id uuid primary key default gen_random_uuid(),
  email text unique not null,
  password_hash text,
  role text not null default 'participant' check (role in ('participant', 'admin', 'checkin_helper')),
  email_verified boolean not null default false,
  name text not null,
  address_enc bytea,
  birthdate_enc bytea,
  phone_enc bytea,
  emergency_contact_enc bytea,
  medical_notes_enc bytea,
  created_at timestamptz not null default now()
);

CREATE TABLE sessions (
  token text primary key,
  user_id uuid not null references users(id) on delete cascade,
  expires_at timestamptz not null
);

CREATE TABLE email_verification_tokens (
  token text primary key,
  user_id uuid not null references users(id) on delete cascade,
  expires_at timestamptz not null
);

CREATE TABLE password_reset_tokens (
  token text primary key,
  user_id uuid not null references users(id) on delete cascade,
  expires_at timestamptz not null
);

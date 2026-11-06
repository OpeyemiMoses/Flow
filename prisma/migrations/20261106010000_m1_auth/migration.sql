BEGIN;

CREATE TABLE flow.auth_users (
  id text PRIMARY KEY,
  name text NOT NULL,
  email text NOT NULL UNIQUE,
  email_verified boolean NOT NULL,
  email_enrolled boolean NOT NULL DEFAULT false,
  mailbox_paused boolean NOT NULL DEFAULT false,
  image text,
  created_at timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamp(3) NOT NULL,
  CONSTRAINT auth_users_canonical_email CHECK (email = lower(btrim(email))),
  CONSTRAINT auth_users_enrollment CHECK (NOT email_enrolled OR (email_verified AND NOT mailbox_paused))
);

CREATE TABLE flow.auth_identities (
  id text PRIMARY KEY,
  user_id text NOT NULL REFERENCES flow.auth_users(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  provider_id text NOT NULL,
  provider_subject text NOT NULL,
  access_token text,
  refresh_token text,
  id_token text,
  access_token_expires_at timestamp(3),
  refresh_token_expires_at timestamp(3),
  scope text,
  password text,
  created_at timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamp(3) NOT NULL,
  CONSTRAINT auth_identities_provider_id_provider_subject_key UNIQUE (provider_id, provider_subject),
  CONSTRAINT auth_identities_user_id_provider_id_key UNIQUE (user_id, provider_id),
  CONSTRAINT auth_identities_google_only CHECK (provider_id = 'google'),
  CONSTRAINT auth_identities_no_credentials CHECK (
    access_token IS NULL AND refresh_token IS NULL AND id_token IS NULL
    AND access_token_expires_at IS NULL AND refresh_token_expires_at IS NULL
    AND scope IS NULL AND password IS NULL
  )
);

CREATE TABLE flow.google_subject_bindings (
  subject text PRIMARY KEY,
  user_id text NOT NULL REFERENCES flow.auth_users(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  created_at timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE flow.auth_sessions (
  id text PRIMARY KEY,
  user_id text NOT NULL REFERENCES flow.auth_users(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  token text NOT NULL UNIQUE,
  expires_at timestamp(3) NOT NULL,
  created_at timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamp(3) NOT NULL,
  ip_address text,
  user_agent text
);
CREATE INDEX auth_sessions_user_id_idx ON flow.auth_sessions(user_id);
CREATE INDEX auth_sessions_expires_at_idx ON flow.auth_sessions(expires_at);

CREATE TABLE flow.auth_verifications (
  id text PRIMARY KEY,
  identifier text NOT NULL,
  value text NOT NULL,
  expires_at timestamp(3) NOT NULL,
  created_at timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamp(3) NOT NULL
);
CREATE INDEX auth_verifications_identifier_idx ON flow.auth_verifications(identifier);
CREATE INDEX auth_verifications_expires_at_idx ON flow.auth_verifications(expires_at);

CREATE TABLE flow.auth_intents (
  slot text PRIMARY KEY,
  digest text NOT NULL UNIQUE,
  purpose text NOT NULL,
  email text,
  user_id text,
  session_id text,
  target text,
  nonce_hash text,
  state_hash text,
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  verified boolean NOT NULL DEFAULT false,
  issued_at timestamp(3) NOT NULL,
  expires_at timestamp(3) NOT NULL
);
CREATE INDEX auth_intents_expires_at_idx ON flow.auth_intents(expires_at);

CREATE TABLE flow.auth_throttles (
  key text PRIMARY KEY,
  count integer NOT NULL CHECK (count > 0),
  expires_at timestamp(3) NOT NULL
);
CREATE INDEX auth_throttles_expires_at_idx ON flow.auth_throttles(expires_at);

DO $$
DECLARE app_role text := current_database() || '_app';
BEGIN
  EXECUTE format('GRANT SELECT, INSERT, UPDATE ON flow.auth_users TO %I', app_role);
  EXECUTE format('GRANT SELECT, INSERT ON flow.google_subject_bindings TO %I', app_role);
  EXECUTE format(
    'GRANT SELECT, INSERT, UPDATE, DELETE ON flow.auth_identities, flow.auth_sessions, '
    'flow.auth_verifications, flow.auth_intents, flow.auth_throttles TO %I', app_role
  );
END;
$$;

COMMIT;

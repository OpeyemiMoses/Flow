BEGIN;

CREATE TYPE flow.account_kind AS ENUM ('PERSONAL', 'BUSINESS');
CREATE TYPE flow.member_role AS ENUM ('OWNER', 'ADMIN', 'MEMBER');
CREATE TYPE flow.member_status AS ENUM ('ACTIVE', 'REMOVED');
CREATE TYPE flow.invite_status AS ENUM ('PENDING', 'ACCEPTED', 'REVOKED');

CREATE TABLE flow.users (
  id uuid PRIMARY KEY,
  auth_user_id text NOT NULL UNIQUE REFERENCES flow.auth_users(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  active boolean NOT NULL DEFAULT true,
  created_at timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE flow.accounts (
  id uuid PRIMARY KEY,
  kind flow.account_kind NOT NULL,
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 80),
  personal_owner_id uuid UNIQUE REFERENCES flow.users(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  created_at timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (id, kind),
  CONSTRAINT accounts_personal_owner CHECK ((kind = 'PERSONAL') = (personal_owner_id IS NOT NULL))
);

CREATE TABLE flow.business_profiles (
  account_id uuid PRIMARY KEY,
  kind flow.account_kind NOT NULL DEFAULT 'BUSINESS' CHECK (kind = 'BUSINESS'),
  UNIQUE (account_id, kind),
  FOREIGN KEY (account_id, kind) REFERENCES flow.accounts(id, kind) ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE TABLE flow.account_memberships (
  id uuid PRIMARY KEY,
  account_id uuid NOT NULL REFERENCES flow.business_profiles(account_id) ON DELETE RESTRICT ON UPDATE CASCADE,
  user_id uuid NOT NULL REFERENCES flow.users(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  role flow.member_role NOT NULL,
  status flow.member_status NOT NULL DEFAULT 'ACTIVE',
  created_at timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (account_id, user_id),
  CONSTRAINT membership_owner_active CHECK (role <> 'OWNER' OR status = 'ACTIVE')
);
CREATE INDEX account_memberships_user_id_status_idx ON flow.account_memberships(user_id, status);
CREATE UNIQUE INDEX account_memberships_single_owner ON flow.account_memberships(account_id) WHERE role = 'OWNER';

CREATE TABLE flow.account_invites (
  id uuid PRIMARY KEY,
  account_id uuid NOT NULL REFERENCES flow.business_profiles(account_id) ON DELETE RESTRICT ON UPDATE CASCADE,
  inviter_id uuid NOT NULL REFERENCES flow.users(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  email text NOT NULL,
  role flow.member_role NOT NULL CHECK (role <> 'OWNER'),
  digest text NOT NULL UNIQUE,
  status flow.invite_status NOT NULL DEFAULT 'PENDING',
  expires_at timestamp(3) NOT NULL,
  created_at timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX account_invites_account_id_status_idx ON flow.account_invites(account_id, status);
CREATE UNIQUE INDEX account_invites_one_pending_email ON flow.account_invites(account_id, email) WHERE status = 'PENDING';

CREATE TABLE flow.business_creations (
  actor_id uuid NOT NULL REFERENCES flow.users(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  key uuid NOT NULL,
  fingerprint text NOT NULL,
  account_id uuid NOT NULL UNIQUE REFERENCES flow.accounts(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  PRIMARY KEY (actor_id, key)
);

CREATE TABLE flow.security_audit_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind text NOT NULL,
  actor_auth_id text NOT NULL,
  account_id uuid,
  target_id text,
  request_id uuid NOT NULL,
  created_at timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX security_audit_events_account_id_created_at_idx ON flow.security_audit_events(account_id, created_at);

DO $$
DECLARE app_role text := current_database() || '_app';
BEGIN
  EXECUTE format('GRANT SELECT, INSERT ON flow.users, flow.business_profiles, flow.business_creations TO %I', app_role);
  EXECUTE format('GRANT SELECT, INSERT, UPDATE ON flow.accounts, flow.account_memberships, flow.account_invites TO %I', app_role);
  EXECUTE format('GRANT INSERT ON flow.security_audit_events TO %I', app_role);
END;
$$;

COMMIT;

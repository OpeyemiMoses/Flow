BEGIN;

-- CreateEnum
CREATE TYPE flow.wallet_status AS ENUM (
  'SETUP_PENDING',
  'PROVISIONING',
  'ACTIVE',
  'SETUP_FAILED',
  'FROZEN',
  'RECOVERY_PENDING'
);

-- CreateTable: flow.wallets
CREATE TABLE flow.wallets (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL,
  provider text NOT NULL DEFAULT 'OUTLAYER',
  provider_wallet_id text NOT NULL,
  near_account_id text NOT NULL,
  encrypted_credential text NOT NULL,
  key_id text NOT NULL DEFAULT 'v1',
  key_digest text NOT NULL,
  status flow.wallet_status NOT NULL DEFAULT 'SETUP_PENDING',
  policy_state text NOT NULL DEFAULT 'none',
  controller_account_id text,
  handoff_url text,
  created_at timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT wallets_pkey PRIMARY KEY (id),
  CONSTRAINT wallets_account_id_key UNIQUE (account_id),
  CONSTRAINT wallets_account_id_fkey FOREIGN KEY (account_id) REFERENCES flow.accounts(id) ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE INDEX wallets_provider_wallet_id_idx ON flow.wallets(provider_wallet_id);

-- CreateTable: flow.wallet_addresses
CREATE TABLE flow.wallet_addresses (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  wallet_id uuid NOT NULL,
  network text NOT NULL,
  chain_id text NOT NULL,
  address text NOT NULL,
  public_key text NOT NULL,
  created_at timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT wallet_addresses_pkey PRIMARY KEY (id),
  CONSTRAINT wallet_addresses_wallet_id_network_key UNIQUE (wallet_id, network),
  CONSTRAINT wallet_addresses_wallet_id_fkey FOREIGN KEY (wallet_id) REFERENCES flow.wallets(id) ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE INDEX wallet_addresses_network_address_idx ON flow.wallet_addresses(network, address);

-- CreateTable: flow.wallet_capabilities
CREATE TABLE flow.wallet_capabilities (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  wallet_id uuid NOT NULL,
  network text NOT NULL,
  can_derive_address boolean NOT NULL DEFAULT true,
  can_receive boolean NOT NULL DEFAULT true,
  can_read_native_balance boolean NOT NULL DEFAULT false,
  can_read_intents_balance boolean NOT NULL DEFAULT false,
  can_sign_transfer boolean NOT NULL DEFAULT false,
  broadcast_mode text NOT NULL DEFAULT 'unsupported',
  can_rotate_credentials boolean NOT NULL DEFAULT false,
  verified_at timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT wallet_capabilities_pkey PRIMARY KEY (id),
  CONSTRAINT wallet_capabilities_wallet_id_network_key UNIQUE (wallet_id, network),
  CONSTRAINT wallet_capabilities_wallet_id_fkey FOREIGN KEY (wallet_id) REFERENCES flow.wallets(id) ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable: flow.wallet_provisioning_jobs
CREATE TABLE flow.wallet_provisioning_jobs (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL,
  idempotency_key uuid NOT NULL,
  status text NOT NULL DEFAULT 'PENDING',
  fencing_token bigint NOT NULL DEFAULT 0,
  lease_holder text,
  lease_expires_at timestamp(3),
  dispatch_attempt_id uuid,
  dispatched_at timestamp(3),
  attempts integer NOT NULL DEFAULT 0,
  max_attempts integer NOT NULL DEFAULT 3,
  failure_classification text,
  last_error text,
  recovery_evidence text,
  created_at timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT wallet_provisioning_jobs_pkey PRIMARY KEY (id),
  CONSTRAINT wallet_provisioning_jobs_account_id_key UNIQUE (account_id),
  CONSTRAINT wallet_provisioning_jobs_idempotency_key_key UNIQUE (idempotency_key),
  CONSTRAINT wallet_provisioning_jobs_account_id_fkey FOREIGN KEY (account_id) REFERENCES flow.accounts(id) ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE INDEX wallet_provisioning_jobs_account_id_status_idx ON flow.wallet_provisioning_jobs(account_id, status);

-- Grants
DO $$
DECLARE app_role text := current_database() || '_app';
BEGIN
  EXECUTE format('GRANT SELECT, INSERT, UPDATE ON flow.wallets, flow.wallet_addresses, flow.wallet_capabilities, flow.wallet_provisioning_jobs TO %I', app_role);
END;
$$;

COMMIT;

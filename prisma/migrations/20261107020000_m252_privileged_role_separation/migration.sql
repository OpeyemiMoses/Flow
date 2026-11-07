BEGIN;

-- 1. Wallets: Distinguish mainnet from testnet
ALTER TABLE flow.wallets ADD COLUMN IF NOT EXISTS environment text NOT NULL DEFAULT 'mainnet';

-- 2. Provider Compatibility Authorizations: Enforce durable single-record limit across database
ALTER TABLE flow.provider_compatibility_authorizations ADD COLUMN IF NOT EXISTS singleton_scope text NOT NULL DEFAULT 'GLOBAL_TESTNET_REHEARSAL';
ALTER TABLE flow.provider_compatibility_authorizations ADD COLUMN IF NOT EXISTS authorized_by_operator_id text;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'provider_compatibility_singleton_key'
  ) THEN
    ALTER TABLE flow.provider_compatibility_authorizations ADD CONSTRAINT provider_compatibility_singleton_key UNIQUE (singleton_scope);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'provider_compatibility_singleton_check'
  ) THEN
    ALTER TABLE flow.provider_compatibility_authorizations ADD CONSTRAINT provider_compatibility_singleton_check CHECK (singleton_scope = 'GLOBAL_TESTNET_REHEARSAL');
  END IF;
END $$;

-- 3. Custody Recovery Approvals: Bind to exact dispatch attempt and enforce two-person rule in DB
ALTER TABLE flow.custody_recovery_approvals ADD COLUMN IF NOT EXISTS dispatch_attempt_id uuid NOT NULL DEFAULT gen_random_uuid();
ALTER TABLE flow.custody_recovery_approvals ADD COLUMN IF NOT EXISTS initiator_operator_auth_id text NOT NULL DEFAULT 'system_operator';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'custody_recovery_approvals_self_approval_check'
  ) THEN
    ALTER TABLE flow.custody_recovery_approvals ADD CONSTRAINT custody_recovery_approvals_self_approval_check CHECK (initiator_operator_auth_id <> approver_auth_id);
  END IF;
END $$;

-- 4. Correct Database Privileges for Least-Privilege Runtime Identities
DO $$
DECLARE
  db_name text := current_database();
  app_role text := db_name || '_app';
  worker_role text := db_name || '_worker';
  operator_role text := db_name || '_operator';
BEGIN
  -- A. Web Application Role (app_role): REVOKE modifying permissions on privileged tables
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = app_role) THEN
    EXECUTE format('REVOKE INSERT, UPDATE, DELETE ON flow.provider_compatibility_authorizations FROM %I', app_role);
    EXECUTE format('REVOKE INSERT, UPDATE, DELETE ON flow.custody_operators FROM %I', app_role);
    EXECUTE format('REVOKE INSERT, UPDATE, DELETE ON flow.custody_recovery_approvals FROM %I', app_role);
    EXECUTE format('REVOKE INSERT, UPDATE, DELETE ON flow.wallets FROM %I', app_role);
    EXECUTE format('REVOKE INSERT, UPDATE, DELETE ON flow.wallet_addresses FROM %I', app_role);
    EXECUTE format('REVOKE INSERT, UPDATE, DELETE ON flow.wallet_capabilities FROM %I', app_role);

    -- Web app only reads public wallet projections and schedules onboarding jobs
    EXECUTE format('GRANT SELECT ON flow.wallets, flow.wallet_addresses, flow.wallet_capabilities, flow.custody_operators TO %I', app_role);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE ON flow.wallet_provisioning_jobs TO %I', app_role);
  END IF;

  -- B. Wallet Worker Role (worker_role): Least-privilege worker identity
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = worker_role) THEN
    EXECUTE format('GRANT USAGE ON SCHEMA flow TO %I', worker_role);
    EXECUTE format('GRANT SELECT ON flow.accounts, flow.users, flow.auth_users TO %I', worker_role);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE ON flow.wallet_provisioning_jobs TO %I', worker_role);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE ON flow.wallets, flow.wallet_addresses, flow.wallet_capabilities TO %I', worker_role);
    EXECUTE format('GRANT SELECT, UPDATE ON flow.provider_compatibility_authorizations TO %I', worker_role);
    EXECUTE format('GRANT SELECT ON flow.custody_operators, flow.custody_recovery_approvals TO %I', worker_role);
    EXECUTE format('GRANT SELECT, INSERT ON flow.security_audit_events TO %I', worker_role);
    -- Worker CANNOT create authorizations, enroll operators, or approve recoveries
    EXECUTE format('REVOKE INSERT, DELETE ON flow.provider_compatibility_authorizations FROM %I', worker_role);
    EXECUTE format('REVOKE INSERT, UPDATE, DELETE ON flow.custody_operators, flow.custody_recovery_approvals FROM %I', worker_role);
  END IF;

  -- C. Authorized Custody Operator Role (operator_role): Privileged recovery & authorization identity
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = operator_role) THEN
    EXECUTE format('GRANT USAGE ON SCHEMA flow TO %I', operator_role);
    EXECUTE format('GRANT SELECT ON flow.accounts, flow.users, flow.auth_users TO %I', operator_role);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON flow.custody_operators TO %I', operator_role);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON flow.custody_recovery_approvals TO %I', operator_role);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON flow.provider_compatibility_authorizations TO %I', operator_role);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE ON flow.wallet_provisioning_jobs TO %I', operator_role);
    EXECUTE format('GRANT SELECT, INSERT ON flow.security_audit_events TO %I', operator_role);
    EXECUTE format('GRANT SELECT, INSERT ON flow.wallets TO %I', operator_role);
    EXECUTE format('REVOKE UPDATE, DELETE ON flow.wallets FROM %I', operator_role);
    EXECUTE format('REVOKE ALL ON flow.wallet_addresses, flow.wallet_capabilities FROM %I', operator_role);
  END IF;
END;
$$;

COMMIT;

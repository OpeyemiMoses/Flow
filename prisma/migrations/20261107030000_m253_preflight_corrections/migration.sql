BEGIN;

-- 1. Create safe projection view for public wallet queries
CREATE OR REPLACE VIEW flow.wallet_public_projections AS
SELECT
  id,
  account_id,
  provider,
  environment,
  provider_wallet_id,
  near_account_id,
  status,
  policy_state,
  controller_account_id,
  handoff_url,
  created_at,
  updated_at
FROM flow.wallets;

-- 2. Restrict Web Application Role (app_role) column-level access on flow.wallets
DO $$
DECLARE
  db_name text := current_database();
  app_role text := db_name || '_app';
  worker_role text := db_name || '_worker';
  operator_role text := db_name || '_operator';
BEGIN
  -- A. Web Application Role: Revoke table-level SELECT on flow.wallets
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = app_role) THEN
    EXECUTE format('REVOKE SELECT ON flow.wallets FROM %I', app_role);

    -- Grant ONLY column-level SELECT on non-secret columns
    -- Custody secret columns (encrypted_credential, key_id, key_digest) remain strictly inaccessible
    EXECUTE format(
      'GRANT SELECT (id, account_id, provider, environment, provider_wallet_id, near_account_id, status, policy_state, controller_account_id, handoff_url, created_at, updated_at) ON flow.wallets TO %I',
      app_role
    );

    -- Grant SELECT on public projection view
    EXECUTE format('GRANT SELECT ON flow.wallet_public_projections TO %I', app_role);
  END IF;

  -- B. Grant SELECT on public projection view to worker and operator as well
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = worker_role) THEN
    EXECUTE format('GRANT SELECT ON flow.wallet_public_projections TO %I', worker_role);
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = operator_role) THEN
    EXECUTE format('GRANT SELECT ON flow.wallet_public_projections TO %I', operator_role);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON flow.auth_sessions TO %I', operator_role);
    EXECUTE format('GRANT SELECT ON flow.wallet_addresses, flow.wallet_capabilities TO %I', operator_role);
  END IF;

  -- C. Revoke DELETE on flow.provider_compatibility_authorizations from app_role and worker_role
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = app_role) THEN
    EXECUTE format('REVOKE DELETE ON flow.provider_compatibility_authorizations FROM %I', app_role);
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = worker_role) THEN
    EXECUTE format('REVOKE DELETE ON flow.provider_compatibility_authorizations FROM %I', worker_role);
  END IF;
END;
$$;

-- 3. Immutability trigger for flow.provider_compatibility_authorizations
CREATE OR REPLACE FUNCTION flow.prevent_compatibility_authorization_tampering()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status IN ('CLAIMED', 'CONSUMED', 'QUARANTINED') THEN
      IF current_setting('flow.allow_test_cleanup', true) IS DISTINCT FROM 'on' THEN
        RAISE EXCEPTION 'Deleting consumed or claimed provider compatibility authorizations is strictly prohibited for quota and audit integrity'
          USING ERRCODE = '42501';
      END IF;
    END IF;
    RETURN OLD;
  END IF;

  IF TG_OP = 'UPDATE' THEN
    -- Block resetting back to AUTHORIZED from any subsequent state
    IF NEW.status = 'AUTHORIZED' AND OLD.status IN ('CLAIMED', 'CONSUMED', 'QUARANTINED', 'EXPIRED') THEN
      RAISE EXCEPTION 'Resetting compatibility authorization back to AUTHORIZED is strictly prohibited'
        USING ERRCODE = '23514';
    END IF;

    -- Once CONSUMED or QUARANTINED, the record is permanently immutable
    IF OLD.status IN ('CONSUMED', 'QUARANTINED') AND (
      NEW.status <> OLD.status OR
      NEW.registrations_attempted <> OLD.registrations_attempted OR
      NEW.registrations_completed <> OLD.registrations_completed OR
      NEW.max_registrations <> OLD.max_registrations OR
      NEW.account_id <> OLD.account_id OR
      NEW.singleton_scope <> OLD.singleton_scope
    ) THEN
      RAISE EXCEPTION 'Consumed or quarantined compatibility authorizations are permanently immutable'
        USING ERRCODE = '23514';
    END IF;

    -- Prevent decrementing counters
    IF NEW.registrations_attempted < OLD.registrations_attempted THEN
      RAISE EXCEPTION 'registrations_attempted cannot be decremented'
        USING ERRCODE = '23514';
    END IF;
    IF NEW.registrations_completed < OLD.registrations_completed THEN
      RAISE EXCEPTION 'registrations_completed cannot be decremented'
        USING ERRCODE = '23514';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_prevent_compatibility_authorization_tampering ON flow.provider_compatibility_authorizations;
CREATE TRIGGER trg_prevent_compatibility_authorization_tampering
  BEFORE UPDATE OR DELETE ON flow.provider_compatibility_authorizations
  FOR EACH ROW
  EXECUTE FUNCTION flow.prevent_compatibility_authorization_tampering();

COMMIT;


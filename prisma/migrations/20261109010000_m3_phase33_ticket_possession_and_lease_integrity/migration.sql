BEGIN;

-- ============================================================================
-- Section 1: Portfolio Refresh Lease Secrets Table
-- ============================================================================

CREATE TABLE IF NOT EXISTS flow.portfolio_refresh_lease_secrets (
  account_id uuid PRIMARY KEY REFERENCES flow.accounts(id) ON DELETE CASCADE,
  fencing_token bigint NOT NULL,
  lease_token uuid NOT NULL,
  lease_holder text NOT NULL,
  acquired_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP
);

ALTER TABLE flow.portfolio_refresh_lease_secrets ENABLE ROW LEVEL SECURITY;
ALTER TABLE flow.portfolio_refresh_lease_secrets NO FORCE ROW LEVEL SECURITY;

REVOKE ALL ON flow.portfolio_refresh_lease_secrets FROM PUBLIC;

-- ============================================================================
-- Section 2: Hardened Portfolio Refresh Lease Functions
-- ============================================================================

-- Drop older overload versions so callers cannot supply custom cooldown or duration
DROP FUNCTION IF EXISTS flow.acquire_portfolio_refresh_lease(uuid, text, integer, integer);
DROP FUNCTION IF EXISTS flow.acquire_portfolio_refresh_lease(uuid, text);

CREATE OR REPLACE FUNCTION flow.acquire_portfolio_refresh_lease(
  p_account_id uuid,
  p_lease_holder text
)
RETURNS TABLE (
  acquired boolean,
  reason text,
  fencing_token bigint,
  lease_token uuid,
  remaining_seconds integer
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = flow, pg_temp
AS $$
DECLARE
  c_cooldown_seconds CONSTANT integer := 15;
  c_lease_duration_seconds CONSTANT integer := 10;
  v_current record;
  v_acquired record;
  v_elapsed_seconds integer;
  v_lease_token uuid;
BEGIN
  -- 1. Tenant boundary enforcement: Caller must be authorized for this account
  IF NOT flow.can_access_account(p_account_id) THEN
    RAISE EXCEPTION 'Account access unauthorized' USING ERRCODE = '42501';
  END IF;

  -- 2. Inspect current lease state
  SELECT last_refreshed_at, lease_expires_at, flow.portfolio_refresh_leases.fencing_token
  INTO v_current
  FROM flow.portfolio_refresh_leases
  WHERE account_id = p_account_id;

  IF FOUND AND v_current.last_refreshed_at IS NOT NULL THEN
    v_elapsed_seconds := EXTRACT(EPOCH FROM (CURRENT_TIMESTAMP - v_current.last_refreshed_at))::integer;
    IF v_elapsed_seconds < c_cooldown_seconds THEN
      RETURN QUERY SELECT
        false,
        'COOLDOWN'::text,
        v_current.fencing_token,
        NULL::uuid,
        GREATEST(1, c_cooldown_seconds - v_elapsed_seconds);
      RETURN;
    END IF;
  END IF;

  -- 3. Atomic lease acquisition with fencing token increment
  INSERT INTO flow.portfolio_refresh_leases (
    account_id, last_refreshed_at, lease_expires_at, lease_holder, fencing_token, updated_at
  ) VALUES (
    p_account_id,
    NULL,
    CURRENT_TIMESTAMP + (c_lease_duration_seconds || ' seconds')::interval,
    p_lease_holder,
    1,
    CURRENT_TIMESTAMP
  )
  ON CONFLICT (account_id) DO UPDATE
  SET lease_expires_at = CURRENT_TIMESTAMP + (c_lease_duration_seconds || ' seconds')::interval,
      lease_holder = EXCLUDED.lease_holder,
      fencing_token = flow.portfolio_refresh_leases.fencing_token + 1,
      updated_at = CURRENT_TIMESTAMP
  WHERE (flow.portfolio_refresh_leases.last_refreshed_at IS NULL
         OR flow.portfolio_refresh_leases.last_refreshed_at <= CURRENT_TIMESTAMP - (c_cooldown_seconds || ' seconds')::interval)
    AND (flow.portfolio_refresh_leases.lease_expires_at IS NULL
         OR flow.portfolio_refresh_leases.lease_expires_at <= CURRENT_TIMESTAMP)
  RETURNING flow.portfolio_refresh_leases.fencing_token INTO v_acquired;

  IF FOUND THEN
    v_lease_token := gen_random_uuid();
    INSERT INTO flow.portfolio_refresh_lease_secrets (
      account_id, fencing_token, lease_token, lease_holder, acquired_at
    ) VALUES (
      p_account_id, v_acquired.fencing_token, v_lease_token, p_lease_holder, CURRENT_TIMESTAMP
    )
    ON CONFLICT (account_id) DO UPDATE
    SET fencing_token = EXCLUDED.fencing_token,
        lease_token = EXCLUDED.lease_token,
        lease_holder = EXCLUDED.lease_holder,
        acquired_at = EXCLUDED.acquired_at;

    RETURN QUERY SELECT true, 'ACQUIRED'::text, v_acquired.fencing_token, v_lease_token, 0;
    RETURN;
  END IF;

  -- 4. In-flight lease held by another worker
  RETURN QUERY SELECT false, 'IN_FLIGHT'::text, COALESCE(v_current.fencing_token, 0::bigint), NULL::uuid, 0;
END;
$$;

-- Drop older overload versions of release function
DROP FUNCTION IF EXISTS flow.release_portfolio_refresh_lease(uuid, bigint, boolean);
DROP FUNCTION IF EXISTS flow.release_portfolio_refresh_lease(uuid, bigint, uuid, boolean);

CREATE OR REPLACE FUNCTION flow.release_portfolio_refresh_lease(
  p_account_id uuid,
  p_fencing_token bigint,
  p_lease_token uuid,
  p_success boolean
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = flow, pg_temp
AS $$
DECLARE
  v_client_user text := SESSION_USER;
  v_secret record;
  v_updated integer;
BEGIN
  -- 1. Security Gate: Only worker_role or migrator_role can release refresh leases
  IF NOT (v_client_user LIKE '%_worker' OR v_client_user LIKE '%_migrator') THEN
    RAISE EXCEPTION 'Lease release unauthorized for client role: %', v_client_user
      USING ERRCODE = '42501';
  END IF;

  -- 2. Validate unforgeable capability: lease_token and fencing_token
  IF p_lease_token IS NULL THEN
    RAISE EXCEPTION 'Lease token required for release' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_secret
  FROM flow.portfolio_refresh_lease_secrets
  WHERE account_id = p_account_id
    AND fencing_token = p_fencing_token
    AND lease_token = p_lease_token;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Invalid, expired, or non-matching lease capability' USING ERRCODE = '42501';
  END IF;

  -- 3. Release with CAS check on fencing_token
  IF p_success THEN
    UPDATE flow.portfolio_refresh_leases
    SET last_refreshed_at = CURRENT_TIMESTAMP,
        lease_expires_at = NULL,
        lease_holder = NULL,
        updated_at = CURRENT_TIMESTAMP
    WHERE account_id = p_account_id AND fencing_token = p_fencing_token;
  ELSE
    -- Fail-closed: clear active lease holder without marking last_refreshed_at as fresh
    UPDATE flow.portfolio_refresh_leases
    SET lease_expires_at = NULL,
        lease_holder = NULL,
        updated_at = CURRENT_TIMESTAMP
    WHERE account_id = p_account_id AND fencing_token = p_fencing_token;
  END IF;

  GET DIAGNOSTICS v_updated = ROW_COUNT;

  -- Clean up secret token
  DELETE FROM flow.portfolio_refresh_lease_secrets WHERE account_id = p_account_id;

  RETURN v_updated > 0;
END;
$$;

-- ============================================================================
-- Section 3: Hardened Authentication Ticket Validation (Zero Fallback)
-- ============================================================================

CREATE OR REPLACE FUNCTION flow.trg_auth_sessions_validate_insert()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = flow, pg_temp
AS $$
DECLARE
  v_ticket_id text;
  v_ticket record;
  v_client_user text := SESSION_USER;
BEGIN
  -- Migrator role can insert during migrations/seeds
  IF v_client_user LIKE '%_migrator' THEN
    PERFORM set_config('flow.current_session_token', NEW.token, true);
    RETURN NEW;
  END IF;

  -- Operator role can insert verified sessions for registered users
  IF v_client_user LIKE '%_operator' THEN
    IF NOT EXISTS (
      SELECT 1 FROM flow.auth_users
      WHERE id = NEW.user_id
    ) THEN
      RAISE EXCEPTION 'Operator session creation unauthorized for unregistered user'
        USING ERRCODE = '42501';
    END IF;
    PERFORM set_config('flow.current_session_token', NEW.token, true);
    RETURN NEW;
  END IF;

  -- For app_role: require trusted, exact, unforgeable authentication flow ticket
  v_ticket_id := NULLIF(current_setting('flow.active_auth_ticket_id', true), '');
  IF v_ticket_id IS NULL THEN
    RAISE EXCEPTION 'Authentication issuance ticket required' USING ERRCODE = '42501';
  END IF;

  BEGIN
    SELECT * INTO v_ticket
    FROM flow.auth_issuance_tickets
    WHERE ticket_id = v_ticket_id::uuid
      AND user_id = NEW.user_id
      AND consumed_at IS NULL
      AND created_at > CURRENT_TIMESTAMP - INTERVAL '30 seconds'
    FOR UPDATE;
  EXCEPTION WHEN invalid_text_representation THEN
    RAISE EXCEPTION 'Authentication issuance ticket invalid, expired, or user mismatch'
      USING ERRCODE = '42501';
  END;

  IF NOT FOUND OR v_ticket.ticket_id IS NULL THEN
    RAISE EXCEPTION 'Authentication issuance ticket invalid, expired, or user mismatch'
      USING ERRCODE = '42501';
  END IF;

  -- Consume ticket immediately
  UPDATE flow.auth_issuance_tickets
  SET consumed_at = CURRENT_TIMESTAMP
  WHERE ticket_id = v_ticket.ticket_id;

  -- Clear the active ticket context so it cannot be reused
  PERFORM set_config('flow.active_auth_ticket_id', '', true);

  -- Establish active session token context ONLY for this authorized issuance so RETURNING * succeeds
  PERFORM set_config('flow.current_session_token', NEW.token, true);

  RETURN NEW;
END;
$$;

-- ============================================================================
-- Section 4: Public Revocations & Least-Privilege Grants
-- ============================================================================

-- Explicitly revoke ALL from PUBLIC on all SECURITY DEFINER functions
REVOKE ALL ON FUNCTION flow.acquire_portfolio_refresh_lease(uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION flow.release_portfolio_refresh_lease(uuid, bigint, uuid, boolean) FROM PUBLIC;
REVOKE ALL ON FUNCTION flow.issue_email_auth_ticket(text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION flow.issue_google_auth_ticket(text, text, bigint) FROM PUBLIC;
REVOKE ALL ON FUNCTION flow.can_access_account(uuid) FROM PUBLIC;

DO $$
DECLARE
  db_name text := current_database();
  app_role text := db_name || '_app';
  worker_role text := db_name || '_worker';
  operator_role text := db_name || '_operator';
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = app_role) THEN
    -- Revoke direct release from app_role (worker role only)
    EXECUTE format('REVOKE ALL ON FUNCTION flow.release_portfolio_refresh_lease(uuid, bigint, uuid, boolean) FROM %I', app_role);
    -- Revoke ticket issuance from app_role
    EXECUTE format('REVOKE ALL ON FUNCTION flow.issue_email_auth_ticket(text, text) FROM %I', app_role);
    EXECUTE format('REVOKE ALL ON FUNCTION flow.issue_google_auth_ticket(text, text, bigint) FROM %I', app_role);
    -- Revoke lease secrets table from app_role
    EXECUTE format('REVOKE ALL ON flow.portfolio_refresh_lease_secrets FROM %I', app_role);

    -- Grant safe functions to app_role
    EXECUTE format('GRANT EXECUTE ON FUNCTION flow.acquire_portfolio_refresh_lease(uuid, text) TO %I', app_role);
    EXECUTE format('GRANT EXECUTE ON FUNCTION flow.can_access_account(uuid) TO %I', app_role);
  END IF;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = worker_role) THEN
    EXECUTE format('GRANT ALL ON flow.portfolio_refresh_lease_secrets TO %I', worker_role);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON flow.auth_issuance_tickets TO %I', worker_role);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON flow.auth_intents TO %I', worker_role);
    EXECUTE format('GRANT EXECUTE ON FUNCTION flow.acquire_portfolio_refresh_lease(uuid, text) TO %I', worker_role);
    EXECUTE format('GRANT EXECUTE ON FUNCTION flow.release_portfolio_refresh_lease(uuid, bigint, uuid, boolean) TO %I', worker_role);
    EXECUTE format('GRANT EXECUTE ON FUNCTION flow.issue_email_auth_ticket(text, text) TO %I', worker_role);
    EXECUTE format('GRANT EXECUTE ON FUNCTION flow.issue_google_auth_ticket(text, text, bigint) TO %I', worker_role);
    EXECUTE format('GRANT EXECUTE ON FUNCTION flow.can_access_account(uuid) TO %I', worker_role);
  END IF;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = operator_role) THEN
    EXECUTE format('REVOKE ALL ON flow.portfolio_refresh_lease_secrets FROM %I', operator_role);
    EXECUTE format('REVOKE ALL ON FUNCTION flow.release_portfolio_refresh_lease(uuid, bigint, uuid, boolean) FROM %I', operator_role);
    EXECUTE format('REVOKE ALL ON FUNCTION flow.acquire_portfolio_refresh_lease(uuid, text) FROM %I', operator_role);
    EXECUTE format('REVOKE ALL ON FUNCTION flow.issue_email_auth_ticket(text, text) FROM %I', operator_role);
    EXECUTE format('REVOKE ALL ON FUNCTION flow.issue_google_auth_ticket(text, text, bigint) FROM %I', operator_role);
    EXECUTE format('GRANT EXECUTE ON FUNCTION flow.can_access_account(uuid) TO %I', operator_role);
  END IF;
END;
$$;

COMMIT;


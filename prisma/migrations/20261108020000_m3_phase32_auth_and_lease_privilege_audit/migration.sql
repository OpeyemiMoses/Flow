BEGIN;

-- ============================================================================
-- Section 1: Tenant Account Access Helper Function
-- ============================================================================

CREATE OR REPLACE FUNCTION flow.can_access_account(p_account_id uuid)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = flow, pg_temp
AS $$
DECLARE
  v_user text := SESSION_USER;
  v_auth_user_id text;
BEGIN
  IF v_user LIKE '%_migrator' OR v_user LIKE '%_worker' OR v_user LIKE '%_operator' THEN
    RETURN true;
  END IF;

  v_auth_user_id := flow.current_session_auth_user_id();
  IF v_auth_user_id IS NULL THEN
    RETURN false;
  END IF;

  RETURN EXISTS (
    SELECT 1
    FROM flow.users u
    JOIN flow.accounts a ON a.id = p_account_id
    LEFT JOIN flow.account_memberships m
      ON m.account_id = a.id
      AND m.status = 'ACTIVE'::flow.member_status
      AND m.user_id = u.id
    WHERE u.auth_user_id = v_auth_user_id
      AND u.active = true
      AND (
        (a.kind = 'PERSONAL' AND a.personal_owner_id = u.id)
        OR (a.kind = 'BUSINESS' AND m.id IS NOT NULL)
      )
  );
END;
$$;

-- ============================================================================
-- Section 2: Portfolio Refresh Leases Row-Level Security & Guarded Functions
-- ============================================================================

ALTER TABLE flow.portfolio_refresh_leases ENABLE ROW LEVEL SECURITY;
ALTER TABLE flow.portfolio_refresh_leases NO FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS portfolio_refresh_leases_app_select ON flow.portfolio_refresh_leases;

CREATE POLICY portfolio_refresh_leases_app_select ON flow.portfolio_refresh_leases
FOR SELECT TO PUBLIC
USING (
  flow.can_access_account(account_id)
);

DROP POLICY IF EXISTS portfolio_refresh_leases_worker_policy ON flow.portfolio_refresh_leases;

CREATE POLICY portfolio_refresh_leases_worker_policy ON flow.portfolio_refresh_leases
FOR ALL TO PUBLIC
USING (
  CURRENT_USER LIKE '%_migrator'
  OR SESSION_USER LIKE '%_migrator'
  OR CURRENT_USER LIKE '%_worker'
  OR SESSION_USER LIKE '%_worker'
  OR CURRENT_USER LIKE '%_operator'
  OR SESSION_USER LIKE '%_operator'
)
WITH CHECK (
  CURRENT_USER LIKE '%_migrator'
  OR SESSION_USER LIKE '%_migrator'
  OR CURRENT_USER LIKE '%_worker'
  OR SESSION_USER LIKE '%_worker'
  OR CURRENT_USER LIKE '%_operator'
  OR SESSION_USER LIKE '%_operator'
);

CREATE OR REPLACE FUNCTION flow.acquire_portfolio_refresh_lease(
  p_account_id uuid,
  p_lease_holder text,
  p_cooldown_seconds integer DEFAULT 15,
  p_lease_duration_seconds integer DEFAULT 10
)
RETURNS TABLE (
  acquired boolean,
  reason text,
  fencing_token bigint,
  remaining_seconds integer
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = flow, pg_temp
AS $$
DECLARE
  v_current record;
  v_acquired record;
  v_elapsed_seconds integer;
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
    IF v_elapsed_seconds < p_cooldown_seconds THEN
      RETURN QUERY SELECT
        false,
        'COOLDOWN'::text,
        v_current.fencing_token,
        GREATEST(1, p_cooldown_seconds - v_elapsed_seconds);
      RETURN;
    END IF;
  END IF;

  -- 3. Atomic lease acquisition with fencing token increment
  INSERT INTO flow.portfolio_refresh_leases (
    account_id, last_refreshed_at, lease_expires_at, lease_holder, fencing_token, updated_at
  ) VALUES (
    p_account_id,
    NULL,
    CURRENT_TIMESTAMP + (p_lease_duration_seconds || ' seconds')::interval,
    p_lease_holder,
    1,
    CURRENT_TIMESTAMP
  )
  ON CONFLICT (account_id) DO UPDATE
  SET lease_expires_at = CURRENT_TIMESTAMP + (p_lease_duration_seconds || ' seconds')::interval,
      lease_holder = EXCLUDED.lease_holder,
      fencing_token = flow.portfolio_refresh_leases.fencing_token + 1,
      updated_at = CURRENT_TIMESTAMP
  WHERE (flow.portfolio_refresh_leases.last_refreshed_at IS NULL
         OR flow.portfolio_refresh_leases.last_refreshed_at <= CURRENT_TIMESTAMP - (p_cooldown_seconds || ' seconds')::interval)
    AND (flow.portfolio_refresh_leases.lease_expires_at IS NULL
         OR flow.portfolio_refresh_leases.lease_expires_at <= CURRENT_TIMESTAMP)
  RETURNING flow.portfolio_refresh_leases.fencing_token INTO v_acquired;

  IF FOUND THEN
    RETURN QUERY SELECT true, 'ACQUIRED'::text, v_acquired.fencing_token, 0;
    RETURN;
  END IF;

  -- 4. In-flight lease held by another worker
  RETURN QUERY SELECT false, 'IN_FLIGHT'::text, COALESCE(v_current.fencing_token, 0::bigint), 0;
END;
$$;

CREATE OR REPLACE FUNCTION flow.release_portfolio_refresh_lease(
  p_account_id uuid,
  p_fencing_token bigint,
  p_success boolean
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = flow, pg_temp
AS $$
DECLARE
  v_updated integer;
BEGIN
  -- 1. Tenant boundary enforcement: Caller must be authorized for this account
  IF NOT flow.can_access_account(p_account_id) THEN
    RAISE EXCEPTION 'Account access unauthorized' USING ERRCODE = '42501';
  END IF;

  -- 2. Release with CAS check on fencing_token
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
  RETURN v_updated > 0;
END;
$$;

-- ============================================================================
-- Section 3: Hardened Auth Ticket Issuance Functions (Worker Role Only)
-- ============================================================================

-- Drop redundant foreign key on ephemeral tickets that causes KEY SHARE / UPDATE deadlocks
ALTER TABLE flow.auth_issuance_tickets
  DROP CONSTRAINT IF EXISTS auth_issuance_tickets_user_id_fkey;

CREATE OR REPLACE FUNCTION flow.issue_email_auth_ticket(
  p_slot text,
  p_nonce_digest text
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = flow, pg_temp
AS $$
DECLARE
  v_intent record;
  v_user record;
  v_ticket_id uuid;
  v_client_user text := SESSION_USER;
BEGIN
  -- Security Audit Gate: Enforce that only worker_role or migrator_role can execute this function
  IF NOT (v_client_user LIKE '%_worker' OR v_client_user LIKE '%_migrator') THEN
    RAISE EXCEPTION 'Ticket issuance unauthorized for client role: %', v_client_user
      USING ERRCODE = '42501';
  END IF;

  -- 1. Find and lock active intent in UTC
  SELECT * INTO v_intent
  FROM flow.auth_intents
  WHERE slot = p_slot
    AND digest = p_nonce_digest
    AND expires_at > (CURRENT_TIMESTAMP AT TIME ZONE 'UTC')
    AND purpose IN ('sign-in-email', 'recover-email')
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Authentication intent invalid, expired, or non-matching' USING ERRCODE = '42501';
  END IF;

  -- 2. Validate registered user matching intent email
  SELECT * INTO v_user
  FROM flow.auth_users
  WHERE email = v_intent.email;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Target user not found for authentication intent' USING ERRCODE = '42501';
  END IF;

  IF v_user.mailbox_paused THEN
    RAISE EXCEPTION 'User mailbox paused' USING ERRCODE = '42501';
  END IF;

  -- 3. Atomically consume the intent so it cannot be replayed
  DELETE FROM flow.auth_intents WHERE slot = p_slot;

  -- 4. Clean up old tickets
  DELETE FROM flow.auth_issuance_tickets WHERE created_at < CURRENT_TIMESTAMP - INTERVAL '5 minutes';

  -- 5. Issue one-time ticket
  v_ticket_id := gen_random_uuid();
  INSERT INTO flow.auth_issuance_tickets (ticket_id, user_id, flow_type, intent_slot, created_at)
  VALUES (v_ticket_id, v_user.id, 'email-otp', p_slot, CURRENT_TIMESTAMP);

  RETURN v_ticket_id;
END;
$$;

CREATE OR REPLACE FUNCTION flow.trg_auth_sessions_validate_insert()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
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

  -- For app_role: require trusted authentication flow ticket
  v_ticket_id := NULLIF(current_setting('flow.active_auth_ticket_id', true), '');
  IF v_ticket_id IS NOT NULL THEN
    SELECT * INTO v_ticket
    FROM flow.auth_issuance_tickets
    WHERE ticket_id = v_ticket_id::uuid
      AND user_id = NEW.user_id
      AND consumed_at IS NULL
      AND created_at > CURRENT_TIMESTAMP - INTERVAL '30 seconds'
    FOR UPDATE;
  ELSE
    SELECT * INTO v_ticket
    FROM flow.auth_issuance_tickets
    WHERE user_id = NEW.user_id
      AND consumed_at IS NULL
      AND created_at > CURRENT_TIMESTAMP - INTERVAL '30 seconds'
    ORDER BY created_at DESC
    LIMIT 1
    FOR UPDATE;
  END IF;

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

CREATE OR REPLACE FUNCTION flow.issue_google_auth_ticket(
  p_subject text,
  p_user_id text,
  p_start_order bigint
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = flow, pg_temp
AS $$
DECLARE
  v_binding record;
  v_ticket_id uuid;
  v_client_user text := SESSION_USER;
BEGIN
  -- Security Audit Gate: Enforce that only worker_role or migrator_role can execute this function
  IF NOT (v_client_user LIKE '%_worker' OR v_client_user LIKE '%_migrator') THEN
    RAISE EXCEPTION 'Ticket issuance unauthorized for client role: %', v_client_user
      USING ERRCODE = '42501';
  END IF;

  -- 1. Validate subject binding
  SELECT * INTO v_binding
  FROM flow.google_subject_bindings
  WHERE subject = p_subject AND user_id = p_user_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Google subject binding not found for user' USING ERRCODE = '42501';
  END IF;

  -- 2. Clean up old tickets
  DELETE FROM flow.auth_issuance_tickets WHERE created_at < CURRENT_TIMESTAMP - INTERVAL '5 minutes';

  -- 4. Issue one-time ticket
  v_ticket_id := gen_random_uuid();
  INSERT INTO flow.auth_issuance_tickets (ticket_id, user_id, flow_type, created_at)
  VALUES (v_ticket_id, p_user_id, 'google-oauth', CURRENT_TIMESTAMP);

  RETURN v_ticket_id;
END;
$$;

-- ============================================================================
-- Section 4: Role-Based Least-Privilege Grants
-- ============================================================================

DO $$
DECLARE
  db_name text := current_database();
  app_role text := db_name || '_app';
  worker_role text := db_name || '_worker';
  operator_role text := db_name || '_operator';
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = app_role) THEN
    -- Portfolio refresh leases: REVOKE direct modification from app_role
    EXECUTE format('REVOKE INSERT, UPDATE, DELETE ON flow.portfolio_refresh_leases FROM %I', app_role);
    EXECUTE format('GRANT SELECT ON flow.portfolio_refresh_leases TO %I', app_role);

    -- Grant guarded functions to app_role
    EXECUTE format('GRANT EXECUTE ON FUNCTION flow.acquire_portfolio_refresh_lease(uuid, text, integer, integer) TO %I', app_role);
    EXECUTE format('GRANT EXECUTE ON FUNCTION flow.release_portfolio_refresh_lease(uuid, bigint, boolean) TO %I', app_role);
    EXECUTE format('GRANT EXECUTE ON FUNCTION flow.can_access_account(uuid) TO %I', app_role);

    -- Auth ticket issuance: REVOKE EXECUTE from app_role (worker role only)
    EXECUTE format('REVOKE ALL ON FUNCTION flow.issue_email_auth_ticket(text, text) FROM %I', app_role);
    EXECUTE format('REVOKE ALL ON FUNCTION flow.issue_google_auth_ticket(text, text, bigint) FROM %I', app_role);
  END IF;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = worker_role) THEN
    -- Worker role manages leases and executes auth ticket issuance
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON flow.portfolio_refresh_leases TO %I', worker_role);
    EXECUTE format('GRANT EXECUTE ON FUNCTION flow.acquire_portfolio_refresh_lease(uuid, text, integer, integer) TO %I', worker_role);
    EXECUTE format('GRANT EXECUTE ON FUNCTION flow.release_portfolio_refresh_lease(uuid, bigint, boolean) TO %I', worker_role);
    EXECUTE format('GRANT EXECUTE ON FUNCTION flow.can_access_account(uuid) TO %I', worker_role);

    EXECUTE format('GRANT EXECUTE ON FUNCTION flow.issue_email_auth_ticket(text, text) TO %I', worker_role);
    EXECUTE format('GRANT EXECUTE ON FUNCTION flow.issue_google_auth_ticket(text, text, bigint) TO %I', worker_role);
  END IF;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = operator_role) THEN
    EXECUTE format('GRANT SELECT ON flow.portfolio_refresh_leases TO %I', operator_role);
    EXECUTE format('REVOKE ALL ON FUNCTION flow.issue_email_auth_ticket(text, text) FROM %I', operator_role);
    EXECUTE format('REVOKE ALL ON FUNCTION flow.issue_google_auth_ticket(text, text, bigint) FROM %I', operator_role);
  END IF;
END;
$$;

COMMIT;


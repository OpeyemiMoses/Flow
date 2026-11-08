BEGIN;

-- FLOW Milestone 3 Phase 3.1: Authentication Boundary Hardening and Durable Refresh Controls
-- 1. Eliminate current_query() regex inspection and permissive session mutation policies on flow.auth_sessions
-- 2. Restrict session creation to verified authentication flow execution via single-use tickets
-- 3. Prevent session tampering (user_id/token mutation) via triggers and strict RLS
-- 4. Establish durable portfolio refresh leases for distributed rate limiting and RPC fan-out prevention

-- ============================================================================
-- Section 1: Durable Portfolio Refresh Leases
-- ============================================================================

CREATE TABLE IF NOT EXISTS flow.portfolio_refresh_leases (
  account_id uuid PRIMARY KEY REFERENCES flow.accounts(id) ON DELETE CASCADE,
  last_refreshed_at timestamp with time zone,
  lease_expires_at timestamp with time zone,
  lease_holder text,
  fencing_token bigint NOT NULL DEFAULT 0,
  created_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- ============================================================================
-- Section 2: Authentication Issuance Tickets (Ephemeral, Single-Use Gate)
-- ============================================================================

CREATE TABLE IF NOT EXISTS flow.auth_issuance_tickets (
  ticket_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id text NOT NULL REFERENCES flow.auth_users(id) ON DELETE CASCADE,
  flow_type text NOT NULL CHECK (flow_type IN ('email-otp', 'google-oauth')),
  intent_slot text,
  created_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  consumed_at timestamp with time zone
);

CREATE INDEX IF NOT EXISTS idx_auth_issuance_tickets_lookup
ON flow.auth_issuance_tickets (ticket_id, user_id)
WHERE consumed_at IS NULL;

-- ============================================================================
-- Section 3: Privileged Ticket Issuance Functions (SECURITY DEFINER)
-- ============================================================================

-- Function 3.1: Issue ticket for verified Email OTP sign-in / recovery
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
BEGIN
  -- 1. Find and lock active intent
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

-- Function 3.2: Issue ticket for verified Google OAuth sign-in / linking
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
BEGIN
  -- 1. Validate subject binding
  SELECT * INTO v_binding
  FROM flow.google_subject_bindings
  WHERE subject = p_subject AND user_id = p_user_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Google subject binding not found for user' USING ERRCODE = '42501';
  END IF;

  -- 2. Validate auth identity exists for google provider
  IF NOT EXISTS (
    SELECT 1 FROM flow.auth_identities
    WHERE provider_id = 'google'
      AND provider_subject = p_subject
      AND user_id = p_user_id
  ) THEN
    RAISE EXCEPTION 'Google auth identity not found for user' USING ERRCODE = '42501';
  END IF;

  -- 3. Clean up old tickets
  DELETE FROM flow.auth_issuance_tickets WHERE created_at < CURRENT_TIMESTAMP - INTERVAL '5 minutes';

  -- 4. Issue one-time ticket
  v_ticket_id := gen_random_uuid();
  INSERT INTO flow.auth_issuance_tickets (ticket_id, user_id, flow_type, created_at)
  VALUES (v_ticket_id, p_user_id, 'google-oauth', CURRENT_TIMESTAMP);

  RETURN v_ticket_id;
END;
$$;

-- ============================================================================
-- Section 4: Triggers on flow.auth_sessions (Strict Insert & Anti-Tampering)
-- ============================================================================

-- Drop Phase 3 triggers and functions that blindly set context or used current_query()
DROP TRIGGER IF EXISTS trg_auth_sessions_before_insert ON flow.auth_sessions;
DROP TRIGGER IF EXISTS trg_auth_sessions_before_update ON flow.auth_sessions;
DROP FUNCTION IF EXISTS flow.trg_auth_sessions_set_context();
DROP FUNCTION IF EXISTS flow.auth_sessions_can_select(text, text) CASCADE;

-- Trigger 4.1: Validate that INSERT has an active, unconsumed issuance ticket
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
  IF v_ticket_id IS NULL THEN
    RAISE EXCEPTION 'Direct session insertion unauthorized: trusted authentication flow execution required'
      USING ERRCODE = '42501';
  END IF;

  -- Look up and lock the ticket
  SELECT * INTO v_ticket
  FROM flow.auth_issuance_tickets
  WHERE ticket_id = v_ticket_id::uuid
    AND user_id = NEW.user_id
    AND consumed_at IS NULL
    AND created_at > CURRENT_TIMESTAMP - INTERVAL '30 seconds'
  FOR UPDATE;

  IF NOT FOUND THEN
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

CREATE TRIGGER trg_auth_sessions_before_insert
BEFORE INSERT ON flow.auth_sessions
FOR EACH ROW
EXECUTE FUNCTION flow.trg_auth_sessions_validate_insert();

-- Trigger 4.2: Prevent tampering with immutable session fields on UPDATE
CREATE OR REPLACE FUNCTION flow.trg_auth_sessions_prevent_tampering()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.user_id <> OLD.user_id THEN
    RAISE EXCEPTION 'Cannot modify session user_id' USING ERRCODE = '42501';
  END IF;
  IF NEW.token <> OLD.token THEN
    RAISE EXCEPTION 'Cannot modify session token' USING ERRCODE = '42501';
  END IF;
  IF NEW.id <> OLD.id THEN
    RAISE EXCEPTION 'Cannot modify session id' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_auth_sessions_before_update
BEFORE UPDATE ON flow.auth_sessions
FOR EACH ROW
EXECUTE FUNCTION flow.trg_auth_sessions_prevent_tampering();

-- ============================================================================
-- Section 5: Row-Level Security Policies on flow.auth_sessions
-- ============================================================================

DO $$
DECLARE
  db_name text := current_database();
  app_role text := db_name || '_app';
  worker_role text := db_name || '_worker';
  operator_role text := db_name || '_operator';
  migrator_role text := db_name || '_migrator';
BEGIN
  -- Drop existing app policies
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = app_role) THEN
    EXECUTE 'DROP POLICY IF EXISTS auth_sessions_app_select ON flow.auth_sessions';
    EXECUTE 'DROP POLICY IF EXISTS auth_sessions_app_insert ON flow.auth_sessions';
    EXECUTE 'DROP POLICY IF EXISTS auth_sessions_app_update ON flow.auth_sessions';
    EXECUTE 'DROP POLICY IF EXISTS auth_sessions_app_delete ON flow.auth_sessions';

    -- SELECT: Gated strictly to matching active session token OR matching authenticated user's active sessions.
    -- Unconstrained bulk queries return 0 rows.
    EXECUTE format(
      $policy$
      CREATE POLICY auth_sessions_app_select ON flow.auth_sessions
      FOR SELECT TO %I
      USING (
        token = NULLIF(current_setting('flow.current_session_token', true), '')
        OR (
          user_id = flow.current_session_auth_user_id()
          AND expires_at > CURRENT_TIMESTAMP
        )
      )
      $policy$,
      app_role
    );

    -- INSERT: Allowed with non-null checks, strictly enforced and consumed by trg_auth_sessions_before_insert
    EXECUTE format(
      $policy$
      CREATE POLICY auth_sessions_app_insert ON flow.auth_sessions
      FOR INSERT TO %I
      WITH CHECK (user_id IS NOT NULL AND token IS NOT NULL)
      $policy$,
      app_role
    );

    -- UPDATE: Strictly own active session, prevents session extension of expired sessions or other users
    EXECUTE format(
      $policy$
      CREATE POLICY auth_sessions_app_update ON flow.auth_sessions
      FOR UPDATE TO %I
      USING (
        token = NULLIF(current_setting('flow.current_session_token', true), '')
        AND expires_at > CURRENT_TIMESTAMP
      )
      WITH CHECK (
        token = NULLIF(current_setting('flow.current_session_token', true), '')
      )
      $policy$,
      app_role
    );

    -- DELETE: Strictly own sessions (matching active token or authenticated user id for dashboard revocation)
    EXECUTE format(
      $policy$
      CREATE POLICY auth_sessions_app_delete ON flow.auth_sessions
      FOR DELETE TO %I
      USING (
        token = NULLIF(current_setting('flow.current_session_token', true), '')
        OR user_id = flow.current_session_auth_user_id()
      )
      $policy$,
      app_role
    );
  END IF;

  -- Configure privileges on new tables and functions
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = app_role) THEN
    -- Portfolio refresh leases: app can read and write leases
    EXECUTE format('GRANT SELECT, INSERT, UPDATE ON flow.portfolio_refresh_leases TO %I', app_role);

    -- Auth issuance tickets: NO DIRECT ACCESS TO APP ROLE
    EXECUTE format('REVOKE ALL ON flow.auth_issuance_tickets FROM %I', app_role);

    -- Function execute grants
    EXECUTE format('GRANT EXECUTE ON FUNCTION flow.issue_email_auth_ticket(text, text) TO %I', app_role);
    EXECUTE format('GRANT EXECUTE ON FUNCTION flow.issue_google_auth_ticket(text, text, bigint) TO %I', app_role);
    EXECUTE format('GRANT EXECUTE ON FUNCTION flow.current_session_auth_user_id() TO %I', app_role);
  END IF;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = worker_role) THEN
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON flow.portfolio_refresh_leases TO %I', worker_role);
    EXECUTE format('REVOKE ALL ON flow.auth_issuance_tickets FROM %I', worker_role);
  END IF;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = operator_role) THEN
    EXECUTE format('GRANT SELECT ON flow.portfolio_refresh_leases TO %I', operator_role);
    EXECUTE format('REVOKE ALL ON flow.auth_issuance_tickets FROM %I', operator_role);
  END IF;
END;
$$;

COMMIT;

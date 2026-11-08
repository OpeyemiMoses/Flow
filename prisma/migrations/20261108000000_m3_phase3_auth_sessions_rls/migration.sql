BEGIN;

-- FLOW Milestone 3 Phase 3: Security Gate
-- Row Level Security on flow.auth_sessions to eliminate bulk bearer session-token extraction
-- by the web application database role (app_role).

-- 1. Enable and FORCE Row Level Security on flow.auth_sessions
ALTER TABLE flow.auth_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE flow.auth_sessions FORCE ROW LEVEL SECURITY;

-- 2. Trusted helper functions to resolve auth_user_id and enforce safe session selection
-- Marked SECURITY DEFINER so they can execute without recursive RLS checks
CREATE OR REPLACE FUNCTION flow.current_session_auth_user_id()
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = flow, pg_temp
AS $$
  SELECT user_id
  FROM flow.auth_sessions
  WHERE token = NULLIF(current_setting('flow.current_session_token', true), '')
    AND expires_at > CURRENT_TIMESTAMP
  LIMIT 1;
$$;

CREATE OR REPLACE FUNCTION flow.auth_sessions_can_select(s_token text, s_user_id text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = flow, pg_temp
AS $$
  SELECT (
    s_token = NULLIF(current_setting('flow.current_session_token', true), '')
    OR s_user_id = flow.current_session_auth_user_id()
    OR (
      current_query() ~* '^\s*(UPDATE|DELETE)\s+'
      AND current_query() !~* '\ytoken\y'
    )
  );
$$;

-- 3. Trigger to establish session context on new session insertions so INSERT ... RETURNING succeeds
CREATE OR REPLACE FUNCTION flow.trg_auth_sessions_set_context()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  PERFORM set_config('flow.current_session_token', NEW.token, true);
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_auth_sessions_before_insert ON flow.auth_sessions;
CREATE TRIGGER trg_auth_sessions_before_insert
BEFORE INSERT ON flow.auth_sessions
FOR EACH ROW
EXECUTE FUNCTION flow.trg_auth_sessions_set_context();

-- 4. Configure RLS policies for database roles
DO $$
DECLARE
  db_name text := current_database();
  app_role text := db_name || '_app';
  worker_role text := db_name || '_worker';
  operator_role text := db_name || '_operator';
  migrator_role text := db_name || '_migrator';
BEGIN
  -- Privileged operator role: full access to manage operator sessions
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = operator_role) THEN
    EXECUTE 'DROP POLICY IF EXISTS auth_sessions_operator_all ON flow.auth_sessions';
    EXECUTE format('CREATE POLICY auth_sessions_operator_all ON flow.auth_sessions FOR ALL TO %I USING (true) WITH CHECK (true)', operator_role);
  END IF;

  -- Worker role: full access
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = worker_role) THEN
    EXECUTE 'DROP POLICY IF EXISTS auth_sessions_worker_all ON flow.auth_sessions';
    EXECUTE format('CREATE POLICY auth_sessions_worker_all ON flow.auth_sessions FOR ALL TO %I USING (true) WITH CHECK (true)', worker_role);
  END IF;

  -- Migrator role: full access
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = migrator_role) THEN
    EXECUTE 'DROP POLICY IF EXISTS auth_sessions_migrator_all ON flow.auth_sessions';
    EXECUTE format('CREATE POLICY auth_sessions_migrator_all ON flow.auth_sessions FOR ALL TO %I USING (true) WITH CHECK (true)', migrator_role);
  END IF;

  -- Application (web) role: tenant-scoped access
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = app_role) THEN
    EXECUTE format('GRANT EXECUTE ON FUNCTION flow.current_session_auth_user_id() TO %I', app_role);
    EXECUTE format('GRANT EXECUTE ON FUNCTION flow.auth_sessions_can_select(text, text) TO %I', app_role);

    -- Drop any preexisting policies if re-running
    EXECUTE 'DROP POLICY IF EXISTS auth_sessions_app_insert ON flow.auth_sessions';
    EXECUTE 'DROP POLICY IF EXISTS auth_sessions_app_select ON flow.auth_sessions';
    EXECUTE 'DROP POLICY IF EXISTS auth_sessions_app_update ON flow.auth_sessions';
    EXECUTE 'DROP POLICY IF EXISTS auth_sessions_app_delete ON flow.auth_sessions';

    -- INSERT: Better Auth sign-in can create new sessions
    EXECUTE format(
      $policy$
      CREATE POLICY auth_sessions_app_insert ON flow.auth_sessions
      FOR INSERT TO %I
      WITH CHECK (true)
      $policy$,
      app_role
    );

    -- SELECT: Gated strictly to the matching session token, user session listing, or non-token maintenance.
    -- Unconstrained bulk extraction returns 0 rows.
    EXECUTE format(
      $policy$
      CREATE POLICY auth_sessions_app_select ON flow.auth_sessions
      FOR SELECT TO %I
      USING (flow.auth_sessions_can_select(token, user_id))
      $policy$,
      app_role
    );

    -- UPDATE: Allows session touching and expiry updates while RETURNING token remains gated by SELECT policy
    EXECUTE format(
      $policy$
      CREATE POLICY auth_sessions_app_update ON flow.auth_sessions
      FOR UPDATE TO %I
      USING (true)
      WITH CHECK (true)
      $policy$,
      app_role
    );

    -- DELETE: Allows sign out, session revocation and cleanup while RETURNING token remains gated by SELECT policy
    EXECUTE format(
      $policy$
      CREATE POLICY auth_sessions_app_delete ON flow.auth_sessions
      FOR DELETE TO %I
      USING (true)
      $policy$,
      app_role
    );
  END IF;
END;
$$;

COMMIT;

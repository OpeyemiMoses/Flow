BEGIN;

CREATE SCHEMA flow;
REVOKE ALL ON SCHEMA flow FROM PUBLIC;

DO $$
BEGIN
  EXECUTE format('GRANT USAGE ON SCHEMA flow TO %I', current_database() || '_app');
END;
$$;

COMMIT;

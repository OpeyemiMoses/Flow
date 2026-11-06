BEGIN;

-- One sequence orders OAuth starts and active bindings across all web processes.
CREATE SEQUENCE flow.google_oauth_order AS bigint CACHE 1;

-- Existing bindings precede every new intent. Older intents have no order.
ALTER TABLE flow.auth_identities ADD COLUMN google_binding_order bigint NOT NULL DEFAULT 0;
ALTER TABLE flow.auth_identities ALTER COLUMN google_binding_order SET DEFAULT nextval('flow.google_oauth_order'::regclass);
ALTER TABLE flow.auth_intents ADD COLUMN google_start_order bigint;

DO $$
BEGIN
  EXECUTE format('GRANT USAGE ON SEQUENCE flow.google_oauth_order TO %I', current_database() || '_app');
END;
$$;

COMMIT;

-- M5 Phase 1: Payment requests and public guest checkout schema
-- Establishes persistent payment requests, non-enumerable public identifier lookup,
-- row-level security isolation, and safe unauthenticated public inspection.

CREATE TYPE flow.payment_amount_mode AS ENUM ('FIXED', 'OPTIONAL');
CREATE TYPE flow.payment_request_status AS ENUM ('ACTIVE', 'DISABLED', 'EXPIRED', 'COMPLETED');

CREATE TABLE flow.payment_requests (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    account_id UUID NOT NULL REFERENCES flow.accounts(id) ON DELETE CASCADE,
    public_id VARCHAR(64) NOT NULL UNIQUE,
    title VARCHAR(120) NOT NULL,
    description TEXT,
    destination_network VARCHAR(64) NOT NULL,
    destination_asset_id VARCHAR(128) NOT NULL,
    destination_asset_symbol VARCHAR(32) NOT NULL,
    destination_decimals INTEGER NOT NULL CHECK (destination_decimals >= 0 AND destination_decimals <= 36),
    amount_mode flow.payment_amount_mode NOT NULL DEFAULT 'FIXED',
    requested_atomic_amount DECIMAL(78, 0),
    status flow.payment_request_status NOT NULL DEFAULT 'ACTIVE',
    expires_at TIMESTAMPTZ,
    payer_memo_required BOOLEAN NOT NULL DEFAULT false,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT payment_requests_public_id_format CHECK (public_id ~ '^pr_[a-zA-Z0-9_-]{16,64}$'),
    CONSTRAINT payment_requests_amount_check CHECK (
        (amount_mode = 'FIXED' AND requested_atomic_amount IS NOT NULL AND requested_atomic_amount > 0)
        OR
        (amount_mode = 'OPTIONAL' AND requested_atomic_amount IS NULL)
    )
);

CREATE INDEX idx_payment_requests_account_status ON flow.payment_requests(account_id, status);
CREATE INDEX idx_payment_requests_public_id ON flow.payment_requests(public_id);

CREATE OR REPLACE FUNCTION flow.enforce_payment_request_consistency()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF length(trim(NEW.destination_asset_id)) = 0 THEN
        RAISE EXCEPTION 'Destination asset ID cannot be empty' USING ERRCODE = 'check_violation';
    END IF;

    IF length(trim(NEW.destination_network)) = 0 THEN
        RAISE EXCEPTION 'Destination network cannot be empty' USING ERRCODE = 'check_violation';
    END IF;

    IF length(trim(NEW.title)) = 0 THEN
        RAISE EXCEPTION 'Title cannot be empty' USING ERRCODE = 'check_violation';
    END IF;

    IF TG_OP = 'INSERT' AND NEW.expires_at IS NOT NULL AND NEW.expires_at <= CURRENT_TIMESTAMP THEN
        RAISE EXCEPTION 'Expiry cannot be in the past' USING ERRCODE = 'check_violation';
    END IF;

    NEW.updated_at := CURRENT_TIMESTAMP;
    RETURN NEW;
END;
$$;

CREATE TRIGGER trg_payment_requests_consistency
    BEFORE INSERT OR UPDATE ON flow.payment_requests
    FOR EACH ROW
    EXECUTE FUNCTION flow.enforce_payment_request_consistency();

ALTER TABLE flow.payment_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE flow.payment_requests FORCE ROW LEVEL SECURITY;

REVOKE ALL ON flow.payment_requests FROM PUBLIC;

CREATE POLICY payment_requests_owner_policy ON flow.payment_requests
FOR ALL TO CURRENT_USER
USING (true)
WITH CHECK (true);

DO $$
DECLARE
    db_name text := current_database();
    app_role text := db_name || '_app';
    worker_role text := db_name || '_worker';
    operator_role text := db_name || '_operator';
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = app_role) THEN
        EXECUTE format(
            $policy$
            CREATE POLICY payment_requests_tenant_policy ON flow.payment_requests
            FOR ALL TO %I
            USING (flow.can_access_account(account_id))
            WITH CHECK (flow.can_access_account(account_id))
            $policy$,
            app_role
        );
        EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON flow.payment_requests TO %I', app_role);
    END IF;

    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = worker_role) THEN
        EXECUTE format(
            'CREATE POLICY payment_requests_worker_policy ON flow.payment_requests FOR ALL TO %I USING (true) WITH CHECK (true)',
            worker_role
        );
        EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON flow.payment_requests TO %I', worker_role);
    END IF;

    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = operator_role) THEN
        EXECUTE format(
            'CREATE POLICY payment_requests_operator_policy ON flow.payment_requests FOR ALL TO %I USING (true) WITH CHECK (true)',
            operator_role
        );
        EXECUTE format('GRANT SELECT ON flow.payment_requests TO %I', operator_role);
    END IF;
END;
$$;

-- Safe public projection function for guest checkout lookup
CREATE OR REPLACE FUNCTION flow.get_public_payment_request(p_public_id text)
RETURNS TABLE (
    public_id VARCHAR(64),
    title VARCHAR(120),
    description TEXT,
    destination_network VARCHAR(64),
    destination_asset_id VARCHAR(128),
    destination_asset_symbol VARCHAR(32),
    destination_decimals INTEGER,
    amount_mode flow.payment_amount_mode,
    requested_atomic_amount DECIMAL(78, 0),
    status flow.payment_request_status,
    expires_at TIMESTAMPTZ,
    payer_memo_required BOOLEAN,
    recipient_name TEXT,
    recipient_kind flow.account_kind
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, flow
AS $$
BEGIN
    RETURN QUERY
    SELECT
        pr.public_id,
        pr.title,
        pr.description,
        pr.destination_network,
        pr.destination_asset_id,
        pr.destination_asset_symbol,
        pr.destination_decimals,
        pr.amount_mode,
        pr.requested_atomic_amount,
        CASE
            WHEN pr.status = 'ACTIVE' AND pr.expires_at IS NOT NULL AND pr.expires_at <= CURRENT_TIMESTAMP THEN 'EXPIRED'::flow.payment_request_status
            ELSE pr.status
        END AS status,
        pr.expires_at,
        pr.payer_memo_required,
        COALESCE(a.name, 'Flow Recipient')::TEXT AS recipient_name,
        a.kind AS recipient_kind
    FROM flow.payment_requests pr
    JOIN flow.accounts a ON a.id = pr.account_id
    WHERE pr.public_id = p_public_id;
END;
$$;

REVOKE EXECUTE ON FUNCTION flow.get_public_payment_request(text) FROM PUBLIC;

DO $$
DECLARE
    db_name text := current_database();
    app_role text := db_name || '_app';
    worker_role text := db_name || '_worker';
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = app_role) THEN
        EXECUTE format('GRANT EXECUTE ON FUNCTION flow.get_public_payment_request(text) TO %I', app_role);
    END IF;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = worker_role) THEN
        EXECUTE format('GRANT EXECUTE ON FUNCTION flow.get_public_payment_request(text) TO %I', worker_role);
    END IF;
END;
$$;

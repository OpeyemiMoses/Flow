-- M5 Phase 2: Payment attempts and indicative quote discovery schema
-- Establishes persistent payment attempts, route status verification,
-- row-level security isolation, and safe unauthenticated public quote recording.

CREATE TABLE flow.payment_attempts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    payment_request_id UUID NOT NULL REFERENCES flow.payment_requests(id) ON DELETE CASCADE,
    attempt_public_id VARCHAR(64) NOT NULL UNIQUE,
    payer_mode VARCHAR(32) NOT NULL CHECK (payer_mode IN ('WALLET', 'EXCHANGE')),
    payer_refund_address VARCHAR(128),
    source_network VARCHAR(64) NOT NULL,
    source_asset_id VARCHAR(128) NOT NULL,
    source_asset_symbol VARCHAR(32) NOT NULL,
    source_decimals INTEGER NOT NULL CHECK (source_decimals >= 0 AND source_decimals <= 36),
    route_type VARCHAR(32) NOT NULL CHECK (route_type IN ('CROSS_CHAIN_1CLICK', 'DIRECT_TRANSFER')),
    route_status VARCHAR(32) NOT NULL,
    swap_type VARCHAR(32) NOT NULL DEFAULT 'EXACT_OUTPUT' CHECK (swap_type IN ('EXACT_OUTPUT', 'EXACT_INPUT')),
    quoted_source_atomic_amount DECIMAL(78, 0),
    quoted_destination_atomic_amount DECIMAL(78, 0),
    estimated_duration_seconds INTEGER,
    provider_fees JSONB NOT NULL DEFAULT '{}'::jsonb,
    provider_correlation_id VARCHAR(128),
    provider_signature TEXT,
    quote_expires_at TIMESTAMPTZ,
    status VARCHAR(32) NOT NULL DEFAULT 'INDICATIVE_QUOTE',
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT payment_attempts_public_id_format CHECK (attempt_public_id ~ '^pa_[a-zA-Z0-9_-]{16,64}$')
);

CREATE INDEX idx_payment_attempts_request_created ON flow.payment_attempts(payment_request_id, created_at DESC);
CREATE INDEX idx_payment_attempts_public_id ON flow.payment_attempts(attempt_public_id);

ALTER TABLE flow.payment_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE flow.payment_attempts FORCE ROW LEVEL SECURITY;

REVOKE ALL ON flow.payment_attempts FROM PUBLIC;

CREATE POLICY payment_attempts_owner_policy ON flow.payment_attempts
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
            CREATE POLICY payment_attempts_tenant_policy ON flow.payment_attempts
            FOR SELECT TO %I
            USING (EXISTS (
                SELECT 1 FROM flow.payment_requests pr
                WHERE pr.id = payment_attempts.payment_request_id
                AND flow.can_access_account(pr.account_id)
            ))
            $policy$,
            app_role
        );
        EXECUTE format('GRANT SELECT ON flow.payment_attempts TO %I', app_role);
    END IF;

    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = worker_role) THEN
        EXECUTE format(
            'CREATE POLICY payment_attempts_worker_policy ON flow.payment_attempts FOR ALL TO %I USING (true) WITH CHECK (true)',
            worker_role
        );
        EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON flow.payment_attempts TO %I', worker_role);
    END IF;

    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = operator_role) THEN
        EXECUTE format(
            'CREATE POLICY payment_attempts_operator_policy ON flow.payment_attempts FOR ALL TO %I USING (true) WITH CHECK (true)',
            operator_role
        );
        EXECUTE format('GRANT SELECT ON flow.payment_attempts TO %I', operator_role);
    END IF;
END;
$$;

-- Security Definer function to safely record public payment attempts
CREATE OR REPLACE FUNCTION flow.record_public_payment_attempt(
    p_payment_request_public_id text,
    p_attempt_public_id text,
    p_payer_mode text,
    p_payer_refund_address text,
    p_source_network text,
    p_source_asset_id text,
    p_source_asset_symbol text,
    p_source_decimals integer,
    p_route_type text,
    p_route_status text,
    p_swap_type text,
    p_quoted_source_atomic decimal,
    p_quoted_destination_atomic decimal,
    p_estimated_duration_seconds integer,
    p_provider_fees jsonb,
    p_provider_correlation_id text,
    p_provider_signature text,
    p_quote_expires_at timestamptz
)
RETURNS TABLE (
    id UUID,
    attempt_public_id VARCHAR(64),
    route_status VARCHAR(32),
    status VARCHAR(32),
    created_at TIMESTAMPTZ
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, flow
AS $$
DECLARE
    v_request_id UUID;
    v_request_status flow.payment_request_status;
    v_expires_at TIMESTAMPTZ;
BEGIN
    SELECT pr.id, pr.status, pr.expires_at
    INTO v_request_id, v_request_status, v_expires_at
    FROM flow.payment_requests pr
    WHERE pr.public_id = p_payment_request_public_id;

    IF v_request_id IS NULL THEN
        RAISE EXCEPTION 'PAYMENT_REQUEST_NOT_FOUND' USING ERRCODE = 'data_exception';
    END IF;

    IF v_request_status <> 'ACTIVE' THEN
        RAISE EXCEPTION 'PAYMENT_REQUEST_INACTIVE' USING ERRCODE = 'data_exception';
    END IF;

    IF v_expires_at IS NOT NULL AND v_expires_at <= CURRENT_TIMESTAMP THEN
        RAISE EXCEPTION 'PAYMENT_REQUEST_EXPIRED' USING ERRCODE = 'data_exception';
    END IF;

    RETURN QUERY
    INSERT INTO flow.payment_attempts (
        payment_request_id,
        attempt_public_id,
        payer_mode,
        payer_refund_address,
        source_network,
        source_asset_id,
        source_asset_symbol,
        source_decimals,
        route_type,
        route_status,
        swap_type,
        quoted_source_atomic_amount,
        quoted_destination_atomic_amount,
        estimated_duration_seconds,
        provider_fees,
        provider_correlation_id,
        provider_signature,
        quote_expires_at,
        status
    ) VALUES (
        v_request_id,
        p_attempt_public_id,
        p_payer_mode,
        p_payer_refund_address,
        p_source_network,
        p_source_asset_id,
        p_source_asset_symbol,
        p_source_decimals,
        p_route_type,
        p_route_status,
        p_swap_type,
        p_quoted_source_atomic,
        p_quoted_destination_atomic,
        p_estimated_duration_seconds,
        COALESCE(p_provider_fees, '{}'::jsonb),
        p_provider_correlation_id,
        p_provider_signature,
        p_quote_expires_at,
        'INDICATIVE_QUOTE'
    )
    RETURNING
        payment_attempts.id,
        payment_attempts.attempt_public_id,
        payment_attempts.route_status,
        payment_attempts.status,
        payment_attempts.created_at;
END;
$$;

REVOKE EXECUTE ON FUNCTION flow.record_public_payment_attempt(
    text, text, text, text, text, text, text, integer, text, text, text, decimal, decimal, integer, jsonb, text, text, timestamptz
) FROM PUBLIC;

DO $$
DECLARE
    db_name text := current_database();
    app_role text := db_name || '_app';
    worker_role text := db_name || '_worker';
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = app_role) THEN
        EXECUTE format('GRANT EXECUTE ON FUNCTION flow.record_public_payment_attempt(text, text, text, text, text, text, text, integer, text, text, text, decimal, decimal, integer, jsonb, text, text, timestamptz) TO %I', app_role);
    END IF;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = worker_role) THEN
        EXECUTE format('GRANT EXECUTE ON FUNCTION flow.record_public_payment_attempt(text, text, text, text, text, text, text, integer, text, text, text, decimal, decimal, integer, jsonb, text, text, timestamptz) TO %I', worker_role);
    END IF;
END;
$$;


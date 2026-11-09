-- M5 Phase 3: Verified Quote Integrity and Payment-Attempt Readiness
-- Enforces strict verification tiers, lifecycle boundaries, exact decimal integrity,
-- and prevents unprivileged SQL callers from manufacturing provider-verified payment attempts.

-- 1. Migrate existing attempts to QUOTE_OBSERVED lifecycle status
UPDATE flow.payment_attempts
SET status = 'QUOTE_OBSERVED'
WHERE status = 'INDICATIVE_QUOTE';

-- 2. Add verification tier, settlement, and lifecycle tracking columns
ALTER TABLE flow.payment_attempts
    ADD COLUMN IF NOT EXISTS verification_tier VARCHAR(32) NOT NULL DEFAULT 'UNVERIFIED_OBSERVATION',
    ADD COLUMN IF NOT EXISTS is_provider_verified BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN IF NOT EXISTS settled_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- 3. Update status default
ALTER TABLE flow.payment_attempts
    ALTER COLUMN status SET DEFAULT 'QUOTE_OBSERVED';

-- 4. Enforce strict lifecycle and verification constraints
ALTER TABLE flow.payment_attempts
    ADD CONSTRAINT chk_payment_attempts_status CHECK (
        status IN ('QUOTE_OBSERVED', 'QUOTE_EXPIRED', 'QUOTE_CANCELLED', 'DEPOSIT_COMMITTED', 'SETTLING', 'SETTLED', 'FAILED')
    ),
    ADD CONSTRAINT chk_payment_attempts_tier CHECK (
        verification_tier IN ('UNVERIFIED_OBSERVATION', 'PROVIDER_VERIFIED')
    ),
    ADD CONSTRAINT chk_payment_attempts_verified_settlement CHECK (
        status NOT IN ('DEPOSIT_COMMITTED', 'SETTLING', 'SETTLED') OR (is_provider_verified = true AND verification_tier = 'PROVIDER_VERIFIED')
    );

-- 5. Guarantee at most one attempt per invoice can ever settle (idempotency guard)
CREATE UNIQUE INDEX IF NOT EXISTS uq_payment_request_settled_attempt
ON flow.payment_attempts (payment_request_id)
WHERE status IN ('SETTLING', 'SETTLED');

-- 6. Index for lifecycle queries
CREATE INDEX IF NOT EXISTS idx_payment_attempts_request_status
ON flow.payment_attempts (payment_request_id, status);

-- 7. Redefine flow.record_public_payment_attempt to enforce untrusted observation boundaries
DROP FUNCTION IF EXISTS flow.record_public_payment_attempt(
    text,text,text,text,text,text,text,integer,text,text,text,numeric,numeric,integer,jsonb,text,text,timestamp with time zone
);

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
    verification_tier VARCHAR(32),
    is_provider_verified BOOLEAN,
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
    -- Validate attempt identifier format strictly
    IF p_attempt_public_id !~ '^pa_[a-zA-Z0-9_-]{16,64}$' THEN
        RAISE EXCEPTION 'INVALID_ATTEMPT_PUBLIC_ID' USING ERRCODE = 'data_exception';
    END IF;

    -- Validate decimals range
    IF p_source_decimals < 0 OR p_source_decimals > 36 THEN
        RAISE EXCEPTION 'INVALID_SOURCE_DECIMALS' USING ERRCODE = 'data_exception';
    END IF;

    -- Validate atomic amounts non-negative
    IF p_quoted_source_atomic < 0 OR p_quoted_destination_atomic < 0 THEN
        RAISE EXCEPTION 'NEGATIVE_ATOMIC_AMOUNT' USING ERRCODE = 'data_exception';
    END IF;

    -- Validate route type
    IF p_route_type NOT IN ('CROSS_CHAIN_1CLICK', 'DIRECT_TRANSFER') THEN
        RAISE EXCEPTION 'INVALID_ROUTE_TYPE' USING ERRCODE = 'data_exception';
    END IF;

    -- Validate payer mode
    IF p_payer_mode NOT IN ('WALLET', 'EXCHANGE') THEN
        RAISE EXCEPTION 'INVALID_PAYER_MODE' USING ERRCODE = 'data_exception';
    END IF;

    -- Resolve payment request
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

    -- Public quotes are strictly recorded with UNVERIFIED_OBSERVATION tier and QUOTE_OBSERVED status.
    -- App-role callers cannot manufacture verified status or execution readiness.
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
        status,
        verification_tier,
        is_provider_verified
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
        'QUOTE_OBSERVED',
        'UNVERIFIED_OBSERVATION',
        false
    )
    RETURNING
        payment_attempts.id,
        payment_attempts.attempt_public_id,
        payment_attempts.route_status,
        payment_attempts.status,
        payment_attempts.verification_tier,
        payment_attempts.is_provider_verified,
        payment_attempts.created_at;
END;
$$;

-- 8. Privileged worker verification function (executable only by flow_worker)
CREATE OR REPLACE FUNCTION flow.worker_verify_payment_attempt(
    p_attempt_public_id text,
    p_expected_correlation_id text
)
RETURNS TABLE (
    id UUID,
    attempt_public_id VARCHAR(64),
    status VARCHAR(32),
    verification_tier VARCHAR(32),
    is_provider_verified BOOLEAN
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, flow
AS $$
BEGIN
    RETURN QUERY
    UPDATE flow.payment_attempts pa
    SET
        verification_tier = 'PROVIDER_VERIFIED',
        is_provider_verified = true,
        updated_at = CURRENT_TIMESTAMP
    WHERE pa.attempt_public_id = p_attempt_public_id
      AND pa.provider_correlation_id = p_expected_correlation_id
      AND pa.status = 'QUOTE_OBSERVED'
    RETURNING
        pa.id,
        pa.attempt_public_id,
        pa.status,
        pa.verification_tier,
        pa.is_provider_verified;
END;
$$;

REVOKE EXECUTE ON FUNCTION flow.worker_verify_payment_attempt(text, text) FROM PUBLIC;

-- 9. Grant permissions to scoped roles
DO $$
DECLARE
    db_name text := current_database();
    app_role text := db_name || '_app';
    worker_role text := db_name || '_worker';
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = app_role) THEN
        EXECUTE format('GRANT EXECUTE ON FUNCTION flow.record_public_payment_attempt TO %I', app_role);
        EXECUTE format('REVOKE EXECUTE ON FUNCTION flow.worker_verify_payment_attempt FROM %I', app_role);
    END IF;

    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = worker_role) THEN
        EXECUTE format('GRANT EXECUTE ON FUNCTION flow.record_public_payment_attempt TO %I', worker_role);
        EXECUTE format('GRANT EXECUTE ON FUNCTION flow.worker_verify_payment_attempt TO %I', worker_role);
    END IF;
END;
$$;

-- 1. Create table flow.payment_rehearsal_authorizations
CREATE TABLE IF NOT EXISTS flow.payment_rehearsal_authorizations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    payment_request_id UUID NOT NULL REFERENCES flow.payment_requests(id) ON DELETE CASCADE,
    operator_auth_id VARCHAR(128) NOT NULL REFERENCES flow.auth_users(id),
    environment VARCHAR(32) NOT NULL DEFAULT 'mainnet',
    source_network VARCHAR(64) NOT NULL,
    source_asset_id VARCHAR(128) NOT NULL,
    destination_network VARCHAR(64) NOT NULL,
    destination_asset_id VARCHAR(128) NOT NULL,
    max_atomic_amount NUMERIC(78, 0) NOT NULL,
    allowed_payer_refund_address VARCHAR(128),
    allowed_recipient_address VARCHAR(128) NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    consumed_at TIMESTAMPTZ,
    consumed_by_attempt_id UUID REFERENCES flow.payment_attempts(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_rehearsal_auth_lookup 
ON flow.payment_rehearsal_authorizations (payment_request_id, environment, expires_at)
WHERE consumed_at IS NULL;

-- 2. Stored procedure: flow.consume_payment_rehearsal_authorization
CREATE OR REPLACE FUNCTION flow.consume_payment_rehearsal_authorization(
    p_payment_request_id UUID,
    p_payment_attempt_id UUID,
    p_source_network TEXT,
    p_source_asset_id TEXT,
    p_destination_network TEXT,
    p_destination_asset_id TEXT,
    p_quoted_amount NUMERIC,
    p_payer_refund_address TEXT,
    p_recipient_address TEXT
)
RETURNS TABLE (
    res_auth_id UUID,
    res_operator_auth_id TEXT,
    res_max_atomic_amount NUMERIC,
    res_consumed_at TIMESTAMPTZ
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, flow
AS $$
DECLARE
    v_row RECORD;
BEGIN
    SELECT * INTO v_row
    FROM flow.payment_rehearsal_authorizations AS a
    WHERE a.payment_request_id = p_payment_request_id
      AND a.environment = 'mainnet'
      AND a.expires_at > CURRENT_TIMESTAMP
      AND a.consumed_at IS NULL
    ORDER BY a.created_at DESC
    LIMIT 1
    FOR UPDATE;

    IF v_row.id IS NULL THEN
        RETURN;
    END IF;

    -- Route & Token constraints
    IF v_row.source_network <> p_source_network THEN
        RAISE EXCEPTION 'REHEARSAL_SOURCE_NETWORK_MISMATCH: expected %, got %', v_row.source_network, p_source_network USING ERRCODE = 'data_exception';
    END IF;

    IF v_row.source_asset_id <> p_source_asset_id THEN
        RAISE EXCEPTION 'REHEARSAL_SOURCE_ASSET_MISMATCH: expected %, got %', v_row.source_asset_id, p_source_asset_id USING ERRCODE = 'data_exception';
    END IF;

    IF v_row.destination_network <> p_destination_network THEN
        RAISE EXCEPTION 'REHEARSAL_DESTINATION_NETWORK_MISMATCH: expected %, got %', v_row.destination_network, p_destination_network USING ERRCODE = 'data_exception';
    END IF;

    IF v_row.destination_asset_id <> p_destination_asset_id THEN
        RAISE EXCEPTION 'REHEARSAL_DESTINATION_ASSET_MISMATCH: expected %, got %', v_row.destination_asset_id, p_destination_asset_id USING ERRCODE = 'data_exception';
    END IF;

    -- Strict financial bound check
    IF p_quoted_amount > v_row.max_atomic_amount THEN
        RAISE EXCEPTION 'REHEARSAL_AMOUNT_EXCEEDS_MAX_BOUND: quoted % exceeds authorized maximum %', p_quoted_amount, v_row.max_atomic_amount USING ERRCODE = 'data_exception';
    END IF;

    -- Recipient address constraint
    IF lower(trim(v_row.allowed_recipient_address)) <> lower(trim(p_recipient_address)) THEN
        RAISE EXCEPTION 'REHEARSAL_RECIPIENT_MISMATCH: expected %, got %', v_row.allowed_recipient_address, p_recipient_address USING ERRCODE = 'data_exception';
    END IF;

    -- Payer refund address constraint (if restricted)
    IF v_row.allowed_payer_refund_address IS NOT NULL AND length(trim(v_row.allowed_payer_refund_address)) > 0 THEN
        IF p_payer_refund_address IS NULL OR trim(v_row.allowed_payer_refund_address) <> trim(p_payer_refund_address) THEN
            RAISE EXCEPTION 'REHEARSAL_PAYER_REFUND_MISMATCH: expected %, got %', v_row.allowed_payer_refund_address, p_payer_refund_address USING ERRCODE = 'data_exception';
        END IF;
    END IF;

    -- Atomically consume authorization
    UPDATE flow.payment_rehearsal_authorizations AS pra
    SET consumed_at = CURRENT_TIMESTAMP,
        consumed_by_attempt_id = p_payment_attempt_id
    WHERE pra.id = v_row.id;

    RETURN QUERY
    SELECT
        v_row.id::UUID,
        v_row.operator_auth_id::TEXT,
        v_row.max_atomic_amount::NUMERIC,
        CURRENT_TIMESTAMP::TIMESTAMPTZ;
END;
$$;

-- 3. Stored procedure: flow.create_payment_rehearsal_authorization
CREATE OR REPLACE FUNCTION flow.create_payment_rehearsal_authorization(
    p_payment_request_id UUID,
    p_operator_auth_id TEXT,
    p_source_network TEXT,
    p_source_asset_id TEXT,
    p_destination_network TEXT,
    p_destination_asset_id TEXT,
    p_max_atomic_amount NUMERIC,
    p_allowed_recipient_address TEXT,
    p_allowed_payer_refund_address TEXT DEFAULT NULL,
    p_duration_seconds INTEGER DEFAULT 1800
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, flow
AS $$
DECLARE
    v_auth_id UUID;
    v_expires_at TIMESTAMPTZ;
BEGIN
    IF p_duration_seconds < 60 OR p_duration_seconds > 86400 THEN
        RAISE EXCEPTION 'INVALID_REHEARSAL_DURATION: must be between 60 and 86400 seconds' USING ERRCODE = 'data_exception';
    END IF;

    IF p_max_atomic_amount <= 0 THEN
        RAISE EXCEPTION 'INVALID_MAX_ATOMIC_AMOUNT: must be greater than zero' USING ERRCODE = 'data_exception';
    END IF;

    v_expires_at := CURRENT_TIMESTAMP + (p_duration_seconds || ' seconds')::interval;

    INSERT INTO flow.payment_rehearsal_authorizations (
        payment_request_id,
        operator_auth_id,
        environment,
        source_network,
        source_asset_id,
        destination_network,
        destination_asset_id,
        max_atomic_amount,
        allowed_payer_refund_address,
        allowed_recipient_address,
        expires_at
    ) VALUES (
        p_payment_request_id,
        p_operator_auth_id,
        'mainnet',
        p_source_network,
        p_source_asset_id,
        p_destination_network,
        p_destination_asset_id,
        p_max_atomic_amount,
        p_allowed_payer_refund_address,
        p_allowed_recipient_address,
        v_expires_at
    )
    RETURNING id INTO v_auth_id;

    RETURN v_auth_id;
END;
$$;

-- 4. Stored procedure: flow.check_active_payment_rehearsal_authorization
CREATE OR REPLACE FUNCTION flow.check_active_payment_rehearsal_authorization(
    p_payment_request_public_id text
)
RETURNS TABLE (
    res_auth_id UUID,
    res_max_atomic_amount NUMERIC,
    res_expires_at TIMESTAMPTZ
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, flow
AS $$
BEGIN
    RETURN QUERY
    SELECT
        a.id::UUID,
        a.max_atomic_amount::NUMERIC,
        a.expires_at::TIMESTAMPTZ
    FROM flow.payment_rehearsal_authorizations a
    JOIN flow.payment_requests pr ON pr.id = a.payment_request_id
    WHERE pr.public_id = p_payment_request_public_id
      AND a.environment = 'mainnet'
      AND a.consumed_at IS NULL
      AND a.expires_at > CURRENT_TIMESTAMP
    ORDER BY a.created_at DESC
    LIMIT 1;
END;
$$;

-- 5. Stored procedure: flow.get_payment_attempt_commitment_details
CREATE OR REPLACE FUNCTION flow.get_payment_attempt_commitment_details(
    p_payment_request_public_id text,
    p_attempt_public_id text
)
RETURNS TABLE (
    payment_request_id UUID,
    attempt_id UUID,
    destination_asset_id TEXT,
    payer_refund_address TEXT,
    recipient_address TEXT,
    recipient_network TEXT,
    recipient_chain_id TEXT,
    wallet_environment TEXT,
    wallet_status TEXT,
    can_receive BOOLEAN
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, flow
AS $$
BEGIN
    RETURN QUERY
    SELECT
        pr.id AS payment_request_id,
        pa.id AS attempt_id,
        pr.destination_asset_id::TEXT,
        pa.payer_refund_address::TEXT,
        wa.address::TEXT AS recipient_address,
        wa.network::TEXT AS recipient_network,
        wa.chain_id::TEXT AS recipient_chain_id,
        w.environment::TEXT AS wallet_environment,
        w.status::TEXT AS wallet_status,
        COALESCE(wc.can_receive, false)::BOOLEAN AS can_receive
    FROM flow.payment_attempts pa
    JOIN flow.payment_requests pr ON pr.id = pa.payment_request_id
    LEFT JOIN flow.wallets w ON w.account_id = pr.account_id
    LEFT JOIN flow.wallet_addresses wa ON wa.wallet_id = w.id AND wa.network = pr.destination_network
    LEFT JOIN flow.wallet_capabilities wc ON wc.wallet_id = w.id AND wc.network = wa.network
    WHERE pa.attempt_public_id = p_attempt_public_id
      AND pr.public_id = p_payment_request_public_id
    LIMIT 1;
END;
$$;

-- 6. Role grants and privilege separation
DO $$
DECLARE
    app_role text := current_database() || '_app';
    worker_role text := current_database() || '_worker';
    operator_role text := current_database() || '_operator';
BEGIN
    EXECUTE format('GRANT SELECT, UPDATE ON flow.payment_rehearsal_authorizations TO %I', app_role);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON flow.payment_rehearsal_authorizations TO %I', worker_role);
    EXECUTE format('GRANT ALL ON flow.payment_rehearsal_authorizations TO %I', operator_role);
    EXECUTE format('GRANT EXECUTE ON FUNCTION flow.consume_payment_rehearsal_authorization TO %I', app_role);
    EXECUTE format('GRANT EXECUTE ON FUNCTION flow.consume_payment_rehearsal_authorization TO %I', worker_role);
    EXECUTE format('GRANT EXECUTE ON FUNCTION flow.create_payment_rehearsal_authorization TO %I', worker_role);
    EXECUTE format('GRANT EXECUTE ON FUNCTION flow.create_payment_rehearsal_authorization TO %I', operator_role);
    EXECUTE format('GRANT EXECUTE ON FUNCTION flow.check_active_payment_rehearsal_authorization TO %I', app_role);
    EXECUTE format('GRANT EXECUTE ON FUNCTION flow.check_active_payment_rehearsal_authorization TO %I', worker_role);
    EXECUTE format('GRANT EXECUTE ON FUNCTION flow.get_payment_attempt_commitment_details TO %I', app_role);
    EXECUTE format('GRANT EXECUTE ON FUNCTION flow.get_payment_attempt_commitment_details TO %I', worker_role);
END;
$$;


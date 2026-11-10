-- Migration: 20261110010000_m6_operator_assertion_and_privilege_hardening
-- Forward-only migration to harden operator authentication via cryptographic approval assertions,
-- enforce strict privilege separation on rehearsal tables, and prevent tampering or spoofing.

-- 1. Create table flow.operator_approval_assertions
CREATE TABLE IF NOT EXISTS flow.operator_approval_assertions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    assertion_token_hash VARCHAR(128) NOT NULL UNIQUE,
    operator_auth_id VARCHAR(128) NOT NULL REFERENCES flow.auth_users(id),
    payment_request_id UUID NOT NULL REFERENCES flow.payment_requests(id) ON DELETE CASCADE,
    environment VARCHAR(32) NOT NULL DEFAULT 'mainnet',
    source_network VARCHAR(64) NOT NULL,
    source_asset_id VARCHAR(128) NOT NULL,
    destination_network VARCHAR(64) NOT NULL,
    destination_asset_id VARCHAR(128) NOT NULL,
    max_atomic_amount NUMERIC(78, 0) NOT NULL,
    allowed_recipient_address VARCHAR(128) NOT NULL,
    allowed_payer_refund_address VARCHAR(128),
    nonce VARCHAR(128) NOT NULL UNIQUE,
    signature TEXT,
    expires_at TIMESTAMPTZ NOT NULL,
    consumed_at TIMESTAMPTZ,
    consumed_by_authorization_id UUID,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT chk_operator_assertion_max_amount CHECK (max_atomic_amount > 0),
    CONSTRAINT chk_operator_assertion_env CHECK (environment IN ('mainnet', 'testnet'))
);

CREATE INDEX IF NOT EXISTS idx_operator_approval_lookup
ON flow.operator_approval_assertions (assertion_token_hash)
WHERE consumed_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_operator_approval_request
ON flow.operator_approval_assertions (payment_request_id, operator_auth_id, expires_at);

-- 2. Add assertion_id and constraints to flow.payment_rehearsal_authorizations
ALTER TABLE flow.payment_rehearsal_authorizations
ADD COLUMN IF NOT EXISTS assertion_id UUID REFERENCES flow.operator_approval_assertions(id) ON DELETE SET NULL;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'chk_rehearsal_environment'
    ) THEN
        ALTER TABLE flow.payment_rehearsal_authorizations
        ADD CONSTRAINT chk_rehearsal_environment CHECK (environment IN ('mainnet', 'testnet'));
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'chk_rehearsal_max_atomic_amount'
    ) THEN
        ALTER TABLE flow.payment_rehearsal_authorizations
        ADD CONSTRAINT chk_rehearsal_max_atomic_amount CHECK (max_atomic_amount > 0);
    END IF;
END;
$$;

-- 3. Immutability trigger on flow.payment_rehearsal_authorizations
CREATE OR REPLACE FUNCTION flow.prevent_payment_rehearsal_authorization_tampering()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        -- Production protection: No payment rehearsal authorization can EVER be deleted in production under any circumstance
        -- Even if allow_test_cleanup is set, production immutability cannot be bypassed
        IF current_database() NOT LIKE '%test%' AND COALESCE(current_setting('flow.environment', true), '') <> 'test' THEN
            RAISE EXCEPTION 'Deleting payment rehearsal authorizations in production is strictly prohibited for audit integrity'
                USING ERRCODE = '42501';
        END IF;

        -- Even in a test database, test cleanup setting is strictly required
        IF current_setting('flow.allow_test_cleanup', true) IS DISTINCT FROM 'on' THEN
            RAISE EXCEPTION 'Deleting payment rehearsal authorizations is strictly prohibited outside test cleanup'
                USING ERRCODE = '42501';
        END IF;

        RETURN OLD;
    END IF;

    IF TG_OP = 'UPDATE' THEN
        -- Once consumed, permanent immutability
        IF OLD.consumed_at IS NOT NULL THEN
            RAISE EXCEPTION 'Consumed payment rehearsal authorizations are permanently immutable'
                USING ERRCODE = '23514';
        END IF;

        -- Authorizations cannot be extended: expires_at cannot be increased
        IF NEW.expires_at > OLD.expires_at THEN
            RAISE EXCEPTION 'Extending payment rehearsal authorization expiry is strictly prohibited'
                USING ERRCODE = '23514';
        END IF;

        -- Prevent modifying core parameters: payment_request_id, operator_auth_id, environment, route, amount, addresses, created_at, assertion_id
        IF NEW.payment_request_id <> OLD.payment_request_id OR
           NEW.operator_auth_id <> OLD.operator_auth_id OR
           NEW.environment <> OLD.environment OR
           NEW.source_network <> OLD.source_network OR
           NEW.source_asset_id <> OLD.source_asset_id OR
           NEW.destination_network <> OLD.destination_network OR
           NEW.destination_asset_id <> OLD.destination_asset_id OR
           NEW.max_atomic_amount <> OLD.max_atomic_amount OR
           NEW.allowed_recipient_address <> OLD.allowed_recipient_address OR
           NEW.allowed_payer_refund_address IS DISTINCT FROM OLD.allowed_payer_refund_address OR
           NEW.created_at <> OLD.created_at OR
           NEW.assertion_id IS DISTINCT FROM OLD.assertion_id THEN
            RAISE EXCEPTION 'Modifying core parameters of payment rehearsal authorization is strictly prohibited'
                USING ERRCODE = '23514';
        END IF;
    END IF;

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_prevent_payment_rehearsal_authorization_tampering ON flow.payment_rehearsal_authorizations;
CREATE TRIGGER trg_prevent_payment_rehearsal_authorization_tampering
    BEFORE UPDATE OR DELETE ON flow.payment_rehearsal_authorizations
    FOR EACH ROW
    EXECUTE FUNCTION flow.prevent_payment_rehearsal_authorization_tampering();

-- 4. Immutability trigger on flow.operator_approval_assertions
CREATE OR REPLACE FUNCTION flow.prevent_operator_approval_assertion_tampering()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        IF current_database() NOT LIKE '%test%' AND COALESCE(current_setting('flow.environment', true), '') <> 'test' THEN
            RAISE EXCEPTION 'Deleting operator approval assertions in production is strictly prohibited'
                USING ERRCODE = '42501';
        END IF;
        IF current_setting('flow.allow_test_cleanup', true) IS DISTINCT FROM 'on' THEN
            RAISE EXCEPTION 'Deleting operator approval assertions is strictly prohibited outside test cleanup'
                USING ERRCODE = '42501';
        END IF;
        RETURN OLD;
    END IF;

    IF TG_OP = 'UPDATE' THEN
        -- Once consumed, permanent immutability
        IF OLD.consumed_at IS NOT NULL THEN
            RAISE EXCEPTION 'Consumed operator approval assertions are permanently immutable'
                USING ERRCODE = '23514';
        END IF;

        IF NEW.operator_auth_id <> OLD.operator_auth_id OR
           NEW.payment_request_id <> OLD.payment_request_id OR
           NEW.assertion_token_hash <> OLD.assertion_token_hash OR
           NEW.source_network <> OLD.source_network OR
           NEW.source_asset_id <> OLD.source_asset_id OR
           NEW.destination_network <> OLD.destination_network OR
           NEW.destination_asset_id <> OLD.destination_asset_id OR
           NEW.max_atomic_amount <> OLD.max_atomic_amount OR
           NEW.allowed_recipient_address <> OLD.allowed_recipient_address OR
           NEW.allowed_payer_refund_address IS DISTINCT FROM OLD.allowed_payer_refund_address OR
           NEW.expires_at <> OLD.expires_at OR
           NEW.created_at <> OLD.created_at THEN
            RAISE EXCEPTION 'Modifying parameters of operator approval assertion is strictly prohibited'
                USING ERRCODE = '23514';
        END IF;
    END IF;

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_prevent_operator_approval_assertion_tampering ON flow.operator_approval_assertions;
CREATE TRIGGER trg_prevent_operator_approval_assertion_tampering
    BEFORE UPDATE OR DELETE ON flow.operator_approval_assertions
    FOR EACH ROW
    EXECUTE FUNCTION flow.prevent_operator_approval_assertion_tampering();

-- 5. Stored procedure: flow.issue_operator_approval_assertion
CREATE OR REPLACE FUNCTION flow.issue_operator_approval_assertion(
    p_operator_auth_id TEXT,
    p_operator_session_token TEXT,
    p_payment_request_id UUID,
    p_source_network TEXT,
    p_source_asset_id TEXT,
    p_destination_network TEXT,
    p_destination_asset_id TEXT,
    p_max_atomic_amount NUMERIC,
    p_allowed_recipient_address TEXT,
    p_allowed_payer_refund_address TEXT DEFAULT NULL,
    p_duration_seconds INTEGER DEFAULT 1800,
    p_assertion_token_hash TEXT DEFAULT NULL,
    p_signature TEXT DEFAULT NULL,
    p_nonce TEXT DEFAULT NULL
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, flow
AS $$
DECLARE
    v_assertion_id UUID;
    v_expires_at TIMESTAMPTZ;
BEGIN
    -- 1. Operator enrollment check
    IF NOT EXISTS (
        SELECT 1 FROM flow.custody_operators co
        WHERE co.auth_user_id = p_operator_auth_id
          AND co.status = 'ACTIVE'
          AND co.role IN ('SECURITY_OFFICER', 'CUSTODY_OPERATOR')
    ) THEN
        RAISE EXCEPTION 'OPERATOR_NOT_AUTHORIZED: operator % is not an active custody operator or security officer', p_operator_auth_id
            USING ERRCODE = '42501';
    END IF;

    -- 2. Cryptographic credential authentication via active operator session
    IF p_operator_session_token IS NULL OR length(trim(p_operator_session_token)) < 16 THEN
        RAISE EXCEPTION 'OPERATOR_CREDENTIALS_REQUIRED: authentic session token required for operator %', p_operator_auth_id
            USING ERRCODE = '42501';
    END IF;

    IF NOT EXISTS (
        SELECT 1
        FROM flow.auth_sessions s
        WHERE s.user_id = p_operator_auth_id
          AND s.token = trim(p_operator_session_token)
          AND s.expires_at > CURRENT_TIMESTAMP
    ) THEN
        RAISE EXCEPTION 'OPERATOR_CREDENTIALS_INVALID: valid unexpired session token required for operator %', p_operator_auth_id
            USING ERRCODE = '42501';
    END IF;

    -- 3. Validate parameters
    IF p_duration_seconds < 60 OR p_duration_seconds > 86400 THEN
        RAISE EXCEPTION 'INVALID_REHEARSAL_DURATION: must be between 60 and 86400 seconds' USING ERRCODE = 'data_exception';
    END IF;

    IF p_max_atomic_amount <= 0 THEN
        RAISE EXCEPTION 'INVALID_MAX_ATOMIC_AMOUNT: must be greater than zero' USING ERRCODE = 'data_exception';
    END IF;

    IF p_assertion_token_hash IS NULL OR length(trim(p_assertion_token_hash)) < 32 THEN
        RAISE EXCEPTION 'INVALID_ASSERTION_HASH: valid cryptographic assertion token hash required' USING ERRCODE = 'data_exception';
    END IF;

    -- Prohibit banned illustrative probe addresses
    IF lower(trim(p_allowed_recipient_address)) IN (
        '0xd8da6bf26964af9d7eed9e03e53415d37aa96045',
        '0x1111111111111111111111111111111111111111',
        '0x0000000000000000000000000000000000000000'
    ) THEN
        RAISE EXCEPTION 'PROHIBITED_RECIPIENT_ADDRESS: illustrative probe address % is strictly prohibited', p_allowed_recipient_address
            USING ERRCODE = '42501';
    END IF;

    v_expires_at := CURRENT_TIMESTAMP + (p_duration_seconds || ' seconds')::interval;

    INSERT INTO flow.operator_approval_assertions (
        assertion_token_hash,
        operator_auth_id,
        payment_request_id,
        environment,
        source_network,
        source_asset_id,
        destination_network,
        destination_asset_id,
        max_atomic_amount,
        allowed_recipient_address,
        allowed_payer_refund_address,
        nonce,
        signature,
        expires_at
    ) VALUES (
        trim(p_assertion_token_hash),
        p_operator_auth_id,
        p_payment_request_id,
        'mainnet',
        p_source_network,
        p_source_asset_id,
        p_destination_network,
        p_destination_asset_id,
        p_max_atomic_amount,
        p_allowed_recipient_address,
        p_allowed_payer_refund_address,
        COALESCE(p_nonce, gen_random_uuid()::text),
        p_signature,
        v_expires_at
    )
    RETURNING id INTO v_assertion_id;

    RETURN v_assertion_id;
END;
$$;

-- 6. Drop legacy stored procedure signature without cryptographic approval assertion
DROP FUNCTION IF EXISTS flow.create_payment_rehearsal_authorization(UUID, TEXT, TEXT, TEXT, TEXT, TEXT, NUMERIC, TEXT, TEXT, INTEGER);

-- 7. Stored procedure: flow.create_payment_rehearsal_authorization with cryptographic assertion verification
CREATE OR REPLACE FUNCTION flow.create_payment_rehearsal_authorization(
    p_payment_request_id UUID,
    p_operator_auth_id TEXT,
    p_approval_assertion_token TEXT,
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
    v_wallet_id UUID;
    v_wallet_status flow.wallet_status;
    v_can_receive BOOLEAN;
    v_pr_dest_net TEXT;
    v_pr_dest_asset TEXT;
    v_pr_status flow.payment_request_status;
    v_assertion_hash TEXT;
    v_assertion RECORD;
    v_session_operator_id TEXT;
BEGIN
    -- 1. Cryptographic Assertion Verification
    IF p_approval_assertion_token IS NULL OR length(trim(p_approval_assertion_token)) < 32 THEN
        RAISE EXCEPTION 'OPERATOR_ASSERTION_REQUIRED: rehearsal authorization requires a valid cryptographic approval assertion token'
            USING ERRCODE = '42501';
    END IF;

    -- Compute SHA256 of the caller-supplied approval assertion token
    v_assertion_hash := encode(sha256(convert_to(trim(p_approval_assertion_token), 'UTF8')), 'hex');

    -- Find and lock active, unconsumed assertion
    SELECT * INTO v_assertion
    FROM flow.operator_approval_assertions
    WHERE assertion_token_hash = v_assertion_hash
      AND consumed_at IS NULL
      AND expires_at > CURRENT_TIMESTAMP
    FOR UPDATE;

    IF v_assertion.id IS NULL THEN
        RAISE EXCEPTION 'OPERATOR_ASSERTION_INVALID: approval assertion token is invalid, expired, or already consumed'
            USING ERRCODE = '42501';
    END IF;

    -- 2. Verify identity independently against assertion
    IF v_assertion.operator_auth_id <> p_operator_auth_id THEN
        RAISE EXCEPTION 'OPERATOR_ASSERTION_IDENTITY_MISMATCH: assertion was issued for operator %, not caller %',
            v_assertion.operator_auth_id, p_operator_auth_id
            USING ERRCODE = '42501';
    END IF;

    -- Defense-in-depth: If session setting is also present, it must match the authentic assertion operator
    v_session_operator_id := NULLIF(current_setting('flow.operator_auth_id', true), '');
    IF v_session_operator_id IS NOT NULL AND v_session_operator_id <> v_assertion.operator_auth_id THEN
        RAISE EXCEPTION 'OPERATOR_IDENTITY_SPOOFED: session context % does not match assertion operator %',
            v_session_operator_id, v_assertion.operator_auth_id
            USING ERRCODE = '42501';
    END IF;

    -- 3. Verify operator role and active status
    IF NOT EXISTS (
        SELECT 1 FROM flow.custody_operators co
        WHERE co.auth_user_id = v_assertion.operator_auth_id
          AND co.status = 'ACTIVE'
          AND co.role IN ('SECURITY_OFFICER', 'CUSTODY_OPERATOR')
    ) THEN
        RAISE EXCEPTION 'OPERATOR_NOT_AUTHORIZED: operator % is not an active custody operator or security officer', v_assertion.operator_auth_id
            USING ERRCODE = '42501';
    END IF;

    -- 4. Verify assertion scope bounds independently
    IF v_assertion.payment_request_id <> p_payment_request_id OR
       v_assertion.source_network <> p_source_network OR
       v_assertion.source_asset_id <> p_source_asset_id OR
       v_assertion.destination_network <> p_destination_network OR
       v_assertion.destination_asset_id <> p_destination_asset_id OR
       p_max_atomic_amount > v_assertion.max_atomic_amount OR
       lower(trim(v_assertion.allowed_recipient_address)) <> lower(trim(p_allowed_recipient_address)) OR
       (v_assertion.allowed_payer_refund_address IS NOT NULL AND v_assertion.allowed_payer_refund_address IS DISTINCT FROM p_allowed_payer_refund_address) THEN
        RAISE EXCEPTION 'OPERATOR_ASSERTION_SCOPE_MISMATCH: rehearsal parameters do not match approved assertion scope'
            USING ERRCODE = '42501';
    END IF;

    -- 5. Validate duration and amount
    IF p_duration_seconds < 60 OR p_duration_seconds > 86400 THEN
        RAISE EXCEPTION 'INVALID_REHEARSAL_DURATION: must be between 60 and 86400 seconds' USING ERRCODE = 'data_exception';
    END IF;

    IF p_max_atomic_amount <= 0 THEN
        RAISE EXCEPTION 'INVALID_MAX_ATOMIC_AMOUNT: must be greater than zero' USING ERRCODE = 'data_exception';
    END IF;

    -- Prevent duplicate active authorizations for the same payment request
    IF EXISTS (
        SELECT 1 FROM flow.payment_rehearsal_authorizations
        WHERE payment_request_id = p_payment_request_id
          AND environment = 'mainnet'
          AND consumed_at IS NULL
          AND expires_at > CURRENT_TIMESTAMP
    ) THEN
        RAISE EXCEPTION 'ACTIVE_REHEARSAL_AUTHORIZATION_EXISTS: an active authorization already exists for this payment request'
            USING ERRCODE = '23505';
    END IF;

    -- Prohibit banned illustrative addresses
    IF lower(trim(p_allowed_recipient_address)) IN (
        '0xd8da6bf26964af9d7eed9e03e53415d37aa96045',
        '0x1111111111111111111111111111111111111111',
        '0x0000000000000000000000000000000000000000'
    ) THEN
        RAISE EXCEPTION 'PROHIBITED_RECIPIENT_ADDRESS: illustrative probe address % is strictly prohibited', p_allowed_recipient_address
            USING ERRCODE = '42501';
    END IF;

    -- Validate payment request existence and active status
    SELECT destination_network, destination_asset_id, status
    INTO v_pr_dest_net, v_pr_dest_asset, v_pr_status
    FROM flow.payment_requests
    WHERE id = p_payment_request_id;

    IF v_pr_status IS NULL THEN
        RAISE EXCEPTION 'PAYMENT_REQUEST_NOT_FOUND: %', p_payment_request_id USING ERRCODE = 'data_exception';
    END IF;

    IF v_pr_status <> 'ACTIVE' THEN
        RAISE EXCEPTION 'PAYMENT_REQUEST_INACTIVE: status is %', v_pr_status USING ERRCODE = 'data_exception';
    END IF;

    IF v_pr_dest_net <> p_destination_network OR v_pr_dest_asset <> p_destination_asset_id THEN
        RAISE EXCEPTION 'REHEARSAL_ROUTE_MISMATCH: payment request destination %:% does not match authorized destination %:%',
            v_pr_dest_net, v_pr_dest_asset, p_destination_network, p_destination_asset_id
            USING ERRCODE = 'data_exception';
    END IF;

    -- Verify merchant recipient wallet ownership
    SELECT w.id, w.status, COALESCE(wc.can_receive, false)
    INTO v_wallet_id, v_wallet_status, v_can_receive
    FROM flow.payment_requests pr
    JOIN flow.wallets w ON w.account_id = pr.account_id AND w.environment = 'mainnet'
    JOIN flow.wallet_addresses wa ON wa.wallet_id = w.id AND wa.network = p_destination_network
    LEFT JOIN flow.wallet_capabilities wc ON wc.wallet_id = w.id AND wc.network = wa.network
    WHERE pr.id = p_payment_request_id
      AND lower(trim(wa.address)) = lower(trim(p_allowed_recipient_address))
    LIMIT 1;

    IF v_wallet_id IS NULL THEN
        RAISE EXCEPTION 'UNVERIFIED_RECIPIENT_WALLET: recipient address % is not an owner-controlled mainnet wallet registered to this merchant account',
            p_allowed_recipient_address
            USING ERRCODE = '42501';
    END IF;

    IF v_wallet_status <> 'ACTIVE' THEN
        RAISE EXCEPTION 'RECIPIENT_WALLET_NOT_ACTIVE: merchant recipient wallet status is %, must be ACTIVE', v_wallet_status
            USING ERRCODE = '42501';
    END IF;

    IF NOT v_can_receive THEN
        RAISE EXCEPTION 'RECIPIENT_WALLET_CANNOT_RECEIVE: merchant recipient wallet capability can_receive is false'
            USING ERRCODE = '42501';
    END IF;

    v_expires_at := LEAST(CURRENT_TIMESTAMP + (p_duration_seconds || ' seconds')::interval, v_assertion.expires_at);

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
        expires_at,
        assertion_id
    ) VALUES (
        p_payment_request_id,
        v_assertion.operator_auth_id,
        'mainnet',
        p_source_network,
        p_source_asset_id,
        p_destination_network,
        p_destination_asset_id,
        p_max_atomic_amount,
        p_allowed_payer_refund_address,
        p_allowed_recipient_address,
        v_expires_at,
        v_assertion.id
    )
    RETURNING id INTO v_auth_id;

    -- 6. Atomically consume the assertion (single-use)
    UPDATE flow.operator_approval_assertions
    SET consumed_at = CURRENT_TIMESTAMP,
        consumed_by_authorization_id = v_auth_id
    WHERE id = v_assertion.id;

    RETURN v_auth_id;
END;
$$;

DROP FUNCTION IF EXISTS flow.consume_payment_rehearsal_authorization(UUID, UUID, TEXT, TEXT, TEXT, TEXT, NUMERIC, TEXT, TEXT);

-- 8. Stored procedure: flow.consume_payment_rehearsal_authorization with probe address check
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
    -- Prohibit illustrative probe addresses at consumption
    IF lower(trim(p_recipient_address)) IN (
        '0xd8da6bf26964af9d7eed9e03e53415d37aa96045',
        '0x1111111111111111111111111111111111111111',
        '0x0000000000000000000000000000000000000000'
    ) THEN
        RAISE EXCEPTION 'PROHIBITED_RECIPIENT_ADDRESS: illustrative probe address % is strictly prohibited in live execution', p_recipient_address
            USING ERRCODE = '42501';
    END IF;

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

-- Stored procedure: flow.check_active_payment_rehearsal_authorization
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

-- Stored procedure: flow.get_payment_attempt_commitment_details
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

-- 9. Role grants and privilege separation
DO $$
DECLARE
    app_role text := current_database() || '_app';
    worker_role text := current_database() || '_worker';
    operator_role text := current_database() || '_operator';
BEGIN
    -- Assertions table: REVOKE direct table mutations from ALL roles
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = app_role) THEN
        EXECUTE format('REVOKE ALL ON flow.operator_approval_assertions FROM %I', app_role);
    END IF;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = worker_role) THEN
        EXECUTE format('REVOKE ALL ON flow.operator_approval_assertions FROM %I', worker_role);
    END IF;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = operator_role) THEN
        EXECUTE format('REVOKE ALL ON flow.operator_approval_assertions FROM %I', operator_role);
        EXECUTE format('GRANT SELECT ON flow.operator_approval_assertions TO %I', operator_role);
        EXECUTE format('GRANT EXECUTE ON FUNCTION flow.issue_operator_approval_assertion TO %I', operator_role);
    END IF;

    -- Application Role: SELECT on authorizations, EXECUTE on consume/check/get.
    -- MUTATIONS (INSERT, UPDATE, DELETE) and create_payment_rehearsal_authorization are strictly revoked.
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = app_role) THEN
        EXECUTE format('REVOKE ALL ON flow.payment_rehearsal_authorizations FROM %I', app_role);
        EXECUTE format('GRANT SELECT ON flow.payment_rehearsal_authorizations TO %I', app_role);
        EXECUTE format('GRANT EXECUTE ON FUNCTION flow.consume_payment_rehearsal_authorization TO %I', app_role);
        EXECUTE format('GRANT EXECUTE ON FUNCTION flow.check_active_payment_rehearsal_authorization TO %I', app_role);
        EXECUTE format('GRANT EXECUTE ON FUNCTION flow.get_payment_attempt_commitment_details TO %I', app_role);
        EXECUTE format('REVOKE EXECUTE ON FUNCTION flow.create_payment_rehearsal_authorization FROM %I', app_role);
        EXECUTE format('REVOKE EXECUTE ON FUNCTION flow.issue_operator_approval_assertion FROM %I', app_role);
    END IF;

    -- Worker Role: SELECT on authorizations, EXECUTE on check/get.
    -- ALL MUTATIONS (INSERT, UPDATE, DELETE) and authorization-creation/consumption are strictly revoked.
    -- The payment worker cannot grant itself execution approval or consume authorizations directly.
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = worker_role) THEN
        EXECUTE format('REVOKE ALL ON flow.payment_rehearsal_authorizations FROM %I', worker_role);
        EXECUTE format('GRANT SELECT ON flow.payment_rehearsal_authorizations TO %I', worker_role);
        EXECUTE format('GRANT EXECUTE ON FUNCTION flow.check_active_payment_rehearsal_authorization TO %I', worker_role);
        EXECUTE format('GRANT EXECUTE ON FUNCTION flow.get_payment_attempt_commitment_details TO %I', worker_role);
        EXECUTE format('REVOKE EXECUTE ON FUNCTION flow.consume_payment_rehearsal_authorization FROM %I', worker_role);
        EXECUTE format('REVOKE EXECUTE ON FUNCTION flow.create_payment_rehearsal_authorization FROM %I', worker_role);
        EXECUTE format('REVOKE EXECUTE ON FUNCTION flow.issue_operator_approval_assertion FROM %I', worker_role);
    END IF;

    -- Operator Role: SELECT on authorizations, EXECUTE on create/check/get.
    -- Direct table mutations (INSERT, UPDATE, DELETE) are strictly revoked to prevent bypassing procedure validations.
    -- Authorizations must be created exclusively via the validated SECURITY DEFINER procedure.
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = operator_role) THEN
        EXECUTE format('REVOKE ALL ON flow.payment_rehearsal_authorizations FROM %I', operator_role);
        EXECUTE format('GRANT SELECT ON flow.payment_rehearsal_authorizations TO %I', operator_role);
        EXECUTE format('GRANT EXECUTE ON FUNCTION flow.create_payment_rehearsal_authorization TO %I', operator_role);
        EXECUTE format('GRANT EXECUTE ON FUNCTION flow.check_active_payment_rehearsal_authorization TO %I', operator_role);
        EXECUTE format('GRANT EXECUTE ON FUNCTION flow.get_payment_attempt_commitment_details TO %I', operator_role);
        EXECUTE format('REVOKE EXECUTE ON FUNCTION flow.consume_payment_rehearsal_authorization FROM %I', operator_role);
    END IF;

    -- Public: REVOKE ALL
    REVOKE ALL ON flow.payment_rehearsal_authorizations FROM PUBLIC;
    REVOKE ALL ON flow.operator_approval_assertions FROM PUBLIC;
    REVOKE ALL ON FUNCTION flow.consume_payment_rehearsal_authorization FROM PUBLIC;
    REVOKE ALL ON FUNCTION flow.create_payment_rehearsal_authorization FROM PUBLIC;
    REVOKE ALL ON FUNCTION flow.issue_operator_approval_assertion FROM PUBLIC;
    REVOKE ALL ON FUNCTION flow.check_active_payment_rehearsal_authorization FROM PUBLIC;
    REVOKE ALL ON FUNCTION flow.get_payment_attempt_commitment_details FROM PUBLIC;
END;
$$;

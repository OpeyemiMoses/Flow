-- Migration: 20261111020000_payment_deadline_and_settlement_safety
-- Purpose:
-- 1. Support persisting committed quote source atomic amount and clearing dry quote expiry in flow.commit_payment_attempt.
-- 2. Extract on-chain transaction timestamp in flow.record_payment_verification so timely deposits confirmed late are not falsely marked late.
-- 3. Decouple dry preview quote expiry from committed quote deposit deadline in late deposit detection.
-- 4. Support base / base-mainnet network matching in destination settlement verification.
BEGIN;

-- 1. flow.commit_payment_attempt (with p_quoted_source_atomic parameter)
DROP FUNCTION IF EXISTS flow.commit_payment_attempt(text, text, text, timestamptz, jsonb, numeric);
DROP FUNCTION IF EXISTS flow.commit_payment_attempt(text, text, text, timestamptz, jsonb);

CREATE OR REPLACE FUNCTION flow.commit_payment_attempt(
    p_attempt_public_id text,
    p_deposit_address text,
    p_deposit_memo text,
    p_deposit_deadline timestamptz,
    p_deposit_instructions jsonb,
    p_quoted_source_atomic numeric DEFAULT NULL
)
RETURNS TABLE (
    id UUID,
    attempt_public_id VARCHAR(64),
    status VARCHAR(32),
    deposit_address VARCHAR(256),
    deposit_memo VARCHAR(128),
    deposit_deadline TIMESTAMPTZ,
    deposit_instructions JSONB,
    updated_at TIMESTAMPTZ
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, flow
AS $$
DECLARE
    v_attempt_id UUID;
    v_current_status VARCHAR(32);
    v_request_status flow.payment_request_status;
    v_request_expires_at TIMESTAMPTZ;
    v_quote_expires_at TIMESTAMPTZ;
BEGIN
    SELECT
        pa.id,
        pa.status,
        pa.quote_expires_at,
        pr.status,
        pr.expires_at
    INTO
        v_attempt_id,
        v_current_status,
        v_quote_expires_at,
        v_request_status,
        v_request_expires_at
    FROM flow.payment_attempts pa
    JOIN flow.payment_requests pr ON pr.id = pa.payment_request_id
    WHERE pa.attempt_public_id = p_attempt_public_id;

    IF v_attempt_id IS NULL THEN
        RAISE EXCEPTION 'PAYMENT_ATTEMPT_NOT_FOUND' USING ERRCODE = 'data_exception';
    END IF;

    -- If already committed with same instructions, allow idempotent replay
    -- Even if parent request has expired or completed, or attempt has settled!
    IF v_current_status IN ('DEPOSIT_COMMITTED', 'SETTLING', 'SETTLED') THEN
        RETURN QUERY
        SELECT
            pa.id,
            pa.attempt_public_id,
            pa.status,
            pa.deposit_address,
            pa.deposit_memo,
            pa.deposit_deadline,
            pa.deposit_instructions,
            pa.updated_at
        FROM flow.payment_attempts pa
        WHERE pa.id = v_attempt_id;
        RETURN;
    END IF;

    IF v_request_status <> 'ACTIVE' THEN
        RAISE EXCEPTION 'PAYMENT_REQUEST_INACTIVE' USING ERRCODE = 'data_exception';
    END IF;

    IF v_request_expires_at IS NOT NULL AND v_request_expires_at <= CURRENT_TIMESTAMP THEN
        RAISE EXCEPTION 'PAYMENT_REQUEST_EXPIRED' USING ERRCODE = 'data_exception';
    END IF;

    -- Strict Quote Expiration: Zero grace window for uncommitted preview quote
    IF v_quote_expires_at IS NOT NULL AND v_quote_expires_at < CURRENT_TIMESTAMP THEN
        RAISE EXCEPTION 'QUOTE_EXPIRED' USING ERRCODE = 'data_exception';
    END IF;

    -- Prohibit synthetic/fabricated deposit addresses
    IF p_deposit_address IS NULL OR length(trim(p_deposit_address)) = 0 OR p_deposit_address LIKE 'flow-%.near' THEN
        RAISE EXCEPTION 'INVALID_PROVIDER_DEPOSIT_ADDRESS' USING ERRCODE = 'data_exception';
    END IF;

    IF v_current_status <> 'QUOTE_OBSERVED' THEN
        RAISE EXCEPTION 'INVALID_ATTEMPT_STATUS_FOR_COMMIT: %', v_current_status USING ERRCODE = 'data_exception';
    END IF;

    RETURN QUERY
    UPDATE flow.payment_attempts pa
    SET
        status = 'DEPOSIT_COMMITTED',
        is_provider_verified = true,
        verification_tier = 'PROVIDER_VERIFIED',
        deposit_address = p_deposit_address,
        deposit_memo = p_deposit_memo,
        deposit_deadline = p_deposit_deadline,
        quote_expires_at = NULL, -- Dry preview expires_at cleared upon commitment!
        quoted_source_atomic_amount = COALESCE(p_quoted_source_atomic, pa.quoted_source_atomic_amount),
        deposit_instructions = COALESCE(p_deposit_instructions, '{}'::jsonb),
        updated_at = CURRENT_TIMESTAMP
    WHERE pa.id = v_attempt_id
    RETURNING
        pa.id,
        pa.attempt_public_id,
        pa.status,
        pa.deposit_address,
        pa.deposit_memo,
        pa.deposit_deadline,
        pa.deposit_instructions,
        pa.updated_at;
END;
$$;

-- Overload for 5 arguments
CREATE OR REPLACE FUNCTION flow.commit_payment_attempt(
    p_attempt_public_id text,
    p_deposit_address text,
    p_deposit_memo text,
    p_deposit_deadline timestamptz,
    p_deposit_instructions jsonb
)
RETURNS TABLE (
    id UUID,
    attempt_public_id VARCHAR(64),
    status VARCHAR(32),
    deposit_address VARCHAR(256),
    deposit_memo VARCHAR(128),
    deposit_deadline TIMESTAMPTZ,
    deposit_instructions JSONB,
    updated_at TIMESTAMPTZ
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, flow
AS $$
    SELECT * FROM flow.commit_payment_attempt(
        p_attempt_public_id,
        p_deposit_address,
        p_deposit_memo,
        p_deposit_deadline,
        p_deposit_instructions,
        NULL::numeric
    );
$$;

-- 2. flow.record_payment_verification (with on-chain timestamp extraction and decoupled deadline check)
DROP FUNCTION IF EXISTS flow.record_payment_verification(text, text, text, text, text, text, text, text, numeric, bigint, text, text, text, text, jsonb, integer);
DROP FUNCTION IF EXISTS flow.record_payment_verification(text, text, text, text, text, text, text, text, numeric, bigint, text, text, text, text, jsonb);

CREATE OR REPLACE FUNCTION flow.record_payment_verification(
    p_attempt_public_id text,
    p_verification_type text,
    p_network text,
    p_tx_hash text,
    p_from_address text,
    p_to_address text,
    p_asset_id text,
    p_token_contract text,
    p_atomic_amount numeric,
    p_block_height bigint,
    p_block_hash text,
    p_finality text,
    p_memo text,
    p_evidence_source text,
    p_raw_evidence jsonb,
    p_event_index integer
)
RETURNS TABLE (
    verification_id UUID,
    payment_attempt_id UUID,
    verification_type VARCHAR(32),
    status VARCHAR(32),
    is_late_deposit BOOLEAN
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, flow
AS $$
DECLARE
    v_attempt RECORD;
    v_request RECORD;
    v_verification_id UUID;
    v_is_late BOOLEAN := false;
    v_new_status VARCHAR(32);
    v_recipient_owns_address BOOLEAN := false;
    v_norm_net TEXT;
    v_tx_timestamp TIMESTAMPTZ := CURRENT_TIMESTAMP;
BEGIN
    -- Finality constraint
    IF p_finality NOT IN ('PENDING', 'CONFIRMED', 'FINALIZED') THEN
        RAISE EXCEPTION 'INVALID_FINALITY_STATE: %', p_finality USING ERRCODE = 'data_exception';
    END IF;

    -- Evidence source constraint
    IF p_evidence_source NOT IN ('CHAIN_RPC_DIRECT', '1CLICK_STATUS_API', 'FIXTURE_EVIDENCE') THEN
        RAISE EXCEPTION 'INVALID_EVIDENCE_SOURCE: %', p_evidence_source USING ERRCODE = 'data_exception';
    END IF;

    -- Finalized records require block hash and non-negative block height
    IF p_finality = 'FINALIZED' THEN
        IF p_block_hash IS NULL OR length(trim(p_block_hash)) < 3 THEN
            RAISE EXCEPTION 'FINALIZED_RECORD_REQUIRES_BLOCK_HASH' USING ERRCODE = 'data_exception';
        END IF;
    END IF;

    -- Network transaction hash format validation
    v_norm_net := lower(trim(p_network));
    IF p_evidence_source = 'CHAIN_RPC_DIRECT' AND (
        (NOT (current_database() LIKE '%test%') AND current_setting('flow.environment', true) <> 'test')
        OR current_setting('flow.enforce_strict_hash_validation', true) = 'true'
    ) THEN
        IF v_norm_net LIKE '%base%' OR v_norm_net LIKE '%eth%' OR v_norm_net LIKE '%eip155%' THEN
            IF p_tx_hash !~* '^0x[0-9a-fA-F]{64}$' THEN
                RAISE EXCEPTION 'INVALID_TRANSACTION_HASH_FORMAT: % for EVM network %', p_tx_hash, p_network USING ERRCODE = 'data_exception';
            END IF;
        ELSIF v_norm_net LIKE '%solana%' THEN
            IF length(p_tx_hash) < 64 OR length(p_tx_hash) > 88 OR p_tx_hash !~ '^[1-9A-HJ-NP-Za-km-z]+$' THEN
                RAISE EXCEPTION 'INVALID_TRANSACTION_HASH_FORMAT: % for Solana network %', p_tx_hash, p_network USING ERRCODE = 'data_exception';
            END IF;
        ELSIF v_norm_net LIKE '%near%' THEN
            IF length(p_tx_hash) < 32 OR length(p_tx_hash) > 64 OR p_tx_hash !~ '^[1-9A-HJ-NP-Za-km-z]+$' THEN
                RAISE EXCEPTION 'INVALID_TRANSACTION_HASH_FORMAT: % for NEAR network %', p_tx_hash, p_network USING ERRCODE = 'data_exception';
            END IF;
        END IF;
    ELSE
        IF p_tx_hash IS NULL OR length(trim(p_tx_hash)) < 3 THEN
            RAISE EXCEPTION 'INVALID_TRANSACTION_HASH_FORMAT: empty or too short' USING ERRCODE = 'data_exception';
        END IF;
    END IF;

    -- Extract authentic on-chain transaction timestamp from raw evidence where available
    IF p_raw_evidence IS NOT NULL THEN
        IF p_raw_evidence ? 'blockTime' AND (p_raw_evidence->>'blockTime') ~ '^[0-9]+(\.[0-9]+)?$' THEN
            v_tx_timestamp := to_timestamp((p_raw_evidence->>'blockTime')::double precision);
        ELSIF p_raw_evidence ? 'timestamp' THEN
            IF (p_raw_evidence->>'timestamp') ~ '^[0-9]+(\.[0-9]+)?$' THEN
                v_tx_timestamp := to_timestamp((p_raw_evidence->>'timestamp')::double precision);
            ELSE
                BEGIN
                    v_tx_timestamp := (p_raw_evidence->>'timestamp')::timestamptz;
                EXCEPTION WHEN OTHERS THEN
                    v_tx_timestamp := CURRENT_TIMESTAMP;
                END;
            END IF;
        ELSIF p_raw_evidence ? 'block_time' AND (p_raw_evidence->>'block_time') ~ '^[0-9]+(\.[0-9]+)?$' THEN
            v_tx_timestamp := to_timestamp((p_raw_evidence->>'block_time')::double precision);
        ELSIF (p_raw_evidence->'tx') IS NOT NULL AND (p_raw_evidence->'tx' ? 'timestamp') THEN
            BEGIN
                v_tx_timestamp := (p_raw_evidence->'tx'->>'timestamp')::timestamptz;
            EXCEPTION WHEN OTHERS THEN
                v_tx_timestamp := CURRENT_TIMESTAMP;
            END;
        END IF;
    END IF;

    SELECT pa.* INTO v_attempt
    FROM flow.payment_attempts pa
    WHERE pa.attempt_public_id = p_attempt_public_id
    FOR UPDATE;

    IF v_attempt.id IS NULL THEN
        RAISE EXCEPTION 'PAYMENT_ATTEMPT_NOT_FOUND: %', p_attempt_public_id USING ERRCODE = 'data_exception';
    END IF;

    SELECT pr.* INTO v_request
    FROM flow.payment_requests pr
    WHERE pr.id = v_attempt.payment_request_id;

    -- Type-specific invariant validation
    IF p_verification_type = 'SOURCE_DEPOSIT' THEN
        -- Network identity
        IF p_network <> v_attempt.source_network THEN
            RAISE EXCEPTION 'NETWORK_MISMATCH: expected % got %', v_attempt.source_network, p_network USING ERRCODE = 'data_exception';
        END IF;

        -- Recipient deposit address
        IF lower(trim(p_to_address)) <> lower(trim(v_attempt.deposit_address)) THEN
            RAISE EXCEPTION 'RECIPIENT_ADDRESS_MISMATCH: expected % got %', v_attempt.deposit_address, p_to_address USING ERRCODE = 'data_exception';
        END IF;

        -- Asset identity
        IF p_asset_id <> v_attempt.source_asset_id THEN
            RAISE EXCEPTION 'ASSET_MISMATCH: expected % got %', v_attempt.source_asset_id, p_asset_id USING ERRCODE = 'data_exception';
        END IF;

        -- Atomic amount minimum satisfaction
        IF p_atomic_amount < v_attempt.quoted_source_atomic_amount THEN
            RAISE EXCEPTION 'UNDERPAID_AMOUNT: expected % got %', v_attempt.quoted_source_atomic_amount, p_atomic_amount USING ERRCODE = 'data_exception';
        END IF;

        -- Memo / Tag check where required
        IF v_attempt.deposit_memo IS NOT NULL AND length(trim(v_attempt.deposit_memo)) > 0 THEN
            IF p_memo IS NULL OR trim(p_memo) <> trim(v_attempt.deposit_memo) THEN
                RAISE EXCEPTION 'MEMO_MISMATCH: expected % got %', v_attempt.deposit_memo, p_memo USING ERRCODE = 'data_exception';
            END IF;
        END IF;

        -- Late deposit detection:
        -- 1. If attempt is already EXPIRED or FAILED: late
        -- 2. If deposit_deadline is set (committed quote): check on-chain tx timestamp against deposit_deadline
        -- 3. If deposit_deadline is NOT set (uncommitted preview quote): check quote_expires_at
        -- Note: A committed attempt clears quote_expires_at, so early dry quote expiry NEVER rejects a valid timely deposit!
        IF (v_attempt.status IN ('EXPIRED', 'FAILED'))
           OR (v_attempt.deposit_deadline IS NOT NULL AND v_tx_timestamp > v_attempt.deposit_deadline)
           OR (v_attempt.deposit_deadline IS NULL AND v_attempt.quote_expires_at IS NOT NULL AND v_tx_timestamp > v_attempt.quote_expires_at) THEN
            v_is_late := true;
        END IF;

        -- Insert verification record (protected by unique index on network, tx_hash, event_index, verification_type)
        INSERT INTO flow.payment_verifications (
            payment_attempt_id, verification_type, network, tx_hash, event_index, from_address, to_address,
            asset_id, token_contract, atomic_amount, block_height, block_hash, finality,
            memo, evidence_source, raw_evidence
        ) VALUES (
            v_attempt.id, p_verification_type, p_network, p_tx_hash, COALESCE(p_event_index, 0), p_from_address, p_to_address,
            p_asset_id, p_token_contract, p_atomic_amount, p_block_height, p_block_hash, p_finality,
            p_memo, p_evidence_source, COALESCE(p_raw_evidence, '{}'::jsonb)
        )
        RETURNING flow.payment_verifications.id INTO v_verification_id;

        IF v_is_late THEN
            -- Transition to EXCEPTION_REFUND_REQUIRED to protect customer funds
            UPDATE flow.payment_attempts
            SET
                status = 'EXCEPTION_REFUND_REQUIRED',
                exception_status = 'LATE_DEPOSIT_REFUND_REQUIRED',
                refund_atomic_amount = p_atomic_amount,
                source_tx_hash = p_tx_hash,
                settlement_error = 'Deposit received after quote deadline expired. Safe refund required.',
                updated_at = CURRENT_TIMESTAMP
            WHERE id = v_attempt.id;
            v_new_status := 'EXCEPTION_REFUND_REQUIRED';
        ELSE
            -- Normal observed/confirmed flow
            IF v_attempt.status = 'DEPOSIT_COMMITTED' AND p_finality IN ('CONFIRMED', 'FINALIZED') THEN
                UPDATE flow.payment_attempts
                SET
                    status = 'SETTLING',
                    source_tx_hash = p_tx_hash,
                    updated_at = CURRENT_TIMESTAMP
                WHERE id = v_attempt.id;
                v_new_status := 'SETTLING';
            ELSE
                UPDATE flow.payment_attempts
                SET
                    source_tx_hash = p_tx_hash,
                    updated_at = CURRENT_TIMESTAMP
                WHERE id = v_attempt.id;
                v_new_status := v_attempt.status;
            END IF;
        END IF;

    ELSIF p_verification_type = 'DESTINATION_SETTLEMENT' THEN
        -- Destination network identity (allowing base / base-mainnet)
        IF p_network <> v_request.destination_network AND p_network <> split_part(v_request.destination_network, '-', 1) THEN
            RAISE EXCEPTION 'NETWORK_MISMATCH: expected % got %', v_request.destination_network, p_network USING ERRCODE = 'data_exception';
        END IF;

        -- Asset identity
        IF p_asset_id <> v_request.destination_asset_id THEN
            RAISE EXCEPTION 'ASSET_MISMATCH: expected % got %', v_request.destination_asset_id, p_asset_id USING ERRCODE = 'data_exception';
        END IF;

        -- Destination recipient ownership check against registered wallet address
        SELECT EXISTS (
            SELECT 1
            FROM flow.wallet_addresses wa
            JOIN flow.wallets w ON w.id = wa.wallet_id
            WHERE w.account_id = v_request.account_id
              AND (wa.network = v_request.destination_network OR wa.network = split_part(v_request.destination_network, '-', 1))
              AND lower(trim(wa.address)) = lower(trim(p_to_address))
        ) INTO v_recipient_owns_address;

        IF NOT v_recipient_owns_address THEN
            RAISE EXCEPTION 'RECIPIENT_ADDRESS_MISMATCH: Destination address % is not registered to recipient account % on %',
                p_to_address, v_request.account_id, v_request.destination_network USING ERRCODE = 'data_exception';
        END IF;

        -- Destination amount satisfaction
        IF p_atomic_amount < v_attempt.quoted_destination_atomic_amount THEN
            RAISE EXCEPTION 'DESTINATION_AMOUNT_SHORTFALL: expected % got %', v_attempt.quoted_destination_atomic_amount, p_atomic_amount USING ERRCODE = 'data_exception';
        END IF;

        -- Insert verification record
        INSERT INTO flow.payment_verifications (
            payment_attempt_id, verification_type, network, tx_hash, event_index, from_address, to_address,
            asset_id, token_contract, atomic_amount, block_height, block_hash, finality,
            memo, evidence_source, raw_evidence
        ) VALUES (
            v_attempt.id, p_verification_type, p_network, p_tx_hash, COALESCE(p_event_index, 0), p_from_address, p_to_address,
            p_asset_id, p_token_contract, p_atomic_amount, p_block_height, p_block_hash, p_finality,
            p_memo, p_evidence_source, COALESCE(p_raw_evidence, '{}'::jsonb)
        )
        RETURNING flow.payment_verifications.id INTO v_verification_id;

        UPDATE flow.payment_attempts
        SET
            destination_tx_hash = p_tx_hash,
            updated_at = CURRENT_TIMESTAMP
        WHERE id = v_attempt.id;
        v_new_status := v_attempt.status;

    ELSIF p_verification_type = '1CLICK_EXECUTION' THEN
        -- Provider status observation
        INSERT INTO flow.payment_verifications (
            payment_attempt_id, verification_type, network, tx_hash, event_index, from_address, to_address,
            asset_id, token_contract, atomic_amount, block_height, block_hash, finality,
            memo, evidence_source, raw_evidence
        ) VALUES (
            v_attempt.id, p_verification_type, p_network, p_tx_hash, COALESCE(p_event_index, 0), p_from_address, p_to_address,
            p_asset_id, p_token_contract, p_atomic_amount, p_block_height, p_block_hash, p_finality,
            p_memo, p_evidence_source, COALESCE(p_raw_evidence, '{}'::jsonb)
        )
        RETURNING flow.payment_verifications.id INTO v_verification_id;

        v_new_status := v_attempt.status;
    ELSE
        RAISE EXCEPTION 'INVALID_VERIFICATION_TYPE: %', p_verification_type USING ERRCODE = 'data_exception';
    END IF;

    RETURN QUERY
    SELECT
        v_verification_id,
        v_attempt.id,
        p_verification_type::varchar(32),
        v_new_status::varchar(32),
        v_is_late;
END;
$$;

-- Overload for 15 arguments
CREATE OR REPLACE FUNCTION flow.record_payment_verification(
    p_attempt_public_id text,
    p_verification_type text,
    p_network text,
    p_tx_hash text,
    p_from_address text,
    p_to_address text,
    p_asset_id text,
    p_token_contract text,
    p_atomic_amount numeric,
    p_block_height bigint,
    p_block_hash text,
    p_finality text,
    p_memo text,
    p_evidence_source text,
    p_raw_evidence jsonb
)
RETURNS TABLE (
    verification_id UUID,
    payment_attempt_id UUID,
    verification_type VARCHAR(32),
    status VARCHAR(32),
    is_late_deposit BOOLEAN
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, flow
AS $$
BEGIN
    RETURN QUERY
    SELECT * FROM flow.record_payment_verification(
        p_attempt_public_id, p_verification_type, p_network, p_tx_hash,
        p_from_address, p_to_address, p_asset_id, p_token_contract,
        p_atomic_amount, p_block_height, p_block_hash, p_finality,
        p_memo, p_evidence_source, p_raw_evidence, 0
    );
END;
$$;

-- 3. Grants
REVOKE EXECUTE ON FUNCTION flow.commit_payment_attempt(text, text, text, timestamptz, jsonb, numeric) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION flow.commit_payment_attempt(text, text, text, timestamptz, jsonb) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION flow.record_payment_verification(text, text, text, text, text, text, text, text, numeric, bigint, text, text, text, text, jsonb, integer) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION flow.record_payment_verification(text, text, text, text, text, text, text, text, numeric, bigint, text, text, text, text, jsonb) FROM PUBLIC;

DO $$
DECLARE
    app_role text := current_database() || '_app';
    worker_role text := current_database() || '_worker';
BEGIN
    EXECUTE format('GRANT EXECUTE ON FUNCTION flow.commit_payment_attempt(text, text, text, timestamptz, jsonb, numeric) TO %I', app_role);
    EXECUTE format('GRANT EXECUTE ON FUNCTION flow.commit_payment_attempt(text, text, text, timestamptz, jsonb, numeric) TO %I', worker_role);
    EXECUTE format('GRANT EXECUTE ON FUNCTION flow.commit_payment_attempt(text, text, text, timestamptz, jsonb) TO %I', app_role);
    EXECUTE format('GRANT EXECUTE ON FUNCTION flow.commit_payment_attempt(text, text, text, timestamptz, jsonb) TO %I', worker_role);

    EXECUTE format('GRANT EXECUTE ON FUNCTION flow.record_payment_verification(text, text, text, text, text, text, text, text, numeric, bigint, text, text, text, text, jsonb, integer) TO %I', worker_role);
    EXECUTE format('GRANT EXECUTE ON FUNCTION flow.record_payment_verification(text, text, text, text, text, text, text, text, numeric, bigint, text, text, text, text, jsonb) TO %I', worker_role);
END;
$$;

COMMIT;

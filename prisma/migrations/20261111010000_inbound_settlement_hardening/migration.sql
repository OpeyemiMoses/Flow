-- Migration: 20261111010000_inbound_settlement_hardening
-- Settlement hardening: idempotent duplicate notification handling & commit reconciliation support
BEGIN;

-- 1. Update check constraint on flow.payment_attempts to support RECONCILIATION_REQUIRED
ALTER TABLE flow.payment_attempts DROP CONSTRAINT IF EXISTS chk_payment_attempts_status;
ALTER TABLE flow.payment_attempts
    ADD CONSTRAINT chk_payment_attempts_status CHECK (
        status IN (
            'QUOTE_OBSERVED',
            'QUOTE_EXPIRED',
            'QUOTE_CANCELLED',
            'DEPOSIT_COMMITTED',
            'SETTLING',
            'SETTLED',
            'FAILED',
            'EXPIRED',
            'EXCEPTION_REFUND_REQUIRED',
            'RECONCILIATION_REQUIRED'
        )
    );

-- 2. Stored Procedure: record_payment_verification with idempotent ON CONFLICT handling
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
#variable_conflict use_column
DECLARE
    v_attempt RECORD;
    v_request RECORD;
    v_verification_id UUID;
    v_is_late BOOLEAN := false;
    v_new_status VARCHAR(32);
    v_recipient_owns_address BOOLEAN := false;
BEGIN
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

        -- Late deposit detection after quote or deadline expiration or in EXPIRED/FAILED state
        IF (v_attempt.status IN ('EXPIRED', 'FAILED'))
           OR (v_attempt.deposit_deadline IS NOT NULL AND CURRENT_TIMESTAMP > v_attempt.deposit_deadline)
           OR (v_attempt.quote_expires_at IS NOT NULL AND CURRENT_TIMESTAMP > v_attempt.quote_expires_at) THEN
            v_is_late := true;
        END IF;

        -- Insert verification record with idempotent ON CONFLICT update
        INSERT INTO flow.payment_verifications AS pv (
            payment_attempt_id, verification_type, network, tx_hash, event_index, from_address, to_address,
            asset_id, token_contract, atomic_amount, block_height, block_hash, finality,
            memo, evidence_source, raw_evidence
        ) VALUES (
            v_attempt.id, p_verification_type, p_network, p_tx_hash, COALESCE(p_event_index, 0), p_from_address, p_to_address,
            p_asset_id, p_token_contract, p_atomic_amount, p_block_height, p_block_hash, p_finality,
            p_memo, p_evidence_source, COALESCE(p_raw_evidence, '{}'::jsonb)
        )
        ON CONFLICT (network, tx_hash, event_index, verification_type)
        DO UPDATE SET
            finality = EXCLUDED.finality,
            block_height = COALESCE(EXCLUDED.block_height, pv.block_height),
            block_hash = COALESCE(EXCLUDED.block_hash, pv.block_hash),
            raw_evidence = pv.raw_evidence || EXCLUDED.raw_evidence
        RETURNING pv.id INTO v_verification_id;

        IF v_is_late THEN
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
        -- Destination network identity
        IF p_network <> v_request.destination_network THEN
            RAISE EXCEPTION 'NETWORK_MISMATCH: expected % got %', v_request.destination_network, p_network USING ERRCODE = 'data_exception';
        END IF;

        -- Verify destination recipient address is authentic merchant address
        SELECT EXISTS (
            SELECT 1 FROM flow.wallet_addresses wa
            JOIN flow.wallets w ON w.id = wa.wallet_id
            WHERE w.account_id = v_request.account_id
              AND wa.network = v_request.destination_network
              AND lower(trim(wa.address)) = lower(trim(p_to_address))
        ) INTO v_recipient_owns_address;

        IF NOT v_recipient_owns_address THEN
            RAISE EXCEPTION 'RECIPIENT_ADDRESS_MISMATCH: % is not a registered wallet address for account % on network %',
                p_to_address, v_request.account_id, v_request.destination_network USING ERRCODE = 'data_exception';
        END IF;

        -- Asset identity
        IF p_asset_id <> v_request.destination_asset_id THEN
            RAISE EXCEPTION 'ASSET_MISMATCH: expected % got %', v_request.destination_asset_id, p_asset_id USING ERRCODE = 'data_exception';
        END IF;

        -- Destination amount satisfaction
        IF p_atomic_amount < v_attempt.quoted_destination_atomic_amount THEN
            RAISE EXCEPTION 'DESTINATION_AMOUNT_SHORTFALL: expected % got %', v_attempt.quoted_destination_atomic_amount, p_atomic_amount USING ERRCODE = 'data_exception';
        END IF;

        -- Insert verification record with idempotent ON CONFLICT update
        INSERT INTO flow.payment_verifications AS pv (
            payment_attempt_id, verification_type, network, tx_hash, event_index, from_address, to_address,
            asset_id, token_contract, atomic_amount, block_height, block_hash, finality,
            memo, evidence_source, raw_evidence
        ) VALUES (
            v_attempt.id, p_verification_type, p_network, p_tx_hash, COALESCE(p_event_index, 0), p_from_address, p_to_address,
            p_asset_id, p_token_contract, p_atomic_amount, p_block_height, p_block_hash, p_finality,
            p_memo, p_evidence_source, COALESCE(p_raw_evidence, '{}'::jsonb)
        )
        ON CONFLICT (network, tx_hash, event_index, verification_type)
        DO UPDATE SET
            finality = EXCLUDED.finality,
            block_height = COALESCE(EXCLUDED.block_height, pv.block_height),
            block_hash = COALESCE(EXCLUDED.block_hash, pv.block_hash),
            raw_evidence = pv.raw_evidence || EXCLUDED.raw_evidence
        RETURNING pv.id INTO v_verification_id;

        UPDATE flow.payment_attempts
        SET
            destination_tx_hash = p_tx_hash,
            updated_at = CURRENT_TIMESTAMP
        WHERE id = v_attempt.id;
        v_new_status := v_attempt.status;

    ELSIF p_verification_type = '1CLICK_EXECUTION' THEN
        -- Provider status observation with idempotent ON CONFLICT update
        INSERT INTO flow.payment_verifications AS pv (
            payment_attempt_id, verification_type, network, tx_hash, event_index, from_address, to_address,
            asset_id, token_contract, atomic_amount, block_height, block_hash, finality,
            memo, evidence_source, raw_evidence
        ) VALUES (
            v_attempt.id, p_verification_type, p_network, p_tx_hash, COALESCE(p_event_index, 0), p_from_address, p_to_address,
            p_asset_id, p_token_contract, p_atomic_amount, p_block_height, p_block_hash, p_finality,
            p_memo, p_evidence_source, COALESCE(p_raw_evidence, '{}'::jsonb)
        )
        ON CONFLICT (network, tx_hash, event_index, verification_type)
        DO UPDATE SET
            finality = EXCLUDED.finality,
            block_height = COALESCE(EXCLUDED.block_height, pv.block_height),
            block_hash = COALESCE(EXCLUDED.block_hash, pv.block_hash),
            raw_evidence = pv.raw_evidence || EXCLUDED.raw_evidence
        RETURNING pv.id INTO v_verification_id;

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

-- 3. Overload for 15 arguments
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

-- 4. Role grants for worker role
DO $$
DECLARE
    db_name text := current_database();
    worker_role text := db_name || '_worker';
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = worker_role) THEN
        EXECUTE format('GRANT EXECUTE ON FUNCTION flow.record_payment_verification(text, text, text, text, text, text, text, text, numeric, bigint, text, text, text, text, jsonb, integer) TO %I', worker_role);
        EXECUTE format('GRANT EXECUTE ON FUNCTION flow.record_payment_verification(text, text, text, text, text, text, text, text, numeric, bigint, text, text, text, text, jsonb) TO %I', worker_role);
    END IF;
END;
$$;

COMMIT;

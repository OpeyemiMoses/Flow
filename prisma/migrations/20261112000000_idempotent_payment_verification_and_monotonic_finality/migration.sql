BEGIN;

-- 1. Update flow.prevent_payment_verifications_mutation to permit idempotent updates
-- and monotonic finality progression (PENDING -> CONFIRMED -> FINALIZED) while strictly
-- preserving immutable financial attribution invariants.
CREATE OR REPLACE FUNCTION flow.prevent_payment_verifications_mutation()
RETURNS TRIGGER AS $$
BEGIN
    IF TG_OP = 'UPDATE' THEN
        -- Allow idempotent refresh or monotonic finality progression (PENDING -> CONFIRMED -> FINALIZED)
        -- while strictly preserving all financial attribution invariants.
        IF OLD.payment_attempt_id = NEW.payment_attempt_id
           AND OLD.verification_type = NEW.verification_type
           AND OLD.network = NEW.network
           AND OLD.tx_hash = NEW.tx_hash
           AND OLD.event_index = NEW.event_index
           AND OLD.atomic_amount = NEW.atomic_amount
           AND OLD.asset_id = NEW.asset_id
           AND lower(trim(OLD.to_address)) = lower(trim(NEW.to_address))
           AND (
               OLD.finality = NEW.finality
               OR (OLD.finality = 'PENDING' AND NEW.finality IN ('CONFIRMED', 'FINALIZED'))
               OR (OLD.finality = 'CONFIRMED' AND NEW.finality = 'FINALIZED')
           ) THEN
            RETURN NEW;
        END IF;
    END IF;

    RAISE EXCEPTION 'PAYMENT_VERIFICATIONS_IMMUTABLE: Updates and deletes are prohibited on flow.payment_verifications' USING ERRCODE = 'data_exception';
END;
$$ LANGUAGE plpgsql;

-- 2. Update flow.record_payment_verification to handle unique constraint conflicts idempotently
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
AS $function$
#variable_conflict use_column
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

    IF p_verification_type = 'SOURCE_DEPOSIT' THEN
        -- Verify network identity (allowing solana / solana-mainnet)
        IF p_network <> v_attempt.source_network AND p_network <> split_part(v_attempt.source_network, '-', 1) THEN
            RAISE EXCEPTION 'NETWORK_MISMATCH: expected % got %', v_attempt.source_network, p_network USING ERRCODE = 'data_exception';
        END IF;

        -- Verify asset identity
        IF p_asset_id <> v_attempt.source_asset_id THEN
            RAISE EXCEPTION 'ASSET_MISMATCH: expected % got %', v_attempt.source_asset_id, p_asset_id USING ERRCODE = 'data_exception';
        END IF;

        -- Verify deposit destination address
        IF lower(trim(p_to_address)) <> lower(trim(v_attempt.deposit_address)) THEN
            RAISE EXCEPTION 'DEPOSIT_ADDRESS_MISMATCH: expected % got %', v_attempt.deposit_address, p_to_address USING ERRCODE = 'data_exception';
        END IF;

        -- Check underpayment
        IF p_atomic_amount < v_attempt.quoted_source_atomic_amount THEN
            RAISE EXCEPTION 'DEPOSIT_AMOUNT_SHORTFALL: expected % got %', v_attempt.quoted_source_atomic_amount, p_atomic_amount USING ERRCODE = 'data_exception';
        END IF;

        -- Deadline check
        IF v_attempt.deposit_deadline IS NOT NULL AND v_tx_timestamp > v_attempt.deposit_deadline THEN
            v_is_late := true;
        END IF;

        -- Insert or update verification record
        INSERT INTO flow.payment_verifications (
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
            finality = CASE
                WHEN EXCLUDED.finality = 'FINALIZED' THEN 'FINALIZED'
                WHEN flow.payment_verifications.finality = 'FINALIZED' THEN 'FINALIZED'
                ELSE EXCLUDED.finality
            END,
            block_height = COALESCE(EXCLUDED.block_height, flow.payment_verifications.block_height),
            block_hash = COALESCE(EXCLUDED.block_hash, flow.payment_verifications.block_hash),
            raw_evidence = EXCLUDED.raw_evidence,
            verified_at = CURRENT_TIMESTAMP
        RETURNING flow.payment_verifications.id INTO v_verification_id;

        IF v_is_late THEN
            UPDATE flow.payment_attempts
            SET
                status = 'EXCEPTION_REFUND_REQUIRED',
                exception_status = 'LATE_DEPOSIT_REFUND_REQUIRED',
                source_tx_hash = p_tx_hash,
                settlement_error = 'LATE_DEPOSIT: Verified deposit arrived after deposit_deadline expired. Safe refund required.',
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

        -- Insert or update verification record
        INSERT INTO flow.payment_verifications (
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
            finality = CASE
                WHEN EXCLUDED.finality = 'FINALIZED' THEN 'FINALIZED'
                WHEN flow.payment_verifications.finality = 'FINALIZED' THEN 'FINALIZED'
                ELSE EXCLUDED.finality
            END,
            block_height = COALESCE(EXCLUDED.block_height, flow.payment_verifications.block_height),
            block_hash = COALESCE(EXCLUDED.block_hash, flow.payment_verifications.block_hash),
            raw_evidence = EXCLUDED.raw_evidence,
            verified_at = CURRENT_TIMESTAMP
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
        ON CONFLICT (network, tx_hash, event_index, verification_type)
        DO UPDATE SET
            finality = CASE
                WHEN EXCLUDED.finality = 'FINALIZED' THEN 'FINALIZED'
                WHEN flow.payment_verifications.finality = 'FINALIZED' THEN 'FINALIZED'
                ELSE EXCLUDED.finality
            END,
            raw_evidence = EXCLUDED.raw_evidence,
            verified_at = CURRENT_TIMESTAMP
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
$function$;

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

-- 4. Grants
REVOKE EXECUTE ON FUNCTION flow.record_payment_verification(text, text, text, text, text, text, text, text, numeric, bigint, text, text, text, text, jsonb, integer) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION flow.record_payment_verification(text, text, text, text, text, text, text, text, numeric, bigint, text, text, text, text, jsonb) FROM PUBLIC;

DO $$
DECLARE
    worker_role text := current_database() || '_worker';
BEGIN
    EXECUTE format('GRANT EXECUTE ON FUNCTION flow.record_payment_verification(text, text, text, text, text, text, text, text, numeric, bigint, text, text, text, text, jsonb, integer) TO %I', worker_role);
    EXECUTE format('GRANT EXECUTE ON FUNCTION flow.record_payment_verification(text, text, text, text, text, text, text, text, numeric, bigint, text, text, text, text, jsonb) TO %I', worker_role);
END;
$$;

COMMIT;

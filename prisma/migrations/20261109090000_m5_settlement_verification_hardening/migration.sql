BEGIN;

-- 1. Add event_index column for multi-transfer attribution
ALTER TABLE flow.payment_verifications ADD COLUMN IF NOT EXISTS event_index INTEGER NOT NULL DEFAULT 0;

-- 2. Update unique index to support distinct legitimate event logs on the same tx
DROP INDEX IF EXISTS flow.idx_payment_verifications_one_time_attribution;
CREATE UNIQUE INDEX IF NOT EXISTS idx_payment_verifications_one_time_attribution
ON flow.payment_verifications (network, tx_hash, event_index, verification_type);

-- 3. Append-Only Trigger on flow.payment_verifications
-- Prohibits UPDATE and DELETE operations to ensure financial verification immutability.
CREATE OR REPLACE FUNCTION flow.prevent_payment_verifications_mutation()
RETURNS TRIGGER AS $$
BEGIN
    RAISE EXCEPTION 'PAYMENT_VERIFICATIONS_IMMUTABLE: Updates and deletes are prohibited on flow.payment_verifications' USING ERRCODE = 'data_exception';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_payment_verifications_append_only ON flow.payment_verifications;
CREATE TRIGGER trg_payment_verifications_append_only
BEFORE UPDATE OR DELETE ON flow.payment_verifications
FOR EACH ROW
EXECUTE FUNCTION flow.prevent_payment_verifications_mutation();

-- 4. Revoke UPDATE and DELETE from all roles
REVOKE UPDATE, DELETE ON flow.payment_verifications FROM PUBLIC;

DO $$
DECLARE
    db_name text := current_database();
    app_role text := db_name || '_app';
    worker_role text := db_name || '_worker';
    operator_role text := db_name || '_operator';
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = app_role) THEN
        EXECUTE format('REVOKE UPDATE, DELETE ON flow.payment_verifications FROM %I', app_role);
    END IF;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = worker_role) THEN
        EXECUTE format('REVOKE UPDATE, DELETE ON flow.payment_verifications FROM %I', worker_role);
    END IF;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = operator_role) THEN
        EXECUTE format('REVOKE UPDATE, DELETE ON flow.payment_verifications FROM %I', operator_role);
    END IF;
END;
$$;

-- 5. Stored Procedure: Record Payment Verification with Recipient Wallet Ownership Check & Late Deposit Support
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
        -- Destination network identity
        IF p_network <> v_request.destination_network THEN
            RAISE EXCEPTION 'NETWORK_MISMATCH: expected % got %', v_request.destination_network, p_network USING ERRCODE = 'data_exception';
        END IF;

        -- Asset identity
        IF p_asset_id <> v_request.destination_asset_id THEN
            RAISE EXCEPTION 'ASSET_MISMATCH: expected % got %', v_request.destination_asset_id, p_asset_id USING ERRCODE = 'data_exception';
        END IF;

        -- Requirement 5: Verify destination recipient ownership against registered wallet address
        SELECT EXISTS (
            SELECT 1
            FROM flow.wallet_addresses wa
            JOIN flow.wallets w ON w.id = wa.wallet_id
            WHERE w.account_id = v_request.account_id
              AND wa.network = v_request.destination_network
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

-- 6. Stored Procedure: worker_settle_payment_attempt with Fixture Blocking
CREATE OR REPLACE FUNCTION flow.worker_settle_payment_attempt(
    p_attempt_public_id text,
    p_source_tx_hash text,
    p_destination_tx_hash text
)
RETURNS TABLE (
    id UUID,
    attempt_public_id VARCHAR(64),
    status VARCHAR(32),
    settled_at TIMESTAMPTZ,
    journal_id UUID,
    journal_public_id VARCHAR(64)
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, flow
AS $$
DECLARE
    v_attempt RECORD;
    v_request RECORD;
    v_journal_public_id VARCHAR(64);
    v_journal_id UUID;
    v_merchant_acct_id UUID;
    v_custody_acct_id UUID;
    v_clearing_pay_acct_id UUID;
    v_clearing_rec_acct_id UUID;
    v_entries jsonb;
    v_dest_atomic NUMERIC(78, 0);
    v_source_atomic NUMERIC(78, 0);
    v_source_verified BOOLEAN := false;
    v_dest_verified BOOLEAN := false;
BEGIN
    IF p_source_tx_hash IS NULL OR length(trim(p_source_tx_hash)) < 10 THEN
        RAISE EXCEPTION 'INVALID_SOURCE_TX_HASH' USING ERRCODE = 'data_exception';
    END IF;

    IF p_destination_tx_hash IS NULL OR length(trim(p_destination_tx_hash)) < 10 THEN
        RAISE EXCEPTION 'INVALID_DESTINATION_TX_HASH' USING ERRCODE = 'data_exception';
    END IF;

    SELECT * INTO v_attempt
    FROM flow.payment_attempts pa
    WHERE pa.attempt_public_id = p_attempt_public_id
    FOR UPDATE;

    IF v_attempt.id IS NULL THEN
        RAISE EXCEPTION 'PAYMENT_ATTEMPT_NOT_FOUND' USING ERRCODE = 'data_exception';
    END IF;

    -- Idempotent return if already settled
    IF v_attempt.status = 'SETTLED' THEN
        SELECT lj.id, lj.journal_public_id INTO v_journal_id, v_journal_public_id
        FROM flow.ledger_journals lj
        WHERE lj.reference_type = 'PAYMENT_SETTLEMENT' AND lj.reference_id = p_attempt_public_id
        LIMIT 1;

        RETURN QUERY
        SELECT
            v_attempt.id,
            p_attempt_public_id::varchar(64),
            'SETTLED'::varchar(32),
            v_attempt.settled_at,
            v_journal_id,
            v_journal_public_id;
        RETURN;
    END IF;

    IF v_attempt.status NOT IN ('DEPOSIT_COMMITTED', 'SETTLING') THEN
        RAISE EXCEPTION 'INVALID_STATUS_FOR_SETTLEMENT: %', v_attempt.status USING ERRCODE = 'data_exception';
    END IF;

    -- Requirement 6 & 8: Enforce Authentic, Finalized On-Chain Verification Records
    -- Block FIXTURE_EVIDENCE unless explicitly permitted by flow.allow_test_fixtures
    SELECT EXISTS (
        SELECT 1 FROM flow.payment_verifications pv
        WHERE pv.payment_attempt_id = v_attempt.id
          AND pv.verification_type = 'SOURCE_DEPOSIT'
          AND pv.tx_hash = p_source_tx_hash
          AND pv.finality = 'FINALIZED'
          AND (pv.evidence_source <> 'FIXTURE_EVIDENCE' OR current_setting('flow.allow_test_fixtures', true) = 'true')
    ) INTO v_source_verified;

    IF NOT v_source_verified THEN
        IF EXISTS (
            SELECT 1 FROM flow.payment_verifications pv
            WHERE pv.payment_attempt_id = v_attempt.id
              AND pv.verification_type = 'SOURCE_DEPOSIT'
              AND pv.tx_hash = p_source_tx_hash
              AND pv.evidence_source = 'FIXTURE_EVIDENCE'
        ) THEN
            RAISE EXCEPTION 'FIXTURE_EVIDENCE_NOT_PERMITTED: Fixture evidence cannot satisfy live settlement requirements' USING ERRCODE = 'data_exception';
        END IF;

        RAISE EXCEPTION 'UNVERIFIED_SOURCE_DEPOSIT: Finalized on-chain source deposit verification required' USING ERRCODE = 'data_exception';
    END IF;

    IF v_attempt.route_type = 'CROSS_CHAIN_1CLICK' THEN
        SELECT EXISTS (
            SELECT 1 FROM flow.payment_verifications pv
            WHERE pv.payment_attempt_id = v_attempt.id
              AND pv.verification_type = 'DESTINATION_SETTLEMENT'
              AND pv.tx_hash = p_destination_tx_hash
              AND pv.finality = 'FINALIZED'
              AND (pv.evidence_source <> 'FIXTURE_EVIDENCE' OR current_setting('flow.allow_test_fixtures', true) = 'true')
        ) INTO v_dest_verified;

        IF NOT v_dest_verified THEN
            IF EXISTS (
                SELECT 1 FROM flow.payment_verifications pv
                WHERE pv.payment_attempt_id = v_attempt.id
                  AND pv.verification_type = 'DESTINATION_SETTLEMENT'
                  AND pv.tx_hash = p_destination_tx_hash
                  AND pv.evidence_source = 'FIXTURE_EVIDENCE'
            ) THEN
                RAISE EXCEPTION 'FIXTURE_EVIDENCE_NOT_PERMITTED: Fixture evidence cannot satisfy live settlement requirements' USING ERRCODE = 'data_exception';
            END IF;

            RAISE EXCEPTION 'UNVERIFIED_DESTINATION_DELIVERY: Finalized on-chain destination delivery verification required' USING ERRCODE = 'data_exception';
        END IF;
    END IF;

    SELECT * INTO v_request
    FROM flow.payment_requests pr
    WHERE pr.id = v_attempt.payment_request_id;

    v_dest_atomic := v_attempt.quoted_destination_atomic_amount;
    IF v_dest_atomic IS NULL OR v_dest_atomic <= 0 THEN
        RAISE EXCEPTION 'INVALID_DESTINATION_AMOUNT' USING ERRCODE = 'data_exception';
    END IF;

    v_source_atomic := v_attempt.quoted_source_atomic_amount;
    IF v_source_atomic IS NULL OR v_source_atomic <= 0 THEN
        v_source_atomic := v_dest_atomic;
    END IF;

    -- Multi-Currency Double-Entry Ledger Posting
    -- Merchant Liability Account (Destination Asset)
    INSERT INTO flow.ledger_accounts (
        account_id, account_type, account_code, asset_id, network, decimals, balance_atomic
    ) VALUES (
        v_request.account_id, 'LIABILITY', 'LIABILITY_MERCHANT_PAYABLE',
        v_request.destination_asset_id, v_request.destination_network, v_request.destination_decimals, 0
    )
    ON CONFLICT (COALESCE(account_id, '00000000-0000-0000-0000-000000000000'::uuid), account_code, asset_id, network)
    DO UPDATE SET updated_at = CURRENT_TIMESTAMP
    RETURNING flow.ledger_accounts.id INTO v_merchant_acct_id;

    IF v_attempt.source_asset_id = v_request.destination_asset_id AND v_attempt.source_network = v_request.destination_network THEN
        -- Direct Transfer: Same currency leg
        INSERT INTO flow.ledger_accounts (
            account_id, account_type, account_code, asset_id, network, decimals, balance_atomic
        ) VALUES (
            NULL, 'ASSET', 'ASSET_CUSTODY_IN_FLIGHT',
            v_request.destination_asset_id, v_request.destination_network, v_request.destination_decimals, 0
        )
        ON CONFLICT (COALESCE(account_id, '00000000-0000-0000-0000-000000000000'::uuid), account_code, asset_id, network)
        DO UPDATE SET updated_at = CURRENT_TIMESTAMP
        RETURNING flow.ledger_accounts.id INTO v_custody_acct_id;

        v_entries := jsonb_build_array(
            jsonb_build_object(
                'ledger_account_id', v_custody_acct_id,
                'entry_direction', 'DEBIT',
                'amount_atomic', v_dest_atomic::text
            ),
            jsonb_build_object(
                'ledger_account_id', v_merchant_acct_id,
                'entry_direction', 'CREDIT',
                'amount_atomic', v_dest_atomic::text
            )
        );
    ELSE
        -- Cross-Chain Conversion: Multi-Currency Accounting
        -- Leg 1: Source Currency Leg (Source Asset & Network)
        INSERT INTO flow.ledger_accounts (
            account_id, account_type, account_code, asset_id, network, decimals, balance_atomic
        ) VALUES (
            NULL, 'ASSET', 'ASSET_CUSTODY_IN_FLIGHT',
            v_attempt.source_asset_id, v_attempt.source_network, v_attempt.source_decimals, 0
        )
        ON CONFLICT (COALESCE(account_id, '00000000-0000-0000-0000-000000000000'::uuid), account_code, asset_id, network)
        DO UPDATE SET updated_at = CURRENT_TIMESTAMP
        RETURNING flow.ledger_accounts.id INTO v_custody_acct_id;

        INSERT INTO flow.ledger_accounts (
            account_id, account_type, account_code, asset_id, network, decimals, balance_atomic
        ) VALUES (
            NULL, 'LIABILITY', 'CLEARING_CROSS_CHAIN_PAYABLE',
            v_attempt.source_asset_id, v_attempt.source_network, v_attempt.source_decimals, 0
        )
        ON CONFLICT (COALESCE(account_id, '00000000-0000-0000-0000-000000000000'::uuid), account_code, asset_id, network)
        DO UPDATE SET updated_at = CURRENT_TIMESTAMP
        RETURNING flow.ledger_accounts.id INTO v_clearing_pay_acct_id;

        -- Leg 2: Destination Currency Leg (Destination Asset & Network)
        INSERT INTO flow.ledger_accounts (
            account_id, account_type, account_code, asset_id, network, decimals, balance_atomic
        ) VALUES (
            NULL, 'ASSET', 'CLEARING_CROSS_CHAIN_RECEIVABLE',
            v_request.destination_asset_id, v_request.destination_network, v_request.destination_decimals, 0
        )
        ON CONFLICT (COALESCE(account_id, '00000000-0000-0000-0000-000000000000'::uuid), account_code, asset_id, network)
        DO UPDATE SET updated_at = CURRENT_TIMESTAMP
        RETURNING flow.ledger_accounts.id INTO v_clearing_rec_acct_id;

        v_entries := jsonb_build_array(
            -- Leg 1: Balanced in Source Currency
            jsonb_build_object(
                'ledger_account_id', v_custody_acct_id,
                'entry_direction', 'DEBIT',
                'amount_atomic', v_source_atomic::text
            ),
            jsonb_build_object(
                'ledger_account_id', v_clearing_pay_acct_id,
                'entry_direction', 'CREDIT',
                'amount_atomic', v_source_atomic::text
            ),
            -- Leg 2: Balanced in Destination Currency
            jsonb_build_object(
                'ledger_account_id', v_clearing_rec_acct_id,
                'entry_direction', 'DEBIT',
                'amount_atomic', v_dest_atomic::text
            ),
            jsonb_build_object(
                'ledger_account_id', v_merchant_acct_id,
                'entry_direction', 'CREDIT',
                'amount_atomic', v_dest_atomic::text
            )
        );
    END IF;

    v_journal_public_id := 'lj_' || replace(gen_random_uuid()::text, '-', '');

    -- Post balanced journal
    SELECT pj.journal_id INTO v_journal_id
    FROM flow.post_balanced_ledger_journal(
        v_journal_public_id,
        'PAYMENT_SETTLEMENT',
        p_attempt_public_id,
        'Settlement for payment attempt ' || p_attempt_public_id || ' to account ' || v_request.account_id::text,
        v_entries
    ) pj;

    -- Update attempt row to SETTLED
    UPDATE flow.payment_attempts pa
    SET
        status = 'SETTLED',
        is_provider_verified = true,
        verification_tier = 'PROVIDER_VERIFIED',
        settled_at = CURRENT_TIMESTAMP,
        source_tx_hash = p_source_tx_hash,
        destination_tx_hash = p_destination_tx_hash,
        updated_at = CURRENT_TIMESTAMP
    WHERE pa.id = v_attempt.id;

    -- If this completed the invoice, mark payment request COMPLETED
    IF v_request.status = 'ACTIVE' THEN
        UPDATE flow.payment_requests pr
        SET
            status = 'COMPLETED',
            updated_at = CURRENT_TIMESTAMP
        WHERE pr.id = v_request.id;
    END IF;

    RETURN QUERY
    SELECT
        v_attempt.id,
        p_attempt_public_id::varchar(64),
        'SETTLED'::varchar(32),
        CURRENT_TIMESTAMP,
        v_journal_id,
        v_journal_public_id;
END;
$$;

-- 7. Stored Procedure: Acquire Payment Monitoring Lease including recently expired attempts for late deposit tracking
CREATE OR REPLACE FUNCTION flow.acquire_payment_monitoring_lease(
    p_worker_id text,
    p_lease_duration_seconds integer,
    p_batch_size integer
)
RETURNS TABLE (
    id UUID,
    attempt_public_id VARCHAR(64),
    status VARCHAR(32),
    source_network VARCHAR(64),
    source_asset_id VARCHAR(128),
    deposit_address VARCHAR(256),
    deposit_memo VARCHAR(128),
    deposit_deadline TIMESTAMPTZ,
    quoted_source_atomic_amount NUMERIC(78, 0),
    quoted_destination_atomic_amount NUMERIC(78, 0),
    destination_network VARCHAR(64),
    destination_asset_id VARCHAR(128),
    provider_correlation_id VARCHAR(128),
    route_type VARCHAR(32)
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, flow
AS $$
BEGIN
    RETURN QUERY
    WITH candidate_attempts AS (
        SELECT pa.id
        FROM flow.payment_attempts pa
        WHERE (
            pa.status IN ('DEPOSIT_COMMITTED', 'SETTLING')
            OR (
                pa.status IN ('EXPIRED', 'FAILED')
                AND pa.created_at > CURRENT_TIMESTAMP - INTERVAL '24 hours'
                AND NOT EXISTS (
                    SELECT 1 FROM flow.payment_verifications pv
                    WHERE pv.payment_attempt_id = pa.id
                      AND pv.verification_type = 'SOURCE_DEPOSIT'
                )
            )
        )
          AND (pa.monitoring_lease_expires_at IS NULL OR pa.monitoring_lease_expires_at < CURRENT_TIMESTAMP)
        ORDER BY pa.last_polled_at ASC NULLS FIRST, pa.created_at ASC
        LIMIT p_batch_size
        FOR UPDATE SKIP LOCKED
    )
    UPDATE flow.payment_attempts
    SET
        monitoring_lease_worker_id = p_worker_id,
        monitoring_lease_expires_at = CURRENT_TIMESTAMP + (p_lease_duration_seconds || ' seconds')::interval,
        last_polled_at = CURRENT_TIMESTAMP,
        poll_count = payment_attempts.poll_count + 1,
        updated_at = CURRENT_TIMESTAMP
    FROM candidate_attempts ca,
         flow.payment_requests pr
    WHERE payment_attempts.id = ca.id
      AND pr.id = payment_attempts.payment_request_id
    RETURNING
        payment_attempts.id,
        payment_attempts.attempt_public_id,
        payment_attempts.status,
        payment_attempts.source_network,
        payment_attempts.source_asset_id,
        payment_attempts.deposit_address,
        payment_attempts.deposit_memo,
        payment_attempts.deposit_deadline,
        payment_attempts.quoted_source_atomic_amount,
        payment_attempts.quoted_destination_atomic_amount,
        pr.destination_network,
        pr.destination_asset_id,
        payment_attempts.provider_correlation_id,
        payment_attempts.route_type;
END;
$$;

-- 8. Permissions for worker role
DO $$
DECLARE
    db_name text := current_database();
    worker_role text := db_name || '_worker';
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = worker_role) THEN
        EXECUTE format('GRANT EXECUTE ON FUNCTION flow.record_payment_verification(text, text, text, text, text, text, text, text, numeric, bigint, text, text, text, text, jsonb, integer) TO %I', worker_role);
        EXECUTE format('GRANT EXECUTE ON FUNCTION flow.record_payment_verification(text, text, text, text, text, text, text, text, numeric, bigint, text, text, text, text, jsonb) TO %I', worker_role);
        EXECUTE format('GRANT EXECUTE ON FUNCTION flow.worker_settle_payment_attempt(text, text, text) TO %I', worker_role);
        EXECUTE format('GRANT EXECUTE ON FUNCTION flow.acquire_payment_monitoring_lease(text, integer, integer) TO %I', worker_role);
    END IF;
END;
$$;

COMMIT;

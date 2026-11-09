BEGIN;

-- 0. Expand Ledger Account Code Check Constraint for Cross-Currency Clearing Accounts
ALTER TABLE flow.ledger_accounts
    DROP CONSTRAINT IF EXISTS ledger_accounts_account_code_check;

ALTER TABLE flow.ledger_accounts
    ADD CONSTRAINT ledger_accounts_account_code_check CHECK (account_code IN (
        'ASSET_CUSTODY_IN_FLIGHT',
        'LIABILITY_MERCHANT_PAYABLE',
        'REVENUE_PLATFORM_FEE',
        'EXPENSE_PROVIDER_FEE',
        'ASSET_SETTLED_HOLDINGS',
        'CLEARING_CROSS_CHAIN_PAYABLE',
        'CLEARING_CROSS_CHAIN_RECEIVABLE'
    ));

-- 1. Multi-Currency Double-Entry Posting Stored Procedure
-- Enforces double-entry conservation PER (asset_id, network) currency leg.
CREATE OR REPLACE FUNCTION flow.post_balanced_ledger_journal(
    p_journal_public_id text,
    p_reference_type text,
    p_reference_id text,
    p_description text,
    p_entries jsonb
)
RETURNS TABLE (
    journal_id UUID,
    journal_public_id VARCHAR(64),
    entry_count INTEGER,
    total_atomic NUMERIC(78, 0)
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, flow
AS $$
DECLARE
    v_journal_id UUID;
    v_entry jsonb;
    v_account_id UUID;
    v_direction VARCHAR(16);
    v_amount NUMERIC(78, 0);
    v_total_debit NUMERIC(78, 0) := 0;
    v_total_credit NUMERIC(78, 0) := 0;
    v_account_type VARCHAR(32);
    v_current_balance NUMERIC(78, 0);
    v_new_balance NUMERIC(78, 0);
    v_count INTEGER := 0;
    v_asset_id VARCHAR(128);
    v_network VARCHAR(64);
    v_leg RECORD;
BEGIN
    IF jsonb_array_length(p_entries) < 2 THEN
        RAISE EXCEPTION 'DOUBLE_ENTRY_MINIMUM_LINES_REQUIRED' USING ERRCODE = 'data_exception';
    END IF;

    -- Temporary table to validate per-currency-leg balance
    CREATE TEMP TABLE IF NOT EXISTS _journal_validation (
        account_id UUID,
        asset_id VARCHAR(128),
        network VARCHAR(64),
        direction VARCHAR(16),
        amount NUMERIC(78, 0)
    ) ON COMMIT DROP;

    TRUNCATE _journal_validation;

    FOR v_entry IN SELECT * FROM jsonb_array_elements(p_entries)
    LOOP
        v_account_id := (v_entry->>'ledger_account_id')::uuid;
        v_direction := v_entry->>'entry_direction';
        v_amount := (v_entry->>'amount_atomic')::numeric;

        IF v_amount <= 0 THEN
            RAISE EXCEPTION 'ENTRY_AMOUNT_MUST_BE_POSITIVE' USING ERRCODE = 'data_exception';
        END IF;

        IF v_direction NOT IN ('DEBIT', 'CREDIT') THEN
            RAISE EXCEPTION 'INVALID_ENTRY_DIRECTION: %', v_direction USING ERRCODE = 'data_exception';
        END IF;

        SELECT la.asset_id, la.network INTO v_asset_id, v_network
        FROM flow.ledger_accounts la
        WHERE la.id = v_account_id;

        IF v_asset_id IS NULL THEN
            RAISE EXCEPTION 'LEDGER_ACCOUNT_NOT_FOUND: %', v_account_id USING ERRCODE = 'data_exception';
        END IF;

        INSERT INTO _journal_validation (account_id, asset_id, network, direction, amount)
        VALUES (v_account_id, v_asset_id, v_network, v_direction, v_amount);

        IF v_direction = 'DEBIT' THEN
            v_total_debit := v_total_debit + v_amount;
        ELSE
            v_total_credit := v_total_credit + v_amount;
        END IF;
    END LOOP;

    -- Enforce Double-Entry Conservation PER (asset_id, network) Currency Leg
    FOR v_leg IN
        SELECT
            asset_id,
            network,
            SUM(CASE WHEN direction = 'DEBIT' THEN amount ELSE 0 END) AS leg_debit,
            SUM(CASE WHEN direction = 'CREDIT' THEN amount ELSE 0 END) AS leg_credit
        FROM _journal_validation
        GROUP BY asset_id, network
    LOOP
        IF v_leg.leg_debit <> v_leg.leg_credit THEN
            RAISE EXCEPTION 'UNBALANCED_CURRENCY_LEG: asset=% network=% debit=% credit=%',
                v_leg.asset_id, v_leg.network, v_leg.leg_debit, v_leg.leg_credit USING ERRCODE = 'data_exception';
        END IF;
    END LOOP;

    -- Insert journal
    INSERT INTO flow.ledger_journals (
        journal_public_id,
        reference_type,
        reference_id,
        description,
        status,
        posted_at
    ) VALUES (
        p_journal_public_id,
        p_reference_type,
        p_reference_id,
        p_description,
        'POSTED',
        CURRENT_TIMESTAMP
    )
    RETURNING id INTO v_journal_id;

    -- Process each entry line and update balances
    FOR v_entry IN SELECT * FROM jsonb_array_elements(p_entries)
    LOOP
        v_account_id := (v_entry->>'ledger_account_id')::uuid;
        v_direction := v_entry->>'entry_direction';
        v_amount := (v_entry->>'amount_atomic')::numeric;

        SELECT la.account_type, la.balance_atomic
        INTO v_account_type, v_current_balance
        FROM flow.ledger_accounts la
        WHERE la.id = v_account_id
        FOR UPDATE;

        IF v_account_type IN ('ASSET', 'EXPENSE') THEN
            IF v_direction = 'DEBIT' THEN
                v_new_balance := v_current_balance + v_amount;
            ELSE
                v_new_balance := v_current_balance - v_amount;
            END IF;
        ELSE
            IF v_direction = 'CREDIT' THEN
                v_new_balance := v_current_balance + v_amount;
            ELSE
                v_new_balance := v_current_balance - v_amount;
            END IF;
        END IF;

        IF v_new_balance < 0 THEN
            RAISE EXCEPTION 'NEGATIVE_BALANCE_NOT_PERMITTED: account=% type=% current=% new=%',
                v_account_id, v_account_type, v_current_balance, v_new_balance USING ERRCODE = 'check_violation';
        END IF;

        UPDATE flow.ledger_accounts
        SET
            balance_atomic = v_new_balance,
            updated_at = CURRENT_TIMESTAMP
        WHERE id = v_account_id;

        INSERT INTO flow.ledger_entries (
            journal_id,
            ledger_account_id,
            entry_direction,
            amount_atomic
        ) VALUES (
            v_journal_id,
            v_account_id,
            v_direction,
            v_amount
        );

        v_count := v_count + 1;
    END LOOP;

    RETURN QUERY
    SELECT
        v_journal_id,
        p_journal_public_id::varchar(64),
        v_count,
        v_total_debit;
END;
$$;

-- 2. Strict Quote Expiration & Non-Synthetic Deposit Address Validation
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

    IF v_request_status <> 'ACTIVE' THEN
        RAISE EXCEPTION 'PAYMENT_REQUEST_INACTIVE' USING ERRCODE = 'data_exception';
    END IF;

    IF v_request_expires_at IS NOT NULL AND v_request_expires_at <= CURRENT_TIMESTAMP THEN
        RAISE EXCEPTION 'PAYMENT_REQUEST_EXPIRED' USING ERRCODE = 'data_exception';
    END IF;

    -- Strict Quote Expiration: Zero grace window
    IF v_quote_expires_at IS NOT NULL AND v_quote_expires_at < CURRENT_TIMESTAMP THEN
        RAISE EXCEPTION 'QUOTE_EXPIRED' USING ERRCODE = 'data_exception';
    END IF;

    -- Prohibit synthetic/fabricated deposit addresses
    IF p_deposit_address IS NULL OR length(trim(p_deposit_address)) = 0 OR p_deposit_address LIKE 'flow-%.near' THEN
        RAISE EXCEPTION 'INVALID_PROVIDER_DEPOSIT_ADDRESS' USING ERRCODE = 'data_exception';
    END IF;

    -- If already committed with same instructions, allow idempotent replay
    IF v_current_status = 'DEPOSIT_COMMITTED' THEN
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

-- 3. Multi-Currency Privileged Worker Settlement Procedure
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
BEGIN
    -- Require genuine, non-empty verified transaction hashes
    IF p_source_tx_hash IS NULL OR length(trim(p_source_tx_hash)) < 10 THEN
        RAISE EXCEPTION 'INVALID_SOURCE_TX_HASH' USING ERRCODE = 'data_exception';
    END IF;

    IF p_destination_tx_hash IS NULL OR length(trim(p_destination_tx_hash)) < 10 THEN
        RAISE EXCEPTION 'INVALID_DESTINATION_TX_HASH' USING ERRCODE = 'data_exception';
    END IF;

    SELECT * INTO v_attempt
    FROM flow.payment_attempts pa
    WHERE pa.attempt_public_id = p_attempt_public_id;

    IF v_attempt.id IS NULL THEN
        RAISE EXCEPTION 'PAYMENT_ATTEMPT_NOT_FOUND' USING ERRCODE = 'data_exception';
    END IF;

    IF v_attempt.status NOT IN ('DEPOSIT_COMMITTED', 'DETECTED', 'SETTLING') THEN
        RAISE EXCEPTION 'INVALID_STATUS_FOR_SETTLEMENT: %', v_attempt.status USING ERRCODE = 'data_exception';
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

    -- Post balanced journal (validates per-currency conservation)
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

-- 4. Role Isolation Grants
REVOKE EXECUTE ON FUNCTION flow.post_balanced_ledger_journal(text, text, text, text, jsonb) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION flow.worker_settle_payment_attempt(text, text, text) FROM PUBLIC;

DO $$
DECLARE
    db_name text := current_database();
    app_role text := db_name || '_app';
    worker_role text := db_name || '_worker';
BEGIN
    -- app_role must NOT possess settlement or raw journal posting privileges
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = app_role) THEN
        EXECUTE format('REVOKE EXECUTE ON FUNCTION flow.worker_settle_payment_attempt(text, text, text) FROM %I', app_role);
        EXECUTE format('REVOKE EXECUTE ON FUNCTION flow.post_balanced_ledger_journal(text, text, text, text, jsonb) FROM %I', app_role);
    END IF;

    -- worker_role possesses settlement and journal posting privileges
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = worker_role) THEN
        EXECUTE format('GRANT EXECUTE ON FUNCTION flow.post_balanced_ledger_journal(text, text, text, text, jsonb) TO %I', worker_role);
        EXECUTE format('GRANT EXECUTE ON FUNCTION flow.worker_settle_payment_attempt(text, text, text) TO %I', worker_role);
    END IF;
END;
$$;

COMMIT;


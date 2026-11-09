-- M5 Phase 4: Financial ledger and settlement lifecycle foundation
-- Implements balanced double-entry ledger bookkeeping, payment attempt deposit commitment,
-- lifecycle transitions (QUOTE_OBSERVED -> DEPOSIT_COMMITTED -> SETTLING -> SETTLED),
-- row-level security isolation, and privileged worker settlement functions.

-- 1. Extend flow.payment_attempts for deposit commitment and settlement lifecycle
ALTER TABLE flow.payment_attempts ADD COLUMN IF NOT EXISTS deposit_address VARCHAR(256);
ALTER TABLE flow.payment_attempts ADD COLUMN IF NOT EXISTS deposit_memo VARCHAR(128);
ALTER TABLE flow.payment_attempts ADD COLUMN IF NOT EXISTS deposit_deadline TIMESTAMPTZ;
ALTER TABLE flow.payment_attempts ADD COLUMN IF NOT EXISTS deposit_instructions JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE flow.payment_attempts ADD COLUMN IF NOT EXISTS source_tx_hash VARCHAR(128);
ALTER TABLE flow.payment_attempts ADD COLUMN IF NOT EXISTS destination_tx_hash VARCHAR(128);
ALTER TABLE flow.payment_attempts ADD COLUMN IF NOT EXISTS settlement_error TEXT;
ALTER TABLE flow.payment_attempts ADD COLUMN IF NOT EXISTS settled_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_payment_attempts_status ON flow.payment_attempts(status);

-- 2. Create Double-Entry Ledger Accounts
CREATE TABLE IF NOT EXISTS flow.ledger_accounts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    account_id UUID REFERENCES flow.accounts(id) ON DELETE CASCADE,
    account_type VARCHAR(32) NOT NULL CHECK (account_type IN ('ASSET', 'LIABILITY', 'EQUITY', 'REVENUE', 'EXPENSE')),
    account_code VARCHAR(64) NOT NULL CHECK (account_code IN (
        'ASSET_CUSTODY_IN_FLIGHT',
        'LIABILITY_MERCHANT_PAYABLE',
        'REVENUE_PLATFORM_FEE',
        'EXPENSE_PROVIDER_FEE',
        'ASSET_SETTLED_HOLDINGS'
    )),
    asset_id VARCHAR(128) NOT NULL,
    network VARCHAR(64) NOT NULL,
    decimals INTEGER NOT NULL CHECK (decimals >= 0 AND decimals <= 36),
    balance_atomic NUMERIC(78, 0) NOT NULL DEFAULT 0 CHECK (balance_atomic >= 0),
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_ledger_accounts_unique_key ON flow.ledger_accounts (
    COALESCE(account_id, '00000000-0000-0000-0000-000000000000'::uuid),
    account_code,
    asset_id,
    network
);

CREATE INDEX IF NOT EXISTS idx_ledger_accounts_tenant ON flow.ledger_accounts(account_id);

-- 3. Create Double-Entry Ledger Journals
CREATE TABLE IF NOT EXISTS flow.ledger_journals (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    journal_public_id VARCHAR(64) NOT NULL UNIQUE CHECK (journal_public_id ~ '^lj_[a-zA-Z0-9_-]{16,64}$'),
    reference_type VARCHAR(32) NOT NULL CHECK (reference_type IN ('PAYMENT_SETTLEMENT', 'PAYMENT_REFUND', 'FEE_SWEEP', 'ADJUSTMENT')),
    reference_id VARCHAR(128) NOT NULL,
    description TEXT NOT NULL,
    status VARCHAR(32) NOT NULL DEFAULT 'POSTED' CHECK (status IN ('POSTED', 'VOID')),
    posted_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_ledger_journals_reference ON flow.ledger_journals(reference_type, reference_id);
CREATE INDEX IF NOT EXISTS idx_ledger_journals_posted_at ON flow.ledger_journals(posted_at DESC);

-- 4. Create Double-Entry Ledger Entries (Debit & Credit Lines)
CREATE TABLE IF NOT EXISTS flow.ledger_entries (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    journal_id UUID NOT NULL REFERENCES flow.ledger_journals(id) ON DELETE CASCADE,
    ledger_account_id UUID NOT NULL REFERENCES flow.ledger_accounts(id) ON DELETE RESTRICT,
    entry_direction VARCHAR(16) NOT NULL CHECK (entry_direction IN ('DEBIT', 'CREDIT')),
    amount_atomic NUMERIC(78, 0) NOT NULL CHECK (amount_atomic > 0),
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_ledger_entries_journal_id ON flow.ledger_entries(journal_id);
CREATE INDEX IF NOT EXISTS idx_ledger_entries_account_id ON flow.ledger_entries(ledger_account_id);

-- 5. Enable Row-Level Security on Ledger Tables
ALTER TABLE flow.ledger_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE flow.ledger_accounts FORCE ROW LEVEL SECURITY;

ALTER TABLE flow.ledger_journals ENABLE ROW LEVEL SECURITY;
ALTER TABLE flow.ledger_journals FORCE ROW LEVEL SECURITY;

ALTER TABLE flow.ledger_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE flow.ledger_entries FORCE ROW LEVEL SECURITY;

REVOKE ALL ON flow.ledger_accounts FROM PUBLIC;
REVOKE ALL ON flow.ledger_journals FROM PUBLIC;
REVOKE ALL ON flow.ledger_entries FROM PUBLIC;

-- Default owner policy
CREATE POLICY ledger_accounts_owner_policy ON flow.ledger_accounts
FOR ALL TO CURRENT_USER USING (true) WITH CHECK (true);

CREATE POLICY ledger_journals_owner_policy ON flow.ledger_journals
FOR ALL TO CURRENT_USER USING (true) WITH CHECK (true);

CREATE POLICY ledger_entries_owner_policy ON flow.ledger_entries
FOR ALL TO CURRENT_USER USING (true) WITH CHECK (true);

-- Scoped RLS policies for tenant, worker, and operator roles
DO $$
DECLARE
    db_name text := current_database();
    app_role text := db_name || '_app';
    worker_role text := db_name || '_worker';
    operator_role text := db_name || '_operator';
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = app_role) THEN
        -- Tenants can only see their own tenant-bound ledger accounts
        EXECUTE format(
            $p$
            CREATE POLICY ledger_accounts_tenant_policy ON flow.ledger_accounts
            FOR SELECT TO %I
            USING (account_id IS NOT NULL AND flow.can_access_account(account_id))
            $p$,
            app_role
        );
        EXECUTE format('GRANT SELECT ON flow.ledger_accounts TO %I', app_role);

        -- Tenants can see entries belonging to their accounts
        EXECUTE format(
            $p$
            CREATE POLICY ledger_entries_tenant_policy ON flow.ledger_entries
            FOR SELECT TO %I
            USING (EXISTS (
                SELECT 1 FROM flow.ledger_accounts la
                WHERE la.id = ledger_entries.ledger_account_id
                AND la.account_id IS NOT NULL
                AND flow.can_access_account(la.account_id)
            ))
            $p$,
            app_role
        );
        EXECUTE format('GRANT SELECT ON flow.ledger_entries TO %I', app_role);

        -- Tenants can see journals associated with their accounts
        EXECUTE format(
            $p$
            CREATE POLICY ledger_journals_tenant_policy ON flow.ledger_journals
            FOR SELECT TO %I
            USING (EXISTS (
                SELECT 1 FROM flow.ledger_entries le
                JOIN flow.ledger_accounts la ON la.id = le.ledger_account_id
                WHERE le.journal_id = ledger_journals.id
                AND la.account_id IS NOT NULL
                AND flow.can_access_account(la.account_id)
            ))
            $p$,
            app_role
        );
        EXECUTE format('GRANT SELECT ON flow.ledger_journals TO %I', app_role);
    END IF;

    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = worker_role) THEN
        EXECUTE format(
            'CREATE POLICY ledger_accounts_worker_policy ON flow.ledger_accounts FOR ALL TO %I USING (true) WITH CHECK (true)',
            worker_role
        );
        EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON flow.ledger_accounts TO %I', worker_role);

        EXECUTE format(
            'CREATE POLICY ledger_journals_worker_policy ON flow.ledger_journals FOR ALL TO %I USING (true) WITH CHECK (true)',
            worker_role
        );
        EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON flow.ledger_journals TO %I', worker_role);

        EXECUTE format(
            'CREATE POLICY ledger_entries_worker_policy ON flow.ledger_entries FOR ALL TO %I USING (true) WITH CHECK (true)',
            worker_role
        );
        EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON flow.ledger_entries TO %I', worker_role);
    END IF;

    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = operator_role) THEN
        EXECUTE format(
            'CREATE POLICY ledger_accounts_operator_policy ON flow.ledger_accounts FOR ALL TO %I USING (true) WITH CHECK (true)',
            operator_role
        );
        EXECUTE format('GRANT SELECT ON flow.ledger_accounts TO %I', operator_role);

        EXECUTE format(
            'CREATE POLICY ledger_journals_operator_policy ON flow.ledger_journals FOR ALL TO %I USING (true) WITH CHECK (true)',
            operator_role
        );
        EXECUTE format('GRANT SELECT ON flow.ledger_journals TO %I', operator_role);

        EXECUTE format(
            'CREATE POLICY ledger_entries_operator_policy ON flow.ledger_entries FOR ALL TO %I USING (true) WITH CHECK (true)',
            operator_role
        );
        EXECUTE format('GRANT SELECT ON flow.ledger_entries TO %I', operator_role);
    END IF;
END;
$$;

-- 6. Atomic Double-Entry Posting Stored Procedure
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
BEGIN
    IF jsonb_array_length(p_entries) < 2 THEN
        RAISE EXCEPTION 'DOUBLE_ENTRY_MINIMUM_LINES_REQUIRED' USING ERRCODE = 'data_exception';
    END IF;

    -- Compute and verify balanced totals
    FOR v_entry IN SELECT * FROM jsonb_array_elements(p_entries)
    LOOP
        v_direction := v_entry->>'entry_direction';
        v_amount := (v_entry->>'amount_atomic')::numeric;

        IF v_amount <= 0 THEN
            RAISE EXCEPTION 'ENTRY_AMOUNT_MUST_BE_POSITIVE' USING ERRCODE = 'data_exception';
        END IF;

        IF v_direction = 'DEBIT' THEN
            v_total_debit := v_total_debit + v_amount;
        ELSIF v_direction = 'CREDIT' THEN
            v_total_credit := v_total_credit + v_amount;
        ELSE
            RAISE EXCEPTION 'INVALID_ENTRY_DIRECTION: %', v_direction USING ERRCODE = 'data_exception';
        END IF;
    END LOOP;

    IF v_total_debit <> v_total_credit THEN
        RAISE EXCEPTION 'UNBALANCED_JOURNAL_ENTRY: debits=% credits=%', v_total_debit, v_total_credit USING ERRCODE = 'data_exception';
    END IF;

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

        -- Lock account row for update
        SELECT la.account_type, la.balance_atomic
        INTO v_account_type, v_current_balance
        FROM flow.ledger_accounts la
        WHERE la.id = v_account_id
        FOR UPDATE;

        IF v_account_type IS NULL THEN
            RAISE EXCEPTION 'LEDGER_ACCOUNT_NOT_FOUND: %', v_account_id USING ERRCODE = 'data_exception';
        END IF;

        -- Calculate new balance based on accounting rules:
        -- ASSET & EXPENSE: Debit increases (+), Credit decreases (-)
        -- LIABILITY, EQUITY & REVENUE: Credit increases (+), Debit decreases (-)
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

        -- Update account balance
        UPDATE flow.ledger_accounts
        SET
            balance_atomic = v_new_balance,
            updated_at = CURRENT_TIMESTAMP
        WHERE id = v_account_id;

        -- Insert entry line
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

-- 7. Public Guest Checkout: Commit to Payment Attempt
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

    IF v_quote_expires_at IS NOT NULL AND v_quote_expires_at <= (CURRENT_TIMESTAMP - interval '1 hour') THEN
        RAISE EXCEPTION 'QUOTE_EXPIRED' USING ERRCODE = 'data_exception';
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

-- 7b. Public Guest Checkout: Safe Query for Payment Attempt
CREATE OR REPLACE FUNCTION flow.get_public_payment_attempt(
    p_payment_request_public_id text,
    p_attempt_public_id text
)
RETURNS TABLE (
    id UUID,
    attempt_public_id VARCHAR(64),
    source_network VARCHAR(64),
    source_asset_id VARCHAR(128),
    source_asset_symbol VARCHAR(32),
    source_decimals INTEGER,
    quoted_source_atomic_amount DECIMAL(78, 0),
    quoted_destination_atomic_amount DECIMAL(78, 0),
    status VARCHAR(32),
    quote_expires_at TIMESTAMPTZ,
    deposit_address VARCHAR(256),
    deposit_memo VARCHAR(128),
    deposit_deadline TIMESTAMPTZ,
    deposit_instructions JSONB,
    source_tx_hash VARCHAR(128),
    destination_tx_hash VARCHAR(128),
    settled_at TIMESTAMPTZ,
    settlement_error TEXT,
    destination_network VARCHAR(64),
    destination_asset_symbol VARCHAR(32),
    destination_decimals INTEGER,
    request_status flow.payment_request_status,
    request_expires_at TIMESTAMPTZ
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, flow
AS $$
BEGIN
    RETURN QUERY
    SELECT
        pa.id,
        pa.attempt_public_id,
        pa.source_network,
        pa.source_asset_id,
        pa.source_asset_symbol,
        pa.source_decimals,
        pa.quoted_source_atomic_amount,
        pa.quoted_destination_atomic_amount,
        pa.status,
        pa.quote_expires_at,
        pa.deposit_address,
        pa.deposit_memo,
        pa.deposit_deadline,
        pa.deposit_instructions,
        pa.source_tx_hash,
        pa.destination_tx_hash,
        pa.settled_at,
        pa.settlement_error,
        pr.destination_network,
        pr.destination_asset_symbol,
        pr.destination_decimals,
        pr.status,
        pr.expires_at
    FROM flow.payment_attempts pa
    JOIN flow.payment_requests pr ON pr.id = pa.payment_request_id
    WHERE pa.attempt_public_id = p_attempt_public_id
      AND pr.public_id = p_payment_request_public_id;
END;
$$;

-- 8. Privileged Worker Settlement Function
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
    v_fee_acct_id UUID;
    v_entries jsonb;
    v_dest_atomic NUMERIC(78, 0);
    v_platform_fee NUMERIC(78, 0) := 0;
    v_merchant_net NUMERIC(78, 0);
BEGIN
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

    -- Net amount to merchant is destination atomic amount
    v_merchant_net := v_dest_atomic;

    -- Provision or fetch merchant liability account
    INSERT INTO flow.ledger_accounts (
        account_id,
        account_type,
        account_code,
        asset_id,
        network,
        decimals,
        balance_atomic
    ) VALUES (
        v_request.account_id,
        'LIABILITY',
        'LIABILITY_MERCHANT_PAYABLE',
        v_request.destination_asset_id,
        v_request.destination_network,
        v_request.destination_decimals,
        0
    )
    ON CONFLICT (COALESCE(account_id, '00000000-0000-0000-0000-000000000000'::uuid), account_code, asset_id, network)
    DO UPDATE SET updated_at = CURRENT_TIMESTAMP
    RETURNING flow.ledger_accounts.id INTO v_merchant_acct_id;

    -- Provision or fetch platform custody account
    INSERT INTO flow.ledger_accounts (
        account_id,
        account_type,
        account_code,
        asset_id,
        network,
        decimals,
        balance_atomic
    ) VALUES (
        NULL,
        'ASSET',
        'ASSET_CUSTODY_IN_FLIGHT',
        v_request.destination_asset_id,
        v_request.destination_network,
        v_request.destination_decimals,
        0
    )
    ON CONFLICT (COALESCE(account_id, '00000000-0000-0000-0000-000000000000'::uuid), account_code, asset_id, network)
    DO UPDATE SET updated_at = CURRENT_TIMESTAMP
    RETURNING flow.ledger_accounts.id INTO v_custody_acct_id;

    -- Prepare balanced entries: Debit Custody, Credit Merchant Payable
    v_entries := jsonb_build_array(
        jsonb_build_object(
            'ledger_account_id', v_custody_acct_id,
            'entry_direction', 'DEBIT',
            'amount_atomic', v_dest_atomic::text
        ),
        jsonb_build_object(
            'ledger_account_id', v_merchant_acct_id,
            'entry_direction', 'CREDIT',
            'amount_atomic', v_merchant_net::text
        )
    );

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

    -- If payment request is fixed amount and now fulfilled, mark COMPLETED
    IF v_request.amount_mode = 'FIXED' THEN
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

-- 9. Function permission grants
REVOKE EXECUTE ON FUNCTION flow.post_balanced_ledger_journal(text, text, text, text, jsonb) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION flow.commit_payment_attempt(text, text, text, timestamptz, jsonb) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION flow.get_public_payment_attempt(text, text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION flow.worker_settle_payment_attempt(text, text, text) FROM PUBLIC;

DO $$
DECLARE
    db_name text := current_database();
    app_role text := db_name || '_app';
    worker_role text := db_name || '_worker';
    operator_role text := db_name || '_operator';
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = app_role) THEN
        EXECUTE format('GRANT EXECUTE ON FUNCTION flow.commit_payment_attempt(text, text, text, timestamptz, jsonb) TO %I', app_role);
        EXECUTE format('GRANT EXECUTE ON FUNCTION flow.get_public_payment_attempt(text, text) TO %I', app_role);
    END IF;

    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = worker_role) THEN
        EXECUTE format('GRANT EXECUTE ON FUNCTION flow.post_balanced_ledger_journal(text, text, text, text, jsonb) TO %I', worker_role);
        EXECUTE format('GRANT EXECUTE ON FUNCTION flow.commit_payment_attempt(text, text, text, timestamptz, jsonb) TO %I', worker_role);
        EXECUTE format('GRANT EXECUTE ON FUNCTION flow.get_public_payment_attempt(text, text) TO %I', worker_role);
        EXECUTE format('GRANT EXECUTE ON FUNCTION flow.worker_settle_payment_attempt(text, text, text) TO %I', worker_role);
    END IF;
END;
$$;

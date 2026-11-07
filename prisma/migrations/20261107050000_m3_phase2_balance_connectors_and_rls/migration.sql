BEGIN;

-- 1. Wallet-to-network consistency trigger on flow.wallet_balances
CREATE OR REPLACE FUNCTION flow.enforce_wallet_balance_consistency()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_wallet_env text;
  v_asset_network text;
  v_asset_chain_id text;
  v_address_exists boolean;
  v_is_testnet_chain boolean;
BEGIN
  -- 1. Fetch wallet environment
  SELECT environment INTO v_wallet_env
  FROM flow.wallets
  WHERE id = NEW.wallet_id;

  IF v_wallet_env IS NULL THEN
    RAISE EXCEPTION 'Wallet % does not exist', NEW.wallet_id
      USING ERRCODE = '23503';
  END IF;

  -- 2. Fetch network asset details
  SELECT network, chain_id INTO v_asset_network, v_asset_chain_id
  FROM flow.network_assets
  WHERE id = NEW.network_asset_id;

  IF v_asset_network IS NULL THEN
    RAISE EXCEPTION 'Network asset % does not exist', NEW.network_asset_id
      USING ERRCODE = '23503';
  END IF;

  -- 3. Determine if chain_id is testnet or mainnet
  v_is_testnet_chain := (v_asset_chain_id IN ('near-testnet', '84532', 'solana-devnet'));

  -- 4. Enforce environment consistency: testnet wallet must only hold testnet chain assets
  IF v_wallet_env = 'testnet' AND NOT v_is_testnet_chain THEN
    RAISE EXCEPTION 'Environment mismatch: testnet wallet % cannot record balances for mainnet chain %',
      NEW.wallet_id, v_asset_chain_id
      USING ERRCODE = '23514';
  END IF;

  IF v_wallet_env = 'mainnet' AND v_is_testnet_chain THEN
    RAISE EXCEPTION 'Environment mismatch: mainnet wallet % cannot record balances for testnet chain %',
      NEW.wallet_id, v_asset_chain_id
      USING ERRCODE = '23514';
  END IF;

  -- 5. Enforce registered address existence: wallet must have a registered address for the asset's network and chain
  SELECT EXISTS (
    SELECT 1 FROM flow.wallet_addresses
    WHERE wallet_id = NEW.wallet_id
      AND network = v_asset_network
      AND chain_id = v_asset_chain_id
  ) INTO v_address_exists;

  IF NOT v_address_exists THEN
    RAISE EXCEPTION 'Missing registered address: wallet % has no registered address for network % chain %',
      NEW.wallet_id, v_asset_network, v_asset_chain_id
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_wallet_balance_consistency ON flow.wallet_balances;
CREATE TRIGGER trg_wallet_balance_consistency
  BEFORE INSERT OR UPDATE ON flow.wallet_balances
  FOR EACH ROW
  EXECUTE FUNCTION flow.enforce_wallet_balance_consistency();

-- 2. Enable and Force Row Level Security on flow.wallet_balances
ALTER TABLE flow.wallet_balances ENABLE ROW LEVEL SECURITY;
ALTER TABLE flow.wallet_balances FORCE ROW LEVEL SECURITY;

-- 3. Configure Policies for Database Roles
DO $$
DECLARE
  db_name text := current_database();
  app_role text := db_name || '_app';
  worker_role text := db_name || '_worker';
  operator_role text := db_name || '_operator';
BEGIN
  -- Drop existing policies if any
  EXECUTE 'DROP POLICY IF EXISTS balance_worker_policy ON flow.wallet_balances';
  EXECUTE 'DROP POLICY IF EXISTS balance_operator_policy ON flow.wallet_balances';
  EXECUTE 'DROP POLICY IF EXISTS balance_app_tenant_policy ON flow.wallet_balances';

  -- A. Worker Policy: Full access for balance reconciliation worker
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = worker_role) THEN
    EXECUTE format(
      'CREATE POLICY balance_worker_policy ON flow.wallet_balances FOR ALL TO %I USING (true) WITH CHECK (true)',
      worker_role
    );
  END IF;

  -- B. Operator Policy: Read-only access across all balances for authorized custody operator
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = operator_role) THEN
    EXECUTE format(
      'CREATE POLICY balance_operator_policy ON flow.wallet_balances FOR SELECT TO %I USING (true)',
      operator_role
    );
  END IF;

  -- C. App Policy: Scoped strictly to the active tenant session / user context
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = app_role) THEN
    EXECUTE format(
      $policy$
      CREATE POLICY balance_app_tenant_policy ON flow.wallet_balances
      FOR SELECT TO %I
      USING (
        EXISTS (
          SELECT 1 FROM flow.wallets w
          JOIN flow.accounts a ON a.id = w.account_id
          LEFT JOIN flow.account_memberships m ON m.account_id = a.id AND m.status = 'ACTIVE'::flow.member_status
          WHERE w.id = flow.wallet_balances.wallet_id
            AND a.id = NULLIF(current_setting('flow.current_account_id', true), '')::uuid
            AND (
              (
                NULLIF(current_setting('flow.current_user_id', true), '') IS NOT NULL
                AND (
                  a.personal_owner_id = NULLIF(current_setting('flow.current_user_id', true), '')::uuid
                  OR m.user_id = NULLIF(current_setting('flow.current_user_id', true), '')::uuid
                )
              )
              OR
              (
                NULLIF(current_setting('flow.current_session_token', true), '') IS NOT NULL
                AND EXISTS (
                  SELECT 1 FROM flow.auth_sessions s
                  JOIN flow.users u ON u.auth_user_id = s.user_id
                  WHERE s.token = NULLIF(current_setting('flow.current_session_token', true), '')
                    AND s.expires_at > CURRENT_TIMESTAMP
                    AND u.active = true
                    AND (a.personal_owner_id = u.id OR m.user_id = u.id)
                )
              )
            )
        )
      )
      $policy$,
      app_role
    );
  END IF;
END;
$$;

COMMIT;

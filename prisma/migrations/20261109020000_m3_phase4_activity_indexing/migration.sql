BEGIN;

-- ============================================================================
-- Section 1: Wallet Transaction Activities Table
-- ============================================================================

CREATE TABLE IF NOT EXISTS flow.wallet_activities (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES flow.accounts(id) ON DELETE CASCADE,
  wallet_id uuid NOT NULL REFERENCES flow.wallets(id) ON DELETE RESTRICT,
  network text NOT NULL,
  chain_id text NOT NULL,
  ecosystem text NOT NULL,
  activity_type text NOT NULL DEFAULT 'ON_CHAIN_TRANSFER',
  direction text NOT NULL,
  tx_hash text NOT NULL,
  event_index integer NOT NULL DEFAULT 0,
  from_address text NOT NULL,
  to_address text NOT NULL,
  asset_id uuid REFERENCES flow.assets(id) ON DELETE RESTRICT,
  network_asset_id uuid REFERENCES flow.network_assets(id) ON DELETE RESTRICT,
  asset_symbol text NOT NULL,
  atomic_amount numeric(78, 0) NOT NULL DEFAULT 0,
  decimals integer NOT NULL DEFAULT 18,
  block_height bigint,
  block_hash text,
  block_timestamp timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
  finality text NOT NULL DEFAULT 'FINALIZED',
  reorg_status text NOT NULL DEFAULT 'CANONICAL',
  fee_atomic_amount numeric(78, 0),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  observed_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,

  -- Constraints
  CONSTRAINT wallet_activities_direction_check CHECK (
    direction IN ('INCOMING', 'OUTGOING', 'SELF')
  ),
  CONSTRAINT wallet_activities_type_check CHECK (
    activity_type IN (
      'ON_CHAIN_TRANSFER',
      'ON_CHAIN_INTERACTION',
      'FLOW_PAYMENT',
      'FLOW_CONVERT',
      'FLOW_CROSS_CHAIN_SETTLEMENT'
    )
  ),
  CONSTRAINT wallet_activities_finality_check CHECK (
    finality IN ('FINALIZED', 'CONFIRMED', 'PENDING')
  ),
  CONSTRAINT wallet_activities_reorg_check CHECK (
    reorg_status IN ('CANONICAL', 'REORGED', 'ORPHANED')
  ),
  CONSTRAINT wallet_activities_unique_event UNIQUE (network, tx_hash, event_index)
);

-- Indexes for performant feed queries and deduplication
CREATE INDEX IF NOT EXISTS wallet_activities_account_feed_idx 
  ON flow.wallet_activities (account_id, block_timestamp DESC, id DESC);

CREATE INDEX IF NOT EXISTS wallet_activities_wallet_network_idx 
  ON flow.wallet_activities (wallet_id, network);

CREATE INDEX IF NOT EXISTS wallet_activities_tx_hash_idx 
  ON flow.wallet_activities (tx_hash);

-- ============================================================================
-- Section 2: Wallet-to-Network Activity Consistency Trigger
-- ============================================================================

CREATE OR REPLACE FUNCTION flow.enforce_wallet_activity_consistency()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = flow, pg_temp
AS $$
DECLARE
  v_wallet record;
  v_has_address boolean;
  v_is_testnet_chain boolean;
BEGIN
  -- 1. Verify wallet exists and belongs to the specified account
  SELECT id, account_id, environment
  INTO v_wallet
  FROM flow.wallets
  WHERE id = NEW.wallet_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Wallet % does not exist', NEW.wallet_id
      USING ERRCODE = '23503';
  END IF;

  IF v_wallet.account_id <> NEW.account_id THEN
    RAISE EXCEPTION 'Account mismatch: wallet % belongs to account %, not %',
      NEW.wallet_id, v_wallet.account_id, NEW.account_id
      USING ERRCODE = '42501';
  END IF;

  -- 2. Verify environment consistency (mainnet vs testnet) using chain_id
  v_is_testnet_chain := (NEW.chain_id IN ('near-testnet', '84532', 'solana-devnet'));

  IF v_wallet.environment = 'testnet' AND NOT v_is_testnet_chain THEN
    RAISE EXCEPTION 'Environment mismatch: testnet wallet % cannot record activity for mainnet chain %',
      NEW.wallet_id, NEW.chain_id
      USING ERRCODE = '23514';
  END IF;

  IF v_wallet.environment = 'mainnet' AND v_is_testnet_chain THEN
    RAISE EXCEPTION 'Environment mismatch: mainnet wallet % cannot record activity for testnet chain %',
      NEW.wallet_id, NEW.chain_id
      USING ERRCODE = '23514';
  END IF;

  -- 3. Verify that at least one side of the transfer matches a registered wallet address
  SELECT EXISTS (
    SELECT 1 FROM flow.wallet_addresses
    WHERE wallet_id = NEW.wallet_id
      AND (
        lower(address) = lower(NEW.from_address)
        OR lower(address) = lower(NEW.to_address)
      )
  ) INTO v_has_address;

  IF NOT v_has_address THEN
    RAISE EXCEPTION 'Address mismatch: neither from_address (%) nor to_address (%) is registered for wallet %',
      NEW.from_address, NEW.to_address, NEW.wallet_id
      USING ERRCODE = '23514';
  END IF;

  NEW.updated_at := CURRENT_TIMESTAMP;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_wallet_activities_consistency ON flow.wallet_activities;

CREATE TRIGGER trg_wallet_activities_consistency
BEFORE INSERT OR UPDATE ON flow.wallet_activities
FOR EACH ROW
EXECUTE FUNCTION flow.enforce_wallet_activity_consistency();

-- ============================================================================
-- Section 3: Row-Level Security & Role Privileges
-- ============================================================================

ALTER TABLE flow.wallet_activities ENABLE ROW LEVEL SECURITY;
ALTER TABLE flow.wallet_activities FORCE ROW LEVEL SECURITY;

REVOKE ALL ON flow.wallet_activities FROM PUBLIC;

DROP POLICY IF EXISTS activity_app_tenant_policy ON flow.wallet_activities;
DROP POLICY IF EXISTS activity_worker_policy ON flow.wallet_activities;
DROP POLICY IF EXISTS activity_operator_policy ON flow.wallet_activities;

DO $$
DECLARE
  db_name text := current_database();
  app_role text := db_name || '_app';
  worker_role text := db_name || '_worker';
  operator_role text := db_name || '_operator';
BEGIN
  -- App role: strictly read-only under row-level tenant security
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = app_role) THEN
    EXECUTE format(
      $policy$
      CREATE POLICY activity_app_tenant_policy ON flow.wallet_activities
      FOR SELECT TO %I
      USING (flow.can_access_account(account_id))
      $policy$,
      app_role
    );

    EXECUTE format('GRANT SELECT ON flow.wallet_activities TO %I', app_role);
    EXECUTE format('REVOKE INSERT, UPDATE, DELETE ON flow.wallet_activities FROM %I', app_role);
  END IF;

  -- Worker role: ingest, update and delete activities
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = worker_role) THEN
    EXECUTE format(
      'CREATE POLICY activity_worker_policy ON flow.wallet_activities FOR ALL TO %I USING (true) WITH CHECK (true)',
      worker_role
    );
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON flow.wallet_activities TO %I', worker_role);
  END IF;

  -- Operator role: privileged observation and maintenance
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = operator_role) THEN
    EXECUTE format(
      'CREATE POLICY activity_operator_policy ON flow.wallet_activities FOR ALL TO %I USING (true) WITH CHECK (true)',
      operator_role
    );
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON flow.wallet_activities TO %I', operator_role);
  END IF;
END;
$$;

COMMIT;

BEGIN;

-- 1. Create flow.assets table
CREATE TABLE IF NOT EXISTS flow.assets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  symbol text NOT NULL,
  name text NOT NULL,
  kind text NOT NULL DEFAULT 'FUNGIBLE_TOKEN' CHECK (kind IN ('NATIVE', 'FUNGIBLE_TOKEN')),
  description text,
  icon_url text,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS assets_symbol_idx ON flow.assets (symbol);

-- 2. Create flow.network_assets table
CREATE TABLE IF NOT EXISTS flow.network_assets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  asset_id uuid NOT NULL REFERENCES flow.assets(id) ON DELETE RESTRICT,
  network text NOT NULL CHECK (network IN ('near', 'base', 'solana')),
  chain_id text NOT NULL,
  token_standard text NOT NULL CHECK (token_standard IN ('NATIVE', 'NEP141', 'ERC20', 'SPL', 'TOKEN_2022')),
  contract_address text,
  decimals integer NOT NULL CHECK (decimals >= 0 AND decimals <= 36),
  symbol_override text,
  name_override text,
  is_verified boolean NOT NULL DEFAULT true,
  is_deposit_eligible boolean NOT NULL DEFAULT false,
  status text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'DEPRECATED', 'UNSUPPORTED')),
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS network_assets_network_chain_idx ON flow.network_assets (network, chain_id);
CREATE INDEX IF NOT EXISTS network_assets_contract_idx ON flow.network_assets (contract_address);

-- Partial unique indexes to strictly prevent duplicate deployments
CREATE UNIQUE INDEX IF NOT EXISTS network_assets_native_unique_idx
  ON flow.network_assets (network, chain_id, token_standard)
  WHERE contract_address IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS network_assets_contract_unique_idx
  ON flow.network_assets (network, chain_id, token_standard, contract_address)
  WHERE contract_address IS NOT NULL;

-- 3. Create flow.wallet_balances table
CREATE TABLE IF NOT EXISTS flow.wallet_balances (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  wallet_id uuid NOT NULL REFERENCES flow.wallets(id) ON DELETE RESTRICT,
  network_asset_id uuid NOT NULL REFERENCES flow.network_assets(id) ON DELETE RESTRICT,
  token_account_address text,
  atomic_balance numeric(78, 0) NOT NULL DEFAULT 0 CHECK (atomic_balance >= 0),
  block_height bigint CHECK (block_height >= 0),
  block_timestamp timestamptz,
  observed_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  finality text NOT NULL DEFAULT 'UNKNOWN' CHECK (finality IN ('FINALIZED', 'CONFIRMED', 'SAFE', 'UNKNOWN')),
  sync_status text NOT NULL DEFAULT 'NOT_SYNCED' CHECK (sync_status IN ('NOT_SYNCED', 'SYNCED', 'STALE', 'UNAVAILABLE', 'ERROR')),
  last_synced_at timestamptz,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS wallet_balances_aggregate_unique_idx
  ON flow.wallet_balances (wallet_id, network_asset_id)
  WHERE token_account_address IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS wallet_balances_token_account_unique_idx
  ON flow.wallet_balances (wallet_id, network_asset_id, token_account_address)
  WHERE token_account_address IS NOT NULL;

CREATE INDEX IF NOT EXISTS wallet_balances_wallet_sync_idx ON flow.wallet_balances (wallet_id, sync_status);
CREATE INDEX IF NOT EXISTS wallet_balances_network_asset_idx ON flow.wallet_balances (network_asset_id);

-- 4. Seed Initially Supported Assets & Verified Network Deployments
-- Logical Assets
INSERT INTO flow.assets (id, symbol, name, kind, description)
VALUES
  ('10000000-0000-0000-0000-000000000001'::uuid, 'NEAR', 'NEAR Protocol Native Token', 'NATIVE', 'Layer 1 native utility and governance token for NEAR Protocol'),
  ('10000000-0000-0000-0000-000000000002'::uuid, 'ETH', 'Ether', 'NATIVE', 'Base native gas and utility token (Ethereum on Base)'),
  ('10000000-0000-0000-0000-000000000003'::uuid, 'SOL', 'Solana', 'NATIVE', 'Solana native gas and utility token'),
  ('10000000-0000-0000-0000-000000000004'::uuid, 'USDC', 'USD Coin', 'FUNGIBLE_TOKEN', 'Circle-issued native fiat-backed stablecoin'),
  ('10000000-0000-0000-0000-000000000005'::uuid, 'USDC.e', 'Bridged USDC (Rainbow Bridge)', 'FUNGIBLE_TOKEN', 'Ethereum bridged USDC via Rainbow Bridge on NEAR')
ON CONFLICT (id) DO NOTHING;

-- Network Deployments
INSERT INTO flow.network_assets (
  id, asset_id, network, chain_id, token_standard, contract_address, decimals, is_verified, is_deposit_eligible, status
)
VALUES
  -- NEAR Native
  ('20000000-0000-0000-0000-000000000001'::uuid, '10000000-0000-0000-0000-000000000001'::uuid, 'near', 'near-mainnet', 'NATIVE', NULL, 24, true, false, 'ACTIVE'),
  ('20000000-0000-0000-0000-000000000002'::uuid, '10000000-0000-0000-0000-000000000001'::uuid, 'near', 'near-testnet', 'NATIVE', NULL, 24, true, false, 'ACTIVE'),

  -- Base ETH Native
  ('20000000-0000-0000-0000-000000000003'::uuid, '10000000-0000-0000-0000-000000000002'::uuid, 'base', '8453', 'NATIVE', NULL, 18, true, false, 'ACTIVE'),
  ('20000000-0000-0000-0000-000000000004'::uuid, '10000000-0000-0000-0000-000000000002'::uuid, 'base', '84532', 'NATIVE', NULL, 18, true, false, 'ACTIVE'),

  -- Solana Native SOL
  ('20000000-0000-0000-0000-000000000005'::uuid, '10000000-0000-0000-0000-000000000003'::uuid, 'solana', 'solana-mainnet', 'NATIVE', NULL, 9, true, false, 'ACTIVE'),
  ('20000000-0000-0000-0000-000000000006'::uuid, '10000000-0000-0000-0000-000000000003'::uuid, 'solana', 'solana-devnet', 'NATIVE', NULL, 9, true, false, 'ACTIVE'),

  -- Circle Native USDC Deployments (Verified on-chain)
  ('20000000-0000-0000-0000-000000000007'::uuid, '10000000-0000-0000-0000-000000000004'::uuid, 'near', 'near-mainnet', 'NEP141', '17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1', 6, true, false, 'ACTIVE'),
  ('20000000-0000-0000-0000-000000000008'::uuid, '10000000-0000-0000-0000-000000000004'::uuid, 'base', '8453', 'ERC20', '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', 6, true, false, 'ACTIVE'),
  ('20000000-0000-0000-0000-000000000009'::uuid, '10000000-0000-0000-0000-000000000004'::uuid, 'base', '84532', 'ERC20', '0x036CbD53842c5426634e7929541eC2318f3dCF7e', 6, true, false, 'ACTIVE'),
  ('20000000-0000-0000-0000-000000000010'::uuid, '10000000-0000-0000-0000-000000000004'::uuid, 'solana', 'solana-mainnet', 'SPL', 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', 6, true, false, 'ACTIVE'),
  ('20000000-0000-0000-0000-000000000011'::uuid, '10000000-0000-0000-0000-000000000004'::uuid, 'solana', 'solana-devnet', 'SPL', '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU', 6, true, false, 'ACTIVE'),

  -- Bridged USDC.e on NEAR Mainnet (Rainbow Bridge)
  ('20000000-0000-0000-0000-000000000012'::uuid, '10000000-0000-0000-0000-000000000005'::uuid, 'near', 'near-mainnet', 'NEP141', 'a0b86991c6218b36c1d19d4a2e9eb0ce3606eb48.factory.bridge.near', 6, true, false, 'ACTIVE')
ON CONFLICT (id) DO NOTHING;

-- 5. Correct Database Privileges for Runtime Roles
DO $$
DECLARE
  db_name text := current_database();
  app_role text := db_name || '_app';
  worker_role text := db_name || '_worker';
  operator_role text := db_name || '_operator';
BEGIN
  -- A. Web Application Role (app_role): Read-only projections for assets and balances
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = app_role) THEN
    EXECUTE format('GRANT SELECT ON flow.assets, flow.network_assets, flow.wallet_balances TO %I', app_role);
    EXECUTE format('REVOKE INSERT, UPDATE, DELETE ON flow.assets, flow.network_assets, flow.wallet_balances FROM %I', app_role);
  END IF;

  -- B. Wallet Worker Role (worker_role): Updates balances from reconciler
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = worker_role) THEN
    EXECUTE format('GRANT SELECT ON flow.assets, flow.network_assets TO %I', worker_role);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON flow.wallet_balances TO %I', worker_role);
    EXECUTE format('REVOKE INSERT, UPDATE, DELETE ON flow.assets, flow.network_assets FROM %I', worker_role);
  END IF;

  -- C. Authorized Custody Operator Role (operator_role): Manages asset registry, reads balances
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = operator_role) THEN
    EXECUTE format('GRANT SELECT, INSERT, UPDATE ON flow.assets, flow.network_assets TO %I', operator_role);
    EXECUTE format('GRANT SELECT ON flow.wallet_balances TO %I', operator_role);
    EXECUTE format('REVOKE INSERT, UPDATE, DELETE ON flow.wallet_balances FROM %I', operator_role);
  END IF;
END;
$$;

COMMIT;

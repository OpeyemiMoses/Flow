-- Migration: 20261111000000_five_asset_mainnet_registry
-- Five-asset canonical registry: USDT, USDC, NEAR, SOL, ETH across Ethereum, Base, Solana, and NEAR.
BEGIN;

-- 1. Update check constraint on flow.network_assets to include 'ethereum'
ALTER TABLE flow.network_assets DROP CONSTRAINT IF EXISTS network_assets_network_check;
ALTER TABLE flow.network_assets ADD CONSTRAINT network_assets_network_check CHECK (network IN ('near', 'base', 'solana', 'ethereum'));

-- 2. Seed flow.assets with USDT
INSERT INTO flow.assets (id, symbol, name, kind, description)
VALUES (
  '10000000-0000-0000-0000-000000000006'::uuid,
  'USDT',
  'Tether USD',
  'FUNGIBLE_TOKEN',
  'Tether USD fiat-backed stablecoin'
)
ON CONFLICT (id) DO NOTHING;

-- 3. Deprecate non-canonical bridged asset USDC.e
UPDATE flow.network_assets
SET status = 'UNSUPPORTED'
WHERE asset_id = '10000000-0000-0000-0000-000000000005'::uuid;

-- 4. Seed flow.network_assets with genuine canonical mainnet deployments
INSERT INTO flow.network_assets (
  id,
  asset_id,
  network,
  chain_id,
  token_standard,
  contract_address,
  decimals,
  is_verified,
  is_deposit_eligible,
  status
)
VALUES
  -- Ethereum Mainnet Native ETH
  (
    '20000000-0000-0000-0000-000000000013'::uuid,
    '10000000-0000-0000-0000-000000000002'::uuid,
    'ethereum',
    '1',
    'NATIVE',
    NULL,
    18,
    true,
    false,
    'ACTIVE'
  ),
  -- Ethereum Mainnet Native USDC
  (
    '20000000-0000-0000-0000-000000000014'::uuid,
    '10000000-0000-0000-0000-000000000004'::uuid,
    'ethereum',
    '1',
    'ERC20',
    '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
    6,
    true,
    false,
    'ACTIVE'
  ),
  -- Ethereum Mainnet Native USDT
  (
    '20000000-0000-0000-0000-000000000015'::uuid,
    '10000000-0000-0000-0000-000000000006'::uuid,
    'ethereum',
    '1',
    'ERC20',
    '0xdac17f958d2ee523a2206206994597c13d831ec7',
    6,
    true,
    false,
    'ACTIVE'
  ),
  -- Solana Mainnet Native USDT
  (
    '20000000-0000-0000-0000-000000000016'::uuid,
    '10000000-0000-0000-0000-000000000006'::uuid,
    'solana',
    'solana-mainnet',
    'SPL',
    'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',
    6,
    true,
    false,
    'ACTIVE'
  ),
  -- NEAR Mainnet Native USDT
  (
    '20000000-0000-0000-0000-000000000017'::uuid,
    '10000000-0000-0000-0000-000000000006'::uuid,
    'near',
    'near-mainnet',
    'NEP141',
    'usdt.tether-token.near',
    6,
    true,
    false,
    'ACTIVE'
  )
ON CONFLICT (id) DO NOTHING;

COMMIT;

export type EcosystemFamily = "evm" | "solana" | "near";

export interface CatalogTokenDeployment {
  readonly id: string;
  readonly assetKey: string;
  readonly symbol: string;
  readonly name: string;
  readonly kind: "NATIVE" | "STABLECOIN" | "FUNGIBLE_TOKEN";
  readonly ecosystem: EcosystemFamily;
  readonly ecosystemLabel: string;
  readonly networkKey: string;
  readonly networkName: string;
  readonly environment: "mainnet" | "testnet";
  readonly standard: "NATIVE" | "ERC20" | "SPL" | "NEP141";
  readonly contractIdentifier: string;
  readonly decimals: number;
  readonly isDbSeeded: boolean;
}

export const ECOSYSTEM_METADATA: ReadonlyArray<{
  readonly family: EcosystemFamily;
  readonly label: string;
  readonly shortLabel: string;
  readonly networks: readonly [string, ...string[]];
  readonly addressFormatHint: string;
  readonly addressPlaceholder: string;
}> = [
  {
    family: "evm",
    label: "Ethereum / Base (EVM)",
    shortLabel: "Ethereum & Base",
    networks: ["ethereum-mainnet", "base-mainnet", "base-sepolia"],
    addressFormatHint:
      "0x-prefixed 20-byte hexadecimal address (42 characters)",
    addressPlaceholder: "0x71C...89A2 or Base / Ethereum 0x address",
  },
  {
    family: "solana",
    label: "Solana",
    shortLabel: "Solana",
    networks: ["solana-mainnet", "solana-devnet"],
    addressFormatHint: "Base58-encoded Ed25519 public key (32–44 characters)",
    addressPlaceholder: "7xKX...gAsU (Solana Base58 public key)",
  },
  {
    family: "near",
    label: "NEAR Protocol",
    shortLabel: "NEAR",
    networks: ["near-mainnet", "near-testnet"],
    addressFormatHint:
      "Named account (e.g. alice.near / alice.testnet) or 64-character hex implicit account",
    addressPlaceholder: "treasury.near or 64-char hex implicit address",
  },
] as const;

export const CURATED_SUPPORTED_DEPLOYMENTS: readonly [
  CatalogTokenDeployment,
  ...CatalogTokenDeployment[],
] = [
  // Ethereum Mainnet (EVM)
  {
    id: "ethereum-mainnet:ETH",
    assetKey: "eth",
    symbol: "ETH",
    name: "Ether",
    kind: "NATIVE",
    ecosystem: "evm",
    ecosystemLabel: "Ethereum / Base (EVM)",
    networkKey: "ethereum-mainnet",
    networkName: "Ethereum Mainnet",
    environment: "mainnet",
    standard: "NATIVE",
    contractIdentifier: "native",
    decimals: 18,
    isDbSeeded: false,
  },
  {
    id: "ethereum-mainnet:USDC",
    assetKey: "usdc",
    symbol: "USDC",
    name: "USD Coin",
    kind: "STABLECOIN",
    ecosystem: "evm",
    ecosystemLabel: "Ethereum / Base (EVM)",
    networkKey: "ethereum-mainnet",
    networkName: "Ethereum Mainnet",
    environment: "mainnet",
    standard: "ERC20",
    contractIdentifier: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
    decimals: 6,
    isDbSeeded: false,
  },
  {
    id: "ethereum-mainnet:USDT",
    assetKey: "usdt",
    symbol: "USDT",
    name: "Tether USD",
    kind: "STABLECOIN",
    ecosystem: "evm",
    ecosystemLabel: "Ethereum / Base (EVM)",
    networkKey: "ethereum-mainnet",
    networkName: "Ethereum Mainnet",
    environment: "mainnet",
    standard: "ERC20",
    contractIdentifier: "0xdac17f958d2ee523a2206206994597c13d831ec7",
    decimals: 6,
    isDbSeeded: false,
  },
  {
    id: "ethereum-mainnet:cbETH",
    assetKey: "cbeth",
    symbol: "cbETH",
    name: "Coinbase Wrapped Staked ETH",
    kind: "FUNGIBLE_TOKEN",
    ecosystem: "evm",
    ecosystemLabel: "Ethereum / Base (EVM)",
    networkKey: "ethereum-mainnet",
    networkName: "Ethereum Mainnet",
    environment: "mainnet",
    standard: "ERC20",
    contractIdentifier: "0xbe9895146f7af43049ca1c1ae358b0541ea49704",
    decimals: 18,
    isDbSeeded: false,
  },
  // Base Mainnet & Base Sepolia (EVM)
  {
    id: "base-mainnet:ETH",
    assetKey: "eth",
    symbol: "ETH",
    name: "Ether",
    kind: "NATIVE",
    ecosystem: "evm",
    ecosystemLabel: "Ethereum / Base (EVM)",
    networkKey: "base-mainnet",
    networkName: "Base",
    environment: "mainnet",
    standard: "NATIVE",
    contractIdentifier: "native",
    decimals: 18,
    isDbSeeded: true,
  },
  {
    id: "base-mainnet:USDC",
    assetKey: "usdc",
    symbol: "USDC",
    name: "USD Coin",
    kind: "STABLECOIN",
    ecosystem: "evm",
    ecosystemLabel: "Ethereum / Base (EVM)",
    networkKey: "base-mainnet",
    networkName: "Base",
    environment: "mainnet",
    standard: "ERC20",
    contractIdentifier: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
    decimals: 6,
    isDbSeeded: true,
  },
  {
    id: "base-mainnet:cbETH",
    assetKey: "cbeth",
    symbol: "cbETH",
    name: "Coinbase Wrapped Staked ETH",
    kind: "FUNGIBLE_TOKEN",
    ecosystem: "evm",
    ecosystemLabel: "Ethereum / Base (EVM)",
    networkKey: "base-mainnet",
    networkName: "Base",
    environment: "mainnet",
    standard: "ERC20",
    contractIdentifier: "0x2ae3f1ec7f1f5012cfeab0185bfc7aa3cf0dec22",
    decimals: 18,
    isDbSeeded: false,
  },
  {
    id: "base-mainnet:WETH",
    assetKey: "weth",
    symbol: "WETH",
    name: "Wrapped Ether",
    kind: "FUNGIBLE_TOKEN",
    ecosystem: "evm",
    ecosystemLabel: "Ethereum / Base (EVM)",
    networkKey: "base-mainnet",
    networkName: "Base",
    environment: "mainnet",
    standard: "ERC20",
    contractIdentifier: "0x4200000000000000000000000000000000000006",
    decimals: 18,
    isDbSeeded: false,
  },
  {
    id: "base-sepolia:ETH",
    assetKey: "eth",
    symbol: "ETH",
    name: "Ether (Base Sepolia)",
    kind: "NATIVE",
    ecosystem: "evm",
    ecosystemLabel: "Ethereum / Base (EVM)",
    networkKey: "base-sepolia",
    networkName: "Base Sepolia",
    environment: "testnet",
    standard: "NATIVE",
    contractIdentifier: "native",
    decimals: 18,
    isDbSeeded: true,
  },
  {
    id: "base-sepolia:USDC",
    assetKey: "usdc",
    symbol: "USDC",
    name: "USD Coin (Base Sepolia)",
    kind: "STABLECOIN",
    ecosystem: "evm",
    ecosystemLabel: "Ethereum / Base (EVM)",
    networkKey: "base-sepolia",
    networkName: "Base Sepolia",
    environment: "testnet",
    standard: "ERC20",
    contractIdentifier: "0x036cbd53842c5426634e7929541ec2318f3dcf7e",
    decimals: 6,
    isDbSeeded: true,
  },

  // Solana Mainnet & Devnet
  {
    id: "solana-mainnet:SOL",
    assetKey: "sol",
    symbol: "SOL",
    name: "Solana",
    kind: "NATIVE",
    ecosystem: "solana",
    ecosystemLabel: "Solana",
    networkKey: "solana-mainnet",
    networkName: "Solana",
    environment: "mainnet",
    standard: "NATIVE",
    contractIdentifier: "native",
    decimals: 9,
    isDbSeeded: true,
  },
  {
    id: "solana-mainnet:USDC",
    assetKey: "usdc",
    symbol: "USDC",
    name: "USD Coin (Solana)",
    kind: "STABLECOIN",
    ecosystem: "solana",
    ecosystemLabel: "Solana",
    networkKey: "solana-mainnet",
    networkName: "Solana",
    environment: "mainnet",
    standard: "SPL",
    contractIdentifier: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    decimals: 6,
    isDbSeeded: true,
  },
  {
    id: "solana-mainnet:USDT",
    assetKey: "usdt",
    symbol: "USDT",
    name: "Tether USD (Solana)",
    kind: "STABLECOIN",
    ecosystem: "solana",
    ecosystemLabel: "Solana",
    networkKey: "solana-mainnet",
    networkName: "Solana",
    environment: "mainnet",
    standard: "SPL",
    contractIdentifier: "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB",
    decimals: 6,
    isDbSeeded: false,
  },
  {
    id: "solana-mainnet:mSOL",
    assetKey: "msol",
    symbol: "mSOL",
    name: "Marinade Staked SOL",
    kind: "FUNGIBLE_TOKEN",
    ecosystem: "solana",
    ecosystemLabel: "Solana",
    networkKey: "solana-mainnet",
    networkName: "Solana",
    environment: "mainnet",
    standard: "SPL",
    contractIdentifier: "mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So",
    decimals: 9,
    isDbSeeded: false,
  },
  {
    id: "solana-mainnet:JUP",
    assetKey: "jup",
    symbol: "JUP",
    name: "Jupiter",
    kind: "FUNGIBLE_TOKEN",
    ecosystem: "solana",
    ecosystemLabel: "Solana",
    networkKey: "solana-mainnet",
    networkName: "Solana",
    environment: "mainnet",
    standard: "SPL",
    contractIdentifier: "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN",
    decimals: 6,
    isDbSeeded: false,
  },
  {
    id: "solana-mainnet:PYTH",
    assetKey: "pyth",
    symbol: "PYTH",
    name: "Pyth Network",
    kind: "FUNGIBLE_TOKEN",
    ecosystem: "solana",
    ecosystemLabel: "Solana",
    networkKey: "solana-mainnet",
    networkName: "Solana",
    environment: "mainnet",
    standard: "SPL",
    contractIdentifier: "HZ1JovNiVvGrGNiiYvEozEVgZ58xaU3RKwX8eACQBCt3",
    decimals: 6,
    isDbSeeded: false,
  },
  {
    id: "solana-devnet:SOL",
    assetKey: "sol",
    symbol: "SOL",
    name: "Solana (Devnet)",
    kind: "NATIVE",
    ecosystem: "solana",
    ecosystemLabel: "Solana",
    networkKey: "solana-devnet",
    networkName: "Solana Devnet",
    environment: "testnet",
    standard: "NATIVE",
    contractIdentifier: "native",
    decimals: 9,
    isDbSeeded: true,
  },
  {
    id: "solana-devnet:USDC",
    assetKey: "usdc",
    symbol: "USDC",
    name: "USD Coin (Solana Devnet)",
    kind: "STABLECOIN",
    ecosystem: "solana",
    ecosystemLabel: "Solana",
    networkKey: "solana-devnet",
    networkName: "Solana Devnet",
    environment: "testnet",
    standard: "SPL",
    contractIdentifier: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
    decimals: 6,
    isDbSeeded: true,
  },

  // NEAR Mainnet & Testnet
  {
    id: "near-mainnet:NEAR",
    assetKey: "near",
    symbol: "NEAR",
    name: "NEAR Protocol",
    kind: "NATIVE",
    ecosystem: "near",
    ecosystemLabel: "NEAR Protocol",
    networkKey: "near-mainnet",
    networkName: "NEAR Mainnet",
    environment: "mainnet",
    standard: "NATIVE",
    contractIdentifier: "native",
    decimals: 24,
    isDbSeeded: true,
  },
  {
    id: "near-mainnet:USDC",
    assetKey: "usdc",
    symbol: "USDC",
    name: "USD Coin (NEAR)",
    kind: "STABLECOIN",
    ecosystem: "near",
    ecosystemLabel: "NEAR Protocol",
    networkKey: "near-mainnet",
    networkName: "NEAR Mainnet",
    environment: "mainnet",
    standard: "NEP141",
    contractIdentifier:
      "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1",
    decimals: 6,
    isDbSeeded: true,
  },
  {
    id: "near-mainnet:USDT",
    assetKey: "usdt",
    symbol: "USDT",
    name: "Tether USD (NEAR)",
    kind: "STABLECOIN",
    ecosystem: "near",
    ecosystemLabel: "NEAR Protocol",
    networkKey: "near-mainnet",
    networkName: "NEAR Mainnet",
    environment: "mainnet",
    standard: "NEP141",
    contractIdentifier: "usdt.tether-token.near",
    decimals: 6,
    isDbSeeded: false,
  },
  {
    id: "near-mainnet:wNEAR",
    assetKey: "wnear",
    symbol: "wNEAR",
    name: "Wrapped NEAR",
    kind: "FUNGIBLE_TOKEN",
    ecosystem: "near",
    ecosystemLabel: "NEAR Protocol",
    networkKey: "near-mainnet",
    networkName: "NEAR Mainnet",
    environment: "mainnet",
    standard: "NEP141",
    contractIdentifier: "wrap.near",
    decimals: 24,
    isDbSeeded: false,
  },
  {
    id: "near-testnet:NEAR",
    assetKey: "near",
    symbol: "NEAR",
    name: "NEAR Protocol (Testnet)",
    kind: "NATIVE",
    ecosystem: "near",
    ecosystemLabel: "NEAR Protocol",
    networkKey: "near-testnet",
    networkName: "NEAR Testnet",
    environment: "testnet",
    standard: "NATIVE",
    contractIdentifier: "native",
    decimals: 24,
    isDbSeeded: true,
  },
  {
    id: "near-testnet:USDC",
    assetKey: "usdc",
    symbol: "USDC",
    name: "USD Coin (NEAR Testnet)",
    kind: "STABLECOIN",
    ecosystem: "near",
    ecosystemLabel: "NEAR Protocol",
    networkKey: "near-testnet",
    networkName: "NEAR Testnet",
    environment: "testnet",
    standard: "NEP141",
    contractIdentifier:
      "3e2210e1184b45b64c8a434c0a7e7b23cc04ea7eb7a6c3c32520d03d4afcb8af",
    decimals: 6,
    isDbSeeded: true,
  },
] as const;

export function getEcosystemForNetworkKey(networkKey: string): EcosystemFamily {
  const lower = networkKey.toLowerCase();
  if (lower.includes("sol")) return "solana";
  if (lower.includes("near")) return "near";
  return "evm";
}

export function validateEcosystemAddress(
  ecosystem: EcosystemFamily,
  rawAddress: string,
): { valid: boolean; reason?: string } {
  const trimmed = rawAddress.trim();
  if (!trimmed) {
    return { valid: false, reason: "Enter a recipient destination address." };
  }
  if (ecosystem === "evm") {
    if (/^0x[0-9a-fA-F]{40}$/.test(trimmed)) {
      return { valid: true };
    }
    return {
      valid: false,
      reason:
        "Ethereum & Base require a 0x-prefixed 40-character hexadecimal address.",
    };
  }
  if (ecosystem === "solana") {
    if (/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(trimmed)) {
      return { valid: true };
    }
    return {
      valid: false,
      reason: "Solana requires a valid Base58 public key (32–44 characters).",
    };
  }
  if (
    /^[0-9a-f]{64}$/.test(trimmed) ||
    /^(?=.{2,64}$)[a-z0-9_-]+(\.[a-z0-9_-]+)+$/.test(trimmed)
  ) {
    return { valid: true };
  }
  return {
    valid: false,
    reason:
      "NEAR requires a named account (e.g. name.near / name.testnet) or 64-character hex implicit account.",
  };
}

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

export function isTestnetEnabled(): boolean {
  if (typeof process === "undefined" || !process.env) return false;
  return process.env.SHOW_TESTNETS === "true";
}

export const MAINNET_ECOSYSTEM_METADATA: ReadonlyArray<{
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
    networks: ["ethereum-mainnet", "base-mainnet"],
    addressFormatHint:
      "0x-prefixed 20-byte hexadecimal address (42 characters)",
    addressPlaceholder: "0x71C...89A2 or Base / Ethereum 0x address",
  },
  {
    family: "solana",
    label: "Solana",
    shortLabel: "Solana",
    networks: ["solana-mainnet"],
    addressFormatHint: "Base58-encoded Ed25519 public key (32–44 characters)",
    addressPlaceholder: "7xKX...gAsU (Solana Base58 public key)",
  },
  {
    family: "near",
    label: "NEAR Protocol",
    shortLabel: "NEAR",
    networks: ["near-mainnet"],
    addressFormatHint:
      "Named account (e.g. alice.near) or 64-character hex implicit account",
    addressPlaceholder: "treasury.near or 64-char hex implicit address",
  },
] as const;

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
    networks: ["ethereum-mainnet", "base-mainnet"],
    addressFormatHint:
      "0x-prefixed 20-byte hexadecimal address (42 characters)",
    addressPlaceholder: "0x71C...89A2 or Base / Ethereum 0x address",
  },
  {
    family: "solana",
    label: "Solana",
    shortLabel: "Solana",
    networks: ["solana-mainnet"],
    addressFormatHint: "Base58-encoded Ed25519 public key (32–44 characters)",
    addressPlaceholder: "7xKX...gAsU (Solana Base58 public key)",
  },
  {
    family: "near",
    label: "NEAR Protocol",
    shortLabel: "NEAR",
    networks: ["near-mainnet"],
    addressFormatHint:
      "Named account (e.g. alice.near / alice.testnet) or 64-character hex implicit account",
    addressPlaceholder: "treasury.near or 64-char hex implicit address",
  },
] as const;

export const CURATED_SUPPORTED_DEPLOYMENTS: readonly [
  CatalogTokenDeployment,
  ...CatalogTokenDeployment[],
] = [
  // --------------------------------------------------------------------------
  // Ethereum Mainnet (Chain ID 1, EVM) — 3 Approved Assets
  // --------------------------------------------------------------------------
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
    isDbSeeded: true,
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
    isDbSeeded: true,
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
    isDbSeeded: true,
  },

  // --------------------------------------------------------------------------
  // Base Mainnet (Chain ID 8453, EVM) — 2 Approved Assets (ETH, USDC)
  // Note: USDT has no native Tether deployment on Base; wrapped tokens prohibited.
  // --------------------------------------------------------------------------
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

  // --------------------------------------------------------------------------
  // Solana Mainnet (solana-mainnet) — 3 Approved Assets (SOL, USDC, USDT)
  // --------------------------------------------------------------------------
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
    isDbSeeded: true,
  },

  // --------------------------------------------------------------------------
  // NEAR Mainnet (near-mainnet) — 3 Approved Assets (NEAR, USDC, USDT)
  // --------------------------------------------------------------------------
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
    isDbSeeded: true,
  },

  // --------------------------------------------------------------------------
  // Testnet Deployments (Retained for automated test suites)
  // --------------------------------------------------------------------------
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

/**
 * The 5 approved assets for the mainnet configuration.
 */
export const APPROVED_ASSET_SYMBOLS = [
  "USDT",
  "USDC",
  "NEAR",
  "SOL",
  "ETH",
] as const;
export type ApprovedAssetSymbol = (typeof APPROVED_ASSET_SYMBOLS)[number];

/**
 * The 4 approved networks for the mainnet configuration.
 */
export const APPROVED_MAINNET_NETWORKS = [
  "ethereum-mainnet",
  "base-mainnet",
  "solana-mainnet",
  "near-mainnet",
] as const;
export type ApprovedMainnetNetwork = (typeof APPROVED_MAINNET_NETWORKS)[number];

export type CanonicalNetworkId =
  | "ethereum-mainnet"
  | "base-mainnet"
  | "solana-mainnet"
  | "near-mainnet"
  | "base-sepolia"
  | "solana-devnet"
  | "near-testnet";

/**
 * Strict canonical network identifier mapping.
 * Normalizes synonyms for each approved chain into its canonical identity.
 * Strictly separates testnet identifiers and never normalizes testnets to mainnet.
 */
export function canonicalizeNetworkId(
  networkOrChain: string | null | undefined,
): CanonicalNetworkId | null {
  if (!networkOrChain) return null;
  const norm = networkOrChain.trim().toLowerCase();
  switch (norm) {
    // Ethereum Mainnet (Chain ID 1, EVM)
    case "ethereum":
    case "ethereum-mainnet":
    case "1":
    case "eip155:1":
      return "ethereum-mainnet";

    // Base Mainnet (Chain ID 8453, EVM)
    case "base":
    case "base-mainnet":
    case "8453":
    case "eip155:8453":
      return "base-mainnet";

    // Solana Mainnet
    case "solana":
    case "solana-mainnet":
    case "solana:mainnet":
      return "solana-mainnet";

    // NEAR Mainnet
    case "near":
    case "near-mainnet":
    case "near:mainnet":
      return "near-mainnet";

    // Testnet networks — explicitly separate, NEVER normalized to mainnet
    case "base-sepolia":
    case "84532":
    case "eip155:84532":
      return "base-sepolia";

    case "solana-devnet":
    case "solana:devnet":
      return "solana-devnet";

    case "near-testnet":
    case "near:testnet":
      return "near-testnet";

    default:
      return null;
  }
}

/**
 * Returns equivalent database network tokens for a given network identifier,
 * based on strict canonical network identity.
 * Testnets are never normalized to mainnet.
 */
export function getEquivalentNetworkTokens(
  networkOrChain: string | null | undefined,
): string[] {
  const canonical = canonicalizeNetworkId(networkOrChain);
  switch (canonical) {
    case "base-mainnet":
      return ["base", "base-mainnet"];
    case "ethereum-mainnet":
      return ["ethereum", "ethereum-mainnet"];
    case "solana-mainnet":
      return ["solana", "solana-mainnet"];
    case "near-mainnet":
      return ["near", "near-mainnet"];
    case "base-sepolia":
      return ["base-sepolia"];
    case "solana-devnet":
      return ["solana-devnet"];
    case "near-testnet":
      return ["near-testnet"];
    default:
      return networkOrChain ? [networkOrChain] : [];
  }
}

export const MAINNET_SUPPORTED_DEPLOYMENTS: readonly [
  CatalogTokenDeployment,
  ...CatalogTokenDeployment[],
] = CURATED_SUPPORTED_DEPLOYMENTS.filter(
  (d) => d.environment === "mainnet",
) as unknown as readonly [CatalogTokenDeployment, ...CatalogTokenDeployment[]];

export function getActiveDeployments(
  includeTestnets?: boolean,
): readonly CatalogTokenDeployment[] {
  const allow = includeTestnets ?? isTestnetEnabled();
  return allow ? CURATED_SUPPORTED_DEPLOYMENTS : MAINNET_SUPPORTED_DEPLOYMENTS;
}

/**
 * Returns canonical list of supported mainnet networks for a given asset symbol or asset key.
 * Strictly excludes testnets by default unless testnets are explicitly enabled.
 */
export function getSupportedNetworksForAsset(
  assetKeyOrSymbol: string,
  includeTestnets?: boolean,
): readonly string[] {
  const norm = assetKeyOrSymbol.trim().toUpperCase();
  const allowTestnets = includeTestnets ?? isTestnetEnabled();
  switch (norm) {
    case "ETH":
      return allowTestnets
        ? ["ethereum-mainnet", "base-mainnet", "base-sepolia"]
        : ["ethereum-mainnet", "base-mainnet"];
    case "USDC":
      return allowTestnets
        ? [
            "ethereum-mainnet",
            "base-mainnet",
            "solana-mainnet",
            "near-mainnet",
            "base-sepolia",
            "solana-devnet",
            "near-testnet",
          ]
        : [
            "ethereum-mainnet",
            "base-mainnet",
            "solana-mainnet",
            "near-mainnet",
          ];
    case "USDT":
      return ["ethereum-mainnet", "solana-mainnet", "near-mainnet"];
    case "SOL":
      return allowTestnets
        ? ["solana-mainnet", "solana-devnet"]
        : ["solana-mainnet"];
    case "NEAR":
      return allowTestnets
        ? ["near-mainnet", "near-testnet"]
        : ["near-mainnet"];
    default:
      return [];
  }
}

/**
 * Validates whether an asset symbol is supported on the specified network.
 */
export function isAssetSupportedOnNetwork(
  assetKeyOrSymbol: string,
  networkKey: string,
  includeTestnets?: boolean,
): boolean {
  const supported = getSupportedNetworksForAsset(
    assetKeyOrSymbol,
    includeTestnets,
  );
  return supported.includes(networkKey);
}

/**
 * Returns all curated deployments for a given asset symbol.
 */
export function getCanonicalDeploymentsForAsset(
  assetKeyOrSymbol: string,
): CatalogTokenDeployment[] {
  const norm = assetKeyOrSymbol.trim().toUpperCase();
  return CURATED_SUPPORTED_DEPLOYMENTS.filter(
    (d) => d.symbol.toUpperCase() === norm,
  );
}

export function getEcosystemForNetworkKey(networkKey: string): EcosystemFamily {
  const canonical = canonicalizeNetworkId(networkKey);
  if (canonical === "solana-mainnet" || canonical === "solana-devnet") {
    return "solana";
  }
  if (canonical === "near-mainnet" || canonical === "near-testnet") {
    return "near";
  }
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

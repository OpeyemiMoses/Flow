import {
  canonicalizeNetworkId,
  MAINNET_SUPPORTED_DEPLOYMENTS,
} from "../../domain/supported-assets-catalog.ts";

export type TokenCapability =
  | "DISCOVERABLE_BY_PROVIDER"
  | "QUOTABLE"
  | "CAN_PAY_FROM"
  | "CAN_RECEIVE_TO"
  | "CAN_DIRECT_DEPOSIT"
  | "CAN_HOLD_IN_FLOW"
  | "CAN_SEND_FROM_FLOW"
  | "CAN_SWAP_TO_NEAR";

export interface DiscoveredToken {
  readonly id: string;
  readonly assetId: string;
  readonly symbol: string;
  readonly name: string;
  readonly decimals: number;
  readonly networkKey: string;
  readonly networkName: string;
  readonly ecosystem: "evm" | "solana" | "near" | "other";
  readonly standard: "NATIVE" | "ERC20" | "SPL" | "NEP141" | "OTHER";
  readonly contractAddress: string | null;
  readonly priceUsd: number | null;
  readonly priceUpdatedAt: string | null;
  readonly isNative: boolean;
  readonly isWrapped: boolean;
  readonly capabilities: readonly TokenCapability[];
}

export interface Raw1ClickToken {
  readonly assetId: string;
  readonly decimals: number;
  readonly blockchain: string;
  readonly symbol: string;
  readonly price?: number | null;
  readonly priceUpdatedAt?: string | null;
  readonly contractAddress?: string | null;
  readonly coingeckoId?: string | null;
}

const CHAIN_MAPPING: Record<
  string,
  {
    networkKey: string;
    networkName: string;
    ecosystem: "evm" | "solana" | "near" | "other";
  }
> = {
  near: { networkKey: "near-mainnet", networkName: "NEAR", ecosystem: "near" },
  base: { networkKey: "base-mainnet", networkName: "Base", ecosystem: "evm" },
  eth: {
    networkKey: "ethereum-mainnet",
    networkName: "Ethereum",
    ecosystem: "evm",
  },
  sol: {
    networkKey: "solana-mainnet",
    networkName: "Solana",
    ecosystem: "solana",
  },
  arb: {
    networkKey: "arbitrum-mainnet",
    networkName: "Arbitrum",
    ecosystem: "evm",
  },
  op: {
    networkKey: "optimism-mainnet",
    networkName: "Optimism",
    ecosystem: "evm",
  },
  pol: {
    networkKey: "polygon-mainnet",
    networkName: "Polygon",
    ecosystem: "evm",
  },
  avax: {
    networkKey: "avalanche-mainnet",
    networkName: "Avalanche",
    ecosystem: "evm",
  },
  btc: {
    networkKey: "bitcoin-mainnet",
    networkName: "Bitcoin",
    ecosystem: "other",
  },
  sui: { networkKey: "sui-mainnet", networkName: "Sui", ecosystem: "other" },
  tron: { networkKey: "tron-mainnet", networkName: "Tron", ecosystem: "other" },
  aptos: {
    networkKey: "aptos-mainnet",
    networkName: "Aptos",
    ecosystem: "other",
  },
  bsc: {
    networkKey: "binance-smart-chain",
    networkName: "BNB Chain",
    ecosystem: "evm",
  },
};

/**
 * Known user-facing wrapped tokens that should be excluded from customer selectors
 * per owner directive (e.g. WETH, WBTC, wNEAR).
 * Solver-internal omnibus representations (.omft.near) are NOT excluded.
 */
const EXCLUDED_WRAPPED_SYMBOLS = new Set([
  "WETH",
  "WNEAR",
  "WBTC",
  "WSOL",
  "WMATIC",
  "WAVAX",
  "WBNB",
  "WFTM",
]);

let cachedTokens: DiscoveredToken[] | null = null;
let cacheExpiresAt = 0;
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Returns whether a symbol represents a user-facing wrapped derivative.
 */
export function isUserFacingWrappedToken(
  symbol: string,
  coingeckoId?: string | null,
): boolean {
  const norm = symbol.trim().toUpperCase();
  if (EXCLUDED_WRAPPED_SYMBOLS.has(norm)) return true;
  if (coingeckoId && coingeckoId.startsWith("wrapped-")) return true;
  if (
    norm.startsWith("W") &&
    norm.length >= 4 &&
    norm !== "WAL" &&
    norm !== "WIF"
  ) {
    // Check common wrapped tokens
    if (["WETH", "WBTC", "WNEAR", "WSOL", "WAVAX", "WBNB"].includes(norm)) {
      return true;
    }
  }
  return false;
}

/**
 * Maps raw 1Click token response into a DiscoveredToken with verified capability flags.
 */
export function normalizeDiscoveredToken(raw: Raw1ClickToken): DiscoveredToken {
  const chainInfo = CHAIN_MAPPING[raw.blockchain.toLowerCase()] ?? {
    networkKey: `${raw.blockchain.toLowerCase()}-mainnet`,
    networkName: raw.blockchain.toUpperCase(),
    ecosystem: "other" as const,
  };

  const isNative =
    !raw.contractAddress ||
    raw.contractAddress.trim() === "" ||
    raw.contractAddress.toLowerCase() === "native";

  let standard: "NATIVE" | "ERC20" | "SPL" | "NEP141" | "OTHER" = "OTHER";
  if (isNative) {
    standard = "NATIVE";
  } else if (chainInfo.ecosystem === "evm") {
    standard = "ERC20";
  } else if (chainInfo.ecosystem === "solana") {
    standard = "SPL";
  } else if (chainInfo.ecosystem === "near") {
    standard = "NEP141";
  }

  const isWrapped = isUserFacingWrappedToken(raw.symbol, raw.coingeckoId);

  // Check if token matches one of the 11 verified FLOW custody deployments
  const custodyMatch = MAINNET_SUPPORTED_DEPLOYMENTS.find((d) => {
    if (
      canonicalizeNetworkId(d.networkKey) !==
      canonicalizeNetworkId(chainInfo.networkKey)
    ) {
      return false;
    }
    if (d.symbol.toUpperCase() !== raw.symbol.toUpperCase()) {
      return false;
    }
    if (d.standard === "NATIVE" && isNative) {
      return true;
    }
    if (
      d.contractIdentifier &&
      raw.contractAddress &&
      d.contractIdentifier.toLowerCase() === raw.contractAddress.toLowerCase()
    ) {
      return true;
    }
    return false;
  });

  const capabilities: TokenCapability[] = [
    "DISCOVERABLE_BY_PROVIDER",
    "QUOTABLE",
  ];

  if (!isWrapped) {
    capabilities.push("CAN_PAY_FROM");
  }

  if (custodyMatch) {
    capabilities.push("CAN_RECEIVE_TO");
    capabilities.push("CAN_DIRECT_DEPOSIT");
    capabilities.push("CAN_HOLD_IN_FLOW");
    capabilities.push("CAN_SEND_FROM_FLOW");
    if (custodyMatch.id !== "near-mainnet:NEAR") {
      capabilities.push("CAN_SWAP_TO_NEAR");
    }
  }

  const id = custodyMatch
    ? custodyMatch.id
    : `${chainInfo.networkKey}:${raw.symbol}`;

  return {
    id,
    assetId: raw.assetId,
    symbol: raw.symbol,
    name: custodyMatch
      ? custodyMatch.name
      : `${raw.symbol} (${chainInfo.networkName})`,
    decimals: raw.decimals,
    networkKey: chainInfo.networkKey,
    networkName: chainInfo.networkName,
    ecosystem: chainInfo.ecosystem,
    standard,
    contractAddress: raw.contractAddress ?? null,
    priceUsd: raw.price ?? null,
    priceUpdatedAt: raw.priceUpdatedAt ?? null,
    isNative,
    isWrapped,
    capabilities,
  };
}

/**
 * Returns static fallback tokens derived from the 11 verified mainnet deployments
 * if the remote 1Click tokens endpoint is down or unreachable.
 */
export function getStaticFallbackTokens(): DiscoveredToken[] {
  return MAINNET_SUPPORTED_DEPLOYMENTS.map((d) => {
    const isNative = d.standard === "NATIVE";
    const capabilities: TokenCapability[] = [
      "DISCOVERABLE_BY_PROVIDER",
      "QUOTABLE",
      "CAN_PAY_FROM",
      "CAN_RECEIVE_TO",
      "CAN_DIRECT_DEPOSIT",
      "CAN_HOLD_IN_FLOW",
      "CAN_SEND_FROM_FLOW",
    ];
    if (d.id !== "near-mainnet:NEAR") {
      capabilities.push("CAN_SWAP_TO_NEAR");
    }

    return {
      id: d.id,
      assetId: d.contractIdentifier,
      symbol: d.symbol,
      name: d.name,
      decimals: d.decimals,
      networkKey: d.networkKey,
      networkName: d.networkName,
      ecosystem: d.ecosystem,
      standard: d.standard as "NATIVE" | "ERC20" | "SPL" | "NEP141",
      contractAddress: isNative ? null : d.contractIdentifier,
      priceUsd: d.kind === "STABLECOIN" ? 1.0 : null,
      priceUpdatedAt: new Date().toISOString(),
      isNative,
      isWrapped: false,
      capabilities,
    };
  });
}

/**
 * Fetches dynamic tokens from 1Click endpoint with TTL caching and fallback.
 */
export async function getDiscoveredTokens(options?: {
  forceRefresh?: boolean;
  excludeWrapped?: boolean;
}): Promise<DiscoveredToken[]> {
  const now = Date.now();
  if (!options?.forceRefresh && cachedTokens && now < cacheExpiresAt) {
    return options?.excludeWrapped
      ? cachedTokens.filter((t) => !t.isWrapped)
      : cachedTokens;
  }

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 6000);
    const res = await fetch("https://1click.chaindefuser.com/v0/tokens", {
      headers: { Accept: "application/json" },
      signal: controller.signal,
      cache: "no-store",
    });
    clearTimeout(timeout);

    if (!res.ok) {
      throw new Error(`1Click tokens endpoint returned HTTP ${res.status}`);
    }

    const data: Raw1ClickToken[] = await res.json();
    if (!Array.isArray(data) || data.length === 0) {
      throw new Error("Empty or malformed token list returned by 1Click");
    }

    const normalized = data.map(normalizeDiscoveredToken);

    // Merge in any of our 11 curated deployments if missing from provider
    const fallback = getStaticFallbackTokens();
    const existingIds = new Set(normalized.map((t) => t.id));
    for (const fb of fallback) {
      if (!existingIds.has(fb.id)) {
        normalized.push(fb);
      }
    }

    cachedTokens = normalized;
    cacheExpiresAt = now + CACHE_TTL_MS;

    return options?.excludeWrapped
      ? normalized.filter((t) => !t.isWrapped)
      : normalized;
  } catch {
    // If cache already exists, return it despite error
    if (cachedTokens) {
      return options?.excludeWrapped
        ? cachedTokens.filter((t) => !t.isWrapped)
        : cachedTokens;
    }
    // Otherwise fallback to static verified catalog
    const fallback = getStaticFallbackTokens();
    return options?.excludeWrapped
      ? fallback.filter((t) => !t.isWrapped)
      : fallback;
  }
}

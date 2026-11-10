import { FlowError } from "../foundation/errors.ts";

export type AssetKind = "NATIVE" | "FUNGIBLE_TOKEN";

export type TokenStandard =
  "NATIVE" | "NEP141" | "ERC20" | "SPL" | "TOKEN_2022";

export type NetworkId = "near" | "base" | "solana" | "ethereum";

export type SyncStatus =
  "NOT_SYNCED" | "SYNCED" | "STALE" | "UNAVAILABLE" | "ERROR";

export type BalanceFinality = "FINALIZED" | "CONFIRMED" | "SAFE" | "UNKNOWN";

export interface AssetDefinition {
  readonly id: string;
  readonly symbol: string;
  readonly name: string;
  readonly kind: AssetKind;
  readonly description?: string | null;
  readonly iconUrl?: string | null;
}

export interface NetworkAssetDeployment {
  readonly id: string;
  readonly assetId: string;
  readonly network: NetworkId;
  readonly chainId: string;
  readonly tokenStandard: TokenStandard;
  readonly contractAddress: string | null;
  readonly decimals: number;
  readonly symbolOverride?: string | null;
  readonly nameOverride?: string | null;
  readonly isVerified: boolean;
  readonly isDepositEligible: boolean;
  readonly status: "ACTIVE" | "DEPRECATED" | "UNSUPPORTED";
}

export interface NetworkAssetWithAsset extends NetworkAssetDeployment {
  readonly asset: AssetDefinition;
}

export interface WalletBalanceRecord {
  readonly id: string;
  readonly walletId: string;
  readonly networkAssetId: string;
  readonly tokenAccountAddress: string | null;
  readonly atomicBalance: bigint;
  readonly displayBalance: string;
  readonly blockHeight: bigint | null;
  readonly blockTimestamp: Date | null;
  readonly observedAt: Date;
  readonly finality: BalanceFinality;
  readonly syncStatus: SyncStatus;
  readonly isZeroConfirmed: boolean;
  readonly lastSyncedAt: Date | null;
  readonly lastError: string | null;
  readonly networkAsset: NetworkAssetWithAsset;
}

export interface WalletAddressProjection {
  readonly network: NetworkId;
  readonly chainId: string;
  readonly address: string;
  readonly publicKey?: string | null;
}

export interface AccountPortfolioProjection {
  readonly accountId: string;
  readonly wallet: {
    readonly id: string;
    readonly environment: string;
    readonly isTestnet: boolean;
    readonly status: string;
    readonly policyState: string;
    readonly eligibleForDeposits: boolean;
    readonly depositWarning: string | null;
    readonly addresses: ReadonlyArray<WalletAddressProjection>;
  } | null;
  readonly balances: ReadonlyArray<WalletBalanceRecord>;
  readonly lastSyncedAt?: Date | null;
  readonly isStale?: boolean;
}

export const VALID_NETWORKS: ReadonlySet<string> = new Set([
  "near",
  "base",
  "solana",
  "ethereum",
]);
export const VALID_TOKEN_STANDARDS: ReadonlySet<string> = new Set([
  "NATIVE",
  "NEP141",
  "ERC20",
  "SPL",
  "TOKEN_2022",
]);
export const VALID_SYNC_STATUSES: ReadonlySet<string> = new Set([
  "NOT_SYNCED",
  "SYNCED",
  "STALE",
  "UNAVAILABLE",
  "ERROR",
]);
export const VALID_FINALITIES: ReadonlySet<string> = new Set([
  "FINALIZED",
  "CONFIRMED",
  "SAFE",
  "UNKNOWN",
]);

export function assertValidNetwork(
  network: string,
): asserts network is NetworkId {
  if (!VALID_NETWORKS.has(network)) {
    throw new FlowError(
      "INVALID_CONFIGURATION",
      `Unsupported network identifier: ${network}. Allowed: near, base, solana.`,
    );
  }
}

export function assertValidTokenStandard(
  standard: string,
): asserts standard is TokenStandard {
  if (!VALID_TOKEN_STANDARDS.has(standard)) {
    throw new FlowError(
      "INVALID_CONFIGURATION",
      `Unsupported token standard: ${standard}.`,
    );
  }
}

export function assertValidSyncStatus(
  status: string,
): asserts status is SyncStatus {
  if (!VALID_SYNC_STATUSES.has(status)) {
    throw new FlowError(
      "INVALID_CONFIGURATION",
      `Invalid balance sync status: ${status}.`,
    );
  }
}

export function assertValidFinality(
  finality: string,
): asserts finality is BalanceFinality {
  if (!VALID_FINALITIES.has(finality)) {
    throw new FlowError(
      "INVALID_CONFIGURATION",
      `Invalid balance finality: ${finality}.`,
    );
  }
}

export type ObservationState =
  | "CONFIRMED_ZERO"
  | "ACCOUNT_NONEXISTENT"
  | "TOKEN_ACCOUNT_ABSENT"
  | "UNSUPPORTED_TOKEN"
  | "RPC_ERROR"
  | "SYNCED";

export interface BalanceObservation {
  readonly networkAssetId: string;
  readonly tokenAccountAddress?: string | null;
  readonly atomicBalance: bigint;
  readonly blockHeight?: bigint | null;
  readonly blockTimestamp?: Date | null;
  readonly observedAt: Date;
  readonly finality: BalanceFinality;
  readonly syncStatus: SyncStatus;
  readonly observationState: ObservationState;
  readonly chainIdVerified: boolean;
  readonly endpointUsed: string;
  readonly lastError?: string | null;
}

export function isTestnetChain(chainId: string): boolean {
  return (
    chainId === "near-testnet" ||
    chainId === "84532" ||
    chainId === "solana-devnet"
  );
}

export function assertWalletChainConsistency(
  walletEnv: string,
  chainId: string,
): void {
  const isTestnet = isTestnetChain(chainId);
  if (walletEnv === "testnet" && !isTestnet) {
    throw new FlowError(
      "INVALID_CONFIGURATION",
      `Environment mismatch: testnet wallet cannot hold balances for mainnet chain ${chainId}.`,
    );
  }
  if (walletEnv === "mainnet" && isTestnet) {
    throw new FlowError(
      "INVALID_CONFIGURATION",
      `Environment mismatch: mainnet wallet cannot hold balances for testnet chain ${chainId}.`,
    );
  }
}

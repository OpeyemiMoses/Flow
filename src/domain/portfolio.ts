import {
  type AccountPortfolioProjection,
  type WalletAddressProjection,
} from "./assets.ts";

export interface SerializedWalletBalanceRecord {
  readonly id: string;
  readonly walletId: string;
  readonly networkAssetId: string;
  readonly tokenAccountAddress: string | null;
  readonly atomicBalance: string;
  readonly displayBalance: string;
  readonly blockHeight: string | null;
  readonly blockTimestamp: string | null;
  readonly observedAt: string;
  readonly finality: string;
  readonly syncStatus: string;
  readonly isZeroConfirmed: boolean;
  readonly lastSyncedAt: string | null;
  readonly lastError: string | null;
  readonly networkAsset: {
    readonly id: string;
    readonly assetId: string;
    readonly network: string;
    readonly chainId: string;
    readonly tokenStandard: string;
    readonly contractAddress: string | null;
    readonly decimals: number;
    readonly symbolOverride: string | null;
    readonly nameOverride: string | null;
    readonly isVerified: boolean;
    readonly isDepositEligible: boolean;
    readonly status: string;
    readonly asset: {
      readonly id: string;
      readonly symbol: string;
      readonly name: string;
      readonly kind: string;
      readonly description: string | null;
      readonly iconUrl: string | null;
    };
  };
}

export interface SerializedAccountPortfolio {
  readonly accountId: string;
  readonly wallet: {
    readonly id: string;
    readonly status: string;
    readonly environment: string;
    readonly policy: string;
    readonly executionDisabled: boolean;
    readonly depositEligible: boolean;
    readonly transferEligible: boolean;
    readonly disclaimer: string;
    readonly addresses: readonly WalletAddressProjection[];
  } | null;
  readonly balances: readonly SerializedWalletBalanceRecord[];
  readonly lastSyncedAt: string | null;
  readonly isStale: boolean;
  readonly cooldownRemainingSeconds?: number;
}

export const REFRESH_COOLDOWN_MS = 15_000;

export function serializePortfolio(
  projection: AccountPortfolioProjection,
): SerializedAccountPortfolio {
  return {
    accountId: projection.accountId,
    wallet: projection.wallet
      ? {
          id: projection.wallet.id,
          status: projection.wallet.status,
          environment: projection.wallet.environment,
          policy: projection.wallet.policyState,
          executionDisabled: true,
          depositEligible: !projection.wallet.isTestnet,
          transferEligible: false,
          disclaimer: projection.wallet.isTestnet
            ? "This testnet wallet is in PROVISIONING state with execution disabled. It is strictly ineligible for deposits, transfers, or execution. Testnet assets have no monetary value."
            : "Mainnet custody wallet. Inbound payments verified on-chain. Outgoing transfer execution is disabled by security policy.",
          addresses: projection.wallet.addresses ?? [],
        }
      : null,
    balances: projection.balances.map((b) => ({
      id: b.id,
      walletId: b.walletId,
      networkAssetId: b.networkAssetId,
      tokenAccountAddress: b.tokenAccountAddress,
      atomicBalance: b.atomicBalance.toString(),
      displayBalance: b.displayBalance,
      blockHeight: b.blockHeight !== null ? b.blockHeight.toString() : null,
      blockTimestamp: b.blockTimestamp ? b.blockTimestamp.toISOString() : null,
      observedAt: b.observedAt.toISOString(),
      finality: b.finality,
      syncStatus: b.syncStatus,
      isZeroConfirmed: b.isZeroConfirmed,
      lastSyncedAt: b.lastSyncedAt ? b.lastSyncedAt.toISOString() : null,
      lastError: b.lastError,
      networkAsset: {
        id: b.networkAsset.id,
        assetId: b.networkAsset.assetId,
        network: b.networkAsset.network,
        chainId: b.networkAsset.chainId,
        tokenStandard: b.networkAsset.tokenStandard,
        contractAddress: b.networkAsset.contractAddress,
        decimals: b.networkAsset.decimals,
        symbolOverride: b.networkAsset.symbolOverride ?? null,
        nameOverride: b.networkAsset.nameOverride ?? null,
        isVerified: b.networkAsset.isVerified,
        isDepositEligible: b.networkAsset.isDepositEligible,
        status: b.networkAsset.status,
        asset: {
          id: b.networkAsset.asset.id,
          symbol: b.networkAsset.asset.symbol,
          name: b.networkAsset.asset.name,
          kind: b.networkAsset.asset.kind,
          description: b.networkAsset.asset.description ?? null,
          iconUrl: b.networkAsset.asset.iconUrl ?? null,
        },
      },
    })),
    lastSyncedAt: projection.lastSyncedAt
      ? projection.lastSyncedAt.toISOString()
      : null,
    isStale: projection.isStale ?? false,
  };
}

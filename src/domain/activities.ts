import { formatAtomicToDisplay } from "./atomic-amounts.ts";

export type ActivityType =
  | "ON_CHAIN_TRANSFER"
  | "ON_CHAIN_INTERACTION"
  | "FLOW_PAYMENT"
  | "FLOW_CONVERT"
  | "FLOW_CROSS_CHAIN_SETTLEMENT";

export type ActivityDirection = "INCOMING" | "OUTGOING" | "SELF" | "INTERNAL";

export type ActivityFinality = "FINALIZED" | "CONFIRMED" | "PENDING";

export type ReorgStatus = "CANONICAL" | "REORGED" | "ORPHANED";

export interface WalletActivityRecord {
  readonly id: string;
  readonly accountId: string;
  readonly walletId: string;
  readonly network: string;
  readonly chainId: string;
  readonly ecosystem: string;
  readonly activityType: ActivityType;
  readonly direction: ActivityDirection;
  readonly txHash: string;
  readonly eventIndex: number;
  readonly fromAddress: string;
  readonly toAddress: string;
  readonly assetId: string | null;
  readonly networkAssetId: string | null;
  readonly assetSymbol: string;
  readonly atomicAmount: bigint;
  readonly decimals: number;
  readonly blockHeight: bigint | null;
  readonly blockHash: string | null;
  readonly blockTimestamp: Date | null;
  readonly finality: ActivityFinality;
  readonly reorgStatus: ReorgStatus;
  readonly feeAtomicAmount: bigint | null;
  readonly metadata: Record<string, unknown>;
  readonly observedAt: Date;
  readonly createdAt?: Date;
  readonly updatedAt?: Date;
}

export interface SerializedWalletActivityRecord {
  readonly id: string;
  readonly accountId: string;
  readonly walletId: string;
  readonly network: string;
  readonly chainId: string;
  readonly ecosystem: string;
  readonly activityType: ActivityType;
  readonly direction: ActivityDirection;
  readonly txHash: string;
  readonly eventIndex: number;
  readonly fromAddress: string;
  readonly toAddress: string;
  readonly assetId: string | null;
  readonly networkAssetId: string | null;
  readonly assetSymbol: string;
  readonly atomicAmount: string;
  readonly displayAmount: string;
  readonly decimals: number;
  readonly blockHeight: string | null;
  readonly blockHash: string | null;
  readonly blockTimestamp: string | null;
  readonly finality: ActivityFinality;
  readonly reorgStatus: ReorgStatus;
  readonly feeAtomicAmount: string | null;
  readonly metadata: Record<string, unknown>;
  readonly observedAt: string;
  readonly explorerUrl: string;
}

export interface ActivityListQuery {
  readonly limit?: number;
  readonly offset?: number;
  readonly cursor?: string;
  readonly network?: string;
  readonly direction?: ActivityDirection;
  readonly activityType?: ActivityType;
  readonly assetSymbol?: string;
}

export interface ActivityFeedResponse {
  readonly activities: SerializedWalletActivityRecord[];
  readonly total: number;
  readonly limit: number;
  readonly offset: number;
  readonly hasMore: boolean;
  readonly nextCursor?: string | null;
  readonly totalCount?: number;
}

/**
 * Returns the public block explorer URL for a given transaction hash and network/chainId.
 */
export function getExplorerUrl(
  network: string,
  chainIdOrTxHash: string,
  maybeTxHash?: string,
): string {
  const txHash = maybeTxHash ?? chainIdOrTxHash;
  const chainId = maybeTxHash ? chainIdOrTxHash : "";
  const cleanHash = txHash.trim();

  const net = network.toLowerCase();
  const chain = chainId.toLowerCase();

  if (net === "base" || chain === "84532" || chain === "8453") {
    if (chain === "84532" || net.includes("sepolia")) {
      return `https://sepolia.basescan.org/tx/${cleanHash}`;
    }
    return `https://basescan.org/tx/${cleanHash}`;
  }

  if (net === "ethereum" || chain === "1") {
    return `https://etherscan.io/tx/${cleanHash}`;
  }

  if (net === "solana") {
    if (chain === "solana-devnet" || chain.includes("devnet")) {
      return `https://solscan.io/tx/${cleanHash}?cluster=devnet`;
    }
    return `https://solscan.io/tx/${cleanHash}`;
  }

  if (net === "near") {
    if (chain === "near-testnet" || chain.includes("testnet")) {
      return `https://testnet.nearblocks.io/txns/${cleanHash}`;
    }
    return `https://nearblocks.io/txns/${cleanHash}`;
  }

  return `#tx-${cleanHash}`;
}

/**
 * Serializes a raw WalletActivityRecord for safe JSON transport over the API.
 */
export function serializeActivity(
  record: WalletActivityRecord,
): SerializedWalletActivityRecord {
  const displayAmount = formatAtomicToDisplay(
    record.atomicAmount,
    record.decimals,
  );

  return {
    id: record.id,
    accountId: record.accountId,
    walletId: record.walletId,
    network: record.network,
    chainId: record.chainId,
    ecosystem: record.ecosystem,
    activityType: record.activityType,
    direction: record.direction,
    txHash: record.txHash,
    eventIndex: record.eventIndex,
    fromAddress: record.fromAddress,
    toAddress: record.toAddress,
    assetId: record.assetId,
    networkAssetId: record.networkAssetId,
    assetSymbol: record.assetSymbol,
    atomicAmount: record.atomicAmount.toString(),
    displayAmount,
    decimals: record.decimals,
    blockHeight:
      record.blockHeight !== null ? record.blockHeight.toString() : null,
    blockHash: record.blockHash,
    blockTimestamp: record.blockTimestamp
      ? record.blockTimestamp.toISOString()
      : null,
    finality: record.finality,
    reorgStatus: record.reorgStatus,
    feeAtomicAmount:
      record.feeAtomicAmount !== null
        ? record.feeAtomicAmount.toString()
        : null,
    metadata: record.metadata,
    observedAt: record.observedAt.toISOString(),
    explorerUrl: getExplorerUrl(record.network, record.chainId, record.txHash),
  };
}

export function serializeActivities(
  records: ReadonlyArray<WalletActivityRecord>,
): SerializedWalletActivityRecord[] {
  return records.map(serializeActivity);
}

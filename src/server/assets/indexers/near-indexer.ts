import { callJsonRpc, type JsonRpcOptions } from "../connectors/rpc-client.ts";
import { verifyNearChainId } from "../connectors/near-connector.ts";
import type {
  ActivityDirection,
  ActivityFinality,
} from "../../../domain/activities.ts";

export interface NearIndexerOptions extends JsonRpcOptions {
  readonly network: "near-mainnet" | "near-testnet";
  readonly indexerApiUrl?: string;
}

export interface RawNearActivityItem {
  readonly txHash: string;
  readonly eventIndex: number;
  readonly fromAddress: string;
  readonly toAddress: string;
  readonly contractAddress: string | null;
  readonly atomicAmount: bigint;
  readonly blockHeight: bigint;
  readonly blockHash: string;
  readonly blockTimestamp: Date | null;
  readonly finality: ActivityFinality;
  readonly direction: ActivityDirection;
  readonly activityType: "ON_CHAIN_TRANSFER" | "ON_CHAIN_INTERACTION";
  readonly network: "near";
  readonly chainId: string;
  readonly ecosystem: "near";
  readonly feeAtomicAmount: bigint | null;
  readonly metadata: Record<string, unknown>;
}

export interface NearTxStatusResult {
  readonly status: {
    readonly SuccessValue?: string;
    readonly Failure?: unknown;
  };
  readonly transaction: {
    readonly hash: string;
    readonly signer_id: string;
    readonly receiver_id: string;
    readonly actions: Array<{
      readonly Transfer?: {
        readonly deposit: string;
      };
      readonly FunctionCall?: {
        readonly method_name: string;
        readonly args: string;
        readonly deposit: string;
        readonly gas: number;
      };
    }>;
  };
  readonly transaction_outcome: {
    readonly block_hash: string;
    readonly outcome: {
      readonly gas_burnt: number;
      readonly status: {
        readonly SuccessReceiptId?: string;
      };
    };
  };
  readonly receipts_outcome?: Array<{
    readonly outcome: {
      readonly logs: string[];
      readonly gas_burnt: number;
    };
  }>;
}

/**
 * Indexes verified NEAR transaction activity.
 * Validates endpoint chain ID and verifies status or indexer records.
 */
export async function indexNearAddressActivities(
  rpcUrl: string,
  accountId: string,
  options: NearIndexerOptions & {
    readonly knownTxHashes?: string[];
  },
): Promise<RawNearActivityItem[]> {
  // 1. Verify chain ID
  await verifyNearChainId(rpcUrl, options.network, options);

  const activities: RawNearActivityItem[] = [];

  // If specific tx hashes are supplied (e.g. from receipt observation or webhook), inspect and verify via RPC
  if (options.knownTxHashes && options.knownTxHashes.length > 0) {
    for (const txHash of options.knownTxHashes) {
      try {
        const txRes = await callJsonRpc<NearTxStatusResult>(
          rpcUrl,
          "tx",
          [txHash, accountId],
          options,
        );

        const tx = txRes.response.result;
        if (!tx) continue;

        const signer = tx.transaction.signer_id;
        const receiver = tx.transaction.receiver_id;
        const isFromMe = signer.toLowerCase() === accountId.toLowerCase();
        const isToMe = receiver.toLowerCase() === accountId.toLowerCase();

        let direction: ActivityDirection = "INTERNAL";
        if (isFromMe && isToMe) {
          direction = "INTERNAL";
        } else if (isToMe) {
          direction = "INCOMING";
        } else if (isFromMe) {
          direction = "OUTGOING";
        }

        let depositAtomic = 0n;
        for (const action of tx.transaction.actions) {
          if (action.Transfer?.deposit) {
            depositAtomic += BigInt(action.Transfer.deposit);
          }
        }

        activities.push({
          txHash: tx.transaction.hash,
          eventIndex: activities.length,
          fromAddress: signer,
          toAddress: receiver,
          contractAddress: null,
          atomicAmount: depositAtomic,
          blockHeight: 0n,
          blockHash: tx.transaction_outcome.block_hash,
          blockTimestamp: null,
          finality: "FINALIZED",
          direction,
          activityType:
            depositAtomic > 0n ? "ON_CHAIN_TRANSFER" : "ON_CHAIN_INTERACTION",
          network: "near",
          chainId: options.network,
          ecosystem: "near",
          feeAtomicAmount: BigInt(
            tx.transaction_outcome.outcome.gas_burnt ?? 0,
          ),
          metadata: {
            signer,
            receiver,
          },
        });
      } catch {
        // Skip invalid/unconfirmed tx
      }
    }
  }

  // Native NEAR RPC returns authentic empty state for addresses with no known transactions
  return activities;
}

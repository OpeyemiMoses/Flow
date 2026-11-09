import { FlowError } from "../../../foundation/errors.ts";
import { callJsonRpc, type JsonRpcOptions } from "../connectors/rpc-client.ts";
import { verifySolanaGenesisHash } from "../connectors/solana-connector.ts";
import type {
  ActivityDirection,
  ActivityFinality,
} from "../../../domain/activities.ts";

export interface SolanaIndexerOptions extends JsonRpcOptions {
  readonly network: "solana-mainnet" | "solana-devnet";
  readonly limit?: number;
}

export interface SolanaSignatureInfo {
  readonly signature: string;
  readonly slot: number;
  readonly err: unknown | null;
  readonly memo: string | null;
  readonly blockTime: number | null;
  readonly confirmationStatus?: "processed" | "confirmed" | "finalized";
}

export interface SolanaParsedInstruction {
  readonly parsed?: {
    readonly info?: Record<string, unknown>;
    readonly type?: string;
  };
  readonly program?: string;
  readonly programId?: string;
}

export interface SolanaParsedTxResponse {
  readonly slot: number;
  readonly blockTime: number | null;
  readonly transaction: {
    readonly signatures: string[];
    readonly message: {
      readonly accountKeys: Array<{
        readonly pubkey: string;
        readonly signer: boolean;
        readonly writable: boolean;
      }>;
      readonly instructions: SolanaParsedInstruction[];
    };
  };
  readonly meta: {
    readonly err: unknown | null;
    readonly fee: number;
    readonly preBalances: number[];
    readonly postBalances: number[];
    readonly preTokenBalances?: Array<{
      readonly accountIndex: number;
      readonly mint: string;
      readonly owner?: string;
      readonly uiTokenAmount: {
        readonly amount: string;
        readonly decimals: number;
      };
    }>;
    readonly postTokenBalances?: Array<{
      readonly accountIndex: number;
      readonly mint: string;
      readonly owner?: string;
      readonly uiTokenAmount: {
        readonly amount: string;
        readonly decimals: number;
      };
    }>;
  } | null;
}

export interface RawSolanaActivityItem {
  readonly txHash: string;
  readonly eventIndex: number;
  readonly fromAddress: string;
  readonly toAddress: string;
  readonly contractAddress: string | null;
  readonly atomicAmount: bigint;
  readonly blockHeight: bigint;
  readonly blockHash: string | null;
  readonly blockTimestamp: Date | null;
  readonly finality: ActivityFinality;
  readonly direction: ActivityDirection;
  readonly activityType: "ON_CHAIN_TRANSFER" | "ON_CHAIN_INTERACTION";
  readonly network: "solana";
  readonly chainId: string;
  readonly ecosystem: "solana";
  readonly feeAtomicAmount: bigint | null;
  readonly metadata: Record<string, unknown>;
}

/**
 * Indexes verified Solana transaction activity for an address using read-only JSON-RPC.
 */
export async function indexSolanaAddressActivities(
  rpcUrl: string,
  walletAddress: string,
  options: SolanaIndexerOptions,
): Promise<RawSolanaActivityItem[]> {
  // 1. Verify genesis hash matches network
  await verifySolanaGenesisHash(rpcUrl, options.network, options);

  // 2. Fetch recent transaction signatures
  const limit = Math.min(50, Math.max(1, options.limit ?? 25));
  const sigsRes = await callJsonRpc<SolanaSignatureInfo[]>(
    rpcUrl,
    "getSignaturesForAddress",
    [walletAddress, { limit }],
    options,
  );

  if (sigsRes.response.error) {
    throw new FlowError(
      "RPC_NETWORK_ERROR",
      `Failed to fetch Solana signatures: ${sigsRes.response.error.message}`,
    );
  }

  const sigs = sigsRes.response.result ?? [];
  if (sigs.length === 0) {
    return [];
  }

  const activities: RawSolanaActivityItem[] = [];

  for (const sigInfo of sigs) {
    if (sigInfo.err !== null) {
      // Failed transaction on chain - skip or record as failed interaction
      continue;
    }

    const txRes = await callJsonRpc<SolanaParsedTxResponse>(
      rpcUrl,
      "getTransaction",
      [
        sigInfo.signature,
        {
          encoding: "jsonParsed",
          maxSupportedTransactionVersion: 0,
        },
      ],
      options,
    );

    const tx = txRes.response.result;
    if (!tx || !tx.meta) continue;

    const blockHeight = BigInt(tx.slot);
    const blockTimestamp = tx.blockTime ? new Date(tx.blockTime * 1000) : null;
    const finality: ActivityFinality =
      sigInfo.confirmationStatus === "finalized" ? "FINALIZED" : "CONFIRMED";
    const feeAtomic = BigInt(tx.meta.fee);

    const accountKeys = tx.transaction.message.accountKeys.map((k) => k.pubkey);
    const myIndex = accountKeys.indexOf(walletAddress);
    if (myIndex === -1) continue;

    const isFeePayer = myIndex === 0;

    // Check SPL token balance changes
    let tokenActivityFound = false;
    if (tx.meta.preTokenBalances && tx.meta.postTokenBalances) {
      const myPreTokens = tx.meta.preTokenBalances.filter(
        (b) => b.owner === walletAddress || b.accountIndex === myIndex,
      );
      const myPostTokens = tx.meta.postTokenBalances.filter(
        (b) => b.owner === walletAddress || b.accountIndex === myIndex,
      );

      const allMints = new Set([
        ...myPreTokens.map((t) => t.mint),
        ...myPostTokens.map((t) => t.mint),
      ]);

      for (const mint of allMints) {
        const preAmount = BigInt(
          myPreTokens.find((t) => t.mint === mint)?.uiTokenAmount.amount ?? "0",
        );
        const postAmount = BigInt(
          myPostTokens.find((t) => t.mint === mint)?.uiTokenAmount.amount ??
            "0",
        );

        if (preAmount !== postAmount) {
          tokenActivityFound = true;
          const isIncoming = postAmount > preAmount;
          const atomicAmount = isIncoming
            ? postAmount - preAmount
            : preAmount - postAmount;

          activities.push({
            txHash: sigInfo.signature,
            eventIndex: activities.length,
            fromAddress: isIncoming ? "external" : walletAddress,
            toAddress: isIncoming ? walletAddress : "external",
            contractAddress: mint,
            atomicAmount,
            blockHeight,
            blockHash: null,
            blockTimestamp,
            finality,
            direction: isIncoming ? "INCOMING" : "OUTGOING",
            activityType: "ON_CHAIN_TRANSFER",
            network: "solana",
            chainId: options.network,
            ecosystem: "solana",
            feeAtomicAmount: isFeePayer ? feeAtomic : null,
            metadata: {
              mint,
              slot: tx.slot,
              memo: sigInfo.memo,
            },
          });
        }
      }
    }

    // Native SOL balance change
    const preBal = BigInt(tx.meta.preBalances[myIndex] ?? 0);
    const postBal = BigInt(tx.meta.postBalances[myIndex] ?? 0);

    if (preBal !== postBal) {
      const rawDelta = postBal - preBal;
      let netTransfer = 0n;
      let direction: ActivityDirection = "INTERNAL";

      if (rawDelta > 0n) {
        // Received SOL
        netTransfer = rawDelta;
        direction = "INCOMING";
      } else {
        // Sent SOL or paid fees
        const absDelta = -rawDelta;
        if (isFeePayer) {
          if (absDelta > feeAtomic) {
            netTransfer = absDelta - feeAtomic;
            direction = "OUTGOING";
          } else {
            // Only paid fee for an interaction
            netTransfer = 0n;
            direction = "OUTGOING";
          }
        } else {
          netTransfer = absDelta;
          direction = "OUTGOING";
        }
      }

      if (netTransfer > 0n || !tokenActivityFound) {
        activities.push({
          txHash: sigInfo.signature,
          eventIndex: activities.length,
          fromAddress: direction === "INCOMING" ? "external" : walletAddress,
          toAddress: direction === "INCOMING" ? walletAddress : "external",
          contractAddress: null,
          atomicAmount: netTransfer,
          blockHeight,
          blockHash: null,
          blockTimestamp,
          finality,
          direction,
          activityType:
            netTransfer > 0n ? "ON_CHAIN_TRANSFER" : "ON_CHAIN_INTERACTION",
          network: "solana",
          chainId: options.network,
          ecosystem: "solana",
          feeAtomicAmount: isFeePayer ? feeAtomic : null,
          metadata: {
            slot: tx.slot,
            memo: sigInfo.memo,
          },
        });
      }
    }
  }

  return activities;
}

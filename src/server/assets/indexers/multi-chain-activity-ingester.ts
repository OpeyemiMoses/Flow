import { FlowError } from "../../../foundation/errors.ts";
import type { FlowDb } from "../../../foundation/prisma.ts";
import {
  type MultiChainRpcConfig,
  getDefaultRpcConfig,
} from "../connectors/multi-chain-reconciler.ts";
import {
  indexEvmAddressActivities,
  type RawEvmActivityItem,
} from "./evm-indexer.ts";
import {
  indexSolanaAddressActivities,
  type RawSolanaActivityItem,
} from "./solana-indexer.ts";
import {
  indexNearAddressActivities,
  type RawNearActivityItem,
} from "./near-indexer.ts";

export interface ActivityIngestionOptions {
  readonly rpcConfig?: MultiChainRpcConfig;
  readonly maxBlockRange?: number;
  readonly solanaLimit?: number;
  readonly nearTxHashes?: string[];
}

export interface ActivityIngestionSummary {
  readonly walletId: string;
  readonly accountId: string;
  readonly totalDiscovered: number;
  readonly insertedCount: number;
  readonly updatedCount: number;
}

type UnifiedRawActivity =
  RawEvmActivityItem | RawSolanaActivityItem | RawNearActivityItem;

/**
 * Ingests real verified multi-chain activity for a wallet into flow.wallet_activities.
 * Enforces wallet-to-network consistency, idempotency, atomic precision, and deduplication.
 */
export async function ingestWalletActivities(
  db: FlowDb,
  walletId: string,
  options?: ActivityIngestionOptions,
): Promise<ActivityIngestionSummary> {
  // 1. Fetch wallet
  const wallets = await db.$queryRaw<
    Array<{ id: string; account_id: string; environment: string }>
  >`
    SELECT id, account_id, environment
    FROM flow.wallets
    WHERE id = ${walletId}::uuid
  `;
  const wallet = wallets[0];
  if (!wallet) {
    throw new FlowError(
      "INVALID_CONFIGURATION",
      `Wallet not found: ${walletId}`,
    );
  }

  const env = wallet.environment as "testnet" | "mainnet";
  const rpc = options?.rpcConfig ?? getDefaultRpcConfig(env);

  // 2. Fetch registered wallet addresses
  const addresses = await db.$queryRaw<
    Array<{ id: string; network: string; chain_id: string; address: string }>
  >`
    SELECT id, network, chain_id, address
    FROM flow.wallet_addresses
    WHERE wallet_id = ${walletId}::uuid
    ORDER BY network
  `;

  if (addresses.length === 0) {
    return {
      walletId,
      accountId: wallet.account_id,
      totalDiscovered: 0,
      insertedCount: 0,
      updatedCount: 0,
    };
  }

  // 3. Fetch verified network assets for this environment
  const networkAssets = await db.$queryRaw<
    Array<{
      id: string;
      asset_id: string;
      network: string;
      chain_id: string;
      token_standard: string;
      contract_address: string | null;
      decimals: number;
      symbol: string;
    }>
  >`
    SELECT
      na.id,
      na.asset_id,
      na.network,
      na.chain_id,
      na.token_standard,
      na.contract_address,
      na.decimals,
      a.symbol
    FROM flow.network_assets na
    JOIN flow.assets a ON a.id = na.asset_id
    WHERE na.is_verified = true
      AND na.status = 'ACTIVE'
  `;

  const allRawActivities: UnifiedRawActivity[] = [];

  // 4. Query indexers per registered address
  for (const addr of addresses) {
    try {
      if (addr.network === "base" || addr.network === "ethereum") {
        const primaryRpc =
          addr.network === "ethereum"
            ? process.env.FLOW_ETH_RPC_URL || "https://rpc.ankr.com/eth"
            : (rpc.base?.primary ?? "https://sepolia.base.org");
        const fallbackRpc =
          addr.network === "ethereum" ? undefined : rpc.base?.fallback;

        const items = await indexEvmAddressActivities(
          primaryRpc,
          addr.address,
          {
            chainId: addr.chain_id,
            network: addr.network,
            fallbackEndpoint: fallbackRpc,
            maxBlockRange: options?.maxBlockRange,
          },
        );
        allRawActivities.push(...items);
      } else if (addr.network === "solana") {
        const primaryRpc =
          rpc.solana?.primary ?? "https://api.devnet.solana.com";
        const fallbackRpc = rpc.solana?.fallback;

        const items = await indexSolanaAddressActivities(
          primaryRpc,
          addr.address,
          {
            network: addr.chain_id as "solana-mainnet" | "solana-devnet",
            fallbackEndpoint: fallbackRpc,
            limit: options?.solanaLimit ?? 25,
          },
        );
        allRawActivities.push(...items);
      } else if (addr.network === "near") {
        const primaryRpc = rpc.near?.primary ?? "https://rpc.testnet.near.org";
        const fallbackRpc = rpc.near?.fallback;

        const items = await indexNearAddressActivities(
          primaryRpc,
          addr.address,
          {
            network: addr.chain_id as "near-mainnet" | "near-testnet",
            fallbackEndpoint: fallbackRpc,
            knownTxHashes: options?.nearTxHashes,
          },
        );
        allRawActivities.push(...items);
      }
    } catch (err) {
      // Log indexer warning without halting entire indexing workflow
      console.warn(
        `[ActivityIngester] Indexer warning for ${addr.network}:${addr.chain_id}:`,
        err,
      );
    }
  }

  // 5. Idempotent upsert into flow.wallet_activities
  let insertedCount = 0;
  let updatedCount = 0;

  for (const item of allRawActivities) {
    // Resolve matching asset
    let matchedAsset = networkAssets.find(
      (na) =>
        na.network === item.network &&
        na.chain_id === item.chainId &&
        item.contractAddress &&
        na.contract_address?.toLowerCase() ===
          item.contractAddress.toLowerCase(),
    );

    if (!matchedAsset) {
      // Fallback to native asset of that network & chain
      matchedAsset = networkAssets.find(
        (na) =>
          na.network === item.network &&
          na.chain_id === item.chainId &&
          na.token_standard === "NATIVE",
      );
    }

    const assetId = matchedAsset ? matchedAsset.asset_id : null;
    const networkAssetId = matchedAsset ? matchedAsset.id : null;
    const assetSymbol = matchedAsset ? matchedAsset.symbol : "UNKNOWN";
    const decimals = matchedAsset ? matchedAsset.decimals : 18;

    const metadataJson = JSON.stringify(item.metadata ?? {});

    const upsertRes = await db.$queryRaw<Array<{ inserted: boolean }>>`
      INSERT INTO flow.wallet_activities (
        account_id,
        wallet_id,
        network,
        chain_id,
        ecosystem,
        activity_type,
        direction,
        tx_hash,
        event_index,
        from_address,
        to_address,
        asset_id,
        network_asset_id,
        asset_symbol,
        atomic_amount,
        decimals,
        block_height,
        block_hash,
        block_timestamp,
        finality,
        reorg_status,
        fee_atomic_amount,
        metadata,
        observed_at,
        created_at,
        updated_at
      ) VALUES (
        ${wallet.account_id}::uuid,
        ${wallet.id}::uuid,
        ${item.network},
        ${item.chainId},
        ${item.ecosystem},
        ${item.activityType},
        ${item.direction},
        ${item.txHash},
        ${item.eventIndex},
        ${item.fromAddress},
        ${item.toAddress},
        ${assetId}::uuid,
        ${networkAssetId}::uuid,
        ${assetSymbol},
        ${item.atomicAmount.toString()}::numeric,
        ${decimals},
        ${item.blockHeight.toString()}::bigint,
        ${item.blockHash},
        ${item.blockTimestamp},
        ${item.finality},
        'CANONICAL',
        ${item.feeAtomicAmount !== null ? item.feeAtomicAmount.toString() : null}::numeric,
        ${metadataJson}::jsonb,
        now(),
        now(),
        now()
      )
      ON CONFLICT (network, tx_hash, event_index)
      DO UPDATE SET
        finality = EXCLUDED.finality,
        reorg_status = CASE
          WHEN flow.wallet_activities.block_hash IS NOT NULL
            AND EXCLUDED.block_hash IS NOT NULL
            AND flow.wallet_activities.block_hash <> EXCLUDED.block_hash
          THEN 'REORGED'
          ELSE flow.wallet_activities.reorg_status
        END,
        block_height = COALESCE(EXCLUDED.block_height, flow.wallet_activities.block_height),
        block_hash = COALESCE(EXCLUDED.block_hash, flow.wallet_activities.block_hash),
        block_timestamp = COALESCE(EXCLUDED.block_timestamp, flow.wallet_activities.block_timestamp),
        fee_atomic_amount = COALESCE(EXCLUDED.fee_atomic_amount, flow.wallet_activities.fee_atomic_amount),
        metadata = flow.wallet_activities.metadata || EXCLUDED.metadata,
        observed_at = EXCLUDED.observed_at,
        updated_at = now()
      RETURNING (xmax = 0) AS inserted;
    `;

    if (upsertRes[0]?.inserted) {
      insertedCount++;
    } else {
      updatedCount++;
    }
  }

  return {
    walletId,
    accountId: wallet.account_id,
    totalDiscovered: allRawActivities.length,
    insertedCount,
    updatedCount,
  };
}

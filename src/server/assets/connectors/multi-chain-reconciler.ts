import { type BalanceObservation } from "../../../domain/assets.ts";
import { FlowError } from "../../../foundation/errors.ts";
import type { FlowDb } from "../../../foundation/prisma.ts";
import { upsertWalletBalance } from "../asset-service.ts";
import {
  fetchBaseNativeBalance,
  fetchBaseTokenBalance,
} from "./base-connector.ts";
import {
  fetchNearNativeBalance,
  fetchNearTokenBalance,
} from "./near-connector.ts";
import {
  fetchSolanaNativeBalance,
  fetchSolanaTokenBalance,
} from "./solana-connector.ts";

export interface EndpointPair {
  readonly primary: string;
  readonly fallback?: string;
}

export interface MultiChainRpcConfig {
  readonly ethereum?: EndpointPair;
  readonly near?: EndpointPair;
  readonly base?: EndpointPair;
  readonly solana?: EndpointPair;
}

export function getDefaultRpcConfig(
  environment: "testnet" | "mainnet",
): MultiChainRpcConfig {
  if (environment === "testnet") {
    return {
      near: {
        primary:
          process.env.FLOW_NEAR_RPC_URL || "https://rpc.testnet.near.org",
        fallback: "https://testnet.neardata.info/v1/rpc",
      },
      base: {
        primary: process.env.FLOW_BASE_RPC_URL || "https://sepolia.base.org",
        fallback: "https://base-sepolia-rpc.publicnode.com",
      },
      solana: {
        primary:
          process.env.FLOW_SOLANA_RPC_URL || "https://api.devnet.solana.com",
        fallback: "https://solana-devnet-rpc.publicnode.com",
      },
    };
  }

  return {
    ethereum: {
      primary:
        process.env.FLOW_ETHEREUM_RPC_URL ||
        "https://ethereum-rpc.publicnode.com",
      fallback: "https://cloudflare-eth.com",
    },
    near: {
      primary: process.env.FLOW_NEAR_RPC_URL || "https://rpc.mainnet.near.org",
      fallback: "https://mainnet.neardata.info/v1/rpc",
    },
    base: {
      primary: process.env.FLOW_BASE_RPC_URL || "https://mainnet.base.org",
      fallback: "https://base-rpc.publicnode.com",
    },
    solana: {
      primary:
        process.env.FLOW_SOLANA_RPC_URL ||
        "https://api.mainnet-beta.solana.com",
      fallback: "https://solana-rpc.publicnode.com",
    },
  };
}

export interface ReconcileResult {
  readonly walletId: string;
  readonly environment: string;
  readonly observations: ReadonlyArray<
    BalanceObservation & {
      readonly symbol: string;
      readonly network: string;
      readonly chainId: string;
      readonly address: string;
      readonly contractAddress: string | null;
    }
  >;
}

/**
 * Connects to live blockchain RPC endpoints and reconciles all registered network balances
 * for a wallet into flow.wallet_balances.
 */
export async function reconcileWalletBalances(
  db: FlowDb,
  walletId: string,
  config?: MultiChainRpcConfig,
): Promise<ReconcileResult> {
  // 1. Fetch wallet
  const wallets = await db.$queryRaw<
    Array<{ id: string; environment: string }>
  >`
    SELECT id, environment FROM flow.wallets WHERE id = ${walletId}::uuid
  `;
  const wallet = wallets[0];
  if (!wallet) {
    throw new FlowError(
      "INVALID_CONFIGURATION",
      `Wallet not found: ${walletId}`,
    );
  }

  const env = wallet.environment as "testnet" | "mainnet";
  const rpc = config ?? getDefaultRpcConfig(env);

  // 2. Fetch registered addresses for this wallet
  const addresses = await db.$queryRaw<
    Array<{ id: string; network: string; chainId: string; address: string }>
  >`
    SELECT id, network, chain_id as "chainId", address
    FROM flow.wallet_addresses
    WHERE wallet_id = ${walletId}::uuid
    ORDER BY network
  `;

  if (addresses.length === 0) {
    throw new FlowError(
      "INVALID_CONFIGURATION",
      `Wallet ${walletId} has no registered addresses.`,
    );
  }

  // 3. Fetch verified network assets matching the wallet's environment
  const networkAssets = await db.$queryRaw<
    Array<{
      id: string;
      network: string;
      chainId: string;
      tokenStandard: string;
      contractAddress: string | null;
      decimals: number;
      symbol: string;
    }>
  >`
    SELECT
      na.id,
      na.network,
      na.chain_id as "chainId",
      na.token_standard as "tokenStandard",
      na.contract_address as "contractAddress",
      na.decimals,
      a.symbol
    FROM flow.network_assets na
    JOIN flow.assets a ON a.id = na.asset_id
    WHERE na.is_verified = true
      AND na.status = 'ACTIVE'
    ORDER BY na.network, na.chain_id, a.symbol
  `;

  const results: Array<
    BalanceObservation & {
      symbol: string;
      network: string;
      chainId: string;
      address: string;
      contractAddress: string | null;
    }
  > = [];

  for (const addr of addresses) {
    // Find matching assets for this network and chain
    const matchingAssets = networkAssets.filter(
      (a) => a.network === addr.network && a.chainId === addr.chainId,
    );

    for (const asset of matchingAssets) {
      let obs: BalanceObservation;

      if (asset.network === "ethereum") {
        const ethRpc =
          rpc.ethereum?.primary ?? "https://ethereum-rpc.publicnode.com";
        const fallback = rpc.ethereum?.fallback ?? "https://cloudflare-eth.com";

        if (asset.tokenStandard === "NATIVE") {
          obs = await fetchBaseNativeBalance(
            ethRpc,
            addr.address,
            asset.chainId,
            {
              networkAssetId: asset.id,
              fallbackEndpoint: fallback,
            },
          );
        } else if (asset.contractAddress) {
          obs = await fetchBaseTokenBalance(
            ethRpc,
            addr.address,
            asset.contractAddress,
            asset.chainId,
            {
              networkAssetId: asset.id,
              fallbackEndpoint: fallback,
            },
          );
        } else {
          continue;
        }
      } else if (asset.network === "near") {
        const nearRpc = rpc.near?.primary ?? "https://rpc.testnet.near.org";
        const fallback = rpc.near?.fallback;
        const net = asset.chainId as "near-mainnet" | "near-testnet";

        if (asset.tokenStandard === "NATIVE") {
          obs = await fetchNearNativeBalance(nearRpc, addr.address, net, {
            networkAssetId: asset.id,
            fallbackEndpoint: fallback,
          });
        } else if (asset.contractAddress) {
          obs = await fetchNearTokenBalance(
            nearRpc,
            addr.address,
            asset.contractAddress,
            net,
            {
              networkAssetId: asset.id,
              fallbackEndpoint: fallback,
            },
          );
        } else {
          continue;
        }
      } else if (asset.network === "base") {
        const baseRpc = rpc.base?.primary ?? "https://sepolia.base.org";
        const fallback = rpc.base?.fallback;

        if (asset.tokenStandard === "NATIVE") {
          obs = await fetchBaseNativeBalance(
            baseRpc,
            addr.address,
            asset.chainId,
            {
              networkAssetId: asset.id,
              fallbackEndpoint: fallback,
            },
          );
        } else if (asset.contractAddress) {
          obs = await fetchBaseTokenBalance(
            baseRpc,
            addr.address,
            asset.contractAddress,
            asset.chainId,
            {
              networkAssetId: asset.id,
              fallbackEndpoint: fallback,
            },
          );
        } else {
          continue;
        }
      } else if (asset.network === "solana") {
        const solanaRpc =
          rpc.solana?.primary ?? "https://api.devnet.solana.com";
        const fallback = rpc.solana?.fallback;
        const net = asset.chainId as "solana-mainnet" | "solana-devnet";

        if (asset.tokenStandard === "NATIVE") {
          obs = await fetchSolanaNativeBalance(solanaRpc, addr.address, net, {
            networkAssetId: asset.id,
            fallbackEndpoint: fallback,
          });
        } else if (asset.contractAddress) {
          obs = await fetchSolanaTokenBalance(
            solanaRpc,
            addr.address,
            asset.contractAddress,
            net,
            {
              networkAssetId: asset.id,
              fallbackEndpoint: fallback,
            },
          );
        } else {
          continue;
        }
      } else {
        continue;
      }

      // Persist observation into flow.wallet_balances
      await upsertWalletBalance(db, {
        walletId,
        networkAssetId: obs.networkAssetId,
        tokenAccountAddress: obs.tokenAccountAddress,
        atomicBalance: obs.atomicBalance,
        blockHeight: obs.blockHeight,
        blockTimestamp: obs.blockTimestamp,
        finality: obs.finality,
        syncStatus: obs.syncStatus,
        lastError: obs.lastError,
      });

      results.push({
        ...obs,
        symbol: asset.symbol,
        network: asset.network,
        chainId: asset.chainId,
        address: addr.address,
        contractAddress: asset.contractAddress,
      });
    }
  }

  return {
    walletId,
    environment: wallet.environment,
    observations: results,
  };
}

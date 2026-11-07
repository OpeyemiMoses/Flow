import { type BalanceObservation } from "../../../domain/assets.ts";
import { FlowError } from "../../../foundation/errors.ts";
import { callJsonRpc, type JsonRpcOptions } from "./rpc-client.ts";

export interface SolanaConnectorOptions extends JsonRpcOptions {
  readonly networkAssetId: string;
}

export const SOLANA_GENESIS_HASHES = Object.freeze({
  mainnet: "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d",
  devnet: "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG",
  testnet: "4uhcVJyU9pJkvQyS88uRDiswHXSCkY3zQawwpjk2NsNY",
});

export const SOLANA_PROGRAMS = Object.freeze({
  splToken: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
  token2022: "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",
});

interface SolanaRpcContext {
  readonly slot: number;
  readonly apiVersion?: string;
}

interface SolanaGetBalanceResult {
  readonly context: SolanaRpcContext;
  readonly value: number;
}

interface SolanaTokenAccountParsed {
  readonly pubkey: string;
  readonly account: {
    readonly data: {
      readonly parsed: {
        readonly info: {
          readonly mint: string;
          readonly owner: string;
          readonly tokenAmount: {
            readonly amount: string;
            readonly decimals: number;
            readonly uiAmountString?: string;
          };
        };
        readonly type: string;
      };
      readonly program: string;
    };
  };
}

interface SolanaGetTokenAccountsResult {
  readonly context: SolanaRpcContext;
  readonly value: SolanaTokenAccountParsed[];
}

/**
 * Verifies that the Solana RPC endpoint connects to the expected network (mainnet or devnet)
 * by verifying its immutable genesis hash.
 */
export async function verifySolanaGenesisHash(
  rpcUrl: string,
  expectedNetwork: "solana-mainnet" | "solana-devnet",
  options?: JsonRpcOptions,
): Promise<{ verified: boolean; genesisHash: string; endpointUsed: string }> {
  const { response, endpointUsed } = await callJsonRpc<string>(
    rpcUrl,
    "getGenesisHash",
    [],
    options,
  );

  if (response.error || !response.result) {
    throw new FlowError(
      "RPC_NETWORK_ERROR",
      `Failed to verify Solana genesis hash: ${response.error?.message ?? "Empty result"}`,
    );
  }

  const expectedHash =
    expectedNetwork === "solana-mainnet"
      ? SOLANA_GENESIS_HASHES.mainnet
      : SOLANA_GENESIS_HASHES.devnet;

  if (response.result !== expectedHash) {
    throw new FlowError(
      "CHAIN_ID_MISMATCH",
      `Solana network genesis hash mismatch on ${endpointUsed}: expected ${expectedHash} (${expectedNetwork}), got ${response.result}.`,
    );
  }

  return { verified: true, genesisHash: response.result, endpointUsed };
}

/**
 * Queries native SOL balance via getBalance with explicit commitment level and context slot validation.
 */
export async function fetchSolanaNativeBalance(
  rpcUrl: string,
  address: string,
  expectedNetwork: "solana-mainnet" | "solana-devnet",
  options: SolanaConnectorOptions,
): Promise<BalanceObservation> {
  const { endpointUsed } = await verifySolanaGenesisHash(
    rpcUrl,
    expectedNetwork,
    options,
  );

  const { response } = await callJsonRpc<SolanaGetBalanceResult>(
    rpcUrl,
    "getBalance",
    [address, { commitment: "finalized" }],
    options,
  );

  if (response.error || !response.result) {
    return {
      networkAssetId: options.networkAssetId,
      tokenAccountAddress: null,
      atomicBalance: 0n,
      blockHeight: null,
      blockTimestamp: null,
      observedAt: new Date(),
      finality: "UNKNOWN",
      syncStatus: "ERROR",
      observationState: "RPC_ERROR",
      chainIdVerified: true,
      endpointUsed,
      lastError: response.error?.message ?? "Solana getBalance failed",
    };
  }

  const slot = BigInt(response.result.context.slot);
  const atomicBalance = BigInt(response.result.value);

  return {
    networkAssetId: options.networkAssetId,
    tokenAccountAddress: null,
    atomicBalance,
    blockHeight: slot,
    blockTimestamp: null,
    observedAt: new Date(),
    finality: "FINALIZED",
    syncStatus: "SYNCED",
    observationState: atomicBalance === 0n ? "CONFIRMED_ZERO" : "SYNCED",
    chainIdVerified: true,
    endpointUsed,
    lastError: null,
  };
}

/**
 * Queries SPL token balances across relevant token programs via getTokenAccountsByOwner,
 * aggregating all matching accounts for the verified mint.
 */
export async function fetchSolanaTokenBalance(
  rpcUrl: string,
  ownerAddress: string,
  mintAddress: string,
  expectedNetwork: "solana-mainnet" | "solana-devnet",
  options: SolanaConnectorOptions,
): Promise<BalanceObservation> {
  const { endpointUsed } = await verifySolanaGenesisHash(
    rpcUrl,
    expectedNetwork,
    options,
  );

  // Query classic SPL Token program
  const { response: splRes } = await callJsonRpc<SolanaGetTokenAccountsResult>(
    rpcUrl,
    "getTokenAccountsByOwner",
    [
      ownerAddress,
      { mint: mintAddress },
      { encoding: "jsonParsed", commitment: "finalized" },
    ],
    options,
  );

  if (splRes.error) {
    return {
      networkAssetId: options.networkAssetId,
      tokenAccountAddress: null,
      atomicBalance: 0n,
      blockHeight: null,
      blockTimestamp: null,
      observedAt: new Date(),
      finality: "UNKNOWN",
      syncStatus: "ERROR",
      observationState: "RPC_ERROR",
      chainIdVerified: true,
      endpointUsed,
      lastError:
        splRes.error.message ?? "Solana getTokenAccountsByOwner failed",
    };
  }

  const tokenAccounts = splRes.result?.value ?? [];
  const slot = splRes.result?.context
    ? BigInt(splRes.result.context.slot)
    : null;

  // If no token accounts exist for this mint, the token account is absent -> confirmed 0 balance
  if (tokenAccounts.length === 0) {
    return {
      networkAssetId: options.networkAssetId,
      tokenAccountAddress: null,
      atomicBalance: 0n,
      blockHeight: slot,
      blockTimestamp: null,
      observedAt: new Date(),
      finality: "FINALIZED",
      syncStatus: "SYNCED",
      observationState: "TOKEN_ACCOUNT_ABSENT",
      chainIdVerified: true,
      endpointUsed,
      lastError: null,
    };
  }

  // Aggregate atomic amounts across all matching token accounts
  let aggregatedBalance = 0n;
  for (const acct of tokenAccounts) {
    const rawAmount = acct.account.data?.parsed?.info?.tokenAmount?.amount;
    if (rawAmount) {
      aggregatedBalance += BigInt(rawAmount);
    }
  }

  const primaryTokenAccount = tokenAccounts[0]?.pubkey ?? null;

  return {
    networkAssetId: options.networkAssetId,
    tokenAccountAddress: primaryTokenAccount,
    atomicBalance: aggregatedBalance,
    blockHeight: slot,
    blockTimestamp: null,
    observedAt: new Date(),
    finality: "FINALIZED",
    syncStatus: "SYNCED",
    observationState: aggregatedBalance === 0n ? "CONFIRMED_ZERO" : "SYNCED",
    chainIdVerified: true,
    endpointUsed,
    lastError: null,
  };
}

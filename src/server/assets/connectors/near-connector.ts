import { type BalanceObservation } from "../../../domain/assets.ts";
import { FlowError } from "../../../foundation/errors.ts";
import { callJsonRpc, type JsonRpcOptions } from "./rpc-client.ts";

export interface NearConnectorOptions extends JsonRpcOptions {
  readonly networkAssetId: string;
}

interface NearStatusResult {
  readonly chain_id: string;
  readonly sync_info?: {
    readonly latest_block_height?: number;
    readonly latest_block_time?: string;
  };
}

interface NearViewAccountResult {
  readonly amount: string;
  readonly locked: string;
  readonly code_hash: string;
  readonly storage_usage: number;
  readonly block_height: number;
  readonly block_hash: string;
}

interface NearCallFunctionResult {
  readonly result: number[];
  readonly logs: string[];
  readonly block_height: number;
  readonly block_hash: string;
}

/**
 * Verifies that the NEAR RPC endpoint's chain_id matches expected network ('mainnet' or 'testnet').
 */
export async function verifyNearChainId(
  rpcUrl: string,
  expectedNetwork: "near-mainnet" | "near-testnet",
  options?: JsonRpcOptions,
): Promise<{ verified: boolean; chainId: string; endpointUsed: string }> {
  const { response, endpointUsed } = await callJsonRpc<NearStatusResult>(
    rpcUrl,
    "status",
    [],
    options,
  );

  if (response.error || !response.result) {
    throw new FlowError(
      "RPC_NETWORK_ERROR",
      `Failed to verify NEAR network: ${response.error?.message ?? "Empty status result"}`,
    );
  }

  const actualChainId = response.result.chain_id;
  const expectedChain =
    expectedNetwork === "near-mainnet" ? "mainnet" : "testnet";

  if (actualChainId !== expectedChain) {
    throw new FlowError(
      "CHAIN_ID_MISMATCH",
      `NEAR chain ID mismatch on ${endpointUsed}: expected ${expectedChain}, got ${actualChainId}.`,
    );
  }

  return { verified: true, chainId: actualChainId, endpointUsed };
}

/**
 * Queries native NEAR balance via view_account with explicit handling for non-existent accounts.
 */
export async function fetchNearNativeBalance(
  rpcUrl: string,
  accountId: string,
  expectedNetwork: "near-mainnet" | "near-testnet",
  options: NearConnectorOptions,
): Promise<BalanceObservation> {
  const { endpointUsed } = await verifyNearChainId(
    rpcUrl,
    expectedNetwork,
    options,
  );

  const { response } = await callJsonRpc<NearViewAccountResult>(
    rpcUrl,
    "query",
    {
      request_type: "view_account",
      finality: "final",
      account_id: accountId,
    },
    options,
  );

  // Check for successful account query
  if (response.result && typeof response.result.amount === "string") {
    const atomicBalance = BigInt(response.result.amount);
    return {
      networkAssetId: options.networkAssetId,
      tokenAccountAddress: null,
      atomicBalance,
      blockHeight: BigInt(response.result.block_height),
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

  // Check for explicit non-existent account response (UNKNOWN_ACCOUNT)
  if (response.error) {
    const errorData = String(response.error.data ?? "");
    const causeName = response.error.cause?.name ?? "";
    const isUnknownAccount =
      causeName === "UNKNOWN_ACCOUNT" ||
      errorData.includes("does not exist while viewing");

    if (isUnknownAccount) {
      const blockHeightRaw = response.error.cause?.info?.block_height;
      const blockHeight =
        typeof blockHeightRaw === "number" || typeof blockHeightRaw === "string"
          ? BigInt(blockHeightRaw)
          : null;

      return {
        networkAssetId: options.networkAssetId,
        tokenAccountAddress: null,
        atomicBalance: 0n,
        blockHeight,
        blockTimestamp: null,
        observedAt: new Date(),
        finality: "FINALIZED",
        syncStatus: "SYNCED",
        observationState: "ACCOUNT_NONEXISTENT",
        chainIdVerified: true,
        endpointUsed,
        lastError: null,
      };
    }

    // Other RPC error
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
      lastError: response.error.message ?? errorData,
    };
  }

  throw new FlowError(
    "RPC_NETWORK_ERROR",
    "Malformed NEAR view_account response: missing result and error.",
  );
}

/**
 * Queries NEP-141 token balance via ft_balance_of call_function.
 */
export async function fetchNearTokenBalance(
  rpcUrl: string,
  accountId: string,
  contractAddress: string,
  expectedNetwork: "near-mainnet" | "near-testnet",
  options: NearConnectorOptions,
): Promise<BalanceObservation> {
  const { endpointUsed } = await verifyNearChainId(
    rpcUrl,
    expectedNetwork,
    options,
  );

  const argsBase64 = Buffer.from(
    JSON.stringify({ account_id: accountId }),
    "utf8",
  ).toString("base64");

  const { response } = await callJsonRpc<NearCallFunctionResult>(
    rpcUrl,
    "query",
    {
      request_type: "call_function",
      finality: "final",
      account_id: contractAddress,
      method_name: "ft_balance_of",
      args_base64: argsBase64,
    },
    options,
  );

  if (response.result && Array.isArray(response.result.result)) {
    const rawStr = Buffer.from(response.result.result).toString("utf8");
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawStr);
    } catch {
      parsed = rawStr.replace(/"/g, "").trim();
    }

    const atomicBalance = BigInt(String(parsed));
    return {
      networkAssetId: options.networkAssetId,
      tokenAccountAddress: null,
      atomicBalance,
      blockHeight: BigInt(response.result.block_height),
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

  if (response.error) {
    const errorData = String(response.error.data ?? "");
    const causeName = response.error.cause?.name ?? "";

    // If contract does not exist
    if (
      causeName === "UNKNOWN_ACCOUNT" ||
      errorData.includes("does not exist while viewing")
    ) {
      return {
        networkAssetId: options.networkAssetId,
        tokenAccountAddress: null,
        atomicBalance: 0n,
        blockHeight: null,
        blockTimestamp: null,
        observedAt: new Date(),
        finality: "UNKNOWN",
        syncStatus: "UNAVAILABLE",
        observationState: "UNSUPPORTED_TOKEN",
        chainIdVerified: true,
        endpointUsed,
        lastError: `NEP-141 contract ${contractAddress} does not exist on-chain.`,
      };
    }

    // If account is not registered in token storage (panics with "The account is not registered" or returns error)
    if (
      errorData.includes("not registered") ||
      errorData.includes("account not found")
    ) {
      return {
        networkAssetId: options.networkAssetId,
        tokenAccountAddress: null,
        atomicBalance: 0n,
        blockHeight: null,
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
      lastError: response.error.message ?? errorData,
    };
  }

  throw new FlowError(
    "RPC_NETWORK_ERROR",
    "Malformed NEAR ft_balance_of response.",
  );
}

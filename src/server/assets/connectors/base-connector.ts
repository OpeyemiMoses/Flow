import { type BalanceObservation } from "../../../domain/assets.ts";
import { FlowError } from "../../../foundation/errors.ts";
import { callJsonRpc, type JsonRpcOptions } from "./rpc-client.ts";

export interface BaseConnectorOptions extends JsonRpcOptions {
  readonly networkAssetId: string;
}

/**
 * Verifies on-chain EVM chain ID matches expected chain ID.
 * Throws CHAIN_ID_MISMATCH if mismatched.
 */
export async function verifyBaseChainId(
  rpcUrl: string,
  expectedChainId: string,
  options?: JsonRpcOptions,
): Promise<{ verified: boolean; chainIdHex: string; endpointUsed: string }> {
  const { response, endpointUsed } = await callJsonRpc<string>(
    rpcUrl,
    "eth_chainId",
    [],
    options,
  );

  if (response.error || !response.result) {
    throw new FlowError(
      "RPC_NETWORK_ERROR",
      `Failed to verify Base chain ID: ${response.error?.message ?? "Empty response"}`,
    );
  }

  const actualChainIdDecimal = BigInt(response.result).toString();
  if (actualChainIdDecimal !== expectedChainId) {
    throw new FlowError(
      "CHAIN_ID_MISMATCH",
      `Chain ID mismatch on ${endpointUsed}: expected ${expectedChainId}, got ${actualChainIdDecimal} (${response.result}).`,
    );
  }

  return { verified: true, chainIdHex: response.result, endpointUsed };
}

/**
 * Queries native ETH balance on Base (or Base Sepolia) via eth_getBalance and eth_blockNumber.
 */
export async function fetchBaseNativeBalance(
  rpcUrl: string,
  address: string,
  expectedChainId: string,
  options: BaseConnectorOptions,
): Promise<BalanceObservation> {
  const { endpointUsed } = await verifyBaseChainId(
    rpcUrl,
    expectedChainId,
    options,
  );

  const [balanceRes, blockRes] = await Promise.all([
    callJsonRpc<string>(rpcUrl, "eth_getBalance", [address, "latest"], options),
    callJsonRpc<string>(rpcUrl, "eth_blockNumber", [], options),
  ]);

  if (balanceRes.response.error || balanceRes.response.result === undefined) {
    throw new FlowError(
      "RPC_NETWORK_ERROR",
      `Failed to fetch Base native balance: ${balanceRes.response.error?.message ?? "Empty result"}`,
    );
  }

  const rawHex = balanceRes.response.result;
  const atomicBalance = BigInt(rawHex);

  let blockHeight: bigint | null = null;
  if (blockRes.response.result) {
    try {
      blockHeight = BigInt(blockRes.response.result);
    } catch {
      blockHeight = null;
    }
  }

  return {
    networkAssetId: options.networkAssetId,
    tokenAccountAddress: null,
    atomicBalance,
    blockHeight,
    blockTimestamp: null,
    observedAt: new Date(),
    finality: "CONFIRMED",
    syncStatus: "SYNCED",
    observationState: atomicBalance === 0n ? "CONFIRMED_ZERO" : "SYNCED",
    chainIdVerified: true,
    endpointUsed,
    lastError: null,
  };
}

/**
 * Queries ERC-20 token balance on Base via eth_call calling balanceOf(address).
 */
export async function fetchBaseTokenBalance(
  rpcUrl: string,
  userAddress: string,
  contractAddress: string,
  expectedChainId: string,
  options: BaseConnectorOptions,
): Promise<BalanceObservation> {
  const { endpointUsed } = await verifyBaseChainId(
    rpcUrl,
    expectedChainId,
    options,
  );

  // Selector: keccak256("balanceOf(address)")[0..4] = 0x70a08231
  const cleanAddress = userAddress.toLowerCase().replace(/^0x/, "");
  const paddedAddress = cleanAddress.padStart(64, "0");
  const callData = `0x70a08231${paddedAddress}`;

  const [callRes, blockRes] = await Promise.all([
    callJsonRpc<string>(
      rpcUrl,
      "eth_call",
      [{ to: contractAddress, data: callData }, "latest"],
      options,
    ),
    callJsonRpc<string>(rpcUrl, "eth_blockNumber", [], options),
  ]);

  if (callRes.response.error) {
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
      lastError: callRes.response.error.message ?? "ERC-20 eth_call failed",
    };
  }

  const hexResult = callRes.response.result;
  if (!hexResult || hexResult === "0x") {
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
      lastError: `Contract ${contractAddress} returned empty bytecode or reverted on balanceOf.`,
    };
  }

  const atomicBalance = BigInt(hexResult);

  let blockHeight: bigint | null = null;
  if (blockRes.response.result) {
    try {
      blockHeight = BigInt(blockRes.response.result);
    } catch {
      blockHeight = null;
    }
  }

  return {
    networkAssetId: options.networkAssetId,
    tokenAccountAddress: null,
    atomicBalance,
    blockHeight,
    blockTimestamp: null,
    observedAt: new Date(),
    finality: "CONFIRMED",
    syncStatus: "SYNCED",
    observationState: atomicBalance === 0n ? "CONFIRMED_ZERO" : "SYNCED",
    chainIdVerified: true,
    endpointUsed,
    lastError: null,
  };
}

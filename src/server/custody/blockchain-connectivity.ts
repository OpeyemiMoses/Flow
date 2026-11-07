export interface BlockchainConnectivityResult {
  readonly network: "near" | "base" | "solana";
  readonly endpoint: string;
  readonly reachable: boolean;
  readonly latencyMs: number;
  readonly details: Readonly<Record<string, unknown>>;
  readonly error?: string;
}

export interface BlockchainRpcConfig {
  readonly nearRpcUrl?: string;
  readonly baseRpcUrl?: string;
  readonly solanaRpcUrl?: string;
  readonly timeoutMs?: number;
}

export const DEFAULT_RPC_ENDPOINTS = Object.freeze({
  near: "https://rpc.mainnet.near.org",
  nearTestnet: "https://rpc.testnet.near.org",
  base: "https://mainnet.base.org",
  baseSepolia: "https://sepolia.base.org",
  solana: "https://api.mainnet-beta.solana.com",
  solanaDevnet: "https://api.devnet.solana.com",
});

const DEFAULT_TIMEOUT_MS = 5_000;

function scrubEndpointForLogging(endpoint: string): string {
  try {
    const url = new URL(endpoint);
    url.username = "";
    url.password = "";
    // Remove query params containing key/token
    for (const key of Array.from(url.searchParams.keys())) {
      if (/key|token|auth|secret|api/i.test(key)) {
        url.searchParams.set(key, "[REDACTED]");
      }
    }
    return url.origin + url.pathname;
  } catch {
    return "[MALFORMED_ENDPOINT]";
  }
}

/**
 * Checks read-only reachability of a NEAR JSON-RPC endpoint (`status` method).
 * Does not require any credentials, private keys, or gas.
 */
export async function checkNearRpc(
  endpoint: string = DEFAULT_RPC_ENDPOINTS.near,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<BlockchainConnectivityResult> {
  const scrubbed = scrubEndpointForLogging(endpoint);
  const start = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "flow-health-check",
        method: "status",
        params: [],
      }),
      signal: controller.signal,
    });

    const latencyMs = Date.now() - start;
    if (!response.ok) {
      return {
        network: "near",
        endpoint: scrubbed,
        reachable: false,
        latencyMs,
        details: { httpStatus: response.status },
        error: `HTTP ${response.status} from NEAR RPC.`,
      };
    }

    const data = (await response.json()) as Record<string, unknown>;
    const result = (data?.result ?? {}) as Record<string, unknown>;
    const chainId =
      typeof result.chain_id === "string" ? result.chain_id : undefined;
    const syncInfo = (result.sync_info ?? {}) as Record<string, unknown>;
    const blockHeight =
      typeof syncInfo.latest_block_height === "number"
        ? syncInfo.latest_block_height
        : undefined;
    const blockTime =
      typeof syncInfo.latest_block_time === "string"
        ? syncInfo.latest_block_time
        : undefined;

    return {
      network: "near",
      endpoint: scrubbed,
      reachable: Boolean(chainId && blockHeight !== undefined),
      latencyMs,
      details: {
        chainId,
        latestBlockHeight: blockHeight,
        latestBlockTime: blockTime,
      },
    };
  } catch (err) {
    const latencyMs = Date.now() - start;
    const isTimeout = err instanceof Error && err.name === "AbortError";
    return {
      network: "near",
      endpoint: scrubbed,
      reachable: false,
      latencyMs,
      details: {},
      error: isTimeout
        ? `Connection timed out after ${timeoutMs}ms.`
        : "Failed to reach NEAR RPC.",
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Checks read-only reachability of a Base (EVM) JSON-RPC endpoint (`net_version` and `eth_blockNumber`).
 * Does not require any credentials, private keys, or gas.
 */
export async function checkBaseRpc(
  endpoint: string = DEFAULT_RPC_ENDPOINTS.base,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<BlockchainConnectivityResult> {
  const scrubbed = scrubEndpointForLogging(endpoint);
  const start = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify([
        { jsonrpc: "2.0", id: 1, method: "net_version", params: [] },
        { jsonrpc: "2.0", id: 2, method: "eth_blockNumber", params: [] },
      ]),
      signal: controller.signal,
    });

    const latencyMs = Date.now() - start;
    if (!response.ok) {
      return {
        network: "base",
        endpoint: scrubbed,
        reachable: false,
        latencyMs,
        details: { httpStatus: response.status },
        error: `HTTP ${response.status} from Base RPC.`,
      };
    }

    const payload = await response.json();
    let netVersion: string | undefined;
    let blockHex: string | undefined;

    if (Array.isArray(payload)) {
      const netRes = payload.find((r) => r?.id === 1);
      const blockRes = payload.find((r) => r?.id === 2);
      netVersion =
        typeof netRes?.result === "string" ? netRes.result : undefined;
      blockHex =
        typeof blockRes?.result === "string" ? blockRes.result : undefined;
    } else if (payload && typeof payload === "object") {
      const single = payload as Record<string, unknown>;
      blockHex = typeof single.result === "string" ? single.result : undefined;
    }

    const blockHeight =
      blockHex && blockHex.startsWith("0x")
        ? parseInt(blockHex, 16)
        : undefined;

    return {
      network: "base",
      endpoint: scrubbed,
      reachable: Boolean(
        blockHeight !== undefined && !Number.isNaN(blockHeight),
      ),
      latencyMs,
      details: {
        networkId: netVersion,
        latestBlockHeight: blockHeight,
        blockHex,
      },
    };
  } catch (err) {
    const latencyMs = Date.now() - start;
    const isTimeout = err instanceof Error && err.name === "AbortError";
    return {
      network: "base",
      endpoint: scrubbed,
      reachable: false,
      latencyMs,
      details: {},
      error: isTimeout
        ? `Connection timed out after ${timeoutMs}ms.`
        : "Failed to reach Base RPC.",
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Checks read-only reachability of a Solana JSON-RPC endpoint (`getSlot` and `getVersion`).
 * Does not require any credentials, private keys, or lamports.
 */
export async function checkSolanaRpc(
  endpoint: string = DEFAULT_RPC_ENDPOINTS.solana,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<BlockchainConnectivityResult> {
  const scrubbed = scrubEndpointForLogging(endpoint);
  const start = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "flow-solana-check",
        method: "getSlot",
        params: [],
      }),
      signal: controller.signal,
    });

    const latencyMs = Date.now() - start;
    if (!response.ok) {
      return {
        network: "solana",
        endpoint: scrubbed,
        reachable: false,
        latencyMs,
        details: { httpStatus: response.status },
        error: `HTTP ${response.status} from Solana RPC.`,
      };
    }

    const data = (await response.json()) as Record<string, unknown>;
    const slot = typeof data?.result === "number" ? data.result : undefined;

    return {
      network: "solana",
      endpoint: scrubbed,
      reachable: typeof slot === "number" && slot > 0,
      latencyMs,
      details: {
        latestSlot: slot,
      },
    };
  } catch (err) {
    const latencyMs = Date.now() - start;
    const isTimeout = err instanceof Error && err.name === "AbortError";
    return {
      network: "solana",
      endpoint: scrubbed,
      reachable: false,
      latencyMs,
      details: {},
      error: isTimeout
        ? `Connection timed out after ${timeoutMs}ms.`
        : "Failed to reach Solana RPC.",
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Checks read-only reachability for all three FLOW launch chains: NEAR, Base, and Solana.
 */
export async function checkAllBlockchainRpcs(
  config?: BlockchainRpcConfig,
): Promise<{
  readonly near: BlockchainConnectivityResult;
  readonly base: BlockchainConnectivityResult;
  readonly solana: BlockchainConnectivityResult;
  readonly allReachable: boolean;
}> {
  const timeoutMs = config?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const [near, base, solana] = await Promise.all([
    checkNearRpc(config?.nearRpcUrl ?? DEFAULT_RPC_ENDPOINTS.near, timeoutMs),
    checkBaseRpc(config?.baseRpcUrl ?? DEFAULT_RPC_ENDPOINTS.base, timeoutMs),
    checkSolanaRpc(
      config?.solanaRpcUrl ?? DEFAULT_RPC_ENDPOINTS.solana,
      timeoutMs,
    ),
  ]);

  return {
    near,
    base,
    solana,
    allReachable: near.reachable && base.reachable && solana.reachable,
  };
}

import { FlowError } from "../../../foundation/errors.ts";

export interface JsonRpcOptions {
  readonly timeoutMs?: number;
  readonly fallbackEndpoint?: string;
  readonly maxRetries?: number;
}

export interface JsonRpcResponse<T> {
  readonly result?: T;
  readonly error?: {
    readonly code?: number;
    readonly message?: string;
    readonly data?: unknown;
    readonly name?: string;
    readonly cause?: {
      readonly name?: string;
      readonly info?: Record<string, unknown>;
    };
  };
}

export interface RpcCallOutcome<T> {
  readonly response: JsonRpcResponse<T>;
  readonly endpointUsed: string;
}

export function scrubRpcEndpoint(endpoint: string): string {
  try {
    const url = new URL(endpoint);
    url.username = "";
    url.password = "";
    for (const key of Array.from(url.searchParams.keys())) {
      url.searchParams.set(key, "[REDACTED]");
    }
    const sanitizedPath = url.pathname.replace(
      /\/([a-zA-Z0-9_-]{16,})/g,
      "/[REDACTED_KEY]",
    );
    return url.origin + sanitizedPath + (url.search ? url.search : "");
  } catch {
    return "[MALFORMED_ENDPOINT]";
  }
}

async function waitWithJitter(attempt: number): Promise<void> {
  const base = Math.min(1000, 100 * Math.pow(2, attempt));
  const jitter = Math.floor(Math.random() * 50);
  await new Promise((resolve) => setTimeout(resolve, base + jitter));
}

/**
 * Dispatches a standard JSON-RPC 2.0 POST request with timeouts, bounded jittered retries,
 * rate-limit handling, and optional provider fallback.
 */
export async function callJsonRpc<T>(
  primaryEndpoint: string,
  method: string,
  params: unknown,
  options?: JsonRpcOptions,
): Promise<RpcCallOutcome<T>> {
  const endpoints = [primaryEndpoint];
  if (
    options?.fallbackEndpoint &&
    options.fallbackEndpoint !== primaryEndpoint
  ) {
    endpoints.push(options.fallbackEndpoint);
  }

  const timeoutMs = options?.timeoutMs ?? 5_000;
  const maxRetries = options?.maxRetries ?? 2;

  let lastError: unknown = null;

  for (const endpoint of endpoints) {
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      if (attempt > 0) {
        await waitWithJitter(attempt);
      }

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);

      try {
        const body = JSON.stringify({
          jsonrpc: "2.0",
          id: Math.floor(Math.random() * 1_000_000) + 1,
          method,
          params,
        });

        const res = await fetch(endpoint, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Accept: "application/json",
          },
          body,
          signal: controller.signal,
        });

        clearTimeout(timer);

        if (res.status === 429) {
          if (attempt < maxRetries) {
            continue;
          }
          throw new FlowError(
            "RPC_RATE_LIMITED",
            `RPC rate limit encountered on ${scrubRpcEndpoint(endpoint)}.`,
          );
        }

        if (!res.ok && res.status >= 500) {
          if (attempt < maxRetries) {
            continue;
          }
          throw new FlowError(
            "RPC_NETWORK_ERROR",
            `RPC returned HTTP ${res.status} on ${scrubRpcEndpoint(endpoint)}.`,
          );
        }

        const data = (await res.json()) as JsonRpcResponse<T>;
        return { response: data, endpointUsed: scrubRpcEndpoint(endpoint) };
      } catch (err: unknown) {
        clearTimeout(timer);

        if (err instanceof FlowError && err.code === "RPC_RATE_LIMITED") {
          lastError = err;
          break; // Fallback to next endpoint if rate limited
        }

        if (err instanceof Error && err.name === "AbortError") {
          lastError = new FlowError(
            "RPC_TIMEOUT",
            `RPC request timed out after ${timeoutMs}ms on ${scrubRpcEndpoint(endpoint)}.`,
          );
        } else {
          lastError = new FlowError(
            "RPC_NETWORK_ERROR",
            `RPC request failed on ${scrubRpcEndpoint(endpoint)}: ${err instanceof Error ? err.message : String(err)}`,
          );
        }

        if (attempt === maxRetries) {
          // Exhausted retries for this endpoint, try fallback endpoint
          break;
        }
      }
    }
  }

  if (lastError instanceof FlowError) {
    throw lastError;
  }
  throw new FlowError(
    "RPC_NETWORK_ERROR",
    `All RPC endpoints exhausted for method ${method}: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
  );
}

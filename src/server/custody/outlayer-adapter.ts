import { z } from "zod";
import {
  isValidNearAddress,
  validateAddressForNetwork,
} from "../../domain/custody.ts";
import { FlowError } from "../../foundation/errors.ts";
import { log } from "../../foundation/logger.ts";

export type SanitizedProviderErrorCode =
  | "BAD_REQUEST"
  | "AUTHENTICATION_FAILED"
  | "RESOURCE_NOT_FOUND"
  | "RATE_LIMITED"
  | "UPSTREAM_UNAVAILABLE"
  | "GATEWAY_TIMEOUT"
  | "NETWORK_ERROR"
  | "CORRUPTED_RESPONSE"
  | "UNSUPPORTED_CHAIN"
  | "CORRELATION_ERROR"
  | "INVALID_ADDRESS";

export interface SanitizedProviderError {
  readonly classification: SanitizedProviderErrorCode;
  readonly safeMessage: string;
  readonly httpStatus?: number;
  readonly endpoint?: "/register" | "/wallet/v1/address" | "/wallet/v1/policy";
  readonly chain?: OutLayerChain;
}

/**
 * Maps raw HTTP status codes and allowlisted error contexts to sanitized, allowlisted classifications.
 * Prevents arbitrary provider response bodies (HTML, stack traces, headers, cookies, emails,
 * database URLs, or bearer tokens) from entering application logs or persisted database records.
 */
export function classifyProviderError(
  status: number | null,
  context?: {
    readonly endpoint?:
      "/register" | "/wallet/v1/address" | "/wallet/v1/policy";
    readonly chain?: OutLayerChain;
  },
): SanitizedProviderError {
  const safeStatus =
    typeof status === "number" &&
    Number.isInteger(status) &&
    status >= 100 &&
    status <= 599
      ? status
      : undefined;

  const metadata = {
    ...(safeStatus !== undefined ? { httpStatus: safeStatus } : {}),
    ...(context?.endpoint !== undefined ? { endpoint: context.endpoint } : {}),
    ...(context?.chain !== undefined ? { chain: context.chain } : {}),
  };

  if (safeStatus === 429) {
    return {
      classification: "RATE_LIMITED",
      safeMessage: "OutLayer rate limit exceeded (30 req/min).",
      ...metadata,
    };
  }
  if (safeStatus === 400) {
    if (context?.chain === "bitcoin") {
      return {
        classification: "UNSUPPORTED_CHAIN",
        safeMessage: "Bitcoin is unsupported by OutLayer wallet v1.",
        ...metadata,
      };
    }
    return {
      classification: "BAD_REQUEST",
      safeMessage: "OutLayer rejected the request as invalid (HTTP 400).",
      ...metadata,
    };
  }
  if (safeStatus === 401 || safeStatus === 403) {
    return {
      classification: "AUTHENTICATION_FAILED",
      safeMessage: "OutLayer authentication failed or credentials rejected.",
      ...metadata,
    };
  }
  if (safeStatus === 404) {
    return {
      classification: "RESOURCE_NOT_FOUND",
      safeMessage: "Requested OutLayer resource was not found (HTTP 404).",
      ...metadata,
    };
  }
  if (safeStatus === 504) {
    return {
      classification: "GATEWAY_TIMEOUT",
      safeMessage: "OutLayer upstream gateway timed out (HTTP 504).",
      ...metadata,
    };
  }
  if (safeStatus && safeStatus >= 500 && safeStatus < 600) {
    return {
      classification: "UPSTREAM_UNAVAILABLE",
      safeMessage: `OutLayer service temporarily unavailable (HTTP ${safeStatus}).`,
      ...metadata,
    };
  }
  return {
    classification: "NETWORK_ERROR",
    safeMessage: "OutLayer communication failed due to a network error.",
    ...metadata,
  };
}

export const outlayerChainSchema = z.enum([
  "near",
  "ethereum",
  "polygon",
  "base",
  "arbitrum",
  "optimism",
  "bsc",
  "avalanche",
  "solana",
  "bitcoin",
]);

export type OutLayerChain = z.infer<typeof outlayerChainSchema>;

const registerResponseSchema = z.object({
  wallet_id: z.string().uuid(),
  api_key: z.string().regex(/^wk_[\w-]+$/),
  near_account_id: z.string().min(2).max(64),
  handoff_url: z.string().optional(),
});

const addressResponseSchema = z.object({
  wallet_id: z.string().uuid(),
  chain: outlayerChainSchema,
  address: z.string().min(1).max(128),
  public_key: z.string().min(1).max(256),
  asset_account_id: z.string().nullable().optional(),
  executor_account_id: z.string().optional(),
});

const policyResponseSchema = z.object({
  wallet_id: z.string().uuid(),
  controller: z.string().optional(),
  frozen: z.boolean(),
  policy: z.enum(["none", "stored"]).optional(),
  rules: z.record(z.string(), z.unknown()).optional(),
});

export type OutLayerRegisterResult = z.infer<typeof registerResponseSchema>;
export type OutLayerAddressResult = z.infer<typeof addressResponseSchema>;
export type OutLayerPolicyResult = z.infer<typeof policyResponseSchema>;

export interface OutLayerRegisterInput {
  readonly seed?: string;
  readonly accountId?: string;
  readonly pubkey?: string;
  readonly message?: string;
  readonly signature?: string;
  readonly vaultId?: string;
}

const ALLOWED_REGISTER_FIELDS = new Set([
  "wallet_id",
  "api_key",
  "near_account_id",
  "handoff_url",
]);

export class OutLayerAdapter {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;

  constructor(baseUrl = "https://api.outlayer.ai", timeoutMs = 5_000) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.timeoutMs = timeoutMs;
  }

  private async fetchWithTimeout(
    endpoint: string,
    options: RequestInit,
  ): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      return await fetch(`${this.baseUrl}${endpoint}`, {
        ...options,
        signal: controller.signal,
      });
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        throw new FlowError(
          "CUSTODY_PROVIDER_TIMEOUT",
          `OutLayer request timed out after ${this.timeoutMs}ms.`,
        );
      }
      // Never propagate raw upstream network error messages, headers, URLs, or bodies
      throw new FlowError(
        "CUSTODY_PROVIDER_NETWORK_ERROR",
        "OutLayer communication failed due to an upstream network error.",
      );
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Registers a custody wallet container on OutLayer.
   * NOTE: For anonymous wallets, passes empty body `{}`.
   */
  async register(
    input: OutLayerRegisterInput = {},
  ): Promise<OutLayerRegisterResult> {
    const body =
      input.accountId && input.pubkey && input.signature && input.message
        ? {
            account_id: input.accountId,
            pubkey: input.pubkey,
            signature: input.signature,
            message: input.message,
            seed: input.seed,
            vault_id: input.vaultId,
          }
        : input.vaultId
          ? { vault_id: input.vaultId }
          : {};

    const response = await this.fetchWithTimeout("/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    if (response.status === 429) {
      throw new FlowError(
        "CUSTODY_PROVIDER_RATE_LIMITED",
        "OutLayer registration rate limit exceeded (30 req/min).",
      );
    }

    if (!response.ok) {
      const sanitized = classifyProviderError(response.status, {
        endpoint: "/register",
      });
      throw new FlowError(
        response.status >= 500
          ? "CUSTODY_PROVIDER_UNAVAILABLE"
          : "CUSTODY_PROVIDER_ERROR",
        sanitized.safeMessage,
      );
    }

    const json = await response.json().catch(() => {
      throw new FlowError(
        "CUSTODY_PROVIDER_ERROR",
        "Invalid JSON received from OutLayer registration.",
      );
    });

    const parsed = registerResponseSchema.safeParse(json);
    if (!parsed.success) {
      const safeFields = parsed.error.issues
        .map((i) => String(i.path[0] ?? "root"))
        .filter((f) => ALLOWED_REGISTER_FIELDS.has(f) || f === "root");
      log("error", "outlayer_register_schema_mismatch", {
        fields: Array.from(new Set(safeFields)),
      });
      throw new FlowError(
        "CUSTODY_PROVIDER_ERROR",
        "OutLayer registration response schema mismatch.",
      );
    }

    if (!isValidNearAddress(parsed.data.near_account_id)) {
      throw new FlowError(
        "CUSTODY_INVALID_ADDRESS",
        "OutLayer returned invalid NEAR account ID format.",
      );
    }

    return parsed.data;
  }

  /**
   * Derives the address for a specific chain using the wallet's bearer key.
   * Enforces mandatory correlation check against expectedWalletId and validates
   * chain-specific address format against network rules.
   */
  async getAddress(
    apiKey: string,
    chain: OutLayerChain,
    expectedWalletId?: string,
  ): Promise<OutLayerAddressResult> {
    const validChain = outlayerChainSchema.safeParse(chain);
    if (!validChain.success) {
      throw new FlowError(
        "UNSUPPORTED_CHAIN",
        "Requested blockchain network is unsupported.",
      );
    }

    if (validChain.data === "bitcoin") {
      throw new FlowError(
        "UNSUPPORTED_CHAIN",
        "Bitcoin is unsupported by OutLayer wallet v1.",
      );
    }

    const response = await this.fetchWithTimeout(
      `/wallet/v1/address?chain=${encodeURIComponent(validChain.data)}`,
      {
        method: "GET",
        headers: {
          Authorization: `Bearer ${apiKey}`,
        },
      },
    );

    if (!response.ok) {
      const sanitized = classifyProviderError(response.status, {
        endpoint: "/wallet/v1/address",
        chain: validChain.data,
      });
      throw new FlowError(
        sanitized.classification === "UNSUPPORTED_CHAIN"
          ? "UNSUPPORTED_CHAIN"
          : "CUSTODY_PROVIDER_ERROR",
        sanitized.safeMessage,
      );
    }

    const json = await response.json().catch(() => {
      throw new FlowError(
        "CUSTODY_PROVIDER_ERROR",
        "Invalid JSON received from OutLayer address endpoint.",
      );
    });

    const parsed = addressResponseSchema.safeParse(json);
    if (!parsed.success) {
      throw new FlowError(
        "CUSTODY_PROVIDER_ERROR",
        `OutLayer address schema mismatch for chain ${validChain.data}.`,
      );
    }

    // 1. Mandatory correlation check: wallet ID must match
    if (expectedWalletId && parsed.data.wallet_id !== expectedWalletId) {
      throw new FlowError(
        "CUSTODY_PROVIDER_CORRELATION_ERROR",
        `Provider returned wallet ID mismatch for chain ${validChain.data}.`,
      );
    }

    // 2. Mandatory correlation check: chain must match requested chain
    if (parsed.data.chain !== validChain.data) {
      throw new FlowError(
        "CUSTODY_PROVIDER_CORRELATION_ERROR",
        `Provider returned chain mismatch for requested chain ${validChain.data}.`,
      );
    }

    // 3. Network-specific address validation
    const validation = validateAddressForNetwork(
      validChain.data,
      parsed.data.address,
    );
    if (!validation.valid) {
      throw new FlowError(
        "CUSTODY_INVALID_ADDRESS",
        `Provider returned invalid address format for ${validChain.data}.`,
      );
    }

    return parsed.data;
  }

  /**
   * Queries the TEE policy status for a wallet with optional wallet ID correlation.
   */
  async getPolicy(
    apiKey: string,
    expectedWalletId?: string,
  ): Promise<OutLayerPolicyResult> {
    const response = await this.fetchWithTimeout("/wallet/v1/policy", {
      method: "GET",
      headers: {
        Authorization: `Bearer ${apiKey}`,
      },
    });

    if (!response.ok) {
      const sanitized = classifyProviderError(response.status, {
        endpoint: "/wallet/v1/policy",
      });
      throw new FlowError("CUSTODY_PROVIDER_ERROR", sanitized.safeMessage);
    }

    const json = await response.json().catch(() => {
      throw new FlowError(
        "CUSTODY_PROVIDER_ERROR",
        "Invalid JSON received from OutLayer policy endpoint.",
      );
    });

    const parsed = policyResponseSchema.safeParse(json);
    if (!parsed.success) {
      throw new FlowError(
        "CUSTODY_PROVIDER_ERROR",
        "OutLayer policy schema mismatch.",
      );
    }

    if (expectedWalletId && parsed.data.wallet_id !== expectedWalletId) {
      throw new FlowError(
        "CUSTODY_PROVIDER_CORRELATION_ERROR",
        "Provider returned wallet ID mismatch on policy query.",
      );
    }

    return parsed.data;
  }
}

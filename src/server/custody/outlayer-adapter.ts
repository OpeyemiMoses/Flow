import { z } from "zod";
import { FlowError } from "../../foundation/errors.ts";
import { log } from "../../foundation/logger.ts";

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
  wallet_id: z.string(),
  chain: outlayerChainSchema,
  address: z.string().min(1),
  public_key: z.string().min(1),
  asset_account_id: z.string().nullable().optional(),
  executor_account_id: z.string().optional(),
});

const policyResponseSchema = z.object({
  wallet_id: z.string(),
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

export class OutLayerAdapter {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;

  constructor(baseUrl = "https://api.outlayer.ai", timeoutMs = 5_000) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.timeoutMs = timeoutMs;
  }

  private sanitizeMessage(message: string): string {
    return message.replace(/\bwk_[\w-]+/g, "[REDACTED_API_KEY]");
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
      const raw = error instanceof Error ? error.message : "Network error";
      throw new FlowError(
        "CUSTODY_PROVIDER_NETWORK_ERROR",
        this.sanitizeMessage(raw),
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
      const status = response.status;
      const text = await response.text().catch(() => "");
      throw new FlowError(
        status >= 500
          ? "CUSTODY_PROVIDER_UNAVAILABLE"
          : "CUSTODY_PROVIDER_ERROR",
        this.sanitizeMessage(
          `OutLayer registration failed with HTTP ${status}: ${text}`,
        ),
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
      log("error", "outlayer_register_schema_mismatch", {
        errors: parsed.error.issues.map((i) => i.path.join(".")),
      });
      throw new FlowError(
        "CUSTODY_PROVIDER_ERROR",
        "OutLayer registration response schema mismatch.",
      );
    }

    return parsed.data;
  }

  /**
   * Derives the address for a specific chain using the wallet's bearer key.
   */
  async getAddress(
    apiKey: string,
    chain: OutLayerChain,
  ): Promise<OutLayerAddressResult> {
    const response = await this.fetchWithTimeout(
      `/wallet/v1/address?chain=${encodeURIComponent(chain)}`,
      {
        method: "GET",
        headers: {
          Authorization: `Bearer ${apiKey}`,
        },
      },
    );

    if (response.status === 400 && chain === "bitcoin") {
      throw new FlowError(
        "UNSUPPORTED_CHAIN",
        "Bitcoin is unsupported by OutLayer wallet v1.",
      );
    }

    if (!response.ok) {
      throw new FlowError(
        "CUSTODY_PROVIDER_ERROR",
        `OutLayer address lookup failed for ${chain} with HTTP ${response.status}.`,
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
        `OutLayer address schema mismatch for chain ${chain}.`,
      );
    }

    return parsed.data;
  }

  /**
   * Queries the TEE policy status for a wallet.
   */
  async getPolicy(apiKey: string): Promise<OutLayerPolicyResult> {
    const response = await this.fetchWithTimeout("/wallet/v1/policy", {
      method: "GET",
      headers: {
        Authorization: `Bearer ${apiKey}`,
      },
    });

    if (!response.ok) {
      throw new FlowError(
        "CUSTODY_PROVIDER_ERROR",
        `OutLayer policy check failed with HTTP ${response.status}.`,
      );
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

    return parsed.data;
  }
}

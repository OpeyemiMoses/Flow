import { z } from "zod";
import { FlowError } from "./errors.ts";

export const ALLOWED_OUTLAYER_HOSTS = Object.freeze([
  "api.outlayer.ai",
  "testnet-api.outlayer.ai",
  "api.outlayer.fastnear.com",
  "api.testnet.outlayer.fastnear.com",
  "127.0.0.1",
  "localhost",
  "[::1]",
]);

export const OUTLAYER_MAINNET_API_URL = "https://api.outlayer.ai";
export const OUTLAYER_TESTNET_API_URL = "https://testnet-api.outlayer.ai";

const walletConfigSchema = z.object({
  FLOW_WALLET_PROVIDER: z.enum(["outlayer", "mock"]).default("outlayer"),
  FLOW_WALLET_ENCRYPTION_KEY: z.string().regex(/^[a-f0-9]{64}$/),
  FLOW_WALLET_KEY_ID: z
    .string()
    .regex(/^[a-zA-Z0-9_-]{1,64}$/)
    .default("v1"),
  FLOW_OUTLAYER_API_URL: z.url().default("https://api.outlayer.ai"),

  // Dedicated fail-closed provider compatibility mode (prohibited by default)
  FLOW_PROVIDER_COMPATIBILITY_MODE: z
    .enum(["disabled", "authorized"])
    .default("disabled"),
  FLOW_PROVIDER_COMPATIBILITY_AUTHORIZATION_ID: z
    .string()
    .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i)
    .optional(),
  FLOW_PROVIDER_COMPATIBILITY_ENVIRONMENT: z
    .enum(["testnet", "mainnet"])
    .default("testnet"),
  FLOW_PROVIDER_COMPATIBILITY_TOKEN: z.string().min(16).max(256).optional(),
  FLOW_PROVIDER_COMPATIBILITY_ACCOUNT_ID: z
    .string()
    .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i)
    .optional(),
  FLOW_PROVIDER_COMPATIBILITY_MAX_REGISTRATIONS: z.coerce
    .number()
    .int()
    .min(1)
    .max(1)
    .default(1),

  // Optional read-only blockchain JSON-RPC endpoints
  FLOW_NEAR_RPC_URL: z.url().optional(),
  FLOW_BASE_RPC_URL: z.url().optional(),
  FLOW_SOLANA_RPC_URL: z.url().optional(),

  // Optional future NEAR Intents 1Click endpoint
  FLOW_NEAR_INTENTS_API_URL: z.url().optional(),
});

export type WalletEnvironmentInput = Readonly<
  Record<string, string | undefined>
>;

export interface ProviderCompatibilityConfig {
  readonly mode: "disabled" | "authorized";
  readonly authorizationId?: string;
  readonly authorizedToken?: string;
  readonly isolatedAccountId?: string;
  readonly providerEnvironment?: "testnet" | "mainnet";
  readonly allowedMethods?: readonly string[];
  readonly maxRegistrations: number;
}

export function readWalletConfig(
  source: WalletEnvironmentInput,
  authSecrets?: { authSecret?: string; otpKey?: string },
) {
  const parsed = walletConfigSchema.safeParse(source);
  if (!parsed.success) {
    const names = parsed.error.issues.map((issue) => issue.path.join("."));
    throw new FlowError(
      "INVALID_CONFIGURATION",
      `Invalid wallet configuration: ${names.join(", ")}.`,
    );
  }

  const {
    FLOW_WALLET_PROVIDER,
    FLOW_WALLET_ENCRYPTION_KEY,
    FLOW_WALLET_KEY_ID,
    FLOW_OUTLAYER_API_URL,
    FLOW_PROVIDER_COMPATIBILITY_MODE,
    FLOW_PROVIDER_COMPATIBILITY_AUTHORIZATION_ID,
    FLOW_PROVIDER_COMPATIBILITY_ENVIRONMENT,
    FLOW_PROVIDER_COMPATIBILITY_TOKEN,
    FLOW_PROVIDER_COMPATIBILITY_ACCOUNT_ID,
    FLOW_PROVIDER_COMPATIBILITY_MAX_REGISTRATIONS,
    FLOW_NEAR_RPC_URL,
    FLOW_BASE_RPC_URL,
    FLOW_SOLANA_RPC_URL,
    FLOW_NEAR_INTENTS_API_URL,
  } = parsed.data;

  const key = FLOW_WALLET_ENCRYPTION_KEY;
  if (
    new Set(key).size < 8 ||
    key.startsWith("replace-") ||
    key === authSecrets?.authSecret ||
    key === authSecrets?.otpKey
  ) {
    throw new FlowError(
      "INVALID_CONFIGURATION",
      "Wallet encryption key is invalid, placeholder, or reuses authentication secrets.",
    );
  }

  const url = new URL(FLOW_OUTLAYER_API_URL);
  if (url.protocol !== "https:" && url.hostname !== "127.0.0.1") {
    throw new FlowError(
      "INVALID_CONFIGURATION",
      "OutLayer API URL must use HTTPS (or loopback for testing).",
    );
  }

  // Validate Provider Compatibility Mode invariants (fail-closed)
  let compatibilityConfig: ProviderCompatibilityConfig;
  if (FLOW_PROVIDER_COMPATIBILITY_MODE === "authorized") {
    // 1. Financial execution MUST be disabled
    if (
      source.FLOW_EXECUTION !== undefined &&
      source.FLOW_EXECUTION !== "disabled"
    ) {
      throw new FlowError(
        "INVALID_CONFIGURATION",
        "Provider compatibility mode cannot be authorized unless FLOW_EXECUTION=disabled.",
      );
    }
    // 2. Token must be supplied and not placeholder
    if (
      !FLOW_PROVIDER_COMPATIBILITY_TOKEN ||
      FLOW_PROVIDER_COMPATIBILITY_TOKEN.startsWith("replace-") ||
      FLOW_PROVIDER_COMPATIBILITY_TOKEN.length < 16
    ) {
      throw new FlowError(
        "INVALID_CONFIGURATION",
        "Provider compatibility mode requires a valid non-placeholder FLOW_PROVIDER_COMPATIBILITY_TOKEN.",
      );
    }
    // 3. Isolated account ID must be explicitly configured
    if (!FLOW_PROVIDER_COMPATIBILITY_ACCOUNT_ID) {
      throw new FlowError(
        "INVALID_CONFIGURATION",
        "Provider compatibility mode requires an explicit FLOW_PROVIDER_COMPATIBILITY_ACCOUNT_ID.",
      );
    }
    // 4. Endpoint must be in the allowed OutLayer hosts
    if (!ALLOWED_OUTLAYER_HOSTS.includes(url.hostname)) {
      throw new FlowError(
        "INVALID_CONFIGURATION",
        `Provider compatibility mode endpoint ${url.hostname} is not in the allowlist.`,
      );
    }

    compatibilityConfig = {
      mode: "authorized",
      authorizationId: FLOW_PROVIDER_COMPATIBILITY_AUTHORIZATION_ID,
      authorizedToken: FLOW_PROVIDER_COMPATIBILITY_TOKEN,
      isolatedAccountId: FLOW_PROVIDER_COMPATIBILITY_ACCOUNT_ID,
      providerEnvironment: FLOW_PROVIDER_COMPATIBILITY_ENVIRONMENT,
      allowedMethods: [
        "POST /register",
        "GET /wallet/v1/address",
        "GET /wallet/v1/policy",
      ],
      maxRegistrations: FLOW_PROVIDER_COMPATIBILITY_MAX_REGISTRATIONS,
    };
  } else {
    compatibilityConfig = {
      mode: "disabled",
      maxRegistrations: 0,
    };
  }

  return {
    provider: FLOW_WALLET_PROVIDER,
    encryptionKey: key,
    keyId: FLOW_WALLET_KEY_ID,
    apiUrl: url.origin,
    compatibility: compatibilityConfig,
    rpc: {
      nearRpcUrl: FLOW_NEAR_RPC_URL,
      baseRpcUrl: FLOW_BASE_RPC_URL,
      solanaRpcUrl: FLOW_SOLANA_RPC_URL,
      nearIntentsApiUrl: FLOW_NEAR_INTENTS_API_URL,
    },
  };
}

export type WalletConfig = ReturnType<typeof readWalletConfig>;

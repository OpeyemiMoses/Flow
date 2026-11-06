import { z } from "zod";
import { FlowError } from "./errors.ts";

const walletConfigSchema = z.object({
  FLOW_WALLET_PROVIDER: z.enum(["outlayer", "mock"]).default("outlayer"),
  FLOW_WALLET_ENCRYPTION_KEY: z.string().regex(/^[a-f0-9]{64}$/),
  FLOW_WALLET_KEY_ID: z
    .string()
    .regex(/^[a-zA-Z0-9_-]{1,64}$/)
    .default("v1"),
  FLOW_OUTLAYER_API_URL: z.url().default("https://api.outlayer.ai"),
});

export type WalletEnvironmentInput = Readonly<
  Record<string, string | undefined>
>;

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

  return {
    provider: FLOW_WALLET_PROVIDER,
    encryptionKey: key,
    keyId: FLOW_WALLET_KEY_ID,
    apiUrl: url.origin,
  };
}

export type WalletConfig = ReturnType<typeof readWalletConfig>;

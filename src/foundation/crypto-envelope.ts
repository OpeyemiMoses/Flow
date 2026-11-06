import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto";
import { FlowError } from "./errors.ts";

export interface EncryptedEnvelope {
  readonly version: 1;
  readonly algorithm: "aes-256-gcm";
  readonly keyId: string;
  /** Base64-encoded encrypted payload */
  readonly ciphertext: string;
  /** Base64-encoded 96-bit (12-byte) initialization vector */
  readonly iv: string;
  /** Base64-encoded 128-bit (16-byte) GCM authentication tag */
  readonly tag: string;
}

export function encryptSecret(
  plaintext: string,
  keyHex: string,
  keyId = "v1",
): EncryptedEnvelope {
  if (!/^[a-f0-9]{64}$/i.test(keyHex)) {
    throw new FlowError(
      "INVALID_CONFIGURATION",
      "Encryption key must be a 64-character hex string.",
    );
  }
  const key = Buffer.from(keyHex, "hex");
  const iv = randomBytes(12); // 96-bit IV recommended for AES-GCM
  const cipher = createCipheriv("aes-256-gcm", key, iv);

  const ciphertext = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();

  return {
    version: 1,
    algorithm: "aes-256-gcm",
    keyId,
    ciphertext: ciphertext.toString("base64"),
    iv: iv.toString("base64"),
    tag: tag.toString("base64"),
  };
}

export function decryptSecret(
  envelope: EncryptedEnvelope,
  keyHex: string,
): string {
  if (envelope.version !== 1 || envelope.algorithm !== "aes-256-gcm") {
    throw new FlowError(
      "UNSUPPORTED_ENVELOPE",
      "Unsupported encryption envelope version or algorithm.",
    );
  }
  if (!/^[a-f0-9]{64}$/i.test(keyHex)) {
    throw new FlowError(
      "INVALID_CONFIGURATION",
      "Decryption key must be a 64-character hex string.",
    );
  }

  const key = Buffer.from(keyHex, "hex");
  const iv = Buffer.from(envelope.iv, "base64");
  const tag = Buffer.from(envelope.tag, "base64");
  const ciphertext = Buffer.from(envelope.ciphertext, "base64");

  if (iv.length !== 12 || tag.length !== 16) {
    throw new FlowError(
      "CORRUPTED_ENVELOPE",
      "Invalid IV or authentication tag length in envelope.",
    );
  }

  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);

  try {
    const decrypted = Buffer.concat([
      decipher.update(ciphertext),
      decipher.final(),
    ]);
    return decrypted.toString("utf8");
  } catch {
    throw new FlowError(
      "DECRYPTION_FAILED",
      "Authentication tag verification failed or key is incorrect.",
    );
  }
}

export function serializeEnvelope(envelope: EncryptedEnvelope): string {
  return JSON.stringify(envelope);
}

export function deserializeEnvelope(serialized: string): EncryptedEnvelope {
  try {
    const parsed = JSON.parse(serialized);
    if (
      parsed.version !== 1 ||
      parsed.algorithm !== "aes-256-gcm" ||
      typeof parsed.keyId !== "string" ||
      typeof parsed.ciphertext !== "string" ||
      typeof parsed.iv !== "string" ||
      typeof parsed.tag !== "string"
    ) {
      throw new Error("Invalid structure");
    }
    return parsed as EncryptedEnvelope;
  } catch {
    throw new FlowError(
      "CORRUPTED_ENVELOPE",
      "Failed to parse encrypted envelope.",
    );
  }
}

export function rotateEnvelope(
  envelope: EncryptedEnvelope,
  currentKeyHex: string,
  newKeyHex: string,
  newKeyId: string,
): EncryptedEnvelope {
  const plaintext = decryptSecret(envelope, currentKeyHex);
  return encryptSecret(plaintext, newKeyHex, newKeyId);
}

export function deriveKeyDigest(keyHex: string): string {
  if (!/^[a-f0-9]{64}$/i.test(keyHex)) {
    throw new FlowError(
      "INVALID_CONFIGURATION",
      "Encryption key must be a 64-character hex string.",
    );
  }
  return createHash("sha256").update(Buffer.from(keyHex, "hex")).digest("hex");
}

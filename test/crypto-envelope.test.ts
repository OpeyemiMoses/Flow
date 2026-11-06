import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { test } from "node:test";
import {
  decryptSecret,
  deserializeEnvelope,
  encryptSecret,
  rotateEnvelope,
  serializeEnvelope,
  type EncryptedEnvelope,
} from "../src/foundation/crypto-envelope.ts";

function randomKey(): string {
  return randomBytes(32).toString("hex");
}

test("encrypts and decrypts a secret bearer key correctly", () => {
  const key = randomKey();
  const bearerSecret = "wk_test_2a8b1f3c4d5e6789abcdef0123456789";

  const envelope = encryptSecret(bearerSecret, key, "v1");
  assert.equal(envelope.version, 1);
  assert.equal(envelope.algorithm, "aes-256-gcm");
  assert.equal(envelope.keyId, "v1");
  assert.notEqual(envelope.ciphertext, bearerSecret);

  const decrypted = decryptSecret(envelope, key);
  assert.equal(decrypted, bearerSecret);
});

test("detects corrupted ciphertext and fails with authentication error", () => {
  const key = randomKey();
  const envelope = encryptSecret("wk_super_secret_payload", key);

  // Corrupt ciphertext
  const rawCiphertext = Buffer.from(envelope.ciphertext, "base64");
  const byte0 = rawCiphertext[0];
  assert(byte0 !== undefined);
  rawCiphertext[0] = byte0 ^ 0xff; // flip bit
  const corruptedEnvelope: EncryptedEnvelope = {
    ...envelope,
    ciphertext: rawCiphertext.toString("base64"),
  };

  assert.throws(
    () => decryptSecret(corruptedEnvelope, key),
    (err: unknown) => {
      return (
        err !== null &&
        typeof err === "object" &&
        "code" in err &&
        err.code === "DECRYPTION_FAILED"
      );
    },
  );
});

test("detects corrupted authentication tag and fails", () => {
  const key = randomKey();
  const envelope = encryptSecret("wk_super_secret_payload", key);

  // Corrupt tag
  const rawTag = Buffer.from(envelope.tag, "base64");
  const tagByte0 = rawTag[0];
  assert(tagByte0 !== undefined);
  rawTag[0] = tagByte0 ^ 0xff;
  const corruptedEnvelope: EncryptedEnvelope = {
    ...envelope,
    tag: rawTag.toString("base64"),
  };

  assert.throws(
    () => decryptSecret(corruptedEnvelope, key),
    (err: unknown) => {
      return (
        err !== null &&
        typeof err === "object" &&
        "code" in err &&
        err.code === "DECRYPTION_FAILED"
      );
    },
  );
});

test("rejects wrong decryption key", () => {
  const key1 = randomKey();
  const key2 = randomKey();
  const envelope = encryptSecret("wk_secret", key1);

  assert.throws(
    () => decryptSecret(envelope, key2),
    (err: unknown) => {
      return (
        err !== null &&
        typeof err === "object" &&
        "code" in err &&
        err.code === "DECRYPTION_FAILED"
      );
    },
  );
});

test("serializes and deserializes envelopes correctly", () => {
  const key = randomKey();
  const envelope = encryptSecret("wk_session_token_123", key, "kms-arn-mock");

  const serialized = serializeEnvelope(envelope);
  assert.equal(typeof serialized, "string");

  const parsed = deserializeEnvelope(serialized);
  assert.deepEqual(parsed, envelope);
  assert.equal(decryptSecret(parsed, key), "wk_session_token_123");
});

test("rejects malformed serialized envelopes", () => {
  assert.throws(() => deserializeEnvelope("not-json"));
  assert.throws(() => deserializeEnvelope(JSON.stringify({ version: 2 })));
  assert.throws(() =>
    deserializeEnvelope(JSON.stringify({ version: 1, algorithm: "aes-cbc" })),
  );
});

test("rotates envelope to a new key and updates keyId", () => {
  const oldKey = randomKey();
  const newKey = randomKey();
  const secret = "wk_operational_key_to_rotate";

  const originalEnvelope = encryptSecret(secret, oldKey, "v1");
  const rotated = rotateEnvelope(originalEnvelope, oldKey, newKey, "v2");

  assert.equal(rotated.keyId, "v2");
  assert.notEqual(rotated.ciphertext, originalEnvelope.ciphertext);

  // New key decrypts successfully
  assert.equal(decryptSecret(rotated, newKey), secret);

  // Old key fails to decrypt rotated envelope
  assert.throws(() => decryptSecret(rotated, oldKey));
});

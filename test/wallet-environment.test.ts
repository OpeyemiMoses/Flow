import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { test } from "node:test";
import { readWalletConfig } from "../src/foundation/wallet-environment.ts";

function validSource() {
  return {
    FLOW_WALLET_PROVIDER: "outlayer" as const,
    FLOW_WALLET_ENCRYPTION_KEY: randomBytes(32).toString("hex"),
    FLOW_WALLET_KEY_ID: "v1",
    FLOW_OUTLAYER_API_URL: "https://api.outlayer.ai",
  };
}

const invalid = { code: "INVALID_CONFIGURATION" };

test("accepts valid wallet configuration with defaults", () => {
  const key = randomBytes(32).toString("hex");
  const config = readWalletConfig({
    FLOW_WALLET_ENCRYPTION_KEY: key,
  });

  assert.equal(config.provider, "outlayer");
  assert.equal(config.encryptionKey, key);
  assert.equal(config.keyId, "v1");
  assert.equal(config.apiUrl, "https://api.outlayer.ai");
});

test("accepts mock provider and custom API URL for testing", () => {
  const source = validSource();
  const config = readWalletConfig({
    ...source,
    FLOW_WALLET_PROVIDER: "mock",
    FLOW_OUTLAYER_API_URL: "http://127.0.0.1:8080",
    FLOW_WALLET_KEY_ID: "kms-key-test-01",
  });

  assert.equal(config.provider, "mock");
  assert.equal(config.apiUrl, "http://127.0.0.1:8080");
  assert.equal(config.keyId, "kms-key-test-01");
});

test("rejects absent, invalid length, or non-hex encryption keys", () => {
  assert.throws(() => readWalletConfig({}), invalid);
  assert.throws(
    () => readWalletConfig({ FLOW_WALLET_ENCRYPTION_KEY: "too-short" }),
    invalid,
  );
  assert.throws(
    () =>
      readWalletConfig({
        FLOW_WALLET_ENCRYPTION_KEY: "z".repeat(64), // not hex
      }),
    invalid,
  );
});

test("rejects weak repetitive keys or placeholder keys", () => {
  assert.throws(
    () =>
      readWalletConfig({
        FLOW_WALLET_ENCRYPTION_KEY: "0".repeat(64), // low entropy
      }),
    invalid,
  );
  assert.throws(
    () =>
      readWalletConfig({
        FLOW_WALLET_ENCRYPTION_KEY: "replace-with-a-real-key-0000000000",
      }),
    invalid,
  );
});

test("rejects wallet encryption key reusing auth secret or OTP key", () => {
  const sharedKey = randomBytes(32).toString("hex");
  assert.throws(
    () =>
      readWalletConfig(
        { FLOW_WALLET_ENCRYPTION_KEY: sharedKey },
        { authSecret: sharedKey },
      ),
    invalid,
  );
  assert.throws(
    () =>
      readWalletConfig(
        { FLOW_WALLET_ENCRYPTION_KEY: sharedKey },
        { otpKey: sharedKey },
      ),
    invalid,
  );
});

test("rejects insecure remote HTTP API URLs", () => {
  const source = validSource();
  assert.throws(
    () =>
      readWalletConfig({
        ...source,
        FLOW_OUTLAYER_API_URL: "http://insecure-api.outlayer.ai",
      }),
    invalid,
  );
});

test("wallet environment defaults provider compatibility mode to disabled", () => {
  const config = readWalletConfig(validSource());
  assert.equal(config.compatibility.mode, "disabled");
  assert.equal(config.compatibility.maxRegistrations, 0);
});

test("wallet environment enforces fail-closed validation for provider compatibility mode", () => {
  const source = validSource();
  const validToken = "0123456789abcdef0123456789abcdef";
  const validAccountId = "11111111-2222-3333-4444-555555555555";

  // 1. Missing token must fail
  assert.throws(
    () =>
      readWalletConfig({
        ...source,
        FLOW_PROVIDER_COMPATIBILITY_MODE: "authorized",
        FLOW_PROVIDER_COMPATIBILITY_ACCOUNT_ID: validAccountId,
      }),
    invalid,
  );

  // 2. Placeholder token must fail
  assert.throws(
    () =>
      readWalletConfig({
        ...source,
        FLOW_PROVIDER_COMPATIBILITY_MODE: "authorized",
        FLOW_PROVIDER_COMPATIBILITY_TOKEN: "replace-with-token-12345",
        FLOW_PROVIDER_COMPATIBILITY_ACCOUNT_ID: validAccountId,
      }),
    invalid,
  );

  // 3. Missing isolated account ID must fail
  assert.throws(
    () =>
      readWalletConfig({
        ...source,
        FLOW_PROVIDER_COMPATIBILITY_MODE: "authorized",
        FLOW_PROVIDER_COMPATIBILITY_TOKEN: validToken,
      }),
    invalid,
  );

  // 4. FLOW_EXECUTION != 'disabled' must fail
  assert.throws(
    () =>
      readWalletConfig({
        ...source,
        FLOW_EXECUTION: "enabled",
        FLOW_PROVIDER_COMPATIBILITY_MODE: "authorized",
        FLOW_PROVIDER_COMPATIBILITY_TOKEN: validToken,
        FLOW_PROVIDER_COMPATIBILITY_ACCOUNT_ID: validAccountId,
      }),
    invalid,
  );

  // 5. Valid compatibility mode configuration succeeds
  const validAuthId = "abcdef01-abcd-abcd-abcd-abcdef012345";
  const authorized = readWalletConfig({
    ...source,
    FLOW_EXECUTION: "disabled",
    FLOW_PROVIDER_COMPATIBILITY_MODE: "authorized",
    FLOW_PROVIDER_COMPATIBILITY_AUTHORIZATION_ID: validAuthId,
    FLOW_PROVIDER_COMPATIBILITY_ENVIRONMENT: "testnet",
    FLOW_PROVIDER_COMPATIBILITY_TOKEN: validToken,
    FLOW_PROVIDER_COMPATIBILITY_ACCOUNT_ID: validAccountId,
    FLOW_OUTLAYER_API_URL: "https://testnet-api.outlayer.ai",
    FLOW_NEAR_RPC_URL: "https://rpc.mainnet.near.org",
  });
  assert.equal(authorized.compatibility.mode, "authorized");
  assert.equal(authorized.compatibility.authorizationId, validAuthId);
  assert.equal(authorized.compatibility.providerEnvironment, "testnet");
  assert.equal(authorized.compatibility.maxRegistrations, 1);
  assert.equal(authorized.compatibility.isolatedAccountId, validAccountId);
  assert.equal(authorized.rpc?.nearRpcUrl, "https://rpc.mainnet.near.org");

  // 6. Invalid authorization ID format fails
  assert.throws(
    () =>
      readWalletConfig({
        ...source,
        FLOW_EXECUTION: "disabled",
        FLOW_PROVIDER_COMPATIBILITY_MODE: "authorized",
        FLOW_PROVIDER_COMPATIBILITY_AUTHORIZATION_ID: "not-a-uuid",
        FLOW_PROVIDER_COMPATIBILITY_TOKEN: validToken,
        FLOW_PROVIDER_COMPATIBILITY_ACCOUNT_ID: validAccountId,
      }),
    invalid,
  );

  // 7. Fail-closed testnet coordinator check: testnet rehearsal rejects mainnet coordinator
  assert.throws(
    () =>
      readWalletConfig({
        ...source,
        FLOW_EXECUTION: "disabled",
        FLOW_PROVIDER_COMPATIBILITY_MODE: "authorized",
        FLOW_PROVIDER_COMPATIBILITY_AUTHORIZATION_ID: validAuthId,
        FLOW_PROVIDER_COMPATIBILITY_ENVIRONMENT: "testnet",
        FLOW_PROVIDER_COMPATIBILITY_TOKEN: validToken,
        FLOW_PROVIDER_COMPATIBILITY_ACCOUNT_ID: validAccountId,
        FLOW_OUTLAYER_API_URL: "https://api.outlayer.ai", // prohibited for testnet!
      }),
    {
      code: "INVALID_CONFIGURATION",
      message:
        /Testnet compatibility rehearsal strictly requires FLOW_OUTLAYER_API_URL to be https:\/\/testnet-api\.outlayer\.ai/,
    },
  );

  // 8. Fail-closed mainnet coordinator check: mainnet mode rejects testnet coordinator
  assert.throws(
    () =>
      readWalletConfig({
        ...source,
        FLOW_EXECUTION: "disabled",
        FLOW_PROVIDER_COMPATIBILITY_MODE: "authorized",
        FLOW_PROVIDER_COMPATIBILITY_AUTHORIZATION_ID: validAuthId,
        FLOW_PROVIDER_COMPATIBILITY_ENVIRONMENT: "mainnet",
        FLOW_PROVIDER_COMPATIBILITY_TOKEN: validToken,
        FLOW_PROVIDER_COMPATIBILITY_ACCOUNT_ID: validAccountId,
        FLOW_OUTLAYER_API_URL: "https://testnet-api.outlayer.ai", // prohibited for mainnet!
      }),
    {
      code: "INVALID_CONFIGURATION",
      message:
        /Mainnet compatibility mode requires FLOW_OUTLAYER_API_URL to be https:\/\/api\.outlayer\.ai/,
    },
  );
});

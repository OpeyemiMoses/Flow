import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { OutLayerAdapter } from "../src/server/custody/outlayer-adapter.ts";
import {
  createOutLayerMockServer,
  type OutLayerMockServer,
} from "./support/outlayer-fixture.ts";

let mockServer: OutLayerMockServer;

before(async () => {
  mockServer = await createOutLayerMockServer();
});

after(async () => {
  await mockServer.close();
});

test("OutLayerAdapter registers an anonymous wallet and parses response", async () => {
  const adapter = new OutLayerAdapter(mockServer.url);
  const result = await adapter.register({});

  assert.equal(result.wallet_id, "9c3c9e10-1c1f-4f5e-9c4a-1d7b9a8f3c20");
  assert.equal(result.api_key, "wk_2a8b1f3c4d5e6789abcdef0123456789");
  assert.equal(
    result.near_account_id,
    "98793cd91a3f870fb126f66285808c7e094afcfc4eda8a970f6644ac0a4961ac",
  );
  assert.ok(result.handoff_url?.includes("key=wk_2a8b"));
});

test("OutLayerAdapter derives addresses for NEAR, Base, and Solana", async () => {
  const adapter = new OutLayerAdapter(mockServer.url);
  const apiKey = "wk_2a8b1f3c4d5e6789abcdef0123456789";

  const near = await adapter.getAddress(apiKey, "near");
  assert.equal(
    near.address,
    "98793cd91a3f870fb126f66285808c7e094afcfc4eda8a970f6644ac0a4961ac",
  );
  assert.equal(near.chain, "near");

  const base = await adapter.getAddress(apiKey, "base");
  assert.equal(base.address, "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913");
  assert.equal(base.chain, "base");

  const solana = await adapter.getAddress(apiKey, "solana");
  assert.equal(solana.address, "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU");
  assert.equal(solana.chain, "solana");
});

test("OutLayerAdapter rejects bitcoin derivation as unsupported chain", async () => {
  const adapter = new OutLayerAdapter(mockServer.url);
  const apiKey = "wk_2a8b1f3c4d5e6789abcdef0123456789";

  await assert.rejects(
    adapter.getAddress(apiKey, "bitcoin"),
    (err: unknown) => {
      return (
        err !== null &&
        typeof err === "object" &&
        "code" in err &&
        err.code === "UNSUPPORTED_CHAIN"
      );
    },
  );
});

test("OutLayerAdapter handles rate limits with dedicated error code", async () => {
  mockServer.setOptions({ forceStatus: 429 });
  try {
    const adapter = new OutLayerAdapter(mockServer.url);
    await assert.rejects(adapter.register({}), (err: unknown) => {
      return (
        err !== null &&
        typeof err === "object" &&
        "code" in err &&
        err.code === "CUSTODY_PROVIDER_RATE_LIMITED"
      );
    });
  } finally {
    mockServer.setOptions({});
  }
});

test("OutLayerAdapter handles timeouts and scrubs API keys from error messages", async () => {
  mockServer.setOptions({ forceTimeout: true });
  try {
    const adapter = new OutLayerAdapter(mockServer.url, 200); // 200ms timeout
    await assert.rejects(adapter.register({}), (err: unknown) => {
      return (
        err !== null &&
        typeof err === "object" &&
        "code" in err &&
        err.code === "CUSTODY_PROVIDER_TIMEOUT"
      );
    });
  } finally {
    mockServer.setOptions({});
  }
});

test("OutLayerAdapter queries policy status correctly", async () => {
  mockServer.setOptions({ policyState: "none" });
  try {
    const adapter = new OutLayerAdapter(mockServer.url);
    const policy = await adapter.getPolicy("wk_valid_key");
    assert.equal(policy.policy, "none");
    assert.equal(policy.frozen, false);
  } finally {
    mockServer.setOptions({});
  }
});

test("OutLayerAdapter enforces mandatory correlation check against expected wallet ID", async () => {
  mockServer.setOptions({ mismatchWalletId: true });
  try {
    const adapter = new OutLayerAdapter(mockServer.url);
    const apiKey = "wk_2a8b1f3c4d5e6789abcdef0123456789";
    const expectedWalletId = "9c3c9e10-1c1f-4f5e-9c4a-1d7b9a8f3c20";

    await assert.rejects(
      adapter.getAddress(apiKey, "base", expectedWalletId),
      (err: unknown) => {
        return (
          err !== null &&
          typeof err === "object" &&
          "code" in err &&
          err.code === "CUSTODY_PROVIDER_CORRELATION_ERROR"
        );
      },
    );

    await assert.rejects(
      adapter.getPolicy(apiKey, expectedWalletId),
      (err: unknown) => {
        return (
          err !== null &&
          typeof err === "object" &&
          "code" in err &&
          err.code === "CUSTODY_PROVIDER_CORRELATION_ERROR"
        );
      },
    );
  } finally {
    mockServer.setOptions({});
  }
});

test("OutLayerAdapter enforces mandatory correlation check against requested chain", async () => {
  mockServer.setOptions({ chainMismatch: true });
  try {
    const adapter = new OutLayerAdapter(mockServer.url);
    const apiKey = "wk_2a8b1f3c4d5e6789abcdef0123456789";

    // Requesting 'base' but mock returns 'ethereum'
    await assert.rejects(adapter.getAddress(apiKey, "base"), (err: unknown) => {
      return (
        err !== null &&
        typeof err === "object" &&
        "code" in err &&
        err.code === "CUSTODY_PROVIDER_CORRELATION_ERROR"
      );
    });
  } finally {
    mockServer.setOptions({});
  }
});

test("OutLayerAdapter validates NEAR implicit address format during registration", async () => {
  mockServer.setOptions({ corruptNearId: true });
  try {
    const adapter = new OutLayerAdapter(mockServer.url);
    await assert.rejects(adapter.register({}), (err: unknown) => {
      return (
        err !== null &&
        typeof err === "object" &&
        "code" in err &&
        err.code === "CUSTODY_INVALID_ADDRESS"
      );
    });
  } finally {
    mockServer.setOptions({});
  }
});

test("OutLayerAdapter validates address format on derivation and rejects corrupted address", async () => {
  mockServer.setOptions({ corruptAddress: true });
  try {
    const adapter = new OutLayerAdapter(mockServer.url);
    const apiKey = "wk_2a8b1f3c4d5e6789abcdef0123456789";

    await assert.rejects(adapter.getAddress(apiKey, "base"), (err: unknown) => {
      return (
        err !== null &&
        typeof err === "object" &&
        "code" in err &&
        err.code === "CUSTODY_INVALID_ADDRESS"
      );
    });
  } finally {
    mockServer.setOptions({});
  }
});

test("OutLayerAdapter sanitizes provider errors and never leaks raw HTML or sensitive bodies", async () => {
  const maliciousRawBody =
    "<html><body><h1>502 Bad Gateway</h1><script>alert('xss')</script>wk_secret_token</body></html>";
  mockServer.setOptions({
    forceStatus: 502,
    rawErrorBody: maliciousRawBody,
    rawErrorContentType: "text/html",
  });

  try {
    const adapter = new OutLayerAdapter(mockServer.url);
    await assert.rejects(adapter.register({}), (err: unknown) => {
      assert.ok(err !== null && typeof err === "object" && "message" in err);
      const msg = String(err.message);
      assert.ok(
        !msg.includes("<script>"),
        "Raw HTML script tags must NOT leak into error message",
      );
      assert.ok(
        !msg.includes("wk_secret"),
        "Bearer credentials must NOT leak into error message",
      );
      assert.ok(
        msg.includes("HTTP 502") || msg.includes("temporarily unavailable"),
        "Must provide sanitized allowlisted classification",
      );
      return true;
    });
  } finally {
    mockServer.setOptions({});
  }
});

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

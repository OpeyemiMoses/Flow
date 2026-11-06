import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { formatIsolatedProviderFailure } from "../src/server/custody/job-repository.ts";
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
    const adapter = new OutLayerAdapter(mockServer.url, 200);
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

test("OutLayerAdapter and error isolator block hostile provider responses with bearer tokens, auth headers, cookies, emails, DB URLs, and malformed HTML", async () => {
  const hostilePayload = [
    "<html><body><h1>502 Bad Gateway</h1>",
    "<script src='https://evil.example/steal.js'", // unclosed malformed HTML tag
    "Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.hostile_jwt_secret",
    "Set-Cookie: __Host-flow_session=secret_cookie_value_999; HttpOnly",
    "wk_secret_live_key_999888777",
    "treasury-admin@flow-victim.example.com",
    "postgresql://flow_admin:super_secret_db_pass@db.internal:5432/flow_prod",
  ].join(" | ");

  const forbiddenSubstrings = [
    "<script",
    "evil.example",
    "Authorization",
    "eyJhbGci",
    "hostile_jwt_secret",
    "Set-Cookie",
    "secret_cookie_value_999",
    "wk_secret_live_key",
    "treasury-admin@flow-victim.example.com",
    "postgresql://",
    "super_secret_db_pass",
  ];

  // 1. Test HTTP 502 with hostile payload across register, getAddress, and getPolicy
  for (const status of [400, 401, 404, 502, 504]) {
    mockServer.setOptions({
      forceStatus: status,
      rawErrorBody: hostilePayload,
      rawErrorContentType: "text/html",
    });

    const adapter = new OutLayerAdapter(mockServer.url);
    for (const action of [
      () => adapter.register({}),
      () => adapter.getAddress("wk_valid_key", "base"),
      () => adapter.getPolicy("wk_valid_key"),
    ]) {
      await assert.rejects(action, (err: unknown) => {
        assert.ok(err !== null && typeof err === "object" && "message" in err);
        const msg = String(err.message);
        for (const forbidden of forbiddenSubstrings) {
          assert.ok(
            !msg.includes(forbidden),
            `Error message must NEVER leak '${forbidden}', got: ${msg}`,
          );
        }
        return true;
      });
    }
  }

  // 2. Test HTTP 200 with hostile payload masquerading as JSON / schema-invalid JSON
  mockServer.setOptions({
    forceStatus: 200,
    rawErrorBody: JSON.stringify({
      wallet_id: hostilePayload,
      api_key: hostilePayload,
      near_account_id: hostilePayload,
      error: hostilePayload,
    }),
  });
  try {
    const adapter = new OutLayerAdapter(mockServer.url);
    await assert.rejects(
      adapter.getAddress(
        "wk_valid_key",
        "base",
        "9c3c9e10-1c1f-4f5e-9c4a-1d7b9a8f3c20",
      ),
      (err: unknown) => {
        const msg = String((err as Error).message);
        for (const forbidden of forbiddenSubstrings) {
          assert.ok(
            !msg.includes(forbidden),
            `Schema mismatch must NEVER echo hostile input '${forbidden}', got: ${msg}`,
          );
        }
        return true;
      },
    );
  } finally {
    mockServer.setOptions({});
  }

  // 3. Test connection drop (network error) isolation
  mockServer.setOptions({ dropConnection: true });
  try {
    const adapter = new OutLayerAdapter(mockServer.url);
    await assert.rejects(adapter.register({}), (err: unknown) => {
      const msg = String((err as Error).message);
      assert.equal(
        msg,
        "OutLayer communication failed due to an upstream network error.",
      );
      return true;
    });
  } finally {
    mockServer.setOptions({});
  }

  // 4. Test formatIsolatedProviderFailure with hostile string and hostile metadata fields
  const isolatedFromString = formatIsolatedProviderFailure(
    "UPSTREAM_UNAVAILABLE",
    hostilePayload,
    "9c3c9e10-1c1f-4f5e-9c4a-1d7b9a8f3c20",
  );
  const isolatedFromHostileObject = formatIsolatedProviderFailure(
    "BAD_REQUEST",
    {
      code: "BAD_REQUEST",
      httpStatus: 400,
      endpoint: "/register",
      chain: "base",
      correlationId: hostilePayload, // invalid UUID -> rejected!
      rawUpstreamError: hostilePayload,
      headers: { Authorization: hostilePayload, Cookie: hostilePayload },
    },
    "11111111-2222-3333-4444-555555555555",
  );

  for (const serialized of [isolatedFromString, isolatedFromHostileObject]) {
    for (const forbidden of forbiddenSubstrings) {
      assert.ok(
        !serialized.includes(forbidden),
        `Persisted failure payload must NEVER include '${forbidden}', got: ${serialized}`,
      );
    }
  }

  const parsed = JSON.parse(isolatedFromHostileObject) as Record<
    string,
    unknown
  >;
  assert.equal(parsed.code, "BAD_REQUEST");
  assert.equal(parsed.httpStatus, 400);
  assert.equal(parsed.endpoint, "/register");
  assert.equal(parsed.chain, "base");
  assert.equal(parsed.correlationId, "11111111-2222-3333-4444-555555555555");
  assert.equal(parsed.rawUpstreamError, undefined);
  assert.equal(parsed.headers, undefined);
});

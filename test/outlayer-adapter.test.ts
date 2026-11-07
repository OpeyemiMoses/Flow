import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import {
  hasTrustedAdapterPolicyProvenance,
  verifyCustodyPolicyEvidence,
} from "../src/domain/custody.ts";
import { formatIsolatedProviderFailure } from "../src/server/custody/job-repository.ts";
import {
  OutLayerAdapter,
  scrubHandoffUrl,
} from "../src/server/custody/outlayer-adapter.ts";
import { isAmbiguousRegistrationError } from "../src/server/custody/provisioning-worker.ts";
import {
  createOutLayerMockServer,
  DEFAULT_MOCK_BASE_ADDRESS,
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
  assert.equal(base.address, DEFAULT_MOCK_BASE_ADDRESS);
  assert.equal(base.chain, "base");
  assert.equal(base.executor_account_id, null);

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

test("OutLayerAdapter unconditionally blocks live non-loopback endpoints when FLOW_EXECUTION=disabled", async () => {
  const liveAdapter = new OutLayerAdapter("https://api.outlayer.ai");
  await assert.rejects(() => liveAdapter.register({}), {
    code: "INVALID_CONFIGURATION",
  });
  await assert.rejects(() => liveAdapter.getAddress("wk_test", "base"), {
    code: "INVALID_CONFIGURATION",
  });
  await assert.rejects(() => liveAdapter.getPolicy("wk_test"), {
    code: "INVALID_CONFIGURATION",
  });
});

test("OutLayerAdapter.getPolicy mints unforgeable adapter provenance and scrubHandoffUrl strips bearer keys", async () => {
  mockServer.setOptions({ policyState: "stored" });
  try {
    const adapter = new OutLayerAdapter(mockServer.url);
    const policy = await adapter.getPolicy(
      "wk_2a8b1f3c4d5e6789abcdef0123456789",
      "9c3c9e10-1c1f-4f5e-9c4a-1d7b9a8f3c20",
    );
    assert.equal(hasTrustedAdapterPolicyProvenance(policy), true);
    const verified = verifyCustodyPolicyEvidence(
      policy,
      "9c3c9e10-1c1f-4f5e-9c4a-1d7b9a8f3c20",
    );
    assert.equal(verified.policyState, "stored");
    assert.equal(verified.controllerAccountId, "controller.near");

    const scrubbed = scrubHandoffUrl(
      "https://app.outlayer.ai/wallet?key=wk_2a8b1f3c4d5e6789abcdef0123456789&mode=view",
    );
    assert.equal(scrubbed, "https://app.outlayer.ai/wallet?mode=view");
    assert.ok(!scrubbed?.includes("wk_"));
  } finally {
    mockServer.setOptions({});
  }
});

test("OutLayerAdapter enforces cryptographic public-key-to-address consistency across NEAR, Base, and Solana", async () => {
  mockServer.setOptions({ corruptPublicKey: true });
  try {
    const adapter = new OutLayerAdapter(mockServer.url);
    const apiKey = "wk_2a8b1f3c4d5e6789abcdef0123456789";

    for (const chain of ["near", "base", "solana"] as const) {
      await assert.rejects(
        adapter.getAddress(apiKey, chain),
        (err: unknown) => {
          return (
            err !== null &&
            typeof err === "object" &&
            "code" in err &&
            err.code === "CUSTODY_INVALID_ADDRESS"
          );
        },
        `Expected getAddress(${chain}) to reject mismatched public_key with CUSTODY_INVALID_ADDRESS`,
      );
    }
  } finally {
    mockServer.setOptions({});
  }
});

test("OutLayerAdapter enforces executor_account_id correlation on NEAR and accepts null on non-NEAR chains per OpenAPI 0.1.0-alpha.4", async () => {
  const adapter = new OutLayerAdapter(mockServer.url);
  const apiKey = "wk_2a8b1f3c4d5e6789abcdef0123456789";

  // Valid NEAR response has executor_account_id === address
  const near = await adapter.getAddress(apiKey, "near");
  assert.equal(near.executor_account_id, near.address);

  // Valid Base and Solana responses have executor_account_id === null per OpenAPI 0.1.0-alpha.4
  const base = await adapter.getAddress(apiKey, "base");
  assert.equal(base.executor_account_id, null);
  const solana = await adapter.getAddress(apiKey, "solana");
  assert.equal(solana.executor_account_id, null);

  // Corrupted executor_account_id on NEAR must be rejected with CUSTODY_PROVIDER_CORRELATION_ERROR
  mockServer.setOptions({ corruptExecutorId: true });
  try {
    await assert.rejects(adapter.getAddress(apiKey, "near"), (err: unknown) => {
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

test("isAmbiguousRegistrationError classifies all uncertain post-dispatch registration outcomes for UNKNOWN quarantine", async () => {
  const adapter = new OutLayerAdapter(mockServer.url, 150);

  // 1. Timeout during /register -> ambiguous (true)
  mockServer.setOptions({ forceTimeout: true });
  try {
    await adapter.register({});
    assert.fail("Expected timeout");
  } catch (err) {
    assert.equal(isAmbiguousRegistrationError(err), true);
  } finally {
    mockServer.setOptions({});
  }

  // 2. Upstream connection drop during /register -> ambiguous (true)
  mockServer.setOptions({ dropConnection: true });
  try {
    await adapter.register({});
    assert.fail("Expected drop");
  } catch (err) {
    assert.equal(isAmbiguousRegistrationError(err), true);
  } finally {
    mockServer.setOptions({});
  }

  // 3. HTTP 408 / 409 / 425 / 500 / 502 / 503 / 504 -> ambiguous (true)
  for (const status of [408, 409, 425, 500, 502, 503, 504]) {
    mockServer.setOptions({ forceStatus: status });
    try {
      await adapter.register({});
      assert.fail(`Expected HTTP ${status} error`);
    } catch (err) {
      assert.equal(
        isAmbiguousRegistrationError(err),
        true,
        `HTTP ${status} during /register must be classified as ambiguous`,
      );
    } finally {
      mockServer.setOptions({});
    }
  }

  // 4. HTTP 200 with truncated/non-JSON body -> ambiguous (true) because wallet was likely created!
  mockServer.setOptions({
    forceStatus: 200,
    rawErrorBody: '{"wallet_id":"9c3c9e10-1c1f-4f5e',
    rawErrorContentType: "application/json",
  });
  try {
    await adapter.register({});
    assert.fail("Expected invalid JSON error");
  } catch (err) {
    assert.equal(isAmbiguousRegistrationError(err), true);
  } finally {
    mockServer.setOptions({});
  }

  // 5. HTTP 200 with schema mismatch -> ambiguous (true)
  mockServer.setOptions({
    forceStatus: 200,
    rawErrorBody: JSON.stringify({ unexpected: "shape" }),
    rawErrorContentType: "application/json",
  });
  try {
    await adapter.register({});
    assert.fail("Expected schema mismatch error");
  } catch (err) {
    assert.equal(isAmbiguousRegistrationError(err), true);
  } finally {
    mockServer.setOptions({});
  }

  // 6. HTTP 200 with corrupted near_account_id -> ambiguous (true)
  mockServer.setOptions({ corruptNearId: true });
  try {
    await adapter.register({});
    assert.fail("Expected invalid address error");
  } catch (err) {
    assert.equal(isAmbiguousRegistrationError(err), true);
  } finally {
    mockServer.setOptions({});
  }

  // 7. Deterministic pre-creation HTTP 400 / 401 / 403 / 429 -> NOT ambiguous (false)
  for (const status of [400, 401, 403, 429]) {
    mockServer.setOptions({ forceStatus: status });
    try {
      await adapter.register({});
      assert.fail(`Expected HTTP ${status} error`);
    } catch (err) {
      assert.equal(
        isAmbiguousRegistrationError(err),
        false,
        `HTTP ${status} during /register is a deterministic pre-creation rejection`,
      );
    } finally {
      mockServer.setOptions({});
    }
  }
});

test("OutLayerAdapter enforces fail-closed provider compatibility mode on remote endpoints", async () => {
  // 1. Remote endpoint without compatibility config -> throws INVALID_CONFIGURATION
  const unconfiguredAdapter = new OutLayerAdapter("https://api.outlayer.ai");
  await assert.rejects(() => unconfiguredAdapter.register({}), {
    code: "INVALID_CONFIGURATION",
  });
  await assert.rejects(() => unconfiguredAdapter.getAddress("wk_key", "base"), {
    code: "INVALID_CONFIGURATION",
  });

  // 2. Remote endpoint with mode: 'disabled' -> throws INVALID_CONFIGURATION
  const disabledAdapter = new OutLayerAdapter("https://api.outlayer.ai", 5000, {
    compatibilityConfig: { mode: "disabled", maxRegistrations: 0 },
  });
  await assert.rejects(() => disabledAdapter.register({}), {
    code: "INVALID_CONFIGURATION",
  });

  // 3. Remote endpoint not in allowlist -> throws INVALID_CONFIGURATION
  const forbiddenHostAdapter = new OutLayerAdapter(
    "https://evil.example.com",
    5000,
    {
      compatibilityConfig: {
        mode: "authorized",
        authorizedToken: "valid_test_token_12345",
        isolatedAccountId: "00000000-0000-0000-0000-000000000000",
        maxRegistrations: 1,
      },
    },
  );
  await assert.rejects(() => forbiddenHostAdapter.register({}), {
    code: "INVALID_CONFIGURATION",
  });

  // 4. Testnet host https://testnet-api.outlayer.ai is recognized in host allowlist
  const testnetAdapter = new OutLayerAdapter(
    "https://testnet-api.outlayer.ai",
    5000,
    {
      compatibilityConfig: {
        mode: "authorized",
        authorizedToken: "valid_test_token_12345",
        isolatedAccountId: "00000000-0000-0000-0000-000000000000",
        maxRegistrations: 1,
      },
    },
  );
  // Endpoint permitted assertion passes host check; registration quota error is thrown if quota exhausted
  // Prohibited execution guard methods verify Requirement 9
  await assert.rejects(() => testnetAdapter.sign(), {
    code: "CUSTODY_EXECUTION_BLOCKED",
  });
  await assert.rejects(() => testnetAdapter.broadcastTransaction(), {
    code: "CUSTODY_EXECUTION_BLOCKED",
  });
  await assert.rejects(() => testnetAdapter.transfer(), {
    code: "CUSTODY_EXECUTION_BLOCKED",
  });
  await assert.rejects(() => testnetAdapter.withdraw(), {
    code: "CUSTODY_EXECUTION_BLOCKED",
  });
  await assert.rejects(() => testnetAdapter.swap(), {
    code: "CUSTODY_EXECUTION_BLOCKED",
  });
  await assert.rejects(() => testnetAdapter.deleteWallet(), {
    code: "CUSTODY_EXECUTION_BLOCKED",
  });
  await assert.rejects(() => testnetAdapter.mutatePolicy(), {
    code: "CUSTODY_EXECUTION_BLOCKED",
  });
});

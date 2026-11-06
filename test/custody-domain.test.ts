import assert from "node:assert/strict";
import { test } from "node:test";
import {
  evaluatePolicyReadiness,
  evaluateWalletFundReadiness,
  isValidEvmAddress,
  isValidNearAddress,
  isValidSolanaAddress,
  OUTLAYER_CAPABILITIES,
  validateAddressForNetwork,
  validateRequiredWalletProvisioning,
  verifyCustodyPolicyEvidence,
} from "../src/domain/custody.ts";

test("validates NEAR implicit addresses requiring 64 hexadecimal characters (32 bytes)", () => {
  const validImplicit =
    "98793cd91a3f870fb126f66285808c7e094afcfc4eda8a970f6644ac0a4961ac";
  assert.equal(isValidNearAddress(validImplicit), true);

  const truncatedImplicit = "9c3c9e101c1f4f5e9c4a1d7b9a8f3c20";
  assert.equal(isValidNearAddress(truncatedImplicit), false);

  assert.equal(isValidNearAddress(validImplicit.toUpperCase()), false);
});

test("validates NEAR named account identifiers", () => {
  assert.equal(isValidNearAddress("alice.near"), true);
  assert.equal(isValidNearAddress("treasury.sputnik-dao.near"), true);
  assert.equal(isValidNearAddress("flow_app.near"), true);
  assert.equal(isValidNearAddress("a"), false);
  assert.equal(isValidNearAddress("a".repeat(65)), false);
});

test("validates EVM addresses for Base and Ethereum", () => {
  const validEvm = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
  assert.equal(isValidEvmAddress(validEvm), true);
  assert.equal(isValidEvmAddress(validEvm.toLowerCase()), true);

  assert.equal(
    isValidEvmAddress("833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"),
    false,
  );
  assert.equal(isValidEvmAddress("0x833589"), false);
  assert.equal(
    isValidEvmAddress("0x833589fCD6eDb6E08f4c7C32D4f71b54bdA0291Z"),
    false,
  );
});

test("validates Solana Base58 addresses", () => {
  const validSolana = "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU";
  assert.equal(isValidSolanaAddress(validSolana), true);

  assert.equal(
    isValidSolanaAddress("0xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU"),
    false,
  );
  assert.equal(isValidSolanaAddress("short"), false);
});

test("validates address for network identifiers", () => {
  const nearImplicit =
    "98793cd91a3f870fb126f66285808c7e094afcfc4eda8a970f6644ac0a4961ac";
  const evmAddress = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
  const solanaAddress = "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU";

  assert.equal(
    validateAddressForNetwork("near:mainnet", nearImplicit).valid,
    true,
  );
  assert.equal(
    validateAddressForNetwork("eip155:8453", evmAddress).valid,
    true,
  );
  assert.equal(
    validateAddressForNetwork("solana:mainnet", solanaAddress).valid,
    true,
  );

  assert.equal(
    validateAddressForNetwork("eip155:8453", nearImplicit).valid,
    false,
  );
  assert.equal(
    validateAddressForNetwork("near:mainnet", evmAddress).valid,
    false,
  );
});

test("distinguishes address derivation, broadcast mode and balance reading across networks with signing disabled", () => {
  const near = OUTLAYER_CAPABILITIES.near;
  assert.equal(near.canDeriveAddress, true);
  assert.equal(near.canReadNativeBalance, true);
  assert.equal(near.broadcastMode, "provider_broadcast");
  assert.equal(near.canSignTransfer, false);
  assert.equal(near.canReceive, false);

  const base = OUTLAYER_CAPABILITIES.base;
  assert.equal(base.canDeriveAddress, true);
  assert.equal(base.canReadNativeBalance, false);
  assert.equal(base.broadcastMode, "caller_broadcast");
  assert.equal(base.canSignTransfer, false);
  assert.equal(base.canReceive, false);

  const solana = OUTLAYER_CAPABILITIES.solana;
  assert.equal(solana.canDeriveAddress, true);
  assert.equal(solana.canSignTransfer, false);
  assert.equal(solana.canReceive, false);

  const btc = OUTLAYER_CAPABILITIES.bitcoin;
  assert.equal(btc.canDeriveAddress, false);
  assert.equal(btc.broadcastMode, "unsupported");
  assert.equal(btc.canSignTransfer, false);
});

test("verifyCustodyPolicyEvidence rejects caller-supplied strings and requires provider-backed evidence", () => {
  const expectedWalletId = "9c3c9e10-1c1f-4f5e-9c4a-1d7b9a8f3c20";

  // 1. Caller-supplied raw string must be rejected
  assert.throws(() => verifyCustodyPolicyEvidence("stored", expectedWalletId), {
    code: "POLICY_VERIFICATION_FAILED",
  });

  // 2. Mismatched provider wallet_id must be rejected
  assert.throws(
    () =>
      verifyCustodyPolicyEvidence(
        {
          wallet_id: "00000000-0000-0000-0000-000000000000",
          controller: "controller.near",
          frozen: false,
          policy: "stored",
          rules: { maxPerTx: "0" },
        },
        expectedWalletId,
      ),
    { code: "CUSTODY_PROVIDER_CORRELATION_ERROR" },
  );

  // 3. Frozen wallet must be rejected
  assert.throws(
    () =>
      verifyCustodyPolicyEvidence(
        {
          wallet_id: expectedWalletId,
          controller: "controller.near",
          frozen: true,
          policy: "stored",
          rules: {},
        },
        expectedWalletId,
      ),
    { code: "POLICY_VERIFICATION_FAILED" },
  );

  // 4. Policy 'none' or arbitrary string must be rejected
  for (const invalidPolicy of [
    "none",
    "unverified",
    "rejected",
    "active",
    "",
  ]) {
    assert.throws(
      () =>
        verifyCustodyPolicyEvidence(
          {
            wallet_id: expectedWalletId,
            controller: "controller.near",
            frozen: false,
            policy: invalidPolicy,
            rules: {},
          },
          expectedWalletId,
        ),
      { code: "POLICY_VERIFICATION_FAILED" },
    );
  }

  // 5. Missing or invalid NEAR controller account must be rejected
  assert.throws(
    () =>
      verifyCustodyPolicyEvidence(
        {
          wallet_id: expectedWalletId,
          controller: "invalid controller!!!",
          frozen: false,
          policy: "stored",
          rules: {},
        },
        expectedWalletId,
      ),
    { code: "POLICY_VERIFICATION_FAILED" },
  );

  // 6. Missing rules object must be rejected
  assert.throws(
    () =>
      verifyCustodyPolicyEvidence(
        {
          wallet_id: expectedWalletId,
          controller: "controller.near",
          frozen: false,
          policy: "stored",
        },
        expectedWalletId,
      ),
    { code: "POLICY_VERIFICATION_FAILED" },
  );

  // 7. Complete, provider-backed policy evidence succeeds
  const verified = verifyCustodyPolicyEvidence(
    {
      wallet_id: expectedWalletId,
      controller: "controller.near",
      frozen: false,
      policy: "stored",
      rules: { defaultAction: "DENY" },
    },
    expectedWalletId,
  );
  assert.equal(verified.providerWalletId, expectedWalletId);
  assert.equal(verified.controllerAccountId, "controller.near");
  assert.equal(verified.policyState, "stored");
  assert.equal(verified.frozen, false);
});

test("validateRequiredWalletProvisioning enforces all launch networks and blocks unverified capability grants", () => {
  const nearImplicit =
    "98793cd91a3f870fb126f66285808c7e094afcfc4eda8a970f6644ac0a4961ac";
  const fullAddresses = [
    {
      network: "near",
      chainId: "near-mainnet",
      address: nearImplicit,
      publicKey: "ed25519:nearKey",
    },
    {
      network: "base",
      chainId: "8453",
      address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
      publicKey: "secp256k1:baseKey",
    },
    {
      network: "solana",
      chainId: "solana-mainnet",
      address: "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU",
      publicKey: "ed25519:solKey",
    },
  ];
  const prePolicyCapabilities = [
    {
      network: "near",
      canDeriveAddress: true,
      canReceive: false,
      canSignTransfer: false,
      broadcastMode: "provider_broadcast",
    },
    {
      network: "base",
      canDeriveAddress: true,
      canReceive: false,
      canSignTransfer: false,
      broadcastMode: "caller_broadcast",
    },
    {
      network: "solana",
      canDeriveAddress: true,
      canReceive: false,
      canSignTransfer: false,
      broadcastMode: "caller_broadcast",
    },
  ];

  // Valid pre-policy provisioning passes
  validateRequiredWalletProvisioning({
    nearAccountId: nearImplicit,
    addresses: fullAddresses,
    capabilities: prePolicyCapabilities,
    policyVerified: false,
  });

  // Granting canReceive=true before policy verification MUST FAIL
  assert.throws(
    () =>
      validateRequiredWalletProvisioning({
        nearAccountId: nearImplicit,
        addresses: fullAddresses,
        capabilities: prePolicyCapabilities.map((c) => ({
          ...c,
          canReceive: true,
        })),
        policyVerified: false,
      }),
    { code: "INVALID_CAPABILITY_GRANT" },
  );

  // Granting canSignTransfer=true at ANY stage MUST FAIL
  assert.throws(
    () =>
      validateRequiredWalletProvisioning({
        nearAccountId: nearImplicit,
        addresses: fullAddresses,
        capabilities: prePolicyCapabilities.map((c) => ({
          ...c,
          canReceive: true,
          canSignTransfer: true,
        })),
        policyVerified: true,
      }),
    { code: "INVALID_CAPABILITY_GRANT" },
  );

  // Missing Solana address MUST FAIL
  assert.throws(
    () =>
      validateRequiredWalletProvisioning({
        nearAccountId: nearImplicit,
        addresses: fullAddresses.slice(0, 2),
        capabilities: prePolicyCapabilities,
        policyVerified: false,
      }),
    { code: "INCOMPLETE_WALLET_PROVISIONING" },
  );
});

test("evaluates policy readiness and enforces that FLOW_EXECUTION=disabled unconditionally blocks execution", () => {
  // Even if caller passes globalExecutionDisabled=false, FLOW_EXECUTION=disabled in environment blocks execution
  assert.equal(
    evaluatePolicyReadiness(
      {
        walletId: "w1",
        controller: "controller.near",
        state: "stored",
        frozen: false,
        allowsFinancialExecution: true,
      },
      false,
    ),
    false,
  );

  assert.equal(
    evaluatePolicyReadiness(
      {
        walletId: "w1",
        controller: "controller.near",
        state: "stored",
        frozen: false,
        allowsFinancialExecution: true,
      },
      true,
    ),
    false,
  );
});

test("evaluateWalletFundReadiness unconditionally blocks fund movement when FLOW_EXECUTION=disabled regardless of wallet status or policy", () => {
  const validAddresses = [
    {
      network: "near",
      address:
        "98793cd91a3f870fb126f66285808c7e094afcfc4eda8a970f6644ac0a4961ac",
    },
    {
      network: "base",
      address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    },
    {
      network: "solana",
      address: "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU",
    },
  ];

  const validPolicy = {
    walletId: "w-ready",
    controller: "controller.near",
    state: "stored" as const,
    frozen: false,
    allowsFinancialExecution: true,
  };

  const capabilities = [
    { network: "near", canSignTransfer: true, canReceive: true },
    { network: "base", canSignTransfer: true, canReceive: true },
    { network: "solana", canSignTransfer: true, canReceive: true },
  ];

  // 1. Even when caller passes globalExecutionDisabled: false, walletStatus: 'ACTIVE',
  // policy: 'stored', and canSignTransfer: true, FLOW_EXECUTION=disabled unconditionally blocks funds!
  const check = evaluateWalletFundReadiness({
    walletStatus: "ACTIVE",
    policySummary: validPolicy,
    derivedAddresses: validAddresses,
    capabilities,
    globalExecutionDisabled: false,
  });
  assert.equal(check.isReady, false);
  assert.equal(check.canReceiveFunds, false);
  assert.equal(check.canSignTransfers, false);
  assert.ok(check.reason?.includes("FLOW_EXECUTION=disabled"));

  // 2. Non-ACTIVE status (e.g. SETUP_PENDING or PROVISIONING) also records status reason
  const pendingCheck = evaluateWalletFundReadiness({
    walletStatus: "SETUP_PENDING",
    policySummary: validPolicy,
    derivedAddresses: validAddresses,
    capabilities,
    globalExecutionDisabled: false,
  });
  assert.equal(pendingCheck.isReady, false);
  assert.equal(pendingCheck.canReceiveFunds, false);
  assert.equal(pendingCheck.canSignTransfers, false);
  assert.ok(pendingCheck.reason?.includes("SETUP_PENDING"));

  // 3. Unverified policy ("none") records policy reason
  const unverifiedPolicyCheck = evaluateWalletFundReadiness({
    walletStatus: "ACTIVE",
    policySummary: { ...validPolicy, state: "none" },
    derivedAddresses: validAddresses,
    capabilities,
    globalExecutionDisabled: false,
  });
  assert.equal(unverifiedPolicyCheck.isReady, false);
  assert.ok(
    unverifiedPolicyCheck.reason?.includes("requires verified 'stored' policy"),
  );

  // 4. Missing required chain address (e.g. Solana missing) records missing address reason
  const missingChainCheck = evaluateWalletFundReadiness({
    walletStatus: "ACTIVE",
    policySummary: validPolicy,
    derivedAddresses: validAddresses.slice(0, 2),
    capabilities,
    globalExecutionDisabled: false,
  });
  assert.equal(missingChainCheck.isReady, false);
  assert.ok(missingChainCheck.reason?.includes("Missing verified addresses"));
});

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
} from "../src/domain/custody.ts";

test("validates NEAR implicit addresses requiring 64 hexadecimal characters (32 bytes)", () => {
  // Real 64-hex implicit account
  const validImplicit =
    "98793cd91a3f870fb126f66285808c7e094afcfc4eda8a970f6644ac0a4961ac";
  assert.equal(isValidNearAddress(validImplicit), true);

  // Truncated (32 hex characters / 16 bytes) must be rejected
  const truncatedImplicit = "9c3c9e101c1f4f5e9c4a1d7b9a8f3c20";
  assert.equal(isValidNearAddress(truncatedImplicit), false);

  // Uppercase hex in implicit address is normalized or checked
  assert.equal(isValidNearAddress(validImplicit.toUpperCase()), false);
});

test("validates NEAR named account identifiers", () => {
  assert.equal(isValidNearAddress("alice.near"), true);
  assert.equal(isValidNearAddress("treasury.sputnik-dao.near"), true);
  assert.equal(isValidNearAddress("flow_app.near"), true);
  assert.equal(isValidNearAddress("a"), false); // too short (< 2)
  assert.equal(isValidNearAddress("a".repeat(65)), false); // too long (> 64)
});

test("validates EVM addresses for Base and Ethereum", () => {
  const validEvm = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
  assert.equal(isValidEvmAddress(validEvm), true);
  assert.equal(isValidEvmAddress(validEvm.toLowerCase()), true);

  // Missing 0x prefix
  assert.equal(
    isValidEvmAddress("833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"),
    false,
  );
  // Invalid length
  assert.equal(isValidEvmAddress("0x833589"), false);
  // Non-hex characters
  assert.equal(
    isValidEvmAddress("0x833589fCD6eDb6E08f4c7C32D4f71b54bdA0291Z"),
    false,
  );
});

test("validates Solana Base58 addresses", () => {
  const validSolana = "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU";
  assert.equal(isValidSolanaAddress(validSolana), true);

  // Contains invalid Base58 character (0, O, I, l)
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

  // Mismatched networks
  assert.equal(
    validateAddressForNetwork("eip155:8453", nearImplicit).valid,
    false,
  );
  assert.equal(
    validateAddressForNetwork("near:mainnet", evmAddress).valid,
    false,
  );
});

test("distinguishes address derivation, broadcast mode and balance reading across networks", () => {
  // NEAR has provider-managed broadcast and native balance
  const near = OUTLAYER_CAPABILITIES.near;
  assert.equal(near.canDeriveAddress, true);
  assert.equal(near.canReadNativeBalance, true);
  assert.equal(near.broadcastMode, "provider_broadcast");

  // Base has caller-managed broadcast (raw signed tx) and external balance
  const base = OUTLAYER_CAPABILITIES.base;
  assert.equal(base.canDeriveAddress, true);
  assert.equal(base.canReadNativeBalance, false); // requires Base RPC
  assert.equal(base.broadcastMode, "caller_broadcast");

  // Bitcoin is unsupported by OutLayer wallet v1
  const btc = OUTLAYER_CAPABILITIES.bitcoin;
  assert.equal(btc.canDeriveAddress, false);
  assert.equal(btc.broadcastMode, "unsupported");
});

test("evaluates policy readiness and enforces execution safeguards", () => {
  // Execution disabled globally -> always false
  assert.equal(
    evaluatePolicyReadiness(
      {
        walletId: "w1",
        state: "stored",
        frozen: false,
        allowsFinancialExecution: true,
      },
      true, // globalExecutionDisabled
    ),
    false,
  );

  // Policy "none" (unverified custody) -> false even if global execution were enabled
  assert.equal(
    evaluatePolicyReadiness(
      {
        walletId: "w1",
        state: "none",
        frozen: false,
        allowsFinancialExecution: true,
      },
      false,
    ),
    false,
  );

  // Frozen wallet -> false
  assert.equal(
    evaluatePolicyReadiness(
      {
        walletId: "w1",
        state: "stored",
        frozen: true,
        allowsFinancialExecution: true,
      },
      false,
    ),
    false,
  );

  // Stored, unfrozen, execution permitted
  assert.equal(
    evaluatePolicyReadiness(
      {
        walletId: "w1",
        state: "stored",
        frozen: false,
        allowsFinancialExecution: true,
      },
      false,
    ),
    true,
  );
});

test("evaluates comprehensive wallet fund-readiness and decouples registration from fund receipt", () => {
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
    state: "stored" as const,
    frozen: false,
    allowsFinancialExecution: true,
  };

  const safeCapabilities = [
    { network: "near", canSignTransfer: false, canReceive: true },
    { network: "base", canSignTransfer: false, canReceive: true },
    { network: "solana", canSignTransfer: false, canReceive: true },
  ];

  // 1. When global execution is disabled (as required in M2), isReady is ALWAYS false
  const globalDisabledCheck = evaluateWalletFundReadiness({
    walletStatus: "ACTIVE",
    policySummary: validPolicy,
    derivedAddresses: validAddresses,
    capabilities: safeCapabilities,
    globalExecutionDisabled: true,
  });
  assert.equal(globalDisabledCheck.isReady, false);
  assert.equal(globalDisabledCheck.canReceiveFunds, false);
  assert.equal(globalDisabledCheck.canSignTransfers, false);
  assert.ok(globalDisabledCheck.reason?.includes("FLOW_EXECUTION=disabled"));

  // 2. Even if global execution were enabled, non-ACTIVE status (e.g. SETUP_PENDING) is NOT ready
  const pendingCheck = evaluateWalletFundReadiness({
    walletStatus: "SETUP_PENDING",
    policySummary: validPolicy,
    derivedAddresses: validAddresses,
    capabilities: safeCapabilities,
    globalExecutionDisabled: false,
  });
  assert.equal(pendingCheck.isReady, false);
  assert.ok(pendingCheck.reason?.includes("SETUP_PENDING"));

  // 3. Even if ACTIVE, unverified policy ("none") is NOT ready
  const unverifiedPolicyCheck = evaluateWalletFundReadiness({
    walletStatus: "ACTIVE",
    policySummary: { ...validPolicy, state: "none" },
    derivedAddresses: validAddresses,
    capabilities: safeCapabilities,
    globalExecutionDisabled: false,
  });
  assert.equal(unverifiedPolicyCheck.isReady, false);
  assert.ok(
    unverifiedPolicyCheck.reason?.includes("requires verified 'stored' policy"),
  );

  // 4. Missing required chain address (e.g. Solana missing) is NOT ready
  const missingChainCheck = evaluateWalletFundReadiness({
    walletStatus: "ACTIVE",
    policySummary: validPolicy,
    derivedAddresses: validAddresses.slice(0, 2), // NEAR and Base only
    capabilities: safeCapabilities,
    globalExecutionDisabled: false,
  });
  assert.equal(missingChainCheck.isReady, false);
  assert.ok(missingChainCheck.reason?.includes("Missing verified addresses"));

  // 5. In an imaginary live environment with verified policy and addresses, canReceive is true but canSign remains false
  const readyCheck = evaluateWalletFundReadiness({
    walletStatus: "ACTIVE",
    policySummary: validPolicy,
    derivedAddresses: validAddresses,
    capabilities: safeCapabilities,
    globalExecutionDisabled: false,
  });
  assert.equal(readyCheck.isReady, true);
  assert.equal(readyCheck.canReceiveFunds, true);
  assert.equal(readyCheck.canSignTransfers, false); // can_sign_transfer is false
});

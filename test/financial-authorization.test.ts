import assert from "node:assert/strict";
import test from "node:test";
import {
  evaluateSpendingPolicy,
  FinancialAuthorizationPipeline,
  type FinancialTransferIntent,
  type SpendingPolicy,
  validateRecipientAddress,
} from "../src/domain/financial-authorization.ts";

const BASE_VALID_POLICY: SpendingPolicy = {
  id: "pol-1",
  accountId: "acc-1",
  maxSingleTransferAtomic: 100_000_000n, // 100 USDC
  dailyVelocityLimitAtomic: 500_000_000n, // 500 USDC
  dailyAccumulatedAtomic: 150_000_000n, // 150 USDC spent today
  allowedNetworks: ["eip155:8453", "solana:mainnet", "near:mainnet"],
  requireDualApproval: false,
};

const BASE_VALID_INTENT: FinancialTransferIntent = {
  transferId: "tx-1",
  accountId: "acc-1",
  initiatorUserId: "usr-1",
  assetId: "base-mainnet:USDC",
  network: "eip155:8453",
  recipientAddress: "0x2424242424242424242424242424242424242424",
  atomicAmount: 50_000_000n, // 50 USDC
  requestedAt: new Date().toISOString(),
  userConfirmationProof: {
    type: "EXPLICIT_STEP_UP_TICKET",
    ticketDigest: "digest-12345",
    confirmedAt: new Date().toISOString(),
  },
};

test("validateRecipientAddress: checks valid EVM, Solana, and NEAR addresses", () => {
  // 1. Valid EVM checksum
  const evmRes = validateRecipientAddress(
    "eip155:8453",
    "0x2424242424242424242424242424242424242424",
  );
  assert.equal(evmRes.valid, true);

  // 2. Invalid EVM length / format
  const badEvmRes = validateRecipientAddress("eip155:8453", "0x1234");
  assert.equal(badEvmRes.valid, false);

  // 3. Valid Solana Base58
  const solRes = validateRecipientAddress(
    "solana:mainnet",
    "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU",
  );
  assert.equal(solRes.valid, true);

  // 4. Invalid Solana
  const badSolRes = validateRecipientAddress(
    "solana:mainnet",
    "invalid!solana",
  );
  assert.equal(badSolRes.valid, false);

  // 5. Valid NEAR named
  const nearRes = validateRecipientAddress("near:mainnet", "merchant.near");
  assert.equal(nearRes.valid, true);

  // 6. Invalid NEAR
  const badNearRes = validateRecipientAddress("near:mainnet", "-invalid-near-");
  assert.equal(badNearRes.valid, false);
});

test("evaluateSpendingPolicy: enforces single transfer and daily velocity boundaries", () => {
  // 1. Permitted under limits
  const ok = evaluateSpendingPolicy(BASE_VALID_POLICY, BASE_VALID_INTENT);
  assert.equal(ok.permitted, true);

  // 2. Exceeds single transfer limit
  const singleExceeded = evaluateSpendingPolicy(BASE_VALID_POLICY, {
    ...BASE_VALID_INTENT,
    atomicAmount: 150_000_000n, // > 100 USDC limit
  });
  assert.equal(singleExceeded.permitted, false);
  assert.ok(singleExceeded.reason?.includes("maximum single transfer limit"));

  // 3. Exceeds daily velocity limit (150 current + 400 new = 550 > 500 limit)
  const velocityExceeded = evaluateSpendingPolicy(
    { ...BASE_VALID_POLICY, maxSingleTransferAtomic: 1_000_000_000n },
    { ...BASE_VALID_INTENT, atomicAmount: 400_000_000n },
  );
  assert.equal(velocityExceeded.permitted, false);
  assert.ok(velocityExceeded.reason?.includes("daily velocity limit"));

  // 4. Disallowed network
  const disallowedNet = evaluateSpendingPolicy(
    { ...BASE_VALID_POLICY, allowedNetworks: ["solana:mainnet"] },
    BASE_VALID_INTENT,
  );
  assert.equal(disallowedNet.permitted, false);
  assert.ok(disallowedNet.reason?.includes("not permitted"));
});

test("FinancialAuthorizationPipeline: enforces FLOW_EXECUTION=disabled guardrail", () => {
  // Global execution disabled = true (default)
  const blocked = FinancialAuthorizationPipeline.authorizeOutgoingPayment({
    intent: BASE_VALID_INTENT,
    policy: BASE_VALID_POLICY,
    availableBalanceAtomic: 100_000_000n,
    globalExecutionDisabled: true,
  });

  assert.equal(blocked.authorized, false);
  assert.equal(blocked.status, "EXECUTION_BLOCKED");
  assert.ok(blocked.rejectionReason?.includes("FLOW_EXECUTION=disabled"));
});

test("FinancialAuthorizationPipeline: verifies balance sufficiency and dual approval", () => {
  const enabledEnv = { FLOW_EXECUTION: "enabled" };

  // 1. Insufficient balance
  const insufficient = FinancialAuthorizationPipeline.authorizeOutgoingPayment({
    intent: BASE_VALID_INTENT,
    policy: BASE_VALID_POLICY,
    availableBalanceAtomic: 10_000_000n, // only 10 USDC available, 50 requested
    globalExecutionDisabled: false,
    env: enabledEnv,
  });
  assert.equal(insufficient.authorized, false);
  assert.equal(insufficient.status, "REJECTED");
  assert.ok(insufficient.rejectionReason?.includes("Insufficient"));

  // 2. Dual approval required for business policy
  const dualReq = FinancialAuthorizationPipeline.authorizeOutgoingPayment({
    intent: BASE_VALID_INTENT,
    policy: { ...BASE_VALID_POLICY, requireDualApproval: true },
    availableBalanceAtomic: 100_000_000n,
    globalExecutionDisabled: false,
    env: enabledEnv,
  });
  assert.equal(dualReq.authorized, false);
  assert.equal(dualReq.status, "PENDING_APPROVAL");
  assert.ok(dualReq.rejectionReason?.includes("dual-operator"));

  // 3. Fully authorized when execution is enabled and dual signature provided
  const authorized = FinancialAuthorizationPipeline.authorizeOutgoingPayment({
    intent: {
      ...BASE_VALID_INTENT,
      userConfirmationProof: {
        type: "DUAL_OPERATOR_SIGNATURE",
        ticketDigest: "dual-sig-1234",
        confirmedAt: new Date().toISOString(),
      },
    },
    policy: { ...BASE_VALID_POLICY, requireDualApproval: true },
    availableBalanceAtomic: 100_000_000n,
    globalExecutionDisabled: false,
    env: enabledEnv,
  });
  assert.equal(authorized.authorized, true);
  assert.equal(authorized.status, "POLICY_APPROVED");
  assert.equal(authorized.reservationAmountAtomic, 50_000_000n);
});

test("FinancialAuthorizationPipeline: enforces privileged worker context", () => {
  // Worker permitted
  assert.doesNotThrow(() => {
    FinancialAuthorizationPipeline.assertPrivilegedSigningContext(
      "flow_worker",
    );
  });

  // App role, web session, or anonymous rejected
  assert.throws(
    () => {
      FinancialAuthorizationPipeline.assertPrivilegedSigningContext("flow_app");
    },
    { code: "CUSTODY_OPERATOR_AUTHORIZATION_ERROR" },
  );

  assert.throws(
    () => {
      FinancialAuthorizationPipeline.assertPrivilegedSigningContext(
        "flow_operator",
      );
    },
    { code: "CUSTODY_OPERATOR_AUTHORIZATION_ERROR" },
  );
});

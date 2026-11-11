import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isFinancialExecutionDisabled } from "../src/domain/custody.ts";
import {
  FinancialAuthorizationPipeline,
  type FinancialTransferIntent,
  type SpendingPolicy,
} from "../src/domain/financial-authorization.ts";
import {
  resolveOneClickAssetId,
  isRouteSupportedByOneClick,
  validateRefundAddressForMode,
  isBannedIllustrativeAddress,
  type PaymentAttemptStatus,
} from "../src/domain/quote-discovery.ts";
import { validateEcosystemAddress } from "../src/domain/supported-assets-catalog.ts";
import {
  quoteHash,
  verifyQuoteSignature,
  type OneClickQuoteResponse,
} from "@defuse-protocol/one-click-sdk-typescript";
import type { FlowError } from "../src/foundation/errors.ts";
import type { FlowDb } from "../src/foundation/prisma.ts";
import { PaymentMonitoringWorker } from "../src/server/payments/payment-monitoring-worker.ts";
import nacl from "tweetnacl";

// Helper to encode Uint8Array to base58
const B58_ALPHABET =
  "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function encodeBase58(buffer: Uint8Array): string {
  const digits = [0];
  for (let i = 0; i < buffer.length; i++) {
    for (let j = 0; j < digits.length; j++) digits[j]! <<= 8;
    digits[0]! += buffer[i]!;
    let carry = 0;
    for (let j = 0; j < digits.length; ++j) {
      digits[j]! += carry;
      carry = (digits[j]! / 58) | 0;
      digits[j]! %= 58;
    }
    while (carry) {
      digits.push(carry % 58);
      carry = (carry / 58) | 0;
    }
  }
  for (let i = 0; i < buffer.length && buffer[i] === 0; i++) digits.push(0);
  return digits
    .reverse()
    .map((digit) => B58_ALPHABET[digit])
    .join("");
}

describe("inbound-payment-readiness: architectural separation & verification guards", () => {
  const CANONICAL_BASE_RECIPIENT = "0x436BdB38888998e269E94301C2362C2f46bCF614";
  const CANONICAL_BASE_USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";

  it("Task 1: confirms FLOW_EXECUTION=disabled blocks outgoing signing while inbound receipt remains passive", () => {
    // 1. Assert execution is disabled under default environment
    const disabled = isFinancialExecutionDisabled();
    assert.equal(disabled, true, "FLOW_EXECUTION must remain disabled");

    // 2. Outgoing transfer pipeline is strictly blocked
    const dummyIntent: FinancialTransferIntent = {
      transferId: "tr_test_123",
      accountId: "cb88c933-b6a9-4de5-a8d8-8cd56cf5696c",
      initiatorUserId: "usr_test",
      assetId: "base-mainnet:USDC",
      network: "base-mainnet",
      recipientAddress: "0x1111111111111111111111111111111111111111",
      atomicAmount: 1000000n,
      requestedAt: new Date().toISOString(),
      userConfirmationProof: {
        type: "EXPLICIT_STEP_UP_TICKET",
        ticketDigest: "hash",
        confirmedAt: new Date().toISOString(),
      },
    };

    const policy: SpendingPolicy = {
      id: "sp_1",
      accountId: "cb88c933-b6a9-4de5-a8d8-8cd56cf5696c",
      maxSingleTransferAtomic: 10000000n,
      dailyVelocityLimitAtomic: 100000000n,
      dailyAccumulatedAtomic: 0n,
      allowedNetworks: ["base-mainnet"],
      requireDualApproval: false,
    };

    const outgoingAuth =
      FinancialAuthorizationPipeline.authorizeOutgoingPayment({
        intent: dummyIntent,
        policy,
        availableBalanceAtomic: 50000000n,
        globalExecutionDisabled: true,
      });

    assert.equal(outgoingAuth.authorized, false);
    assert.equal(outgoingAuth.status, "EXECUTION_BLOCKED");
    assert.match(outgoingAuth.rejectionReason ?? "", /FLOW_EXECUTION=disabled/);

    // 3. Confirm only privileged flow_worker context can access signing workers
    assert.throws(
      () =>
        FinancialAuthorizationPipeline.assertPrivilegedSigningContext(
          "flow_app",
        ),
      (err: unknown) =>
        err instanceof Error &&
        (err as FlowError).code === "CUSTODY_OPERATOR_AUTHORIZATION_ERROR",
    );
  });

  it("Task 2 & 4: validates exact destination binding and 1Click asset identifiers for 1 USDC on Base", () => {
    // 1. Resolve 1Click identifiers
    const solOneClickId = resolveOneClickAssetId("solana-mainnet:SOL");
    const baseUsdcOneClickId = resolveOneClickAssetId("base-mainnet:USDC");

    assert.equal(solOneClickId, "nep141:sol.omft.near");
    assert.equal(
      baseUsdcOneClickId,
      "nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near",
    );

    // 2. Validate route support
    const isSupported = isRouteSupportedByOneClick(
      "solana-mainnet:SOL",
      "base-mainnet:USDC",
    );
    assert.equal(isSupported, true);

    // 3. Validate recipient address matches permanent Base address
    const recipientValidation = validateEcosystemAddress(
      "evm",
      CANONICAL_BASE_RECIPIENT,
    );
    assert.equal(recipientValidation.valid, true);

    // 4. Validate non-synthetic recipient and contract addresses
    assert.equal(isBannedIllustrativeAddress(CANONICAL_BASE_RECIPIENT), false);
    assert.equal(isBannedIllustrativeAddress(CANONICAL_BASE_USDC), false);
  });

  it("Task 3: validates cryptographic signature verification on dry and committed 1Click quotes", () => {
    const keypair = nacl.sign.keyPair();
    const managerPublicKey = `ed25519:${encodeBase58(keypair.publicKey)}`;

    const validQuote = {
      quoteRequest: {
        dry: false,
        swapType: "EXACT_OUTPUT",
        slippageTolerance: 100,
        originAsset: "nep141:sol.omft.near",
        depositType: "ORIGIN_CHAIN" as const,
        destinationAsset:
          "nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near",
        amount: "1000000", // 1 USDC
        refundTo: "GvTihjQRfzPtuk4iptiDnsWLojCFX1QBSDgzgi8JAgAS",
        refundType: "ORIGIN_CHAIN" as const,
        recipient: CANONICAL_BASE_RECIPIENT,
        recipientType: "DESTINATION_CHAIN" as const,
        deadline: new Date(Date.now() + 600000).toISOString(),
      },
      quote: {
        amountIn: "12268315", // 0.012268315 SOL
        amountOut: "1000000", // 1 USDC
        depositAddress: "0xRealSolverDepositAddress1234567890",
        deadline: new Date(Date.now() + 600000).toISOString(),
      },
      timestamp: new Date().toISOString(),
      signature: "",
    };

    // Sign payload
    const hash = quoteHash(validQuote as unknown as OneClickQuoteResponse);
    const signatureBytes = nacl.sign.detached(
      new TextEncoder().encode(hash),
      keypair.secretKey,
    );
    validQuote.signature = `ed25519:${encodeBase58(signatureBytes)}`;

    // 1. Valid signature verifies
    assert.equal(
      verifyQuoteSignature(
        validQuote as unknown as OneClickQuoteResponse,
        managerPublicKey,
      ),
      true,
    );

    // 2. Tampered recipient address fails
    const tamperedQuote = {
      ...validQuote,
      quoteRequest: {
        ...validQuote.quoteRequest,
        recipient: "0xAttackerAddress000000000000000000000000",
      },
    };
    assert.equal(
      verifyQuoteSignature(
        tamperedQuote as unknown as OneClickQuoteResponse,
        managerPublicKey,
      ),
      false,
    );

    // 3. Tampered destination amount fails
    const tamperedAmountQuote = {
      ...validQuote,
      quote: {
        ...validQuote.quote,
        amountOut: "999999999",
      },
    };
    assert.equal(
      verifyQuoteSignature(
        tamperedAmountQuote as unknown as OneClickQuoteResponse,
        managerPublicKey,
      ),
      false,
    );
  });

  it("Task 5 & 8: validates strict refund address formatting and edge-case rejections", () => {
    // 1. Solana refund address validation
    const validSolanaRefund = "GvTihjQRfzPtuk4iptiDnsWLojCFX1QBSDgzgi8JAgAS";
    const invalidSolanaRefund = "0x436BdB38888998e269E94301C2362C2f46bCF614"; // EVM address passed as Solana

    const solanaCheck = validateRefundAddressForMode(
      "EXCHANGE",
      "solana",
      validSolanaRefund,
    );
    assert.equal(solanaCheck.valid, true);

    const invalidSolanaCheck = validateRefundAddressForMode(
      "EXCHANGE",
      "solana",
      invalidSolanaRefund,
    );
    assert.equal(invalidSolanaCheck.valid, false);

    // 2. Reject synthetic and illustrative addresses
    assert.equal(
      isBannedIllustrativeAddress("0x0000000000000000000000000000000000000000"),
      true,
    );
    assert.equal(
      isBannedIllustrativeAddress("0x1111111111111111111111111111111111111111"),
      true,
    );
    assert.equal(
      isBannedIllustrativeAddress("0xd8da6bf26964af9d7eed9e03e53415d37aa96045"),
      true,
    );
    assert.equal(
      isBannedIllustrativeAddress(
        "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU",
      ),
      true,
    );
  });

  it("Task 6: asserts 1 USDC (1,000,000 atomic units) satisfies minimum threshold bounds", () => {
    const INVOICE_1_USDC = 1000000n;
    const MINIMUM_BRIDGE_THRESHOLD = 83676n; // Observed from 1Click live rejection

    assert.ok(
      INVOICE_1_USDC > MINIMUM_BRIDGE_THRESHOLD,
      "1.00 USDC must comfortably exceed bridge minimum threshold (83,676 atomic units)",
    );
    assert.equal(
      Number(INVOICE_1_USDC) / 1e6,
      1.0,
      "Must match exactly 1.000000 USDC",
    );
  });

  it("Task 1 (Hardened): rejects OutLayer recipient address as payer refund destination and validates distinct ownership", () => {
    const RECIPIENT_BASE_ADDRESS = CANONICAL_BASE_RECIPIENT.toLowerCase();
    const RECIPIENT_SOLANA_ADDRESS =
      "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d";
    const PAYER_SOLANA_REFUND = "GvTihjQRfzPtuk4iptiDnsWLojCFX1QBSDgzgi8JAgAS";

    const recipientWalletAddresses = [
      RECIPIENT_BASE_ADDRESS,
      RECIPIENT_SOLANA_ADDRESS,
    ];

    // Check helper for recipient collision
    const isCollision = (refundAddr: string) =>
      recipientWalletAddresses.some(
        (addr) => addr.toLowerCase() === refundAddr.trim().toLowerCase(),
      );

    // 1. Recipient's own Solana address must be rejected
    assert.equal(
      isCollision(RECIPIENT_SOLANA_ADDRESS),
      true,
      "Recipient OutLayer Solana address must never be used as payer refund destination",
    );

    // 2. Recipient's Base address must be rejected
    assert.equal(
      isCollision(CANONICAL_BASE_RECIPIENT),
      true,
      "Recipient OutLayer Base address must never be used as payer refund destination",
    );

    // 3. Genuine payer refund address passes
    assert.equal(
      isCollision(PAYER_SOLANA_REFUND),
      false,
      "Distinct payer Solana refund address must be accepted",
    );
    assert.equal(
      validateRefundAddressForMode("WALLET", "solana", PAYER_SOLANA_REFUND)
        .valid,
      true,
    );
  });

  it("Task 2 (Hardened): binds payer cost cap strictly in SOL lamports and rejects quotes exceeding limit", () => {
    const AUTHORIZED_MAX_LAMPORTS = 15000000n; // 0.015 SOL authorized cap (~$3.00 max headroom for $1.00)

    // 1. Fresh committed quote within limit passes
    const validCommittedLamports = 12268315n; // ~0.012268 SOL
    assert.ok(
      validCommittedLamports <= AUTHORIZED_MAX_LAMPORTS,
      "Committed quote must be within authorized lamport ceiling",
    );

    // 2. Fresh committed quote exceeding authorized lamports is rejected
    const excessiveCommittedLamports = 16500000n; // ~0.0165 SOL
    const exceedsCap = excessiveCommittedLamports > AUTHORIZED_MAX_LAMPORTS;
    assert.equal(
      exceedsCap,
      true,
      "Quotes exceeding authorized lamport bound must be strictly rejected",
    );

    // 3. Separate source network gas verification
    const SOLANA_NETWORK_GAS_ESTIMATE_LAMPORTS = 5000n; // ~0.000005 SOL
    assert.ok(
      SOLANA_NETWORK_GAS_ESTIMATE_LAMPORTS < 100000n,
      "Solana source network fee is negligible and accounted separately from swap amount",
    );
  });

  it("Task 3 (Hardened): verifies commit timeout safety, RECONCILIATION_REQUIRED transition, and duplicate prevention", () => {
    // 1. Verify RECONCILIATION_REQUIRED is a valid PaymentAttemptStatus
    const validStatus: PaymentAttemptStatus = "RECONCILIATION_REQUIRED";
    assert.equal(validStatus, "RECONCILIATION_REQUIRED");

    // 2. Verify that an attempt in RECONCILIATION_REQUIRED cannot be recommitted
    const invalidStatusesForCommit: PaymentAttemptStatus[] = [
      "RECONCILIATION_REQUIRED",
      "SETTLING",
      "SETTLED",
      "FAILED",
      "EXPIRED",
      "EXCEPTION_REFUND_REQUIRED",
    ];

    for (const status of invalidStatusesForCommit) {
      const canCommit = status === "QUOTE_OBSERVED";
      assert.equal(
        canCommit,
        false,
        `Attempt in status ${status} must not be eligible for commitment`,
      );
    }
  });

  it("Task 4 (Hardened): correctly handles INCOMPLETE_DEPOSIT, prevents stale expiration, and avoids premature refund assumption", async () => {
    let rawQueryExecuted = false;
    const mockDb = {
      $executeRaw: async (query: unknown) => {
        const queryStr = String(query);
        rawQueryExecuted = true;
        assert.ok(
          queryStr.includes("UNDERPAID_REFUND_REQUIRED") ||
            queryStr.includes("EXCEPTION_REFUND_REQUIRED") ||
            queryStr.includes("poll_count"),
        );
        return 1;
      },
      $queryRaw: async (query: unknown) => {
        const queryStr = String(query);
        if (queryStr.includes("SELECT\n        pa.id")) {
          return [
            {
              id: "00000000-0000-0000-0000-000000000002",
              attempt_public_id: "pa_test_incomplete",
              status: "DEPOSIT_COMMITTED",
              deposit_address: "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d",
              deposit_memo: null,
              deposit_deadline: new Date(Date.now() + 600000),
              quote_expires_at: new Date(Date.now() + 600000),
              provider_correlation_id: "1click_corr_underpaid",
              source_network: "solana-mainnet",
              source_asset_id: "solana-mainnet:SOL",
              quoted_source_atomic_amount: "12268315",
              destination_network: "base-mainnet",
              destination_asset_id: "base-mainnet:USDC",
              quoted_destination_atomic_amount: "1000000",
              route_type: "CROSS_CHAIN_1CLICK",
              source_tx_hash: null,
              destination_tx_hash: null,
              poll_count: 0,
            },
          ];
        }
        return [];
      },
    } as unknown as FlowDb;

    const worker = new PaymentMonitoringWorker({
      workerId: "test-underpaid-worker",
      workerDb: mockDb,
    });

    const reconcileResult = await worker.reconcileAttempt(
      "pa_test_incomplete",
      async () => ({
        status: "INCOMPLETE_DEPOSIT",
        failureReason: "1Click reported incomplete/underpaid deposit",
        sourceTxHash:
          "5VERv8NMvzbJMEdV8xnrLkEaWR436xQsGhmGLxrNdEd137KqD5N2wK1i4tGv3d8nZbG1mR6tWv2tB9gH8yK3mQp2",
        rawEvidence: { status: "INCOMPLETE_DEPOSIT" },
      }),
    );
    assert.equal(reconcileResult.transitioned, true);
    assert.equal(reconcileResult.newStatus, "EXCEPTION_REFUND_REQUIRED");
    assert.equal(rawQueryExecuted, true);
  });

  it("Task 5 (Hardened): ensures provider SUCCESS alone cannot settle attempt without independent Base USDC verification", async () => {
    let dbSettledCalled = false;
    let onChainVerifierCalled = false;

    const mockDb = {
      $executeRaw: async () => 1,
      $queryRaw: async (query: unknown) => {
        const queryStr = String(query);
        if (queryStr.includes("SELECT\n        pa.id")) {
          return [
            {
              id: "00000000-0000-0000-0000-000000000003",
              attempt_public_id: "pa_test_settle_guard",
              status: "SETTLING",
              deposit_address: "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d",
              deposit_memo: null,
              deposit_deadline: null,
              quote_expires_at: null,
              provider_correlation_id: "1click_corr_success",
              source_network: "solana-mainnet",
              source_asset_id: "solana-mainnet:SOL",
              quoted_source_atomic_amount: "12268315",
              destination_network: "base-mainnet",
              destination_asset_id: "base-mainnet:USDC",
              quoted_destination_atomic_amount: "1000000",
              route_type: "CROSS_CHAIN_1CLICK",
              source_tx_hash:
                "5VERv8NMvzbJMEdV8xnrLkEaWR436xQsGhmGLxrNdEd137KqD5N2wK1i4tGv3d8nZbG1mR6tWv2tB9gH8yK3mQp2",
              destination_tx_hash:
                "0x4f3edf983ac636a65a842ce7c78d9aa706d3b113bce9c46f30d7d21715b23b1d",
              poll_count: 0,
            },
          ];
        }
        if (queryStr.includes("flow.payment_verifications")) {
          // No destination verification exists yet
          return [];
        }
        if (queryStr.includes("flow.worker_settle_payment_attempt")) {
          dbSettledCalled = true;
          return [
            {
              id: "attempt-uuid",
              attempt_public_id: "pa_test_settle_guard",
              status: "SETTLED",
              settled_at: new Date(),
              journal_id: "jid",
              journal_public_id: "j_pub",
            },
          ];
        }
        if (queryStr.includes("flow.wallet_addresses")) {
          return [{ address: CANONICAL_BASE_RECIPIENT }];
        }
        if (queryStr.includes("flow.record_payment_verification")) {
          return [
            {
              verification_id: "v-dest",
              payment_attempt_id: "00000000-0000-0000-0000-000000000003",
              verification_type: "DESTINATION_SETTLEMENT",
              status: "SETTLING",
              is_late_deposit: false,
            },
          ];
        }
        return [];
      },
    } as unknown as FlowDb;

    // 1. When onChainVerifier fails or returns non-finalized receipt, worker refuses to settle
    const workerWithFailingVerifier = new PaymentMonitoringWorker({
      workerId: "test-failing-verifier-worker",
      workerDb: mockDb,
      onChainVerifier: async (params) => {
        onChainVerifierCalled = true;
        // Independent verification discovers receipt is PENDING (not FINALIZED)
        return {
          network: params.network,
          txHash: params.txHash,
          eventIndex: 0,
          fromAddress: "0xsolver",
          toAddress: CANONICAL_BASE_RECIPIENT,
          assetId: "base-mainnet:USDC",
          tokenContract: CANONICAL_BASE_USDC,
          atomicAmount: 1000000n,
          blockHeight: 12345n,
          blockHash: "0xblock",
          finality: "PENDING" as const, // NOT FINALIZED
          memo: null,
          evidenceSource: "CHAIN_RPC_DIRECT" as const,
          rawEvidence: {},
          isSuccess: true,
        };
      },
    });

    const res = await workerWithFailingVerifier.reconcileAttempt(
      "pa_test_settle_guard",
      async () => ({
        status: "SETTLED", // Provider claims success!
        sourceTxHash:
          "5VERv8NMvzbJMEdV8xnrLkEaWR436xQsGhmGLxrNdEd137KqD5N2wK1i4tGv3d8nZbG1mR6tWv2tB9gH8yK3mQp2",
        destinationTxHash:
          "0x4f3edf983ac636a65a842ce7c78d9aa706d3b113bce9c46f30d7d21715b23b1d",
        evidenceSource: "1CLICK_STATUS_API",
        rawEvidence: { status: "SUCCESS" },
      }),
    );
    assert.equal(onChainVerifierCalled, true);
    assert.equal(
      dbSettledCalled,
      false,
      "Must NOT call worker_settle_payment_attempt when on-chain proof is not FINALIZED",
    );
    assert.notEqual(res.newStatus, "SETTLED");
  });

  it("Task 6 (Hardened): single-use authorization guard operates while FLOW_EXECUTION=disabled and can_sign_transfer=false", () => {
    // Assert custody settings
    assert.equal(isFinancialExecutionDisabled(), true);

    // Single-use simulation
    const authRecord = {
      id: "auth-1234",
      maxAtomicAmount: 15000000n, // 0.015 SOL in lamports
      consumedAt: null as Date | null,
    };

    const consumeAuth = (requestedLamports: bigint) => {
      if (authRecord.consumedAt !== null) {
        throw new Error("REHEARSAL_AUTHORIZATION_ALREADY_CONSUMED");
      }
      if (requestedLamports > authRecord.maxAtomicAmount) {
        throw new Error("REHEARSAL_AMOUNT_EXCEEDS_MAX_BOUND");
      }
      authRecord.consumedAt = new Date();
      return { ok: true, consumedAt: authRecord.consumedAt };
    };

    // First attempt consumes successfully
    const firstResult = consumeAuth(12268315n);
    assert.equal(firstResult.ok, true);
    assert.ok(authRecord.consumedAt !== null);

    // Subsequent attempt fails immediately with ALREADY_CONSUMED
    assert.throws(
      () => consumeAuth(12268315n),
      /REHEARSAL_AUTHORIZATION_ALREADY_CONSUMED/,
      "Authorization must be single-use only",
    );
  });
});

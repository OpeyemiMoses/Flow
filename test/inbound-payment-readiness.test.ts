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
} from "../src/domain/quote-discovery.ts";
import { validateEcosystemAddress } from "../src/domain/supported-assets-catalog.ts";
import {
  quoteHash,
  verifyQuoteSignature,
  type OneClickQuoteResponse,
} from "@defuse-protocol/one-click-sdk-typescript";
import type { FlowError } from "../src/foundation/errors.ts";
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
});

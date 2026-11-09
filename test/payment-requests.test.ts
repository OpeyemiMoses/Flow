import assert from "node:assert/strict";
import { test } from "node:test";
import {
  computeEligibleSourceRoutes,
  generatePublicPaymentId,
  isValidPublicPaymentId,
  serializePaymentRequest,
  serializePublicPaymentRequest,
  type PaymentRequestRecord,
  type PublicPaymentRequestDbRow,
} from "../src/domain/payment-requests.ts";

test("payment-requests: generatePublicPaymentId produces high-entropy unguessable tokens", () => {
  const ids = new Set<string>();
  for (let i = 0; i < 100; i++) {
    const id = generatePublicPaymentId();
    assert.ok(id.startsWith("pr_"));
    assert.ok(isValidPublicPaymentId(id));
    assert.ok(id.length >= 32);
    assert.equal(ids.has(id), false, "Generated IDs must be globally unique");
    ids.add(id);
  }
});

test("payment-requests: isValidPublicPaymentId enforces strict format and rejects malformed/enumerated IDs", () => {
  assert.equal(
    isValidPublicPaymentId("pr_abc123456789012345678901234567890"),
    true,
  );
  assert.equal(isValidPublicPaymentId("pr_"), false);
  assert.equal(isValidPublicPaymentId("pr_short"), false);
  assert.equal(
    isValidPublicPaymentId("invalid_prefix_1234567890123456"),
    false,
  );
  assert.equal(
    isValidPublicPaymentId("pr_has spaces in token 123456789"),
    false,
  );
  assert.equal(isValidPublicPaymentId("pr_semi;colon'attack1234567890"), false);
  assert.equal(isValidPublicPaymentId(""), false);
});

test("payment-requests: serializePaymentRequest formats atomic amounts and builds local share URL", () => {
  const now = new Date("2026-11-09T14:00:00Z");
  const expiry = new Date("2026-11-16T14:00:00Z");

  const record: PaymentRequestRecord = {
    id: "9f8b2a1c-0000-0000-0000-000000000001",
    accountId: "11111111-1111-1111-1111-111111111111",
    publicId: "pr_test_token_12345678901234567890",
    title: "Consulting Invoice #1042",
    description: "Phase 1 deliverables",
    destinationNetwork: "base-sepolia",
    destinationAssetId: "base-sepolia:USDC",
    destinationAssetSymbol: "USDC",
    destinationDecimals: 6,
    amountMode: "FIXED",
    requestedAtomicAmount: 50000000n, // 50 USDC
    status: "ACTIVE",
    expiresAt: expiry,
    payerMemoRequired: false,
    metadata: { ref: "inv-1042" },
    createdAt: now,
    updatedAt: now,
  };

  const serialized = serializePaymentRequest(record, "http://127.0.0.1:3000");

  assert.equal(serialized.id, record.id);
  assert.equal(serialized.accountId, record.accountId);
  assert.equal(serialized.publicId, record.publicId);
  assert.equal(
    serialized.shareUrl,
    "http://127.0.0.1:3000/pay/pr_test_token_12345678901234567890",
  );
  assert.equal(serialized.title, "Consulting Invoice #1042");
  assert.equal(serialized.displayAmount, "50");
  assert.equal(serialized.requestedAtomicAmount, "50000000");
  assert.equal(serialized.status, "ACTIVE");
  assert.equal(serialized.expiresAt, expiry.toISOString());
});

test("payment-requests: serializePaymentRequest handles optional amounts gracefully", () => {
  const now = new Date("2026-11-09T14:00:00Z");

  const record: PaymentRequestRecord = {
    id: "9f8b2a1c-0000-0000-0000-000000000002",
    accountId: "11111111-1111-1111-1111-111111111111",
    publicId: "pr_optional_token_1234567890123456",
    title: "Donation Tip",
    description: null,
    destinationNetwork: "near-testnet",
    destinationAssetId: "near-testnet:NEAR",
    destinationAssetSymbol: "NEAR",
    destinationDecimals: 24,
    amountMode: "OPTIONAL",
    requestedAtomicAmount: null,
    status: "ACTIVE",
    expiresAt: null,
    payerMemoRequired: true,
    metadata: {},
    createdAt: now,
    updatedAt: now,
  };

  const serialized = serializePaymentRequest(record, "http://localhost:3000/");

  assert.equal(serialized.requestedAtomicAmount, null);
  assert.equal(serialized.displayAmount, null);
  assert.equal(serialized.amountMode, "OPTIONAL");
  assert.equal(serialized.payerMemoRequired, true);
  assert.equal(
    serialized.shareUrl,
    "http://localhost:3000/pay/pr_optional_token_1234567890123456",
  );
});

test("payment-requests: serializePublicPaymentRequest strictly omits internal account identifiers and detects expiry", () => {
  const dbRow: PublicPaymentRequestDbRow = {
    public_id: "pr_public_test_1234567890123456",
    title: "Services Payment",
    description: "Net 30 terms",
    destination_network: "base-sepolia",
    destination_asset_id: "base-sepolia:USDC",
    destination_asset_symbol: "USDC",
    destination_decimals: 6,
    amount_mode: "FIXED",
    requested_atomic_amount: "15000000", // 15 USDC
    status: "ACTIVE",
    expires_at: new Date(Date.now() - 3600_000), // Expired 1 hour ago
    payer_memo_required: false,
    recipient_name: "Acme Payments Inc",
    recipient_kind: "BUSINESS",
  };

  const pub = serializePublicPaymentRequest(dbRow, "http://127.0.0.1:3000");

  assert.equal(pub.publicId, "pr_public_test_1234567890123456");
  assert.equal(pub.title, "Services Payment");
  assert.equal(pub.recipientName, "Acme Payments Inc");
  assert.equal(pub.recipientKind, "BUSINESS");
  assert.equal(pub.displayAmount, "15");
  assert.equal(
    pub.status,
    "EXPIRED",
    "Past expiry must be reflected as EXPIRED",
  );
  assert.equal(pub.isExpired, true);

  // Assert internal IDs are completely absent from public projection
  const unk = pub as unknown as Record<string, unknown>;
  assert.equal(unk.accountId, undefined);
  assert.equal(unk.account_id, undefined);
  assert.equal(unk.walletId, undefined);
  assert.equal(unk.wallet_id, undefined);
  assert.equal(unk.id, undefined);
});

test("payment-requests: computeEligibleSourceRoutes partitions direct vs 1Click cross-chain routes truthfully", () => {
  const routes = computeEligibleSourceRoutes(
    "base-sepolia",
    "base-sepolia:USDC",
  );

  assert.ok(routes.length > 0);

  // Direct route on Base Sepolia USDC
  const direct = routes.find(
    (r) => r.networkKey === "base-sepolia" && r.id === "base-sepolia:USDC",
  );
  assert.ok(direct);
  assert.equal(direct.routeType, "DIRECT_TRANSFER");
  assert.equal(direct.isOperationalNow, false);
  assert.ok(direct.availabilityNotice.includes("FLOW_EXECUTION is disabled"));

  // Cross-chain route from Solana Devnet or NEAR Testnet
  const cross = routes.find(
    (r) => r.networkKey === "near-testnet" || r.networkKey === "solana-devnet",
  );
  assert.ok(cross);
  assert.equal(cross.routeType, "CROSS_CHAIN_1CLICK");
  assert.equal(cross.isOperationalNow, false);
  assert.ok(cross.availabilityNotice.includes("FLOW_EXECUTION is disabled"));
});

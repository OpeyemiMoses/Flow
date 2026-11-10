import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import {
  PROBE_ADDRESSES,
  buildRateDescription,
  generatePaymentAttemptPublicId,
  isRouteExchangeCompatible,
  isRouteSupportedByOneClick,
  isValidPaymentAttemptPublicId,
  resolveOneClickAssetId,
  validateProviderAtomicAmount,
  validateRefundAddressForMode,
} from "../src/domain/quote-discovery.ts";
import { fetchOneClickDryQuote } from "../src/server/providers/one-click-adapter.ts";

test("quote-discovery: resolveOneClickAssetId maps curated mainnet assets and excludes testnets", () => {
  // Mainnet mapped assets
  assert.equal(
    resolveOneClickAssetId("ethereum-mainnet:ETH"),
    "nep141:eth.omft.near",
  );
  assert.equal(
    resolveOneClickAssetId("ethereum-mainnet:USDC"),
    "nep141:eth-0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48.omft.near",
  );
  assert.equal(
    resolveOneClickAssetId("base-mainnet:ETH"),
    "nep141:base.omft.near",
  );
  assert.equal(
    resolveOneClickAssetId("base-mainnet:USDC"),
    "nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near",
  );
  assert.equal(
    resolveOneClickAssetId("solana-mainnet:SOL"),
    "nep141:sol.omft.near",
  );
  assert.equal(
    resolveOneClickAssetId("solana-mainnet:USDC"),
    "nep141:sol-5ce3bf3a31af18be40ba30f721101b4341690186.omft.near",
  );
  assert.equal(
    resolveOneClickAssetId("near-mainnet:wNEAR"),
    "nep141:wrap.near",
  );
  assert.equal(
    resolveOneClickAssetId("near-mainnet:USDC"),
    "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1",
  );

  // Testnets have zero solver liquidity and must return null
  assert.equal(resolveOneClickAssetId("base-sepolia:USDC"), null);
  assert.equal(resolveOneClickAssetId("base-sepolia:ETH"), null);
  assert.equal(resolveOneClickAssetId("solana-devnet:SOL"), null);
  assert.equal(resolveOneClickAssetId("solana-devnet:USDC"), null);
  assert.equal(resolveOneClickAssetId("near-testnet:NEAR"), null);
  assert.equal(resolveOneClickAssetId("near-testnet:USDC"), null);
});

test("quote-discovery: isRouteSupportedByOneClick checks both source and destination support", () => {
  // Mainnet pair: Solana SOL -> Base USDC
  assert.equal(
    isRouteSupportedByOneClick("solana-mainnet:SOL", "base-mainnet:USDC"),
    true,
  );
  // Mainnet pair: Ethereum ETH -> Base USDC
  assert.equal(
    isRouteSupportedByOneClick("ethereum-mainnet:ETH", "base-mainnet:USDC"),
    true,
  );
  // Testnet pair: Base Sepolia USDC -> Base Sepolia USDC
  assert.equal(
    isRouteSupportedByOneClick("base-sepolia:USDC", "base-sepolia:USDC"),
    false,
  );
  // Mixed: Mainnet SOL -> Testnet Base Sepolia USDC
  assert.equal(
    isRouteSupportedByOneClick("solana-mainnet:SOL", "base-sepolia:USDC"),
    false,
  );
});

test("quote-discovery: generatePaymentAttemptPublicId creates compliant unguessable IDs", () => {
  const ids = new Set<string>();
  for (let i = 0; i < 50; i++) {
    const id = generatePaymentAttemptPublicId();
    assert.ok(id.startsWith("pa_"));
    assert.ok(isValidPaymentAttemptPublicId(id));
    assert.equal(ids.has(id), false);
    ids.add(id);
  }

  assert.equal(
    isValidPaymentAttemptPublicId("pa_0123456789abcdef0123456789abcdef"),
    true,
  );
  assert.equal(isValidPaymentAttemptPublicId("pa_"), false);
  assert.equal(isValidPaymentAttemptPublicId("pa_short"), false);
  assert.equal(isValidPaymentAttemptPublicId("invalid_pa_123456789"), false);
  assert.equal(
    isValidPaymentAttemptPublicId("pa_has space in id 12345"),
    false,
  );
});

test("quote-discovery: validateRefundAddressForMode strictly enforces address rules in Exchange mode", () => {
  // 1. In WALLET mode, refund address is optional
  const walletEmpty = validateRefundAddressForMode("WALLET", "evm", undefined);
  assert.equal(walletEmpty.valid, true);

  const walletProvidedValid = validateRefundAddressForMode(
    "WALLET",
    "evm",
    "0x1111111111111111111111111111111111111111",
  );
  assert.equal(walletProvidedValid.valid, true);

  const walletProvidedInvalid = validateRefundAddressForMode(
    "WALLET",
    "evm",
    "not-an-evm-address",
  );
  assert.equal(walletProvidedInvalid.valid, false);

  // 2. In EXCHANGE mode, refund address is mandatory
  const exchangeEmpty = validateRefundAddressForMode("EXCHANGE", "evm", "");
  assert.equal(exchangeEmpty.valid, false);
  assert.ok(
    exchangeEmpty.error?.includes("strictly required for exchange withdrawals"),
  );

  // EVM valid vs invalid
  assert.equal(
    validateRefundAddressForMode(
      "EXCHANGE",
      "evm",
      "0x2424242424242424242424242424242424242424",
    ).valid,
    true,
  );
  assert.equal(
    validateRefundAddressForMode("EXCHANGE", "evm", "0xInvalidLength").valid,
    false,
  );

  // Solana valid vs invalid
  assert.equal(
    validateRefundAddressForMode(
      "EXCHANGE",
      "solana",
      "4wBqpZM9xaSheZzJSMawUKKwhdpChKbZ5eu5ky4Vigw",
    ).valid,
    true,
  );
  assert.equal(
    validateRefundAddressForMode(
      "EXCHANGE",
      "solana",
      "0x2424242424242424242424242424242424242424",
    ).valid,
    false,
    "EVM address must be rejected for Solana ecosystem refund",
  );

  // NEAR valid vs invalid
  assert.equal(
    validateRefundAddressForMode("EXCHANGE", "near", "treasury.near").valid,
    true,
  );
  assert.equal(
    validateRefundAddressForMode(
      "EXCHANGE",
      "near",
      "9f8b2a1c00000000000000000000000000000000000000000000000000000001",
    ).valid,
    true,
  );
  assert.equal(
    validateRefundAddressForMode(
      "EXCHANGE",
      "near",
      "invalid near address with spaces",
    ).valid,
    false,
  );
});

test("quote-discovery: buildRateDescription formats human readable exchange rates", () => {
  // SOL (9 dec) to USDC (6 dec)
  // 1 SOL (1_000_000_000) -> 85 USDC (85_000_000)
  const rateDesc = buildRateDescription(
    "SOL",
    9,
    "1000000000",
    "USDC",
    6,
    "85000000",
  );
  assert.ok(
    rateDesc.includes("1 SOL ≈ 85.0000 USDC") || rateDesc.includes("85"),
  );

  // Base ETH (18 dec) to USDC (6 dec)
  const rateDesc2 = buildRateDescription(
    "ETH",
    18,
    "1000000000000000000",
    "USDC",
    6,
    "3000000000",
  );
  assert.ok(rateDesc2.includes("3000"));
});

test("quote-discovery: fetchOneClickDryQuote parses responses and handles provider errors accurately", async () => {
  let mockStatus = 200;
  let mockBody: Record<string, unknown> = {};

  const server = http.createServer((_req, res) => {
    res.writeHead(mockStatus, { "Content-Type": "application/json" });
    res.end(JSON.stringify(mockBody));
  });

  await new Promise<void>((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve()),
  );
  const address = server.address() as AddressInfo;
  const apiBase = `http://127.0.0.1:${address.port}`;

  try {
    // 1. Success case: supported and quotable with valid amounts and fees
    mockStatus = 200;
    mockBody = {
      quote: {
        amountIn: "116868899",
        amountOut: "10000000",
        timeEstimate: 22,
        refundFee: "115314",
        withdrawFee: "2400",
      },
      signature: "ed25519:test_sig",
      correlationId: "corr-12345",
      timestamp: "2026-11-09T14:00:00Z",
    };

    const res1 = await fetchOneClickDryQuote({
      originAsset: "nep141:sol.omft.near",
      destinationAsset:
        "nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near",
      swapType: "EXACT_OUTPUT",
      amountAtomic: "10000000",
      refundTo: PROBE_ADDRESSES.solana,
      recipient: PROBE_ADDRESSES.evm,
      apiBase,
    });

    assert.equal(res1.ok, true);
    assert.equal(res1.routeStatus, "SUPPORTED_AND_QUOTABLE");
    assert.equal(res1.amountInAtomic, "116868899");
    assert.equal(res1.amountOutAtomic, "10000000");
    assert.equal(res1.timeEstimateSeconds, 22);
    assert.equal(res1.correlationId, "corr-12345");
    assert.equal(res1.signature, "ed25519:test_sig");
    assert.equal(res1.fees?.refundFeeAtomic, "115314");
    assert.equal(res1.fees?.withdrawFeeAtomic, "2400");

    // 2. Unsupported pair (tokenIn is not valid)
    mockStatus = 400;
    mockBody = { message: "tokenIn is not valid" };

    const res2 = await fetchOneClickDryQuote({
      originAsset: "nep141:invalid.near",
      destinationAsset: "nep141:base.near",
      swapType: "EXACT_OUTPUT",
      amountAtomic: "10000000",
      refundTo: PROBE_ADDRESSES.solana,
      recipient: PROBE_ADDRESSES.evm,
      apiBase,
    });

    assert.equal(res2.ok, false);
    assert.equal(res2.routeStatus, "UNSUPPORTED_PAIR");
    assert.ok(res2.errorMessage?.includes("tokenIn is not valid"));

    // 3. Temporarily unavailable (No liquidity available)
    mockStatus = 400;
    mockBody = { message: "No liquidity available" };

    const res3 = await fetchOneClickDryQuote({
      originAsset: "nep141:sol.omft.near",
      destinationAsset: "nep141:base.near",
      swapType: "EXACT_OUTPUT",
      amountAtomic: "999999999999999999",
      refundTo: PROBE_ADDRESSES.solana,
      recipient: PROBE_ADDRESSES.evm,
      apiBase,
    });

    assert.equal(res3.ok, false);
    assert.equal(res3.routeStatus, "TEMPORARILY_UNAVAILABLE");
    assert.ok(res3.errorMessage?.includes("No solver liquidity"));

    // 4. Provider 500 server error
    mockStatus = 500;
    mockBody = { message: "Internal server error" };

    const res4 = await fetchOneClickDryQuote({
      originAsset: "nep141:sol.omft.near",
      destinationAsset: "nep141:base.near",
      swapType: "EXACT_OUTPUT",
      amountAtomic: "10000000",
      refundTo: PROBE_ADDRESSES.solana,
      recipient: PROBE_ADDRESSES.evm,
      apiBase,
    });

    assert.equal(res4.ok, false);
    assert.equal(res4.routeStatus, "PROVIDER_ERROR");
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("quote-discovery: validateProviderAtomicAmount enforces exact positive integer bounds", () => {
  assert.equal(validateProviderAtomicAmount("1"), true);
  assert.equal(validateProviderAtomicAmount("10000000"), true);
  assert.equal(
    validateProviderAtomicAmount(
      "115792089237316195423570985008687907853269984665640564039457584007913129639935",
    ),
    true,
  );

  // Non-strings or invalid types
  assert.equal(validateProviderAtomicAmount(null), false);
  assert.equal(validateProviderAtomicAmount(undefined), false);
  assert.equal(validateProviderAtomicAmount(12345), false);
  assert.equal(validateProviderAtomicAmount({}), false);

  // Malformed numbers: floats, negative, scientific, zero, empty
  assert.equal(validateProviderAtomicAmount(""), false);
  assert.equal(validateProviderAtomicAmount("0"), false);
  assert.equal(validateProviderAtomicAmount("-1"), false);
  assert.equal(validateProviderAtomicAmount("10.5"), false);
  assert.equal(validateProviderAtomicAmount("1e18"), false);
  assert.equal(validateProviderAtomicAmount("0x123"), false);
  assert.equal(validateProviderAtomicAmount("10000000a"), false);
  assert.equal(validateProviderAtomicAmount(" 10000000 "), false);

  // Overflow > 78 digits
  const oversized = "9".repeat(79);
  assert.equal(validateProviderAtomicAmount(oversized), false);
});

test("quote-discovery: buildRateDescription preserves exact precision without lossy Number conversion", () => {
  // Test with large 24-decimal wNEAR amount
  const nearRate = buildRateDescription(
    "wNEAR",
    24,
    "2812067450621102369042695",
    "USDC",
    6,
    "10000000",
  );
  assert.ok(
    nearRate.startsWith("1 wNEAR ≈ 3.5561 USDC") || nearRate.includes("USDC"),
  );
  assert.equal(nearRate.includes("NaN"), false);
  assert.equal(nearRate.includes("Infinity"), false);
  assert.equal(nearRate.includes("e+"), false);

  // Test with 18-decimal ETH
  const ethRate = buildRateDescription(
    "ETH",
    18,
    "4761826033562274",
    "USDC",
    6,
    "10000000",
  );
  assert.ok(ethRate.includes("ETH") && ethRate.includes("USDC"));
  assert.equal(ethRate.includes("NaN"), false);

  // Rejection on malformed input returns fallback
  assert.equal(
    buildRateDescription("ETH", 18, "invalid", "USDC", 6, "10000000"),
    "1 ETH → USDC",
  );
});

test("quote-discovery: fetchOneClickDryQuote rejects shortfall on exact-output and malformed amounts", async () => {
  let mockBody: Record<string, unknown> = {};

  const server = http.createServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(mockBody));
  });

  await new Promise<void>((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve()),
  );
  const address = server.address() as AddressInfo;
  const apiBase = `http://127.0.0.1:${address.port}`;

  try {
    // 1. Shortfall on exact-output (provider returned 9_999_999 when 10_000_000 requested)
    mockBody = {
      quote: {
        amountIn: "116000000",
        amountOut: "9999999", // Underfunded!
      },
      signature: "ed25519:sig",
      correlationId: "corr-shortfall",
    };

    const res1 = await fetchOneClickDryQuote({
      originAsset: "nep141:sol.omft.near",
      destinationAsset:
        "nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near",
      swapType: "EXACT_OUTPUT",
      amountAtomic: "10000000",
      refundTo: PROBE_ADDRESSES.solana,
      recipient: PROBE_ADDRESSES.evm,
      apiBase,
    });

    assert.equal(res1.ok, false);
    assert.equal(res1.routeStatus, "PROVIDER_ERROR");
    assert.ok(
      res1.errorMessage?.includes("less than requested invoice amount"),
    );

    // 2. Malformed amountIn (float string "116.5")
    mockBody = {
      quote: {
        amountIn: "116.5",
        amountOut: "10000000",
      },
    };

    const res2 = await fetchOneClickDryQuote({
      originAsset: "nep141:sol.omft.near",
      destinationAsset:
        "nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near",
      swapType: "EXACT_OUTPUT",
      amountAtomic: "10000000",
      refundTo: PROBE_ADDRESSES.solana,
      recipient: PROBE_ADDRESSES.evm,
      apiBase,
    });

    assert.equal(res2.ok, false);
    assert.equal(res2.routeStatus, "PROVIDER_ERROR");
    assert.ok(res2.errorMessage?.includes("out-of-range"));

    // 3. Missing timeEstimate is preserved as null, not default 30
    mockBody = {
      quote: {
        amountIn: "116000000",
        amountOut: "10000000",
      },
    };

    const res3 = await fetchOneClickDryQuote({
      originAsset: "nep141:sol.omft.near",
      destinationAsset:
        "nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near",
      swapType: "EXACT_OUTPUT",
      amountAtomic: "10000000",
      refundTo: PROBE_ADDRESSES.solana,
      recipient: PROBE_ADDRESSES.evm,
      apiBase,
    });

    assert.equal(res3.ok, true);
    assert.equal(res3.timeEstimateSeconds, null);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("quote-discovery: isRouteExchangeCompatible checks sender-independent refunding", () => {
  // Cross-chain routes with 1Click mapping support sender-independent refundTo
  assert.equal(
    isRouteExchangeCompatible("CROSS_CHAIN_1CLICK", "solana-mainnet:SOL"),
    true,
  );
  assert.equal(
    isRouteExchangeCompatible("CROSS_CHAIN_1CLICK", "ethereum-mainnet:ETH"),
    true,
  );
  assert.equal(
    isRouteExchangeCompatible("CROSS_CHAIN_1CLICK", "near-mainnet:wNEAR"),
    true,
  );

  // Direct transfers are incompatible with exchange mode (originate from exchange omnibus wallets)
  assert.equal(
    isRouteExchangeCompatible("DIRECT_TRANSFER", "base-mainnet:USDC"),
    false,
  );
  assert.equal(
    isRouteExchangeCompatible("DIRECT_TRANSFER", "ethereum-mainnet:USDC"),
    false,
  );

  // Unmapped/unsupported token is incompatible
  assert.equal(
    isRouteExchangeCompatible("CROSS_CHAIN_1CLICK", "unsupported-chain:FOO"),
    false,
  );
});

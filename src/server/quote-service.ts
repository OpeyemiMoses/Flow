import {
  type IndicativeQuote,
  type PayerCheckoutMode,
  type QuoteSwapType,
  buildRateDescription,
  generatePaymentAttemptPublicId,
  isRouteExchangeCompatible,
  PROBE_ADDRESSES,
  resolveOneClickAssetId,
  validateRefundAddressForMode,
} from "../domain/quote-discovery.ts";
import {
  formatAtomicToDisplay,
  parseDisplayToAtomic,
} from "../domain/atomic-amounts.ts";
import { isValidPublicPaymentId } from "../domain/payment-requests.ts";
import { isFinancialExecutionDisabled } from "../domain/custody.ts";
import { CURATED_SUPPORTED_DEPLOYMENTS } from "../domain/supported-assets-catalog.ts";
import { clientBudget } from "./auth/limits.ts";
import { ApiFailure, reply } from "./http.ts";
import { runtime, type FlowDb } from "../foundation/prisma.ts";
import { fetchOneClickDryQuote } from "./providers/one-click-adapter.ts";

export interface RequestQuoteInput {
  readonly sourceDeploymentId: string;
  readonly payerMode: PayerCheckoutMode;
  readonly refundAddress?: string | null;
  readonly payerAmount?: string | null;
  readonly customSourceDisplayAmount?: string | null;
}

export async function requestPaymentQuote(
  request: Request,
  publicId: string,
): Promise<Response> {
  // 1. Validate Payment Request Public ID format
  if (!isValidPublicPaymentId(publicId)) {
    throw new ApiFailure(404, "PAYMENT_REQUEST_NOT_FOUND");
  }

  // 2. Parse request body
  let body: RequestQuoteInput;
  try {
    body = (await request.json()) as RequestQuoteInput;
  } catch {
    throw new ApiFailure(400, "INVALID_JSON");
  }

  const rawBody = body as RequestQuoteInput & {
    readonly sourceAssetId?: string;
    readonly checkoutMode?: PayerCheckoutMode;
  };

  const sourceDeploymentId =
    rawBody.sourceDeploymentId || rawBody.sourceAssetId;
  const payerMode = rawBody.payerMode || rawBody.checkoutMode;
  const refundAddress = rawBody.refundAddress;
  const payerAmount = rawBody.payerAmount;
  const customSourceDisplayAmount = rawBody.customSourceDisplayAmount;

  if (!sourceDeploymentId || typeof sourceDeploymentId !== "string") {
    throw new ApiFailure(400, "SOURCE_DEPLOYMENT_ID_REQUIRED");
  }

  if (payerMode !== "WALLET" && payerMode !== "EXCHANGE") {
    throw new ApiFailure(400, "INVALID_PAYER_MODE");
  }

  // 3. Resolve source token deployment
  const sourceDeployment = CURATED_SUPPORTED_DEPLOYMENTS.find(
    (d) => d.id === sourceDeploymentId,
  );
  if (!sourceDeployment) {
    throw new ApiFailure(400, "UNSUPPORTED_SOURCE_DEPLOYMENT");
  }

  // 4. Validate refund address for the chosen mode and source ecosystem
  const refundCheck = validateRefundAddressForMode(
    payerMode,
    sourceDeployment.ecosystem,
    refundAddress,
  );
  if (!refundCheck.valid) {
    throw new ApiFailure(400, refundCheck.error ?? "INVALID_REFUND_ADDRESS");
  }

  // 5. Durable rate limiting via flow.auth_throttles
  const allowed = await clientBudget(request, "public:payment-quote");
  if (!allowed) {
    throw new ApiFailure(429, "RATE_LIMIT_EXCEEDED");
  }

  const { db } = runtime();

  // Query payment request from database
  const requestRows = await db.$queryRaw<
    Array<{
      id: string;
      public_id: string;
      title: string;
      destination_network: string;
      destination_asset_id: string;
      destination_asset_symbol: string;
      destination_decimals: number;
      amount_mode: "FIXED" | "OPTIONAL";
      requested_atomic_amount: string | null;
      status: "ACTIVE" | "DISABLED" | "EXPIRED" | "COMPLETED";
      expires_at: string | null;
    }>
  >`
    SELECT *
    FROM flow.get_public_payment_request(${publicId})
  `;

  if (requestRows.length === 0) {
    throw new ApiFailure(404, "PAYMENT_REQUEST_NOT_FOUND");
  }

  const pr = requestRows[0]!;

  if (pr.status === "DISABLED") {
    throw new ApiFailure(404, "PAYMENT_REQUEST_UNAVAILABLE");
  }

  if (pr.status === "EXPIRED") {
    throw new ApiFailure(400, "PAYMENT_REQUEST_EXPIRED");
  }

  // Check if expires_at is in the past
  if (pr.expires_at && new Date(pr.expires_at) <= new Date()) {
    throw new ApiFailure(400, "PAYMENT_REQUEST_EXPIRED");
  }

  // 6. Resolve destination token deployment with strict exact catalog match (Requirement 4)
  const destDeployment = CURATED_SUPPORTED_DEPLOYMENTS.find(
    (d) =>
      d.networkKey === pr.destination_network &&
      d.id === pr.destination_asset_id,
  );

  if (!destDeployment) {
    throw new ApiFailure(400, "UNSUPPORTED_DESTINATION_DEPLOYMENT");
  }

  // Reject mismatched contract, network, standard or decimals (Requirement 4)
  if (
    destDeployment.decimals !== pr.destination_decimals ||
    destDeployment.networkKey !== pr.destination_network ||
    destDeployment.symbol !== pr.destination_asset_symbol
  ) {
    throw new ApiFailure(400, "DESTINATION_DEPLOYMENT_MISMATCH");
  }

  // 7. Check if optional amount request has an explicit positive payer amount (Requirement 5)
  let requestedPayerDisplayAmount: string | null = null;
  if (pr.amount_mode === "OPTIONAL") {
    const rawPayerAmount = customSourceDisplayAmount ?? payerAmount;
    if (
      !rawPayerAmount ||
      typeof rawPayerAmount !== "string" ||
      rawPayerAmount.trim().length === 0
    ) {
      throw new ApiFailure(400, "PAYER_AMOUNT_REQUIRED");
    }
    const trimmed = rawPayerAmount.trim();
    try {
      const parsedAtomic = parseDisplayToAtomic(
        trimmed,
        sourceDeployment.decimals,
      );
      if (parsedAtomic <= 0n) {
        throw new ApiFailure(400, "INVALID_PAYER_AMOUNT");
      }
      requestedPayerDisplayAmount = trimmed;
    } catch {
      throw new ApiFailure(400, "INVALID_PAYER_AMOUNT");
    }
  }

  const isDirectTransfer =
    sourceDeployment.networkKey === destDeployment.networkKey &&
    sourceDeployment.contractIdentifier.toLowerCase() ===
      destDeployment.contractIdentifier.toLowerCase();

  const routeType = isDirectTransfer ? "DIRECT_TRANSFER" : "CROSS_CHAIN_1CLICK";

  // 8. Validate route exchange compatibility (Requirement 13)
  const isExchangeCompat = isRouteExchangeCompatible(
    routeType,
    sourceDeployment.id,
  );
  if (isDirectTransfer && payerMode === "EXCHANGE") {
    throw new ApiFailure(400, "EXCHANGE_MODE_NOT_SUPPORTED_FOR_ROUTE");
  }

  const attemptPublicId = generatePaymentAttemptPublicId();
  const now = new Date();
  const localPreviewExpiresAt = new Date(now.getTime() + 60_000); // 60s local client preview window

  // 9. Process Direct Transfer vs Cross-Chain 1Click Route
  if (isDirectTransfer) {
    // Direct Transfer: 1:1 rate, but on-chain execution is disabled
    let sourceAtomic: string;
    let destAtomic: string;

    if (pr.amount_mode === "FIXED" && pr.requested_atomic_amount) {
      sourceAtomic = pr.requested_atomic_amount;
      destAtomic = pr.requested_atomic_amount;
    } else {
      const parsed = parseDisplayToAtomic(
        requestedPayerDisplayAmount!,
        sourceDeployment.decimals,
      );
      sourceAtomic = parsed.toString();
      destAtomic = parsed.toString();
    }

    const sourceDisplay = formatAtomicToDisplay(
      BigInt(sourceAtomic),
      sourceDeployment.decimals,
    );
    const destDisplay = formatAtomicToDisplay(
      BigInt(destAtomic),
      destDeployment.decimals,
    );

    // Record attempt in PostgreSQL via flow.record_public_payment_attempt (untrusted tier)
    await recordPaymentAttemptRow(db, {
      paymentRequestPublicId: pr.public_id,
      attemptPublicId,
      payerMode,
      payerRefundAddress: refundAddress ?? null,
      sourceNetwork: sourceDeployment.networkKey,
      sourceAssetId: sourceDeployment.id,
      sourceAssetSymbol: sourceDeployment.symbol,
      sourceDecimals: sourceDeployment.decimals,
      routeType: "DIRECT_TRANSFER",
      routeStatus: "NOT_YET_ENABLED_FOR_PAYMENT",
      swapType: pr.amount_mode === "FIXED" ? "EXACT_OUTPUT" : "EXACT_INPUT",
      quotedSourceAtomic: sourceAtomic,
      quotedDestinationAtomic: destAtomic,
      estimatedDurationSeconds: null,
      providerFees: {
        isEstimate: true,
        description: "Zero route fees for direct transfer.",
      },
      providerCorrelationId: null,
      providerSignature: null,
      quoteExpiresAt: localPreviewExpiresAt,
    });

    const quote: IndicativeQuote = {
      attemptPublicId,
      paymentRequestPublicId: pr.public_id,
      routeStatus: "NOT_YET_ENABLED_FOR_PAYMENT",
      routeType: "DIRECT_TRANSFER",
      sourceNetwork: sourceDeployment.networkKey,
      sourceAssetId: sourceDeployment.id,
      sourceAssetSymbol: sourceDeployment.symbol,
      sourceDecimals: sourceDeployment.decimals,
      destinationNetwork: destDeployment.networkKey,
      destinationAssetId: destDeployment.id,
      destinationAssetSymbol: destDeployment.symbol,
      destinationDecimals: destDeployment.decimals,
      payerMode,
      refundAddress: refundAddress ?? null,
      swapType: pr.amount_mode === "FIXED" ? "EXACT_OUTPUT" : "EXACT_INPUT",
      sourceAtomicAmount: sourceAtomic,
      sourceDisplayAmount: sourceDisplay,
      destinationAtomicAmount: destAtomic,
      destinationDisplayAmount: destDisplay,
      estimatedDurationSeconds: null,
      exchangeRateDescription: `1 ${sourceDeployment.symbol} = 1 ${destDeployment.symbol}`,
      fees: {
        isEstimate: true,
        description:
          "Direct on-chain transfer. Standard network gas fee applies at broadcast.",
      },
      quoteCreatedAt: now.toISOString(),
      localPreviewExpiresAt: localPreviewExpiresAt.toISOString(),
      providerQuoteExpiresAt: null,
      correlationId: null,
      verificationTier: "UNVERIFIED_OBSERVATION",
      isProviderVerified: false,
      isExchangeCompatible: isExchangeCompat,
      isIndicativeOnly: true,
      isExecutionDisabled: isFinancialExecutionDisabled(),
      executionBlockedNotice:
        "Direct transfer preview only. Live payment execution is disabled (FLOW_EXECUTION=disabled).",
      statusMessage:
        "Direct transfers on the same network are supported in architecture but disabled for live execution.",
    };

    return reply(200, quote);
  }

  // 10. Cross-Chain / Cross-Asset Route via 1Click Provider
  const sourceOneClickId = resolveOneClickAssetId(sourceDeployment.id);
  const destOneClickId = resolveOneClickAssetId(destDeployment.id);

  if (!sourceOneClickId || !destOneClickId) {
    // Pair not supported by 1Click
    const quote: IndicativeQuote = {
      attemptPublicId,
      paymentRequestPublicId: pr.public_id,
      routeStatus: "UNSUPPORTED_PAIR",
      routeType: "CROSS_CHAIN_1CLICK",
      sourceNetwork: sourceDeployment.networkKey,
      sourceAssetId: sourceDeployment.id,
      sourceAssetSymbol: sourceDeployment.symbol,
      sourceDecimals: sourceDeployment.decimals,
      destinationNetwork: destDeployment.networkKey,
      destinationAssetId: destDeployment.id,
      destinationAssetSymbol: destDeployment.symbol,
      destinationDecimals: destDeployment.decimals,
      payerMode,
      refundAddress: refundAddress ?? null,
      swapType: pr.amount_mode === "FIXED" ? "EXACT_OUTPUT" : "EXACT_INPUT",
      sourceAtomicAmount: "0",
      sourceDisplayAmount: "0",
      destinationAtomicAmount: pr.requested_atomic_amount ?? "0",
      destinationDisplayAmount: pr.requested_atomic_amount
        ? formatAtomicToDisplay(
            BigInt(pr.requested_atomic_amount),
            destDeployment.decimals,
          )
        : "0",
      estimatedDurationSeconds: null,
      exchangeRateDescription: "No route available",
      fees: {
        isEstimate: false,
        description: "Unsupported cross-chain pair.",
      },
      quoteCreatedAt: now.toISOString(),
      localPreviewExpiresAt: localPreviewExpiresAt.toISOString(),
      providerQuoteExpiresAt: null,
      correlationId: null,
      verificationTier: "UNVERIFIED_OBSERVATION",
      isProviderVerified: false,
      isExchangeCompatible: isExchangeCompat,
      isIndicativeOnly: true,
      isExecutionDisabled: isFinancialExecutionDisabled(),
      executionBlockedNotice:
        "Route is unsupported by solver network. Live payment execution is disabled (FLOW_EXECUTION=disabled).",
      statusMessage:
        "This token pair is currently unsupported for automated cross-chain settlement.",
    };

    return reply(200, quote);
  }

  // 11. Fetch Real Read-Only Dry Quote from 1Click
  const swapType: QuoteSwapType =
    pr.amount_mode === "FIXED" ? "EXACT_OUTPUT" : "EXACT_INPUT";

  let amountAtomic: string;
  if (swapType === "EXACT_OUTPUT") {
    amountAtomic = pr.requested_atomic_amount!;
  } else {
    const parsed = parseDisplayToAtomic(
      requestedPayerDisplayAmount!,
      sourceDeployment.decimals,
    );
    amountAtomic = parsed.toString();
  }

  // Safe fallback probe addresses for dry quote query (Requirement 12)
  const effectiveRefundTo =
    refundAddress && refundAddress.trim().length > 0
      ? refundAddress.trim()
      : PROBE_ADDRESSES[sourceDeployment.ecosystem];

  // Safe probe address for dry quote query (Requirement 12: probe is indicative only)
  const probeRecipient = PROBE_ADDRESSES[destDeployment.ecosystem];

  const dryResult = await fetchOneClickDryQuote({
    originAsset: sourceOneClickId,
    destinationAsset: destOneClickId,
    swapType,
    amountAtomic,
    refundTo: effectiveRefundTo,
    recipient: probeRecipient,
  });

  if (!dryResult.ok) {
    const quote: IndicativeQuote = {
      attemptPublicId,
      paymentRequestPublicId: pr.public_id,
      routeStatus: dryResult.routeStatus,
      routeType: "CROSS_CHAIN_1CLICK",
      sourceNetwork: sourceDeployment.networkKey,
      sourceAssetId: sourceDeployment.id,
      sourceAssetSymbol: sourceDeployment.symbol,
      sourceDecimals: sourceDeployment.decimals,
      destinationNetwork: destDeployment.networkKey,
      destinationAssetId: destDeployment.id,
      destinationAssetSymbol: destDeployment.symbol,
      destinationDecimals: destDeployment.decimals,
      payerMode,
      refundAddress: refundAddress ?? null,
      swapType,
      sourceAtomicAmount: "0",
      sourceDisplayAmount: "0",
      destinationAtomicAmount: pr.requested_atomic_amount ?? "0",
      destinationDisplayAmount: pr.requested_atomic_amount
        ? formatAtomicToDisplay(
            BigInt(pr.requested_atomic_amount),
            destDeployment.decimals,
          )
        : "0",
      estimatedDurationSeconds: null,
      exchangeRateDescription: "Unavailable",
      fees: {
        isEstimate: true,
        description: dryResult.errorMessage ?? "Provider error",
      },
      quoteCreatedAt: now.toISOString(),
      localPreviewExpiresAt: localPreviewExpiresAt.toISOString(),
      providerQuoteExpiresAt: null,
      correlationId: null,
      verificationTier: "UNVERIFIED_OBSERVATION",
      isProviderVerified: false,
      isExchangeCompatible: isExchangeCompat,
      isIndicativeOnly: true,
      isExecutionDisabled: isFinancialExecutionDisabled(),
      executionBlockedNotice:
        "Quote discovery failed or route liquidity is temporarily unavailable. Live payment execution is disabled (FLOW_EXECUTION=disabled).",
      statusMessage: dryResult.errorMessage,
    };

    return reply(200, quote);
  }

  // 12. Compute display amounts and format
  const sourceAtomicAmount = dryResult.amountInAtomic!;
  const destAtomicAmount = dryResult.amountOutAtomic!;

  const sourceDisplayAmount = formatAtomicToDisplay(
    BigInt(sourceAtomicAmount),
    sourceDeployment.decimals,
  );
  const destDisplayAmount = formatAtomicToDisplay(
    BigInt(destAtomicAmount),
    destDeployment.decimals,
  );

  const exchangeRateDescription = buildRateDescription(
    sourceDeployment.symbol,
    sourceDeployment.decimals,
    sourceAtomicAmount,
    destDeployment.symbol,
    destDeployment.decimals,
    destAtomicAmount,
  );

  // 13. Record Attempt in PostgreSQL (Untrusted Observation Tier)
  await recordPaymentAttemptRow(db, {
    paymentRequestPublicId: pr.public_id,
    attemptPublicId,
    payerMode,
    payerRefundAddress: refundAddress ?? null,
    sourceNetwork: sourceDeployment.networkKey,
    sourceAssetId: sourceDeployment.id,
    sourceAssetSymbol: sourceDeployment.symbol,
    sourceDecimals: sourceDeployment.decimals,
    routeType: "CROSS_CHAIN_1CLICK",
    routeStatus: "SUPPORTED_AND_QUOTABLE",
    swapType,
    quotedSourceAtomic: sourceAtomicAmount,
    quotedDestinationAtomic: destAtomicAmount,
    estimatedDurationSeconds: dryResult.timeEstimateSeconds ?? null,
    providerFees: dryResult.fees ?? {},
    providerCorrelationId: dryResult.correlationId ?? null,
    providerSignature: dryResult.signature ?? null,
    quoteExpiresAt: localPreviewExpiresAt,
  });

  const quote: IndicativeQuote = {
    attemptPublicId,
    paymentRequestPublicId: pr.public_id,
    routeStatus: "SUPPORTED_AND_QUOTABLE",
    routeType: "CROSS_CHAIN_1CLICK",
    sourceNetwork: sourceDeployment.networkKey,
    sourceAssetId: sourceDeployment.id,
    sourceAssetSymbol: sourceDeployment.symbol,
    sourceDecimals: sourceDeployment.decimals,
    destinationNetwork: destDeployment.networkKey,
    destinationAssetId: destDeployment.id,
    destinationAssetSymbol: destDeployment.symbol,
    destinationDecimals: destDeployment.decimals,
    payerMode,
    refundAddress: refundAddress ?? null,
    swapType,
    sourceAtomicAmount,
    sourceDisplayAmount,
    destinationAtomicAmount: destAtomicAmount,
    destinationDisplayAmount: destDisplayAmount,
    estimatedDurationSeconds: dryResult.timeEstimateSeconds ?? null,
    exchangeRateDescription,
    fees: dryResult.fees ?? {
      isEstimate: true,
      description: "Solver and cross-chain settlement fees included.",
    },
    quoteCreatedAt: now.toISOString(),
    localPreviewExpiresAt: localPreviewExpiresAt.toISOString(),
    providerQuoteExpiresAt: dryResult.providerDeadline ?? null,
    correlationId: dryResult.correlationId ?? null,
    verificationTier: "UNVERIFIED_OBSERVATION",
    isProviderVerified: false,
    isExchangeCompatible: isExchangeCompat,
    isIndicativeOnly: true,
    isExecutionDisabled: isFinancialExecutionDisabled(),
    executionBlockedNotice:
      "Indicative quote only. Live deposit address issuance and payment execution are disabled (FLOW_EXECUTION=disabled).",
  };

  return reply(200, quote);
}

async function recordPaymentAttemptRow(
  db: FlowDb,
  input: {
    paymentRequestPublicId: string;
    attemptPublicId: string;
    payerMode: string;
    payerRefundAddress: string | null;
    sourceNetwork: string;
    sourceAssetId: string;
    sourceAssetSymbol: string;
    sourceDecimals: number;
    routeType: string;
    routeStatus: string;
    swapType: string;
    quotedSourceAtomic: string;
    quotedDestinationAtomic: string;
    estimatedDurationSeconds: number | null;
    providerFees: unknown;
    providerCorrelationId: string | null;
    providerSignature: string | null;
    quoteExpiresAt: Date;
  },
): Promise<void> {
  await db.$queryRaw`
    SELECT * FROM flow.record_public_payment_attempt(
      ${input.paymentRequestPublicId},
      ${input.attemptPublicId},
      ${input.payerMode},
      ${input.payerRefundAddress},
      ${input.sourceNetwork},
      ${input.sourceAssetId},
      ${input.sourceAssetSymbol},
      ${input.sourceDecimals},
      ${input.routeType},
      ${input.routeStatus},
      ${input.swapType},
      ${input.quotedSourceAtomic}::decimal,
      ${input.quotedDestinationAtomic}::decimal,
      ${input.estimatedDurationSeconds}::integer,
      ${JSON.stringify(input.providerFees)}::jsonb,
      ${input.providerCorrelationId},
      ${input.providerSignature},
      ${input.quoteExpiresAt}
    )
  `;
}

export const discoverPaymentQuote = requestPaymentQuote;

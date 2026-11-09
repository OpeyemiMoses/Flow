import "server-only";
import {
  parseDisplayToAtomic,
  formatAtomicToDisplay,
} from "../domain/atomic-amounts.ts";
import {
  type IndicativeQuote,
  type PayerCheckoutMode,
  type QuoteSwapType,
  PROBE_ADDRESSES,
  buildRateDescription,
  generatePaymentAttemptPublicId,
  resolveOneClickAssetId,
  validateRefundAddressForMode,
} from "../domain/quote-discovery.ts";
import { CURATED_SUPPORTED_DEPLOYMENTS } from "../domain/supported-assets-catalog.ts";
import { runtime, type FlowDb } from "../foundation/prisma.ts";
import { clientBudget } from "./auth/limits.ts";
import { ApiFailure, reply } from "./http.ts";
import { fetchOneClickDryQuote } from "./providers/one-click-adapter.ts";

export interface DiscoverQuoteInput {
  sourceDeploymentId: string;
  payerMode: PayerCheckoutMode;
  refundAddress?: string | null;
  customSourceDisplayAmount?: string | null;
}

export async function discoverPaymentQuote(
  request: Request,
  publicId: string,
): Promise<Response> {
  // 1. Rate limiting via durable PostgreSQL auth_throttles
  const allowed = await clientBudget(request, "public:payment-quote");
  if (!allowed) {
    throw new ApiFailure(429, "RATE_LIMIT_EXCEEDED");
  }

  // 2. Parse body
  let body: DiscoverQuoteInput;
  try {
    body = (await request.json()) as DiscoverQuoteInput;
  } catch {
    throw new ApiFailure(400, "INVALID_JSON");
  }

  const {
    sourceDeploymentId,
    payerMode,
    refundAddress,
    customSourceDisplayAmount,
  } = body;

  if (!sourceDeploymentId) {
    throw new ApiFailure(400, "MISSING_SOURCE_DEPLOYMENT");
  }

  if (payerMode !== "WALLET" && payerMode !== "EXCHANGE") {
    throw new ApiFailure(400, "INVALID_PAYER_MODE");
  }

  // 3. Resolve source token deployment
  const sourceDeployment = CURATED_SUPPORTED_DEPLOYMENTS.find(
    (d) => d.id === sourceDeploymentId,
  );
  if (!sourceDeployment) {
    throw new ApiFailure(400, "UNKNOWN_SOURCE_DEPLOYMENT");
  }

  // 4. Validate refund address for payer mode
  const refundCheck = validateRefundAddressForMode(
    payerMode,
    sourceDeployment.ecosystem,
    refundAddress,
  );
  if (!refundCheck.valid) {
    throw new ApiFailure(400, "INVALID_REFUND_ADDRESS");
  }

  // 5. Look up public payment request from DB
  const { db } = runtime();
  const requestRows = await db.$queryRaw<
    Array<{
      public_id: string;
      title: string;
      description: string | null;
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

  // 6. Resolve destination token deployment
  const destDeployment = CURATED_SUPPORTED_DEPLOYMENTS.find(
    (d) =>
      d.networkKey === pr.destination_network &&
      (d.id === pr.destination_asset_id ||
        d.symbol === pr.destination_asset_symbol),
  ) ?? {
    id: `${pr.destination_network}:${pr.destination_asset_symbol}`,
    assetKey: pr.destination_asset_symbol.toLowerCase(),
    symbol: pr.destination_asset_symbol,
    name: pr.destination_asset_symbol,
    kind: "STABLECOIN" as const,
    ecosystem: sourceDeployment.ecosystem,
    ecosystemLabel: pr.destination_network,
    networkKey: pr.destination_network,
    networkName: pr.destination_network,
    environment: "mainnet" as const,
    standard: "ERC20" as const,
    contractIdentifier: pr.destination_asset_id,
    decimals: pr.destination_decimals,
    isDbSeeded: false,
  };

  const isDirectTransfer =
    sourceDeployment.networkKey === destDeployment.networkKey &&
    sourceDeployment.contractIdentifier.toLowerCase() ===
      destDeployment.contractIdentifier.toLowerCase();

  const attemptPublicId = generatePaymentAttemptPublicId();
  const now = new Date();
  const quoteExpiresAt = new Date(now.getTime() + 60_000); // 60s quote TTL

  // 7. Process Direct Transfer vs Cross-Chain 1Click Route
  if (isDirectTransfer) {
    // Direct Transfer: 1:1 rate, but on-chain execution is disabled
    let sourceAtomic: string;
    let destAtomic: string;

    if (pr.amount_mode === "FIXED" && pr.requested_atomic_amount) {
      sourceAtomic = pr.requested_atomic_amount;
      destAtomic = pr.requested_atomic_amount;
    } else {
      const parsed = customSourceDisplayAmount
        ? parseDisplayToAtomic(
            customSourceDisplayAmount,
            sourceDeployment.decimals,
          )
        : 10n * BigInt(10 ** sourceDeployment.decimals);
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

    // Record attempt in PostgreSQL
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
      estimatedDurationSeconds: 15,
      providerFees: { description: "Zero route fees for direct transfer." },
      providerCorrelationId: null,
      providerSignature: null,
      quoteExpiresAt,
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
      estimatedDurationSeconds: 15,
      exchangeRateDescription: `1 ${sourceDeployment.symbol} = 1 ${destDeployment.symbol}`,
      fees: {
        description:
          "Direct on-chain transfer. Standard network gas fee applies at broadcast.",
      },
      quoteCreatedAt: now.toISOString(),
      quoteExpiresAt: quoteExpiresAt.toISOString(),
      correlationId: null,
      isIndicativeOnly: true,
      executionBlockedNotice:
        "Direct transfer preview only. Live payment execution is disabled (FLOW_EXECUTION=disabled).",
      statusMessage:
        "Direct transfers on the same network are supported in architecture but disabled for live execution.",
    };

    return reply(200, quote);
  }

  // 8. Cross-Chain / Cross-Asset Route via 1Click Provider
  const sourceOneClickId = resolveOneClickAssetId(sourceDeployment.id);
  const destOneClickId = resolveOneClickAssetId(destDeployment.id);

  if (!sourceOneClickId || !destOneClickId) {
    // Pair not supported by 1Click (e.g. testnet tokens or unmapped assets)
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
      estimatedDurationSeconds: 0,
      exchangeRateDescription: "No route available",
      fees: { description: "Unsupported cross-chain pair." },
      quoteCreatedAt: now.toISOString(),
      quoteExpiresAt: quoteExpiresAt.toISOString(),
      correlationId: null,
      isIndicativeOnly: true,
      executionBlockedNotice:
        "Route is unsupported by solver network. Live payment execution is disabled (FLOW_EXECUTION=disabled).",
      statusMessage:
        "This token pair is currently unsupported for automated cross-chain settlement.",
    };

    return reply(200, quote);
  }

  // 9. Fetch Real Read-Only Dry Quote from 1Click
  const swapType: QuoteSwapType =
    pr.amount_mode === "FIXED" ? "EXACT_OUTPUT" : "EXACT_INPUT";

  let amountAtomic: string;
  if (swapType === "EXACT_OUTPUT") {
    amountAtomic = pr.requested_atomic_amount!;
  } else {
    const parsed = customSourceDisplayAmount
      ? parseDisplayToAtomic(
          customSourceDisplayAmount,
          sourceDeployment.decimals,
        )
      : 10n * BigInt(10 ** sourceDeployment.decimals);
    amountAtomic = parsed.toString();
  }

  // Safe fallback probe addresses for dry quote query
  const effectiveRefundTo =
    refundAddress && refundAddress.trim().length > 0
      ? refundAddress.trim()
      : PROBE_ADDRESSES[sourceDeployment.ecosystem];

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
      estimatedDurationSeconds: 0,
      exchangeRateDescription: "Unavailable",
      fees: { description: dryResult.errorMessage ?? "Provider error" },
      quoteCreatedAt: now.toISOString(),
      quoteExpiresAt: quoteExpiresAt.toISOString(),
      correlationId: null,
      isIndicativeOnly: true,
      executionBlockedNotice:
        "Quote discovery failed or route liquidity is temporarily unavailable. Live payment execution is disabled (FLOW_EXECUTION=disabled).",
      statusMessage: dryResult.errorMessage,
    };

    return reply(200, quote);
  }

  // 10. Compute display amounts and format
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

  // 11. Record Attempt in PostgreSQL
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
    estimatedDurationSeconds: dryResult.timeEstimateSeconds ?? 30,
    providerFees: dryResult.fees ?? {},
    providerCorrelationId: dryResult.correlationId ?? null,
    providerSignature: dryResult.signature ?? null,
    quoteExpiresAt,
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
    estimatedDurationSeconds: dryResult.timeEstimateSeconds ?? 30,
    exchangeRateDescription,
    fees: dryResult.fees ?? {
      description: "Solver and cross-chain settlement fees included.",
    },
    quoteCreatedAt: now.toISOString(),
    quoteExpiresAt: quoteExpiresAt.toISOString(),
    correlationId: dryResult.correlationId ?? null,
    isIndicativeOnly: true,
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
    estimatedDurationSeconds: number;
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
      ${input.estimatedDurationSeconds},
      ${JSON.stringify(input.providerFees)}::jsonb,
      ${input.providerCorrelationId},
      ${input.providerSignature},
      ${input.quoteExpiresAt}
    )
  `;
}

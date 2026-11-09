import {
  type IndicativeQuoteFeeBreakdown,
  type QuoteSwapType,
  type RouteAvailabilityStatus,
  validateProviderAtomicAmount,
} from "../../domain/quote-discovery.ts";

export interface OneClickQuoteRequest {
  dry: true;
  swapType: QuoteSwapType;
  slippageTolerance: number;
  originAsset: string;
  depositType: "ORIGIN_CHAIN";
  destinationAsset: string;
  amount: string;
  refundTo: string;
  refundType: "ORIGIN_CHAIN";
  recipient: string;
  recipientType: "DESTINATION_CHAIN";
  deadline: string;
}

export interface OneClickRawResponse {
  quote?: {
    amountIn: string;
    amountInFormatted?: string;
    amountInUsd?: string;
    minAmountIn?: string;
    amountOut: string;
    amountOutFormatted?: string;
    amountOutUsd?: string;
    minAmountOut?: string;
    timeEstimate?: number;
    refundFee?: string;
    withdrawFee?: string;
  };
  quoteRequest?: OneClickQuoteRequest;
  signature?: string;
  timestamp?: string;
  correlationId?: string;
  message?: string;
  error?: string;
  statusCode?: number;
}

export interface OneClickDryQuoteResult {
  ok: boolean;
  routeStatus: RouteAvailabilityStatus;
  amountInAtomic?: string;
  amountOutAtomic?: string;
  minAmountOutAtomic?: string;
  timeEstimateSeconds?: number | null;
  fees?: IndicativeQuoteFeeBreakdown;
  correlationId?: string;
  signature?: string;
  quoteTimestamp?: string | null;
  providerDeadline?: string | null;
  errorMessage?: string;
}

const DEFAULT_ONE_CLICK_API_BASE = "https://1click.chaindefuser.com";
const TIMEOUT_MS = 8000;

export async function fetchOneClickDryQuote(params: {
  originAsset: string;
  destinationAsset: string;
  swapType: QuoteSwapType;
  amountAtomic: string;
  refundTo: string;
  recipient: string;
  deadlineSeconds?: number;
  apiBase?: string;
}): Promise<OneClickDryQuoteResult> {
  const apiBase = params.apiBase ?? DEFAULT_ONE_CLICK_API_BASE;
  const deadlineDate = new Date(
    Date.now() + (params.deadlineSeconds ?? 600) * 1000,
  );

  const payload: OneClickQuoteRequest = {
    dry: true,
    swapType: params.swapType,
    slippageTolerance: 100, // 1%
    originAsset: params.originAsset,
    depositType: "ORIGIN_CHAIN",
    destinationAsset: params.destinationAsset,
    amount: params.amountAtomic,
    refundTo: params.refundTo,
    refundType: "ORIGIN_CHAIN",
    recipient: params.recipient,
    recipientType: "DESTINATION_CHAIN",
    deadline: deadlineDate.toISOString(),
  };

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), TIMEOUT_MS);

    const response = await fetch(`${apiBase}/v0/quote`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    const data = (await response.json()) as OneClickRawResponse;

    if (!response.ok) {
      const msg = data.message ?? data.error ?? `HTTP ${response.status}`;
      const msgLower = msg.toLowerCase();
      if (
        msgLower.includes("tokenin is not valid") ||
        msgLower.includes("tokenout is not valid") ||
        msgLower.includes("unsupported")
      ) {
        return {
          ok: false,
          routeStatus: "UNSUPPORTED_PAIR",
          errorMessage: msg,
        };
      }
      if (
        msgLower.includes("no liquidity") ||
        msgLower.includes("insufficient liquidity")
      ) {
        return {
          ok: false,
          routeStatus: "TEMPORARILY_UNAVAILABLE",
          errorMessage:
            "No solver liquidity currently available for this route.",
        };
      }
      return {
        ok: false,
        routeStatus: "PROVIDER_ERROR",
        errorMessage: msg,
      };
    }

    if (!data.quote || !data.quote.amountIn || !data.quote.amountOut) {
      return {
        ok: false,
        routeStatus: "PROVIDER_ERROR",
        errorMessage: "Malformed quote payload received from provider.",
      };
    }

    // Validate atomic integer amount format and positive bounds (Requirement 6)
    if (
      !validateProviderAtomicAmount(data.quote.amountIn) ||
      !validateProviderAtomicAmount(data.quote.amountOut)
    ) {
      return {
        ok: false,
        routeStatus: "PROVIDER_ERROR",
        errorMessage: "Malformed or out-of-range provider atomic amounts.",
      };
    }

    // Validate exact-output destination satisfaction (Requirement 7)
    if (params.swapType === "EXACT_OUTPUT") {
      const expectedRequested = BigInt(params.amountAtomic);
      const returnedOut = BigInt(data.quote.amountOut);
      if (returnedOut < expectedRequested) {
        return {
          ok: false,
          routeStatus: "PROVIDER_ERROR",
          errorMessage: `Provider quote output amount (${data.quote.amountOut}) is less than requested invoice amount (${params.amountAtomic}).`,
        };
      }
      if (data.quote.minAmountOut) {
        if (!validateProviderAtomicAmount(data.quote.minAmountOut)) {
          return {
            ok: false,
            routeStatus: "PROVIDER_ERROR",
            errorMessage: "Provider minAmountOut has invalid atomic format.",
          };
        }
        if (BigInt(data.quote.minAmountOut) < expectedRequested) {
          return {
            ok: false,
            routeStatus: "PROVIDER_ERROR",
            errorMessage: `Provider minAmountOut (${data.quote.minAmountOut}) is less than requested invoice amount (${params.amountAtomic}).`,
          };
        }
      }
    }

    const hasProviderFees = Boolean(
      data.quote.refundFee || data.quote.withdrawFee,
    );
    const feeDescription = hasProviderFees
      ? [
          data.quote.refundFee ? `Refund fee: ${data.quote.refundFee}` : null,
          data.quote.withdrawFee
            ? `Withdraw fee: ${data.quote.withdrawFee}`
            : null,
        ]
          .filter(Boolean)
          .join("; ")
      : "Solver and network fees are determined at route execution.";

    return {
      ok: true,
      routeStatus: "SUPPORTED_AND_QUOTABLE",
      amountInAtomic: data.quote.amountIn,
      amountOutAtomic: data.quote.amountOut,
      minAmountOutAtomic: data.quote.minAmountOut ?? undefined,
      // Preserve missing fields as null rather than arbitrary defaults (Requirement 8)
      timeEstimateSeconds:
        typeof data.quote.timeEstimate === "number" &&
        data.quote.timeEstimate > 0
          ? data.quote.timeEstimate
          : null,
      fees: {
        refundFeeAtomic: data.quote.refundFee ?? null,
        withdrawFeeAtomic: data.quote.withdrawFee ?? null,
        isEstimate: !hasProviderFees,
        description: feeDescription,
      },
      correlationId: data.correlationId ?? undefined,
      signature: data.signature ?? undefined,
      quoteTimestamp: data.timestamp ?? null,
      providerDeadline: data.quoteRequest?.deadline ?? payload.deadline,
    };
  } catch (err: unknown) {
    const isTimeout =
      err instanceof Error &&
      (err.name === "AbortError" || err.message.includes("abort"));
    return {
      ok: false,
      routeStatus: "PROVIDER_ERROR",
      errorMessage: isTimeout
        ? "Provider quote request timed out."
        : "Failed to connect to route provider.",
    };
  }
}

export interface OneClickCommittedQuoteResult {
  readonly ok: boolean;
  readonly depositAddress?: string;
  readonly depositMemo?: string | null;
  readonly depositDeadline?: string;
  readonly amountInAtomic?: string;
  readonly amountOutAtomic?: string;
  readonly timeEstimateSeconds?: number | null;
  readonly correlationId?: string;
  readonly signature?: string;
  readonly quoteTimestamp?: string | null;
  readonly errorMessage?: string;
}

/**
 * Requests an authentic committed execution quote from 1Click with dry: false.
 * Returns genuine provider deposit instructions when execution is authorized.
 */
export async function fetchOneClickCommittedQuote(params: {
  originAsset: string;
  destinationAsset: string;
  swapType: QuoteSwapType;
  amountAtomic: string;
  refundTo: string;
  recipient: string;
  deadlineSeconds?: number;
  apiBase?: string;
}): Promise<OneClickCommittedQuoteResult> {
  const apiBase = params.apiBase ?? DEFAULT_ONE_CLICK_API_BASE;
  const deadlineDate = new Date(
    Date.now() + (params.deadlineSeconds ?? 900) * 1000,
  );

  const payload = {
    dry: false,
    swapType: params.swapType,
    slippageTolerance: 100, // 1%
    originAsset: params.originAsset,
    depositType: "ORIGIN_CHAIN" as const,
    destinationAsset: params.destinationAsset,
    amount: params.amountAtomic,
    refundTo: params.refundTo,
    refundType: "ORIGIN_CHAIN" as const,
    recipient: params.recipient,
    recipientType: "DESTINATION_CHAIN" as const,
    deadline: deadlineDate.toISOString(),
  };

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), TIMEOUT_MS);

    const response = await fetch(`${apiBase}/v0/quote`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    const data = (await response.json()) as OneClickRawResponse & {
      depositAddress?: string;
      depositMemo?: string;
      quote?: {
        depositAddress?: string;
        depositMemo?: string;
        memo?: string;
        deadline?: string;
        amountIn: string;
        amountOut: string;
        timeEstimate?: number;
      };
    };

    if (!response.ok) {
      return {
        ok: false,
        errorMessage:
          data.message ??
          data.error ??
          `Provider error (HTTP ${response.status})`,
      };
    }

    const depositAddress = data.depositAddress ?? data.quote?.depositAddress;
    if (!depositAddress) {
      return {
        ok: false,
        errorMessage: "Provider response did not contain a deposit address.",
      };
    }

    const memo =
      data.depositMemo ?? data.quote?.depositMemo ?? data.quote?.memo ?? null;
    const deadline =
      data.quote?.deadline ?? data.quoteRequest?.deadline ?? payload.deadline;

    return {
      ok: true,
      depositAddress,
      depositMemo: memo,
      depositDeadline: deadline,
      amountInAtomic: data.quote?.amountIn,
      amountOutAtomic: data.quote?.amountOut,
      timeEstimateSeconds: data.quote?.timeEstimate ?? null,
      correlationId: data.correlationId,
      signature: data.signature,
      quoteTimestamp: data.timestamp ?? null,
    };
  } catch (err: unknown) {
    const isTimeout =
      err instanceof Error &&
      (err.name === "AbortError" || err.message.includes("abort"));
    return {
      ok: false,
      errorMessage: isTimeout
        ? "Provider committed quote request timed out."
        : "Failed to connect to route provider for committed quote.",
    };
  }
}

export type OneClickExecutionStage =
  | "SOURCE_DEPOSIT_OBSERVED"
  | "SOURCE_FINALIZED"
  | "ROUTING_IN_PROGRESS"
  | "DESTINATION_TRANSFER_OBSERVED"
  | "DESTINATION_FINALIZED"
  | "FAILED"
  | "REFUNDED"
  | "PENDING_DEPOSIT";

export interface OneClickExecutionStatusResult {
  readonly ok: boolean;
  readonly stage: OneClickExecutionStage;
  readonly sourceTxHash?: string;
  readonly destinationTxHash?: string;
  readonly refundTxHash?: string;
  readonly failureReason?: string;
  readonly rawResponse?: Record<string, unknown>;
}

export async function fetchOneClickExecutionStatus(params: {
  readonly depositAddress: string;
  readonly depositMemo?: string | null;
  readonly correlationId?: string | null;
  readonly apiBase?: string;
}): Promise<OneClickExecutionStatusResult> {
  const apiBase = params.apiBase ?? DEFAULT_ONE_CLICK_API_BASE;
  const url = new URL(`${apiBase}/v0/status`);
  url.searchParams.set("depositAddress", params.depositAddress);
  if (params.depositMemo) {
    url.searchParams.set("memo", params.depositMemo);
  }
  if (params.correlationId) {
    url.searchParams.set("correlationId", params.correlationId);
  }

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), TIMEOUT_MS);

    const response = await fetch(url.toString(), {
      method: "GET",
      headers: {
        Accept: "application/json",
      },
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      if (response.status === 404) {
        return {
          ok: true,
          stage: "PENDING_DEPOSIT",
        };
      }
      return {
        ok: false,
        stage: "FAILED",
        failureReason: `Provider status error: HTTP ${response.status}`,
      };
    }

    const data = (await response.json()) as Record<string, unknown>;
    const rawStatus = String(data.status || "").toUpperCase();

    let stage: OneClickExecutionStage = "PENDING_DEPOSIT";
    if (
      rawStatus === "DEPOSIT_DETECTED" ||
      rawStatus === "DETECTED" ||
      rawStatus === "PENDING"
    ) {
      stage = "SOURCE_DEPOSIT_OBSERVED";
    } else if (
      rawStatus === "SOURCE_FINALIZED" ||
      rawStatus === "DEPOSIT_CONFIRMED"
    ) {
      stage = "SOURCE_FINALIZED";
    } else if (
      rawStatus === "PROCESSING" ||
      rawStatus === "SWAPPING" ||
      rawStatus === "ROUTING_IN_PROGRESS"
    ) {
      stage = "ROUTING_IN_PROGRESS";
    } else if (
      rawStatus === "DESTINATION_TRANSFER_OBSERVED" ||
      rawStatus === "SUBMITTED"
    ) {
      stage = "DESTINATION_TRANSFER_OBSERVED";
    } else if (
      rawStatus === "COMPLETED" ||
      rawStatus === "SUCCESS" ||
      rawStatus === "SETTLED" ||
      rawStatus === "DESTINATION_FINALIZED"
    ) {
      stage = "DESTINATION_FINALIZED";
    } else if (rawStatus === "REFUNDED") {
      stage = "REFUNDED";
    } else if (rawStatus === "FAILED" || rawStatus === "ERROR") {
      stage = "FAILED";
    }

    const sourceTx =
      (data.sourceTxHash as string) ||
      (data.depositTxHash as string) ||
      (data.originTxHash as string) ||
      undefined;

    const destTx =
      (data.destinationTxHash as string) ||
      (data.payoutTxHash as string) ||
      (data.targetTxHash as string) ||
      undefined;

    const refundTx = (data.refundTxHash as string) || undefined;
    const failureReason =
      (data.failureReason as string) ||
      (data.error as string) ||
      (data.message as string) ||
      undefined;

    return {
      ok: true,
      stage,
      sourceTxHash: sourceTx,
      destinationTxHash: destTx,
      refundTxHash: refundTx,
      failureReason,
      rawResponse: data,
    };
  } catch (err: unknown) {
    const isTimeout =
      err instanceof Error &&
      (err.name === "AbortError" || err.message.includes("abort"));
    return {
      ok: false,
      stage: "FAILED",
      failureReason: isTimeout
        ? "Provider status request timed out."
        : `Provider connection failure: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

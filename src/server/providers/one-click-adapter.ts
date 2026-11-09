import type {
  IndicativeQuoteFeeBreakdown,
  QuoteSwapType,
  RouteAvailabilityStatus,
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
  timeEstimateSeconds?: number;
  fees?: IndicativeQuoteFeeBreakdown;
  correlationId?: string;
  signature?: string;
  quoteTimestamp?: string;
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
      if (
        msg.toLowerCase().includes("tokenin is not valid") ||
        msg.toLowerCase().includes("tokenout is not valid") ||
        msg.toLowerCase().includes("unsupported")
      ) {
        return {
          ok: false,
          routeStatus: "UNSUPPORTED_PAIR",
          errorMessage: msg,
        };
      }
      if (msg.toLowerCase().includes("no liquidity")) {
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
        errorMessage: "Malformed quote received from provider.",
      };
    }

    const feeDescription =
      [
        data.quote.refundFee ? `Refund fee: ${data.quote.refundFee}` : null,
        data.quote.withdrawFee
          ? `Withdraw fee: ${data.quote.withdrawFee}`
          : null,
      ]
        .filter(Boolean)
        .join("; ") || "Network and solver fees included.";

    return {
      ok: true,
      routeStatus: "SUPPORTED_AND_QUOTABLE",
      amountInAtomic: data.quote.amountIn,
      amountOutAtomic: data.quote.amountOut,
      timeEstimateSeconds: data.quote.timeEstimate ?? 30,
      fees: {
        refundFeeAtomic: data.quote.refundFee,
        withdrawFeeAtomic: data.quote.withdrawFee,
        description: feeDescription,
      },
      correlationId: data.correlationId ?? undefined,
      signature: data.signature ?? undefined,
      quoteTimestamp: data.timestamp ?? new Date().toISOString(),
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

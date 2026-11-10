import { randomBytes } from "node:crypto";
import {
  type CatalogTokenDeployment,
  type EcosystemFamily,
  validateEcosystemAddress,
} from "./supported-assets-catalog.ts";

export type RouteAvailabilityStatus =
  | "SUPPORTED_AND_QUOTABLE"
  | "UNSUPPORTED_PAIR"
  | "TEMPORARILY_UNAVAILABLE"
  | "QUOTE_EXPIRED"
  | "PROVIDER_ERROR"
  | "NOT_YET_ENABLED_FOR_PAYMENT";

export type PayerCheckoutMode = "WALLET" | "EXCHANGE";

export type QuoteSwapType = "EXACT_OUTPUT" | "EXACT_INPUT";

export type PaymentAttemptStatus =
  | "QUOTE_OBSERVED"
  | "QUOTE_EXPIRED"
  | "QUOTE_CANCELLED"
  | "DEPOSIT_COMMITTED"
  | "DETECTED"
  | "SETTLING"
  | "SETTLED"
  | "EXPIRED"
  | "EXCEPTION_REFUND_REQUIRED"
  | "FAILED";

export interface PaymentDepositInstructions {
  readonly attemptPublicId: string;
  readonly status: PaymentAttemptStatus;
  readonly depositAddress: string;
  readonly depositMemo: string | null;
  readonly depositDeadline: string;
  readonly sourceNetwork: string;
  readonly sourceAssetId: string;
  readonly sourceAssetSymbol: string;
  readonly sourceDecimals: number;
  readonly destinationNetwork: string;
  readonly destinationAssetSymbol: string;
  readonly requiredAtomicAmount: string;
  readonly requiredDisplayAmount: string;
  readonly destinationDisplayAmount: string;
  readonly qrData: string;
  readonly instructionsNotice: string;
  readonly isExecutionDisabled: boolean;
  readonly sourceTxHash: string | null;
  readonly destinationTxHash: string | null;
  readonly settledAt: string | null;
}

export type QuoteVerificationTier =
  "UNVERIFIED_OBSERVATION" | "PROVIDER_VERIFIED";

/**
 * 1Click token asset identifiers mapped to Flow's curated token deployments.
 * Validated against 1Click's live /v0/tokens contract registry.
 * Testnet deployments have no live solver liquidity in 1Click and map to null.
 */
export const ONE_CLICK_ASSET_MAPPINGS: Readonly<Record<string, string>> = {
  // Ethereum Mainnet (EVM)
  "ethereum-mainnet:ETH": "nep141:eth.omft.near",
  "ethereum-mainnet:USDC":
    "nep141:eth-0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48.omft.near",
  "ethereum-mainnet:USDT":
    "nep141:eth-0xdac17f958d2ee523a2206206994597c13d831ec7.omft.near",

  // Base Mainnet (EVM)
  "base-mainnet:ETH": "nep141:base.omft.near",
  "base-mainnet:USDC":
    "nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near",

  // Solana Mainnet
  "solana-mainnet:SOL": "nep141:sol.omft.near",
  "solana-mainnet:USDC":
    "nep141:sol-5ce3bf3a31af18be40ba30f721101b4341690186.omft.near",
  "solana-mainnet:USDT":
    "nep141:sol-c800a4bd850783ccb82c2b2c7e84175443606352.omft.near",

  // NEAR Mainnet
  "near-mainnet:wNEAR": "nep141:wrap.near",
  "near-mainnet:USDC":
    "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1",
  "near-mainnet:USDT": "nep141:usdt.tether-token.near",
};

/**
 * Fallback probe addresses for dry quote estimation per ecosystem
 * when the payer has not yet connected a wallet or specified a refund address.
 * Matches real provider chain address format requirements.
 */
export const PROBE_ADDRESSES: Readonly<Record<EcosystemFamily, string>> = {
  evm: "0x1111111111111111111111111111111111111111",
  solana: "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU",
  near: "0000000000000000000000000000000000000000000000000000000000000001",
};

/**
 * Known illustrative, synthetic probe or public demo addresses that are strictly prohibited
 * from financial commitment, authorization or execution.
 */
export const BANNED_ILLUSTRATIVE_ADDRESSES: ReadonlySet<string> = new Set([
  "0xd8da6bf26964af9d7eed9e03e53415d37aa96045", // vitalik.eth / illustrative public demo
  "0x1111111111111111111111111111111111111111",
  "0x0000000000000000000000000000000000000000",
  "7xkxtg2cw87d97txjsdpbd5jbkhetqa83tzrujosgasu",
  "0000000000000000000000000000000000000000000000000000000000000001",
]);

export function isBannedIllustrativeAddress(
  address: string | null | undefined,
): boolean {
  if (!address) return false;
  const normalized = address.trim().toLowerCase();
  if (BANNED_ILLUSTRATIVE_ADDRESSES.has(normalized)) return true;
  for (const probe of Object.values(PROBE_ADDRESSES)) {
    if (probe.toLowerCase() === normalized) return true;
  }
  return false;
}

export function resolveOneClickAssetId(deploymentId: string): string | null {
  return ONE_CLICK_ASSET_MAPPINGS[deploymentId] ?? null;
}

export function isRouteSupportedByOneClick(
  sourceDeploymentId: string,
  destinationDeploymentId: string,
): boolean {
  const sourceAsset = resolveOneClickAssetId(sourceDeploymentId);
  const destAsset = resolveOneClickAssetId(destinationDeploymentId);
  return sourceAsset !== null && destAsset !== null;
}

/**
 * Determines whether a route supports sender-independent refunding required for exchange withdrawals.
 * In 1Click, cross-chain routes deliver refunds to the explicit refundTo address on the origin chain.
 * Same-chain direct transfers originate from pooled hot wallets without refund routing and are incompatible.
 */
export function isRouteExchangeCompatible(
  routeType: "CROSS_CHAIN_1CLICK" | "DIRECT_TRANSFER",
  sourceDeploymentId?: string,
): boolean {
  if (routeType === "DIRECT_TRANSFER") {
    return false;
  }
  if (!sourceDeploymentId) {
    return true;
  }
  return resolveOneClickAssetId(sourceDeploymentId) !== null;
}

export function generatePaymentAttemptPublicId(): string {
  return `pa_${randomBytes(16).toString("hex")}`;
}

export function isValidPaymentAttemptPublicId(id: string): boolean {
  return /^pa_[a-zA-Z0-9_-]{16,64}$/.test(id);
}

/**
 * Validates that an atomic amount from a provider is an exact positive integer string
 * conforming to max uint256 bounds (1-78 decimal digits).
 */
export function validateProviderAtomicAmount(val: unknown): boolean {
  if (typeof val !== "string") return false;
  if (!/^[0-9]{1,78}$/.test(val)) return false;
  try {
    const b = BigInt(val);
    return b > 0n;
  } catch {
    return false;
  }
}

export interface IndicativeQuoteFeeBreakdown {
  readonly refundFeeAtomic?: string | null;
  readonly withdrawFeeAtomic?: string | null;
  readonly appFeeBps?: number | null;
  readonly isEstimate: boolean;
  readonly description: string;
}

export interface IndicativeQuote {
  readonly attemptPublicId: string;
  readonly paymentRequestPublicId: string;
  readonly routeStatus: RouteAvailabilityStatus;
  readonly routeType: "CROSS_CHAIN_1CLICK" | "DIRECT_TRANSFER";
  readonly sourceNetwork: string;
  readonly sourceAssetId: string;
  readonly sourceAssetSymbol: string;
  readonly sourceDecimals: number;
  readonly destinationNetwork: string;
  readonly destinationAssetId: string;
  readonly destinationAssetSymbol: string;
  readonly destinationDecimals: number;
  readonly payerMode: PayerCheckoutMode;
  readonly refundAddress: string | null;
  readonly swapType: QuoteSwapType;

  // Amounts
  readonly sourceAtomicAmount: string;
  readonly sourceDisplayAmount: string;
  readonly destinationAtomicAmount: string;
  readonly destinationDisplayAmount: string;

  // Rate & Timing (preserve missing fields as null/unknown)
  readonly estimatedDurationSeconds: number | null;
  readonly exchangeRateDescription: string;
  readonly fees: IndicativeQuoteFeeBreakdown;

  // Timestamps & Lifecycles
  readonly quoteCreatedAt: string;
  readonly localPreviewExpiresAt: string;
  readonly providerQuoteExpiresAt: string | null;
  readonly correlationId: string | null;

  // Verification & Audit
  readonly verificationTier: QuoteVerificationTier;
  readonly isProviderVerified: boolean;
  readonly isExchangeCompatible: boolean;

  // Safety boundaries & guardrails
  readonly isIndicativeOnly: true;
  readonly isExecutionDisabled?: boolean;
  readonly executionBlockedNotice: string;
  readonly statusMessage?: string;
}

export interface QuoteDiscoveryInput {
  readonly paymentRequestPublicId: string;
  readonly sourceDeployment: CatalogTokenDeployment;
  readonly destinationDeployment: CatalogTokenDeployment;
  readonly payerMode: PayerCheckoutMode;
  readonly refundAddress?: string | null;
  readonly requestedAtomicAmount?: bigint | null;
  readonly customInputAtomicAmount?: bigint | null;
}

export function validateRefundAddressForMode(
  payerMode: PayerCheckoutMode,
  ecosystem: EcosystemFamily,
  refundAddress?: string | null,
): { valid: boolean; error?: string } {
  if (payerMode === "EXCHANGE") {
    if (!refundAddress || refundAddress.trim().length === 0) {
      return {
        valid: false,
        error:
          "A valid personal self-custody refund address is strictly required for exchange withdrawals.",
      };
    }
    const check = validateEcosystemAddress(ecosystem, refundAddress);
    if (!check.valid) {
      return {
        valid: false,
        error:
          check.reason ?? "Invalid refund address for selected source network.",
      };
    }
  } else if (refundAddress && refundAddress.trim().length > 0) {
    const check = validateEcosystemAddress(ecosystem, refundAddress);
    if (!check.valid) {
      return {
        valid: false,
        error:
          check.reason ?? "Invalid refund address for selected source network.",
      };
    }
  }
  return { valid: true };
}

/**
 * Builds an exact human-readable exchange rate description using pure BigInt fixed-point scaling.
 * Eliminates lossy IEEE-754 Number conversions on large atomic integer values.
 */
export function buildRateDescription(
  sourceSymbol: string,
  sourceDecimals: number,
  sourceAtomic: string,
  destSymbol: string,
  destDecimals: number,
  destAtomic: string,
): string {
  try {
    if (
      !validateProviderAtomicAmount(sourceAtomic) ||
      !validateProviderAtomicAmount(destAtomic)
    ) {
      return `1 ${sourceSymbol} → ${destSymbol}`;
    }
    const srcBig = BigInt(sourceAtomic);
    const dstBig = BigInt(destAtomic);
    if (srcBig <= 0n || dstBig <= 0n) {
      return `1 ${sourceSymbol} → ${destSymbol}`;
    }

    // Normalized display units scaled by 10^12 for exact fixed-point integer division
    const SCALE = 10n ** 12n;
    const srcNorm = (srcBig * SCALE) / 10n ** BigInt(sourceDecimals);
    const dstNorm = (dstBig * SCALE) / 10n ** BigInt(destDecimals);

    if (srcNorm === 0n || dstNorm === 0n) {
      return `1 ${sourceSymbol} → ${destSymbol}`;
    }

    if (srcNorm >= dstNorm) {
      // ratio = srcNorm / dstNorm scaled to 4 decimal places
      const ratioScaled = (srcNorm * 10000n) / dstNorm;
      const intPart = ratioScaled / 10000n;
      const fracPart = (ratioScaled % 10000n).toString().padStart(4, "0");
      return `1 ${destSymbol} ≈ ${intPart}.${fracPart} ${sourceSymbol}`;
    } else {
      // ratio = dstNorm / srcNorm scaled to 4 decimal places
      const ratioScaled = (dstNorm * 10000n) / srcNorm;
      const intPart = ratioScaled / 10000n;
      const fracPart = (ratioScaled % 10000n).toString().padStart(4, "0");
      return `1 ${sourceSymbol} ≈ ${intPart}.${fracPart} ${destSymbol}`;
    }
  } catch {
    return `1 ${sourceSymbol} → ${destSymbol}`;
  }
}

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

/**
 * 1Click token asset identifiers mapped to Flow's curated token deployments.
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
    "nep141:sol-Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB.omft.near",

  // NEAR Mainnet
  "near-mainnet:wNEAR": "nep141:wrap.near",
  "near-mainnet:USDC":
    "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1",
  "near-mainnet:USDT": "nep141:usdt.tether-token.near",
};

/**
 * Fallback probe addresses for dry quote estimation per ecosystem
 * when the payer has not yet connected a wallet or specified a refund address.
 */
export const PROBE_ADDRESSES: Readonly<Record<EcosystemFamily, string>> = {
  evm: "0x1111111111111111111111111111111111111111",
  solana: "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU",
  near: "preview-probe.near",
};

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

export function generatePaymentAttemptPublicId(): string {
  return `pa_${randomBytes(16).toString("hex")}`;
}

export function isValidPaymentAttemptPublicId(id: string): boolean {
  return /^pa_[a-zA-Z0-9_-]{16,64}$/.test(id);
}

export interface IndicativeQuoteFeeBreakdown {
  readonly refundFeeAtomic?: string;
  readonly withdrawFeeAtomic?: string;
  readonly appFeeBps?: number;
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

  // Rate & Timing
  readonly estimatedDurationSeconds: number;
  readonly exchangeRateDescription: string;
  readonly fees: IndicativeQuoteFeeBreakdown;

  // Timestamps & Lifecycles
  readonly quoteCreatedAt: string;
  readonly quoteExpiresAt: string;
  readonly correlationId: string | null;

  // Safety boundaries & guardrails
  readonly isIndicativeOnly: true;
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

export function buildRateDescription(
  sourceSymbol: string,
  sourceDecimals: number,
  sourceAtomic: string,
  destSymbol: string,
  destDecimals: number,
  destAtomic: string,
): string {
  try {
    const src = Number(BigInt(sourceAtomic)) / 10 ** sourceDecimals;
    const dst = Number(BigInt(destAtomic)) / 10 ** destDecimals;
    if (src > 0 && dst > 0) {
      if (src >= dst) {
        const rate = (src / dst).toFixed(4);
        return `1 ${destSymbol} ≈ ${rate} ${sourceSymbol}`;
      } else {
        const rate = (dst / src).toFixed(4);
        return `1 ${sourceSymbol} ≈ ${rate} ${destSymbol}`;
      }
    }
  } catch {
    // fallback if parse fails
  }
  return `1 ${sourceSymbol} → ${destSymbol}`;
}

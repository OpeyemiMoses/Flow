import { randomBytes } from "node:crypto";
import { formatAtomicToDisplay } from "./atomic-amounts.ts";
import {
  CURATED_SUPPORTED_DEPLOYMENTS,
  type CatalogTokenDeployment,
  type EcosystemFamily,
} from "./supported-assets-catalog.ts";

export type PaymentAmountMode = "FIXED" | "OPTIONAL";
export type PaymentRequestStatus =
  "ACTIVE" | "DISABLED" | "EXPIRED" | "COMPLETED";

export interface PaymentRequestRecord {
  readonly id: string;
  readonly accountId: string;
  readonly publicId: string;
  readonly title: string;
  readonly description: string | null;
  readonly destinationNetwork: string;
  readonly destinationAssetId: string;
  readonly destinationAssetSymbol: string;
  readonly destinationDecimals: number;
  readonly amountMode: PaymentAmountMode;
  readonly requestedAtomicAmount: bigint | null;
  readonly status: PaymentRequestStatus;
  readonly expiresAt: Date | null;
  readonly payerMemoRequired: boolean;
  readonly metadata: Record<string, unknown>;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface SerializedPaymentRequest {
  readonly id: string;
  readonly accountId: string;
  readonly publicId: string;
  readonly shareUrl: string;
  readonly title: string;
  readonly description: string | null;
  readonly destinationNetwork: string;
  readonly destinationAssetId: string;
  readonly destinationAssetSymbol: string;
  readonly destinationDecimals: number;
  readonly amountMode: PaymentAmountMode;
  readonly requestedAtomicAmount: string | null;
  readonly displayAmount: string | null;
  readonly status: PaymentRequestStatus;
  readonly expiresAt: string | null;
  readonly payerMemoRequired: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface EligibleSourceRoute {
  readonly id: string;
  readonly ecosystem: EcosystemFamily;
  readonly networkKey: string;
  readonly networkName: string;
  readonly assetSymbol: string;
  readonly assetName: string;
  readonly standard: string;
  readonly contractIdentifier: string;
  readonly decimals: number;
  readonly routeType: "DIRECT_TRANSFER" | "CROSS_CHAIN_1CLICK";
  readonly isOperationalNow: boolean;
  readonly availabilityNotice: string;
}

export interface PublicPaymentRequest {
  readonly publicId: string;
  readonly shareUrl: string;
  readonly title: string;
  readonly description: string | null;
  readonly recipientName: string;
  readonly recipientKind: "PERSONAL" | "BUSINESS";
  readonly destinationNetwork: string;
  readonly destinationAssetId: string;
  readonly destinationAssetSymbol: string;
  readonly destinationDecimals: number;
  readonly amountMode: PaymentAmountMode;
  readonly requestedAtomicAmount: string | null;
  readonly displayAmount: string | null;
  readonly status: PaymentRequestStatus;
  readonly expiresAt: string | null;
  readonly payerMemoRequired: boolean;
  readonly isExpired: boolean;
  readonly eligibleSourceRoutes: readonly EligibleSourceRoute[];
}

export function generatePublicPaymentId(): string {
  // 24 random bytes provides 192 bits of cryptographic entropy, URL-safe
  return `pr_${randomBytes(24).toString("base64url")}`;
}

export function isValidPublicPaymentId(id: string): boolean {
  return /^pr_[a-zA-Z0-9_-]{16,64}$/.test(id);
}

export function serializePaymentRequest(
  record: PaymentRequestRecord,
  origin: string,
): SerializedPaymentRequest {
  const displayAmount =
    record.requestedAtomicAmount !== null
      ? formatAtomicToDisplay(
          record.requestedAtomicAmount,
          record.destinationDecimals,
        )
      : null;

  return {
    id: record.id,
    accountId: record.accountId,
    publicId: record.publicId,
    shareUrl: `${origin.replace(/\/+$/, "")}/pay/${record.publicId}`,
    title: record.title,
    description: record.description,
    destinationNetwork: record.destinationNetwork,
    destinationAssetId: record.destinationAssetId,
    destinationAssetSymbol: record.destinationAssetSymbol,
    destinationDecimals: record.destinationDecimals,
    amountMode: record.amountMode,
    requestedAtomicAmount:
      record.requestedAtomicAmount !== null
        ? record.requestedAtomicAmount.toString()
        : null,
    displayAmount,
    status: record.status,
    expiresAt: record.expiresAt ? record.expiresAt.toISOString() : null,
    payerMemoRequired: record.payerMemoRequired,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
  };
}

export interface PublicPaymentRequestDbRow {
  public_id: string;
  title: string;
  description: string | null;
  destination_network: string;
  destination_asset_id: string;
  destination_asset_symbol: string;
  destination_decimals: number;
  amount_mode: PaymentAmountMode;
  requested_atomic_amount: string | null;
  status: PaymentRequestStatus;
  expires_at: Date | string | null;
  payer_memo_required: boolean;
  recipient_name: string;
  recipient_kind: "PERSONAL" | "BUSINESS";
}

export function serializePublicPaymentRequest(
  row: PublicPaymentRequestDbRow,
  origin: string,
): PublicPaymentRequest {
  const expiresAtDate = row.expires_at ? new Date(row.expires_at) : null;
  const isExpired = expiresAtDate !== null && expiresAtDate <= new Date();
  const effectiveStatus = isExpired ? "EXPIRED" : row.status;

  const displayAmount =
    row.requested_atomic_amount !== null
      ? formatAtomicToDisplay(
          BigInt(row.requested_atomic_amount),
          row.destination_decimals,
        )
      : null;

  const eligibleSourceRoutes = computeEligibleSourceRoutes(
    row.destination_network,
    row.destination_asset_id,
  );

  return {
    publicId: row.public_id,
    shareUrl: `${origin.replace(/\/+$/, "")}/pay/${row.public_id}`,
    title: row.title,
    description: row.description,
    recipientName: row.recipient_name,
    recipientKind: row.recipient_kind,
    destinationNetwork: row.destination_network,
    destinationAssetId: row.destination_asset_id,
    destinationAssetSymbol: row.destination_asset_symbol,
    destinationDecimals: row.destination_decimals,
    amountMode: row.amount_mode,
    requestedAtomicAmount: row.requested_atomic_amount,
    displayAmount,
    status: effectiveStatus,
    expiresAt: expiresAtDate ? expiresAtDate.toISOString() : null,
    payerMemoRequired: row.payer_memo_required,
    isExpired,
    eligibleSourceRoutes,
  };
}

export function computeEligibleSourceRoutes(
  destinationNetwork: string,
  destinationAssetId: string,
): readonly EligibleSourceRoute[] {
  // Determine destination environment (testnet vs mainnet)
  const isTestnet =
    destinationNetwork.includes("sepolia") ||
    destinationNetwork.includes("testnet") ||
    destinationNetwork.includes("devnet");

  const targetEnv = isTestnet ? "testnet" : "mainnet";

  return CURATED_SUPPORTED_DEPLOYMENTS.filter(
    (dep) => dep.environment === targetEnv,
  ).map((dep: CatalogTokenDeployment) => {
    const isDirect =
      dep.networkKey === destinationNetwork && dep.id === destinationAssetId;

    return {
      id: dep.id,
      ecosystem: dep.ecosystem,
      networkKey: dep.networkKey,
      networkName: dep.networkName,
      assetSymbol: dep.symbol,
      assetName: dep.name,
      standard: dep.standard,
      contractIdentifier: dep.contractIdentifier,
      decimals: dep.decimals,
      routeType: isDirect ? "DIRECT_TRANSFER" : "CROSS_CHAIN_1CLICK",
      isOperationalNow: false, // Execution remains disabled until M6
      availabilityNotice: isDirect
        ? "Direct transfer path. Deposit address issuance and signing are staged for M5 Phase 2 / M6. FLOW_EXECUTION is disabled."
        : "1Click cross-chain route. Executable quoting and cross-chain routing are staged for M6. FLOW_EXECUTION is disabled.",
    };
  });
}

import "server-only";
import {
  type PaymentAttemptStatus,
  type PaymentDepositInstructions,
  isValidPaymentAttemptPublicId,
  resolveOneClickAssetId,
  PROBE_ADDRESSES,
} from "../domain/quote-discovery.ts";
import { formatAtomicToDisplay } from "../domain/atomic-amounts.ts";
import { isValidPublicPaymentId } from "../domain/payment-requests.ts";
import { isFinancialExecutionDisabled } from "../domain/custody.ts";
import { getPrismaClient, runtime } from "../foundation/prisma.ts";
import { fetchOneClickCommittedQuote } from "./providers/one-click-adapter.ts";
import { clientBudget } from "./auth/limits.ts";
import { ApiFailure, reply } from "./http.ts";

export interface CommitPaymentAttemptInput {
  readonly attemptPublicId: string;
}

/**
 * Commits a guest payer to a quote, generating verified deposit instructions
 * and transitioning the payment attempt to DEPOSIT_COMMITTED status.
 *
 * Mandatory Security Safeguards:
 * 1. Rejected if FLOW_EXECUTION=disabled (Requirement 8)
 * 2. Rejected if quote is expired (Requirement 12 - strictly enforced without 1-hour grace)
 * 3. Synthetic deposit addresses are strictly prohibited (Requirement 7 & 9)
 */
export async function commitPaymentAttempt(
  request: Request,
  publicId: string,
): Promise<Response> {
  // Requirement 8: Execution guardrail
  if (isFinancialExecutionDisabled()) {
    throw new ApiFailure(
      403,
      "PAYMENT_EXECUTION_DISABLED: Payment execution and deposit commitment are disabled (FLOW_EXECUTION=disabled).",
    );
  }

  if (!isValidPublicPaymentId(publicId)) {
    throw new ApiFailure(404, "PAYMENT_REQUEST_NOT_FOUND");
  }

  // Parse body
  let body: CommitPaymentAttemptInput;
  try {
    body = (await request.json()) as CommitPaymentAttemptInput;
  } catch {
    throw new ApiFailure(400, "INVALID_JSON");
  }

  const { attemptPublicId } = body;
  if (!attemptPublicId || !isValidPaymentAttemptPublicId(attemptPublicId)) {
    throw new ApiFailure(400, "INVALID_ATTEMPT_PUBLIC_ID");
  }

  // Rate limit
  const allowed = await clientBudget(request, "public:payment-commit");
  if (!allowed) {
    throw new ApiFailure(429, "RATE_LIMIT_EXCEEDED");
  }

  const { db } = runtime();

  // Query attempt details to generate instructions
  const attempts = await db.$queryRaw<
    Array<{
      id: string;
      attempt_public_id: string;
      source_network: string;
      source_asset_id: string;
      source_asset_symbol: string;
      source_decimals: number;
      quoted_source_atomic_amount: string | null;
      quoted_destination_atomic_amount: string | null;
      status: string;
      quote_expires_at: Date | null;
      destination_network: string;
      destination_asset_symbol: string;
      destination_decimals: number;
      deposit_address: string | null;
      deposit_memo: string | null;
      deposit_deadline: Date | null;
      deposit_instructions: Record<string, unknown> | null;
    }>
  >`
    SELECT
      id,
      attempt_public_id,
      source_network,
      source_asset_id,
      source_asset_symbol,
      source_decimals,
      quoted_source_atomic_amount::text,
      quoted_destination_atomic_amount::text,
      status,
      quote_expires_at,
      destination_network,
      destination_asset_symbol,
      destination_decimals,
      deposit_address,
      deposit_memo,
      deposit_deadline,
      deposit_instructions
    FROM flow.get_public_payment_attempt(${publicId}, ${attemptPublicId})
    LIMIT 1
  `;

  if (attempts.length === 0) {
    throw new ApiFailure(404, "PAYMENT_ATTEMPT_NOT_FOUND");
  }

  const attempt = attempts[0]!;

  if (
    attempt.status !== "QUOTE_OBSERVED" &&
    attempt.status !== "DEPOSIT_COMMITTED"
  ) {
    throw new ApiFailure(400, `INVALID_STATUS_FOR_COMMIT: ${attempt.status}`);
  }

  // Requirement 12: Strict quote expiration enforcement
  if (
    attempt.quote_expires_at &&
    new Date(attempt.quote_expires_at).getTime() < Date.now()
  ) {
    throw new ApiFailure(400, "QUOTE_EXPIRED");
  }

  // Requirement 9, 10 & M6: Genuine provider and recipient address authorization
  let depositAddress = attempt.deposit_address;
  let depositMemo = attempt.deposit_memo;
  let deadline = attempt.deposit_deadline
    ? new Date(attempt.deposit_deadline)
    : new Date(Date.now() + 15 * 60 * 1000);

  if (!depositAddress) {
    const isDirect = attempt.source_network === attempt.destination_network;
    if (isDirect) {
      // Direct same-chain transfer path (Requirement 4)
      const recipientRows = await db.$queryRaw<Array<{ address: string }>>`
        SELECT wa.address
        FROM flow.wallet_addresses wa
        JOIN flow.wallets w ON w.id = wa.wallet_id
        JOIN flow.payment_requests pr ON pr.account_id = w.account_id
        JOIN flow.payment_attempts pa ON pa.payment_request_id = pr.id
        WHERE pa.attempt_public_id = ${attemptPublicId}
          AND wa.network = ${attempt.destination_network}
        LIMIT 1
      `;
      if (recipientRows.length === 0 || !recipientRows[0]?.address) {
        throw new ApiFailure(
          400,
          "RECIPIENT_WALLET_UNAVAILABLE: Recipient account has no registered wallet address for destination network.",
        );
      }
      depositAddress = recipientRows[0].address;
    } else {
      // Cross-chain 1Click committed quote path (Requirements 1, 2, 3)
      const attemptDetails = await db.$queryRaw<
        Array<{
          recipient_address: string;
          payer_refund_address: string | null;
          source_asset_id: string;
          destination_asset_id: string;
        }>
      >`
        SELECT
          wa.address AS recipient_address,
          pa.payer_refund_address,
          pa.source_asset_id,
          pr.destination_asset_id
        FROM flow.wallet_addresses wa
        JOIN flow.wallets w ON w.id = wa.wallet_id
        JOIN flow.payment_requests pr ON pr.account_id = w.account_id
        JOIN flow.payment_attempts pa ON pa.payment_request_id = pr.id
        WHERE pa.attempt_public_id = ${attemptPublicId}
          AND wa.network = ${attempt.destination_network}
        LIMIT 1
      `;

      if (
        attemptDetails.length === 0 ||
        !attemptDetails[0]?.recipient_address
      ) {
        throw new ApiFailure(
          400,
          "RECIPIENT_WALLET_UNAVAILABLE: Recipient account has no registered wallet address for destination network.",
        );
      }

      const row = attemptDetails[0]!;
      const sourceOneClickId = resolveOneClickAssetId(row.source_asset_id);
      const destOneClickId = resolveOneClickAssetId(row.destination_asset_id);
      if (!sourceOneClickId || !destOneClickId) {
        throw new ApiFailure(400, "UNSUPPORTED_ONE_CLICK_ASSET_PAIR");
      }

      const eco = attempt.source_network.startsWith("solana")
        ? "solana"
        : attempt.source_network.startsWith("near")
          ? "near"
          : "evm";
      const refundTo = row.payer_refund_address ?? PROBE_ADDRESSES[eco];

      const committedRes = await fetchOneClickCommittedQuote({
        originAsset: sourceOneClickId,
        destinationAsset: destOneClickId,
        swapType: "EXACT_OUTPUT",
        amountAtomic:
          attempt.quoted_destination_atomic_amount ??
          attempt.quoted_source_atomic_amount ??
          "0",
        refundTo,
        recipient: row.recipient_address,
      });

      if (!committedRes.ok || !committedRes.depositAddress) {
        throw new ApiFailure(
          400,
          committedRes.errorMessage ?? "PROVIDER_COMMITTED_QUOTE_FAILED",
        );
      }

      depositAddress = committedRes.depositAddress;
      depositMemo = committedRes.depositMemo ?? null;
      if (committedRes.depositDeadline) {
        deadline = new Date(committedRes.depositDeadline);
      }
    }
  }

  // Synthetic address fabrication is strictly prohibited.
  if (!depositAddress || depositAddress.startsWith("flow-")) {
    throw new ApiFailure(
      400,
      "PROVIDER_DEPOSIT_DESTINATION_UNAVAILABLE: Real provider deposit destination has not been authorized.",
    );
  }

  const depositInstructionsPayload = attempt.deposit_instructions ?? {
    network: attempt.source_network,
    tokenSymbol: attempt.source_asset_symbol,
    decimals: attempt.source_decimals,
    expectedAtomicAmount: attempt.quoted_source_atomic_amount,
    deadlineIso: deadline.toISOString(),
    memo: depositMemo,
    depositAddress,
  };

  // Commit via stored procedure
  const commitRows = await db.$queryRaw<
    Array<{
      id: string;
      attempt_public_id: string;
      status: string;
      deposit_address: string;
      deposit_memo: string | null;
      deposit_deadline: Date;
      deposit_instructions: Record<string, unknown>;
      updated_at: Date;
    }>
  >`
    SELECT *
    FROM flow.commit_payment_attempt(
      ${attemptPublicId},
      ${depositAddress},
      ${depositMemo},
      ${deadline},
      ${JSON.stringify(depositInstructionsPayload)}::jsonb
    )
  `;

  if (commitRows.length === 0) {
    throw new ApiFailure(500, "COMMIT_FAILED");
  }

  const committed = commitRows[0]!;

  const sourceDisplayAmount = formatAtomicToDisplay(
    BigInt(attempt.quoted_source_atomic_amount ?? "0"),
    attempt.source_decimals,
  );
  const destDisplayAmount = formatAtomicToDisplay(
    BigInt(attempt.quoted_destination_atomic_amount ?? "0"),
    attempt.destination_decimals,
  );

  const instructions: PaymentDepositInstructions = {
    attemptPublicId: committed.attempt_public_id,
    status: committed.status as PaymentAttemptStatus,
    depositAddress: committed.deposit_address,
    depositMemo: committed.deposit_memo,
    depositDeadline: new Date(committed.deposit_deadline).toISOString(),
    sourceNetwork: attempt.source_network,
    sourceAssetId: attempt.source_asset_id,
    sourceAssetSymbol: attempt.source_asset_symbol,
    sourceDecimals: attempt.source_decimals,
    destinationNetwork: attempt.destination_network,
    destinationAssetSymbol: attempt.destination_asset_symbol,
    requiredAtomicAmount: attempt.quoted_source_atomic_amount ?? "0",
    requiredDisplayAmount: sourceDisplayAmount,
    destinationDisplayAmount: destDisplayAmount,
    qrData:
      typeof committed.deposit_instructions === "object" &&
      committed.deposit_instructions !== null
        ? (((committed.deposit_instructions as Record<string, unknown>)
            .qrData as string) ?? "")
        : "",
    instructionsNotice: `Send verified ${sourceDisplayAmount} ${attempt.source_asset_symbol} on ${attempt.source_network}.`,
    isExecutionDisabled: false,
    sourceTxHash: null,
    destinationTxHash: null,
    settledAt: null,
  };

  return reply(200, instructions);
}

/**
 * Polling endpoint for public guest checkout to inspect payment attempt lifecycle status.
 */
export async function getPaymentAttemptStatus(
  request: Request,
  publicId: string,
  attemptPublicId: string,
): Promise<Response> {
  if (!isValidPublicPaymentId(publicId)) {
    throw new ApiFailure(404, "PAYMENT_REQUEST_NOT_FOUND");
  }

  if (!isValidPaymentAttemptPublicId(attemptPublicId)) {
    throw new ApiFailure(400, "INVALID_ATTEMPT_PUBLIC_ID");
  }

  const { db } = runtime();

  const rows = await db.$queryRaw<
    Array<{
      id: string;
      attempt_public_id: string;
      status: string;
      deposit_address: string | null;
      deposit_memo: string | null;
      deposit_deadline: Date | null;
      deposit_instructions: Record<string, unknown> | null;
      source_network: string;
      source_asset_id: string;
      source_asset_symbol: string;
      source_decimals: number;
      quoted_source_atomic_amount: string | null;
      quoted_destination_atomic_amount: string | null;
      source_tx_hash: string | null;
      destination_tx_hash: string | null;
      settled_at: Date | null;
      destination_network: string;
      destination_asset_symbol: string;
      destination_decimals: number;
    }>
  >`
    SELECT
      id,
      attempt_public_id,
      status,
      deposit_address,
      deposit_memo,
      deposit_deadline,
      deposit_instructions,
      source_network,
      source_asset_id,
      source_asset_symbol,
      source_decimals,
      quoted_source_atomic_amount::text,
      quoted_destination_atomic_amount::text,
      source_tx_hash,
      destination_tx_hash,
      settled_at,
      destination_network,
      destination_asset_symbol,
      destination_decimals
    FROM flow.get_public_payment_attempt(${publicId}, ${attemptPublicId})
    LIMIT 1
  `;

  if (rows.length === 0) {
    throw new ApiFailure(404, "PAYMENT_ATTEMPT_NOT_FOUND");
  }

  const row = rows[0]!;

  const sourceDisplayAmount = formatAtomicToDisplay(
    BigInt(row.quoted_source_atomic_amount ?? "0"),
    row.source_decimals,
  );
  const destDisplayAmount = formatAtomicToDisplay(
    BigInt(row.quoted_destination_atomic_amount ?? "0"),
    row.destination_decimals,
  );

  const instructions: PaymentDepositInstructions = {
    attemptPublicId: row.attempt_public_id,
    status: row.status as PaymentAttemptStatus,
    depositAddress: row.deposit_address ?? "",
    depositMemo: row.deposit_memo,
    depositDeadline: row.deposit_deadline
      ? new Date(row.deposit_deadline).toISOString()
      : "",
    sourceNetwork: row.source_network,
    sourceAssetId: row.source_asset_id,
    sourceAssetSymbol: row.source_asset_symbol,
    sourceDecimals: row.source_decimals,
    destinationNetwork: row.destination_network,
    destinationAssetSymbol: row.destination_asset_symbol,
    requiredAtomicAmount: row.quoted_source_atomic_amount ?? "0",
    requiredDisplayAmount: sourceDisplayAmount,
    destinationDisplayAmount: destDisplayAmount,
    qrData:
      row.deposit_instructions && typeof row.deposit_instructions === "object"
        ? ((row.deposit_instructions.qrData as string) ?? "")
        : "",
    instructionsNotice: `Payment status: ${row.status}`,
    isExecutionDisabled: true,
    sourceTxHash: row.source_tx_hash,
    destinationTxHash: row.destination_tx_hash,
    settledAt: row.settled_at ? new Date(row.settled_at).toISOString() : null,
  };

  return reply(200, instructions);
}

/**
 * Worker-privileged function to settle a committed payment attempt,
 * recording transaction hashes and posting the balanced double-entry ledger journal.
 */
export async function workerSettlePayment(
  attemptPublicId: string,
  params: {
    sourceTxHash: string;
    destinationTxHash: string;
  },
): Promise<{
  id: string;
  attemptPublicId: string;
  status: string;
  settledAt: string;
  journalId: string;
  journalPublicId: string;
}> {
  const workerDb = getPrismaClient("worker");

  const rows = await workerDb.$queryRaw<
    Array<{
      id: string;
      attempt_public_id: string;
      status: string;
      settled_at: Date;
      journal_id: string;
      journal_public_id: string;
    }>
  >`
    SELECT *
    FROM flow.worker_settle_payment_attempt(
      ${attemptPublicId},
      ${params.sourceTxHash},
      ${params.destinationTxHash}
    )
  `;

  if (rows.length === 0) {
    throw new ApiFailure(500, "SETTLEMENT_FAILED");
  }

  const r = rows[0]!;
  return {
    id: r.id,
    attemptPublicId: r.attempt_public_id,
    status: r.status,
    settledAt: new Date(r.settled_at).toISOString(),
    journalId: r.journal_id,
    journalPublicId: r.journal_public_id,
  };
}

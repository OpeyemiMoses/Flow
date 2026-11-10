import "server-only";
import {
  type PaymentAttemptStatus,
  type PaymentDepositInstructions,
  isValidPaymentAttemptPublicId,
  resolveOneClickAssetId,
  isBannedIllustrativeAddress,
} from "../domain/quote-discovery.ts";
import { formatAtomicToDisplay } from "../domain/atomic-amounts.ts";
import { isValidPublicPaymentId } from "../domain/payment-requests.ts";
import {
  isFinancialExecutionDisabled,
  isValidEvmAddress,
  isValidNearAddress,
  isValidSolanaAddress,
} from "../domain/custody.ts";
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
    if (isFinancialExecutionDisabled()) {
      throw new ApiFailure(
        403,
        "PAYMENT_EXECUTION_DISABLED: Payment execution and deposit commitment are disabled (FLOW_EXECUTION=disabled).",
      );
    }
    throw new ApiFailure(400, "INVALID_ATTEMPT_PUBLIC_ID");
  }

  // Rate limit
  const allowed = await clientBudget(request, "public:payment-commit");
  if (!allowed) {
    throw new ApiFailure(429, "RATE_LIMIT_EXCEEDED");
  }

  const { db } = runtime();

  // If financial execution is disabled, check if an active, unconsumed rehearsal authorization exists
  if (isFinancialExecutionDisabled()) {
    const authRows = await db.$queryRaw<Array<{ res_auth_id: string }>>`
      SELECT res_auth_id FROM flow.check_active_payment_rehearsal_authorization(${publicId})
    `;
    if (authRows.length === 0 || !authRows[0]?.res_auth_id) {
      throw new ApiFailure(
        403,
        "PAYMENT_EXECUTION_DISABLED: Payment execution and deposit commitment are disabled (FLOW_EXECUTION=disabled).",
      );
    }
  }

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
    if (isFinancialExecutionDisabled()) {
      throw new ApiFailure(
        403,
        "PAYMENT_EXECUTION_DISABLED: Payment execution and deposit commitment are disabled (FLOW_EXECUTION=disabled).",
      );
    }
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
    // 1. Fetch recipient wallet details with full custody, chain ID, and capability checks via SECURITY DEFINER (Blocker 1)
    const recipientDetails = await db.$queryRaw<
      Array<{
        payment_request_id: string;
        attempt_id: string;
        destination_asset_id: string;
        payer_refund_address: string | null;
        recipient_address: string | null;
        recipient_network: string | null;
        recipient_chain_id: string | null;
        wallet_environment: string | null;
        wallet_status: string | null;
        can_receive: boolean | null;
      }>
    >`
      SELECT *
      FROM flow.get_payment_attempt_commitment_details(${publicId}, ${attemptPublicId})
      LIMIT 1
    `;

    if (
      recipientDetails.length === 0 ||
      !recipientDetails[0]?.recipient_address
    ) {
      throw new ApiFailure(
        400,
        "RECIPIENT_WALLET_UNAVAILABLE: Recipient account has no registered wallet address for destination network.",
      );
    }

    const row = recipientDetails[0]!;
    const recipientAddress = row.recipient_address!;

    // Recipient wallet readiness validation (Blocker 1)
    if (row.wallet_status !== "ACTIVE") {
      throw new ApiFailure(
        400,
        `RECIPIENT_WALLET_NOT_ACTIVE: Recipient wallet status is ${row.wallet_status}, must be ACTIVE.`,
      );
    }

    if (!row.can_receive) {
      throw new ApiFailure(
        400,
        "RECIPIENT_RECEIVE_DISABLED: Recipient wallet does not have receive capability enabled.",
      );
    }

    if (attempt.destination_network.toLowerCase().includes("base")) {
      if (row.recipient_chain_id !== "8453") {
        throw new ApiFailure(
          400,
          `RECIPIENT_CHAIN_ID_MISMATCH: Base mainnet chain ID must be 8453, got ${row.recipient_chain_id}. Testnet (84532) wallets are strictly prohibited.`,
        );
      }
      if (row.wallet_environment !== "mainnet") {
        throw new ApiFailure(
          400,
          `RECIPIENT_ENVIRONMENT_MISMATCH: Recipient wallet environment must be mainnet, got ${row.wallet_environment}.`,
        );
      }
      if (
        !isValidEvmAddress(recipientAddress) ||
        isBannedIllustrativeAddress(recipientAddress)
      ) {
        throw new ApiFailure(
          400,
          "RECIPIENT_ADDRESS_INVALID: Recipient Base address must be a verified, valid non-probe EVM address. Illustrative probe addresses are strictly prohibited.",
        );
      }
    }

    // 2. Strict Rehearsal Authorization & Execution Guardrail (Blocker 2 & 3)
    if (isFinancialExecutionDisabled()) {
      const quotedAmtStr =
        attempt.quoted_destination_atomic_amount ??
        attempt.quoted_source_atomic_amount ??
        "0";

      const authConsumption = await db.$queryRaw<
        Array<{
          res_auth_id: string;
          res_operator_auth_id: string;
          res_max_atomic_amount: string;
          res_consumed_at: Date;
        }>
      >`
        SELECT *
        FROM flow.consume_payment_rehearsal_authorization(
          ${row.payment_request_id}::uuid,
          ${attempt.id}::uuid,
          ${attempt.source_network},
          ${attempt.source_asset_id},
          ${attempt.destination_network},
          ${row.destination_asset_id},
          ${quotedAmtStr}::numeric,
          ${row.payer_refund_address},
          ${recipientAddress}
        )
      `.catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        throw new ApiFailure(403, `REHEARSAL_AUTHORIZATION_FAILED: ${msg}`);
      });

      if (authConsumption.length === 0 || !authConsumption[0]?.res_auth_id) {
        throw new ApiFailure(
          403,
          "PAYMENT_EXECUTION_DISABLED: Global financial execution is disabled and no valid, unconsumed rehearsal authorization exists for this payment request.",
        );
      }
    }

    const isDirect = attempt.source_network === attempt.destination_network;
    if (isDirect) {
      depositAddress = recipientAddress;
    } else {
      // Cross-chain 1Click committed quote path (Requirements 1, 2, 3)
      if (
        !row.payer_refund_address ||
        row.payer_refund_address.trim().length === 0 ||
        isBannedIllustrativeAddress(row.payer_refund_address)
      ) {
        throw new ApiFailure(
          400,
          "PAYER_REFUND_ADDRESS_REQUIRED: A valid payer refund address is strictly required before committing a cross-chain payment. Illustrative and synthetic probe addresses are prohibited.",
        );
      }

      if (
        attempt.source_network.toLowerCase().includes("solana") &&
        !isValidSolanaAddress(row.payer_refund_address)
      ) {
        throw new ApiFailure(
          400,
          "PAYER_REFUND_ADDRESS_INVALID: Source network is Solana but refund address is not a valid Solana address.",
        );
      }
      if (
        (attempt.source_network.toLowerCase().includes("base") ||
          attempt.source_network.toLowerCase().includes("ethereum")) &&
        !isValidEvmAddress(row.payer_refund_address)
      ) {
        throw new ApiFailure(
          400,
          "PAYER_REFUND_ADDRESS_INVALID: Source network is EVM but refund address is not a valid EVM address.",
        );
      }
      if (
        attempt.source_network.toLowerCase().includes("near") &&
        !isValidNearAddress(row.payer_refund_address)
      ) {
        throw new ApiFailure(
          400,
          "PAYER_REFUND_ADDRESS_INVALID: Source network is NEAR but refund address is not a valid NEAR address.",
        );
      }

      const sourceOneClickId = resolveOneClickAssetId(attempt.source_asset_id);
      const destOneClickId = resolveOneClickAssetId(row.destination_asset_id);
      if (!sourceOneClickId || !destOneClickId) {
        throw new ApiFailure(400, "UNSUPPORTED_ONE_CLICK_ASSET_PAIR");
      }

      const committedRes = await fetchOneClickCommittedQuote({
        originAsset: sourceOneClickId,
        destinationAsset: destOneClickId,
        swapType: "EXACT_OUTPUT",
        amountAtomic:
          attempt.quoted_destination_atomic_amount ??
          attempt.quoted_source_atomic_amount ??
          "0",
        refundTo: row.payer_refund_address,
        recipient: recipientAddress,
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

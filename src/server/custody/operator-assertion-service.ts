import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import { FlowError } from "../../foundation/errors.ts";
import { isFinancialExecutionDisabled } from "../../domain/custody.ts";
import type { FlowDb } from "../../foundation/prisma.ts";

export interface IssueRehearsalApprovalAssertionInput {
  readonly operatorAuthId: string;
  readonly operatorSessionToken: string;
  readonly paymentRequestId: string;
  readonly sourceNetwork: string;
  readonly sourceAssetId: string;
  readonly destinationNetwork: string;
  readonly destinationAssetId: string;
  readonly maxAtomicAmount: bigint | string | number;
  readonly allowedRecipientAddress: string;
  readonly allowedPayerRefundAddress?: string | null;
  readonly durationSeconds?: number;
}

export interface IssuedApprovalAssertion {
  readonly assertionId: string;
  readonly assertionToken: string;
  readonly assertionTokenHash: string;
  readonly operatorAuthId: string;
  readonly nonce: string;
  readonly signature: string;
  readonly expiresAt: Date;
}

export interface CreateRehearsalAuthorizationInput {
  readonly paymentRequestId: string;
  readonly operatorAuthId: string;
  readonly approvalAssertionToken: string;
  readonly sourceNetwork: string;
  readonly sourceAssetId: string;
  readonly destinationNetwork: string;
  readonly destinationAssetId: string;
  readonly maxAtomicAmount: bigint | string | number;
  readonly allowedRecipientAddress: string;
  readonly allowedPayerRefundAddress?: string | null;
  readonly durationSeconds?: number;
}

const BANNED_ILLUSTRATIVE_ADDRESSES = new Set([
  "0xd8da6bf26964af9d7eed9e03e53415d37aa96045",
  "0x1111111111111111111111111111111111111111",
  "0x0000000000000000000000000000000000000000",
]);

/**
 * Privileged Operator Authorization Service.
 *
 * Cryptographically validates operator credentials and issues signed, short-lived approval assertions.
 * Never trusts arbitrary caller-supplied IDs or custom session variables as proof of identity.
 */
export async function issuePaymentRehearsalApprovalAssertion(
  operatorDb: FlowDb,
  input: IssueRehearsalApprovalAssertionInput,
): Promise<IssuedApprovalAssertion> {
  // Financial execution safety gate
  if (!isFinancialExecutionDisabled()) {
    throw new FlowError(
      "INVALID_CONFIGURATION",
      "FLOW_EXECUTION must remain disabled while preparing rehearsal approvals.",
    );
  }

  const operatorAuthId = input.operatorAuthId?.trim();
  if (!operatorAuthId) {
    throw new FlowError(
      "CUSTODY_OPERATOR_AUTHENTICATION_REQUIRED",
      "Operator authentication required: missing operatorAuthId.",
    );
  }

  const sessionToken = input.operatorSessionToken?.trim();
  if (!sessionToken || sessionToken.length < 16) {
    throw new FlowError(
      "CUSTODY_OPERATOR_AUTHENTICATION_REQUIRED",
      "Operator authentication required: valid unexpired operator session token must be provided.",
    );
  }

  const recipientAddress = input.allowedRecipientAddress?.trim();
  if (
    !recipientAddress ||
    BANNED_ILLUSTRATIVE_ADDRESSES.has(recipientAddress.toLowerCase())
  ) {
    throw new FlowError(
      "CUSTODY_INVALID_ADDRESS",
      `Invalid or illustrative recipient address prohibited: ${recipientAddress}`,
    );
  }

  const durationSeconds = input.durationSeconds ?? 1800;
  if (durationSeconds < 60 || durationSeconds > 86400) {
    throw new FlowError(
      "INVALID_CONFIGURATION",
      "Rehearsal duration must be between 60 and 86400 seconds.",
    );
  }

  const maxAtomic = BigInt(input.maxAtomicAmount.toString());
  if (maxAtomic <= 0n) {
    throw new FlowError(
      "INVALID_AMOUNT",
      "Max atomic amount must be strictly greater than zero.",
    );
  }

  // Generate high-entropy cryptographic assertion bearer token (256-bit)
  const assertionToken = randomBytes(32).toString("hex");
  const assertionTokenHash = createHash("sha256")
    .update(assertionToken)
    .digest("hex");
  const nonce = randomUUID();

  // Canonical payload for cryptographic HMAC signing
  const canonicalPayload = [
    operatorAuthId,
    input.paymentRequestId,
    input.sourceNetwork,
    input.sourceAssetId,
    input.destinationNetwork,
    input.destinationAssetId,
    maxAtomic.toString(),
    recipientAddress.toLowerCase(),
    (input.allowedPayerRefundAddress ?? "").trim(),
    nonce,
  ].join(":");

  const hmacKey =
    process.env.FLOW_OPERATOR_TRUSTED_EXECUTION_KEY || sessionToken;
  const signature = createHmac("sha256", hmacKey)
    .update(canonicalPayload)
    .digest("hex");

  const rows = await operatorDb.$queryRaw<Array<{ id: string }>>`
    SELECT flow.issue_operator_approval_assertion(
      ${operatorAuthId},
      ${sessionToken},
      ${input.paymentRequestId}::uuid,
      ${input.sourceNetwork},
      ${input.sourceAssetId},
      ${input.destinationNetwork},
      ${input.destinationAssetId},
      ${maxAtomic.toString()}::numeric,
      ${recipientAddress},
      ${input.allowedPayerRefundAddress?.trim() ?? null},
      ${durationSeconds},
      ${assertionTokenHash},
      ${signature},
      ${nonce}
    ) AS id
  `;

  if (!rows[0]?.id) {
    throw new FlowError(
      "CUSTODY_OPERATOR_AUTHORIZATION_ERROR",
      "Failed to issue cryptographic approval assertion from procedure.",
    );
  }

  const expiresAt = new Date(Date.now() + durationSeconds * 1000);

  return {
    assertionId: rows[0].id,
    assertionToken,
    assertionTokenHash,
    operatorAuthId,
    nonce,
    signature,
    expiresAt,
  };
}

/**
 * Creates single-use payment rehearsal authorization using a verified cryptographic approval assertion token.
 */
export async function createPaymentRehearsalAuthorization(
  operatorDb: FlowDb,
  input: CreateRehearsalAuthorizationInput,
): Promise<{ readonly authorizationId: string }> {
  const maxAtomic = BigInt(input.maxAtomicAmount.toString());

  const rows = await operatorDb.$queryRaw<Array<{ id: string }>>`
    SELECT flow.create_payment_rehearsal_authorization(
      ${input.paymentRequestId}::uuid,
      ${input.operatorAuthId},
      ${input.approvalAssertionToken},
      ${input.sourceNetwork},
      ${input.sourceAssetId},
      ${input.destinationNetwork},
      ${input.destinationAssetId},
      ${maxAtomic.toString()}::numeric,
      ${input.allowedRecipientAddress},
      ${input.allowedPayerRefundAddress?.trim() ?? null},
      ${input.durationSeconds ?? 1800}
    ) AS id
  `;

  if (!rows[0]?.id) {
    throw new FlowError(
      "CUSTODY_OPERATOR_AUTHORIZATION_ERROR",
      "Failed to create payment rehearsal authorization.",
    );
  }

  return { authorizationId: rows[0].id };
}

/**
 * Convenience helper to issue an assertion and consume it immediately to create an authorization.
 */
export async function authorizePaymentRehearsalWithCredentials(
  operatorDb: FlowDb,
  input: IssueRehearsalApprovalAssertionInput,
): Promise<{
  readonly authorizationId: string;
  readonly assertionId: string;
  readonly expiresAt: Date;
}> {
  const assertion = await issuePaymentRehearsalApprovalAssertion(
    operatorDb,
    input,
  );
  const auth = await createPaymentRehearsalAuthorization(operatorDb, {
    paymentRequestId: input.paymentRequestId,
    operatorAuthId: input.operatorAuthId,
    approvalAssertionToken: assertion.assertionToken,
    sourceNetwork: input.sourceNetwork,
    sourceAssetId: input.sourceAssetId,
    destinationNetwork: input.destinationNetwork,
    destinationAssetId: input.destinationAssetId,
    maxAtomicAmount: input.maxAtomicAmount,
    allowedRecipientAddress: input.allowedRecipientAddress,
    allowedPayerRefundAddress: input.allowedPayerRefundAddress,
    durationSeconds: input.durationSeconds,
  });

  return {
    authorizationId: auth.authorizationId,
    assertionId: assertion.assertionId,
    expiresAt: assertion.expiresAt,
  };
}

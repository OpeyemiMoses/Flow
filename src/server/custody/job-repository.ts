import {
  evaluateWalletFundReadiness,
  isValidNearAddress,
  isValidPolicyState,
  validateRequiredWalletProvisioning,
  verifyCustodyPolicyEvidence,
  verifyPublicKeyMatchesAddress,
  type OutLayerPolicyState,
  type ProviderPolicyEvidenceInput,
} from "../../domain/custody.ts";
import { FlowError } from "../../foundation/errors.ts";
import type { FlowDb } from "../../foundation/prisma.ts";
import {
  outlayerChainSchema,
  scrubHandoffUrl,
  type OutLayerChain,
  type SanitizedProviderErrorCode,
} from "./outlayer-adapter.ts";

export const ALLOWED_JOB_FAILURE_CLASSIFICATIONS = [
  "POST_DISPATCH_AMBIGUOUS",
  "BAD_REQUEST",
  "AUTHENTICATION_FAILED",
  "RESOURCE_NOT_FOUND",
  "RATE_LIMITED",
  "UPSTREAM_UNAVAILABLE",
  "GATEWAY_TIMEOUT",
  "NETWORK_ERROR",
  "CORRUPTED_RESPONSE",
  "UNSUPPORTED_CHAIN",
  "CORRELATION_ERROR",
  "INVALID_ADDRESS",
  "POLICY_VERIFICATION_FAILED",
  "INCOMPLETE_PROVISIONING",
] as const;

export type JobFailureClassification =
  (typeof ALLOWED_JOB_FAILURE_CLASSIFICATIONS)[number];

export type AllowlistedProviderEndpoint =
  "/register" | "/wallet/v1/address" | "/wallet/v1/policy";

const ALLOWED_PROVIDER_ENDPOINTS = new Set<AllowlistedProviderEndpoint>([
  "/register",
  "/wallet/v1/address",
  "/wallet/v1/policy",
]);

const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface SafeProviderErrorMetadata {
  readonly code?: SanitizedProviderErrorCode | JobFailureClassification;
  readonly httpStatus?: number;
  readonly endpoint?: AllowlistedProviderEndpoint;
  readonly chain?: OutLayerChain;
  readonly correlationId?: string;
}

const ALLOWLISTED_FAILURE_SUMMARIES: Readonly<
  Record<JobFailureClassification, string>
> = Object.freeze({
  POST_DISPATCH_AMBIGUOUS:
    "Ambiguous provider outcome after external dispatch; quarantined for reconciliation.",
  BAD_REQUEST: "Provider rejected request with HTTP 400 category error.",
  AUTHENTICATION_FAILED: "Provider rejected authentication credentials.",
  RESOURCE_NOT_FOUND: "Requested provider resource was not found.",
  RATE_LIMITED: "Provider rate limit exceeded.",
  UPSTREAM_UNAVAILABLE: "Provider service temporarily unavailable.",
  GATEWAY_TIMEOUT: "Provider gateway timed out.",
  NETWORK_ERROR: "Provider network communication failed.",
  CORRUPTED_RESPONSE: "Provider returned malformed or schema-invalid response.",
  UNSUPPORTED_CHAIN: "Requested blockchain network is unsupported by provider.",
  CORRELATION_ERROR:
    "Provider response failed mandatory wallet or chain correlation check.",
  INVALID_ADDRESS:
    "Provider returned address that failed network format validation.",
  POLICY_VERIFICATION_FAILED:
    "Provider custody policy failed mandatory verification checks.",
  INCOMPLETE_PROVISIONING:
    "Wallet provisioning is missing required launch chain addresses or capabilities.",
});

export function isValidJobFailureClassification(
  value: unknown,
): value is JobFailureClassification {
  return (
    typeof value === "string" &&
    (ALLOWED_JOB_FAILURE_CLASSIFICATIONS as readonly string[]).includes(value)
  );
}

/**
 * Constructs a strictly isolated, non-sensitive JSON error payload for database persistence.
 * Arbitrary upstream error messages, HTML, bearer tokens, headers, cookies, email addresses,
 * and database URLs are never read or persisted; only allowlisted codes and validated
 * correlation metadata (HTTP integer status, allowlisted endpoint/chain, UUID correlationId)
 * are serialized.
 */
export function formatIsolatedProviderFailure(
  classification: JobFailureClassification,
  metadata?: SafeProviderErrorMetadata | unknown,
  fallbackCorrelationId?: string | null,
): string {
  if (!isValidJobFailureClassification(classification)) {
    throw new FlowError(
      "INVALID_FAILURE_CLASSIFICATION",
      "Unrecognized or unallowlisted job failure classification.",
    );
  }

  let safeCode: JobFailureClassification = classification;
  let safeHttpStatus: number | undefined;
  let safeEndpoint: AllowlistedProviderEndpoint | undefined;
  let safeChain: OutLayerChain | undefined;
  let safeCorrelationId: string | undefined;

  if (metadata && typeof metadata === "object" && !Array.isArray(metadata)) {
    const record = metadata as Record<string, unknown>;

    if (isValidJobFailureClassification(record.code)) {
      safeCode = record.code;
    }

    if (
      typeof record.httpStatus === "number" &&
      Number.isInteger(record.httpStatus) &&
      record.httpStatus >= 100 &&
      record.httpStatus <= 599
    ) {
      safeHttpStatus = record.httpStatus;
    }

    if (
      typeof record.endpoint === "string" &&
      ALLOWED_PROVIDER_ENDPOINTS.has(
        record.endpoint as AllowlistedProviderEndpoint,
      )
    ) {
      safeEndpoint = record.endpoint as AllowlistedProviderEndpoint;
    }

    const parsedChain = outlayerChainSchema.safeParse(record.chain);
    if (parsedChain.success) {
      safeChain = parsedChain.data;
    }

    if (
      typeof record.correlationId === "string" &&
      UUID_REGEX.test(record.correlationId.trim())
    ) {
      safeCorrelationId = record.correlationId.trim().toLowerCase();
    }
  }

  if (
    !safeCorrelationId &&
    typeof fallbackCorrelationId === "string" &&
    UUID_REGEX.test(fallbackCorrelationId.trim())
  ) {
    safeCorrelationId = fallbackCorrelationId.trim().toLowerCase();
  }

  return JSON.stringify({
    code: safeCode,
    summary: ALLOWLISTED_FAILURE_SUMMARIES[classification],
    ...(safeHttpStatus !== undefined ? { httpStatus: safeHttpStatus } : {}),
    ...(safeEndpoint !== undefined ? { endpoint: safeEndpoint } : {}),
    ...(safeChain !== undefined ? { chain: safeChain } : {}),
    ...(safeCorrelationId !== undefined
      ? { correlationId: safeCorrelationId }
      : {}),
  });
}

export interface ProvisioningJobRow {
  readonly id: string;
  readonly accountId: string;
  readonly idempotencyKey: string;
  readonly status: string;
  readonly fencingToken: bigint;
  readonly leaseHolder: string | null;
  readonly leaseExpiresAt: Date | null;
  readonly dispatchAttemptId: string | null;
  readonly dispatchedAt: Date | null;
  readonly attempts: number;
  readonly maxAttempts: number;
  readonly failureClassification: string | null;
  readonly lastError: string | null;
}

export interface WalletCommitInput {
  readonly accountId: string;
  readonly providerWalletId: string;
  readonly nearAccountId: string;
  readonly encryptedCredential: string;
  readonly keyId: string;
  readonly keyDigest: string;
  readonly handoffUrl?: string;
  readonly policyEvidence: ProviderPolicyEvidenceInput;
  readonly addresses: ReadonlyArray<{
    readonly network: string;
    readonly chainId: string;
    readonly address: string;
    readonly publicKey: string;
  }>;
  readonly capabilities: ReadonlyArray<{
    readonly network: string;
    readonly canDeriveAddress: boolean;
    readonly canReceive: boolean;
    readonly canReadNativeBalance: boolean;
    readonly canReadIntentsBalance: boolean;
    readonly canSignTransfer: boolean;
    readonly broadcastMode: string;
    readonly canRotateCredentials: boolean;
  }>;
}

export interface PersistRegisteredWalletInput {
  readonly accountId: string;
  readonly providerWalletId: string;
  readonly nearAccountId: string;
  readonly encryptedCredential: string;
  readonly keyId: string;
  readonly keyDigest: string;
  readonly handoffUrl?: string;
}

export interface AttachAddressesInput {
  readonly addresses: ReadonlyArray<{
    readonly network: string;
    readonly chainId: string;
    readonly address: string;
    readonly publicKey: string;
  }>;
  readonly capabilities: ReadonlyArray<{
    readonly network: string;
    readonly canDeriveAddress: boolean;
    readonly canReceive: boolean;
    readonly canReadNativeBalance: boolean;
    readonly canReadIntentsBalance: boolean;
    readonly canSignTransfer: boolean;
    readonly broadcastMode: string;
    readonly canRotateCredentials: boolean;
  }>;
}

export interface PublicWalletProjection {
  readonly id: string;
  readonly accountId: string;
  readonly provider: string;
  readonly providerWalletId: string;
  readonly nearAccountId: string;
  readonly status: string;
  readonly policyState: string;
  readonly controllerAccountId: string | null;
  readonly handoffUrl: string | null;
  readonly provisioningComplete: boolean;
  readonly policyVerified: boolean;
  readonly fundsReady: boolean;
  readonly canReceiveFunds: boolean;
  readonly canSignTransfers: boolean;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly addresses: ReadonlyArray<{
    readonly network: string;
    readonly chainId: string;
    readonly address: string;
    readonly publicKey: string;
  }>;
  readonly capabilities: ReadonlyArray<{
    readonly network: string;
    readonly canDeriveAddress: boolean;
    readonly canReceive: boolean;
    readonly canReadNativeBalance: boolean;
    readonly canReadIntentsBalance: boolean;
    readonly canSignTransfer: boolean;
    readonly broadcastMode: string;
  }>;
}

/**
 * Creates an initial provisioning job record for an account.
 */
export async function createProvisioningJob(
  db: FlowDb,
  accountId: string,
  idempotencyKey: string,
): Promise<ProvisioningJobRow> {
  const result = await db.$queryRaw<ProvisioningJobRow[]>`
    INSERT INTO flow.wallet_provisioning_jobs (
      account_id, idempotency_key, status, fencing_token, attempts
    ) VALUES (
      ${accountId}::uuid, ${idempotencyKey}::uuid, 'PENDING', 0, 0
    )
    RETURNING
      id, account_id AS "accountId", idempotency_key AS "idempotencyKey",
      status, fencing_token AS "fencingToken", lease_holder AS "leaseHolder",
      lease_expires_at AS "leaseExpiresAt", dispatch_attempt_id AS "dispatchAttemptId",
      dispatched_at AS "dispatchedAt", attempts, max_attempts AS "maxAttempts",
      failure_classification AS "failureClassification", last_error AS "lastError"
  `;
  const row = result[0];
  if (!row)
    throw new FlowError(
      "DATABASE_UNAVAILABLE",
      "Failed to create provisioning job.",
    );
  return row;
}

/**
 * Idempotently ensures a provisioning job record exists for an account.
 * Safe to invoke inside the personal onboarding or business creation database
 * transaction without calling external providers or blocking on wallet registration.
 */
export async function ensureProvisioningJobForAccount(
  db: FlowDb,
  accountId: string,
  idempotencyKey: string,
): Promise<ProvisioningJobRow> {
  const result = await db.$queryRaw<ProvisioningJobRow[]>`
    INSERT INTO flow.wallet_provisioning_jobs (
      account_id, idempotency_key, status, fencing_token, attempts
    ) VALUES (
      ${accountId}::uuid, ${idempotencyKey}::uuid, 'PENDING', 0, 0
    )
    ON CONFLICT (account_id) DO UPDATE
    SET account_id = EXCLUDED.account_id
    RETURNING
      id, account_id AS "accountId", idempotency_key AS "idempotencyKey",
      status, fencing_token AS "fencingToken", lease_holder AS "leaseHolder",
      lease_expires_at AS "leaseExpiresAt", dispatch_attempt_id AS "dispatchAttemptId",
      dispatched_at AS "dispatchedAt", attempts, max_attempts AS "maxAttempts",
      failure_classification AS "failureClassification", last_error AS "lastError"
  `;
  const row = result[0];
  if (!row) {
    throw new FlowError(
      "DATABASE_UNAVAILABLE",
      "Failed to ensure provisioning job for account.",
    );
  }
  return row;
}

/**
 * Atomically claims an execution lease for a provisioning job.
 * Enforces pre-dispatch retry safety: only claims if PENDING or if previous lease
 * expired BEFORE any external network dispatch occurred (dispatched_at IS NULL),
 * OR if the job is already REGISTERED, PROVISIONED, or POLICY_VERIFYING (bearer key durably persisted)
 * and lease expired during address derivation / policy verification, allowing safe
 * recovery without duplicate registration. Enforces bounded retries (`attempts < max_attempts`).
 */
export async function claimJobLease(
  db: FlowDb,
  accountId: string,
  leaseHolder: string,
  leaseDurationSeconds = 30,
): Promise<ProvisioningJobRow | null> {
  const result = await db.$queryRaw<ProvisioningJobRow[]>`
    UPDATE flow.wallet_provisioning_jobs
    SET
      status = 'LEASED',
      lease_holder = ${leaseHolder},
      lease_expires_at = CURRENT_TIMESTAMP + (${leaseDurationSeconds} * interval '1 second'),
      fencing_token = fencing_token + 1,
      attempts = attempts + 1,
      updated_at = CURRENT_TIMESTAMP
    WHERE account_id = ${accountId}::uuid
      AND attempts < max_attempts
      AND (
        (status = 'PENDING')
        OR (status = 'LEASED' AND lease_expires_at <= CURRENT_TIMESTAMP AND dispatched_at IS NULL)
        OR (status IN ('REGISTERED', 'PROVISIONED', 'POLICY_VERIFYING') AND (lease_expires_at IS NULL OR lease_expires_at <= CURRENT_TIMESTAMP))
      )
    RETURNING
      id, account_id AS "accountId", idempotency_key AS "idempotencyKey",
      status, fencing_token AS "fencingToken", lease_holder AS "leaseHolder",
      lease_expires_at AS "leaseExpiresAt", dispatch_attempt_id AS "dispatchAttemptId",
      dispatched_at AS "dispatchedAt", attempts, max_attempts AS "maxAttempts",
      failure_classification AS "failureClassification", last_error AS "lastError"
  `;

  return result[0] ?? null;
}

/**
 * Records that an external network call has been dispatched.
 * Once dispatched_at is set, expired leases will NEVER allow automatic duplicate registration.
 */
export async function recordJobDispatch(
  db: FlowDb,
  jobId: string,
  fencingToken: bigint,
  dispatchAttemptId: string,
): Promise<void> {
  const result = await db.$executeRaw`
    UPDATE flow.wallet_provisioning_jobs
    SET
      status = 'SUBMITTED',
      dispatch_attempt_id = ${dispatchAttemptId}::uuid,
      dispatched_at = CURRENT_TIMESTAMP,
      updated_at = CURRENT_TIMESTAMP
    WHERE id = ${jobId}::uuid
      AND fencing_token = ${fencingToken}
  `;

  if (result === 0) {
    throw new FlowError(
      "STALE_FENCING_TOKEN",
      `Job ${jobId} fencing token ${fencingToken} is stale or lease was revoked.`,
    );
  }
}

/**
 * Quarantines an ambiguous external outcome into the UNKNOWN state.
 * Never persists arbitrary upstream error messages; stores only allowlisted classification
 * codes, static summaries, and safe correlation metadata.
 */
export async function recordJobAmbiguous(
  db: FlowDb,
  jobId: string,
  fencingToken: bigint,
  metadataOrIgnoredError?: SafeProviderErrorMetadata | unknown,
): Promise<void> {
  const rows = await db.$queryRaw<
    Array<{ fencingToken: bigint; dispatchAttemptId: string | null }>
  >`
    SELECT fencing_token AS "fencingToken", dispatch_attempt_id AS "dispatchAttemptId"
    FROM flow.wallet_provisioning_jobs
    WHERE id = ${jobId}::uuid
  `;
  const existing = rows[0];
  if (!existing || existing.fencingToken !== fencingToken) {
    throw new FlowError(
      "STALE_FENCING_TOKEN",
      `Job ${jobId} fencing token is stale on ambiguous error recording.`,
    );
  }

  const isolatedError = formatIsolatedProviderFailure(
    "POST_DISPATCH_AMBIGUOUS",
    metadataOrIgnoredError,
    existing.dispatchAttemptId,
  );

  const result = await db.$executeRaw`
    UPDATE flow.wallet_provisioning_jobs
    SET
      status = 'UNKNOWN',
      failure_classification = 'POST_DISPATCH_AMBIGUOUS',
      last_error = ${isolatedError},
      lease_holder = NULL,
      lease_expires_at = NULL,
      updated_at = CURRENT_TIMESTAMP
    WHERE id = ${jobId}::uuid
      AND fencing_token = ${fencingToken}
  `;

  if (result === 0) {
    throw new FlowError(
      "STALE_FENCING_TOKEN",
      `Job ${jobId} fencing token is stale on ambiguous error recording.`,
    );
  }
}

/**
 * Records an explicit, terminal failure using allowlisted classifications and safe
 * correlation metadata. Never persists arbitrary upstream error messages.
 */
export async function recordJobTerminalFailure(
  db: FlowDb,
  jobId: string,
  fencingToken: bigint,
  classificationOrIgnoredError: JobFailureClassification | string,
  metadataOrClassification?:
    SafeProviderErrorMetadata | JobFailureClassification | string,
  maybeMetadata?: SafeProviderErrorMetadata,
): Promise<void> {
  const classificationCandidate =
    typeof metadataOrClassification === "string"
      ? metadataOrClassification
      : classificationOrIgnoredError;
  const metadataCandidate =
    typeof metadataOrClassification === "string"
      ? maybeMetadata
      : metadataOrClassification;

  if (!isValidJobFailureClassification(classificationCandidate)) {
    throw new FlowError(
      "INVALID_FAILURE_CLASSIFICATION",
      `Invalid failure classification '${String(classificationCandidate)}'. Must be an allowlisted classification code.`,
    );
  }

  const rows = await db.$queryRaw<
    Array<{ fencingToken: bigint; dispatchAttemptId: string | null }>
  >`
    SELECT fencing_token AS "fencingToken", dispatch_attempt_id AS "dispatchAttemptId"
    FROM flow.wallet_provisioning_jobs
    WHERE id = ${jobId}::uuid
  `;
  const existing = rows[0];
  if (!existing || existing.fencingToken !== fencingToken) {
    throw new FlowError(
      "STALE_FENCING_TOKEN",
      `Job ${jobId} fencing token is stale on failure recording.`,
    );
  }

  const isolatedError = formatIsolatedProviderFailure(
    classificationCandidate,
    metadataCandidate,
    existing.dispatchAttemptId,
  );

  const result = await db.$executeRaw`
    UPDATE flow.wallet_provisioning_jobs
    SET
      status = 'FAILED',
      failure_classification = ${classificationCandidate},
      last_error = ${isolatedError},
      lease_holder = NULL,
      lease_expires_at = NULL,
      updated_at = CURRENT_TIMESTAMP
    WHERE id = ${jobId}::uuid
      AND fencing_token = ${fencingToken}
  `;

  if (result === 0) {
    throw new FlowError(
      "STALE_FENCING_TOKEN",
      `Job ${jobId} fencing token is stale on failure recording.`,
    );
  }
}

/**
 * Stage 1: Immediately and durably saves the provider wallet ID and encrypted
 * one-time bearer credential in an atomic transaction before any address derivation
 * or policy verification is attempted.
 *
 * Enforces:
 * - Job-to-account ownership (`job.account_id === input.accountId`)
 * - Active fencing token CAS (`job.fencing_token === fencingToken`)
 * - Valid state transition (`job.status IN ('SUBMITTED', 'LEASED')`)
 * - Valid NEAR account ID format
 * - Initial wallet status is strictly `SETUP_PENDING` and `policy_state = 'none'`
 *   (callers cannot promote policy state at registration).
 */
export async function persistRegisteredWallet(
  db: FlowDb,
  jobId: string,
  fencingToken: bigint,
  input: PersistRegisteredWalletInput,
): Promise<string> {
  if (!isValidNearAddress(input.nearAccountId)) {
    throw new FlowError(
      "CUSTODY_INVALID_ADDRESS",
      "Cannot persist registered wallet: invalid NEAR account ID format.",
    );
  }

  if (
    typeof input.providerWalletId !== "string" ||
    input.providerWalletId.trim().length === 0
  ) {
    throw new FlowError(
      "CUSTODY_PROVIDER_ERROR",
      "Cannot persist registered wallet: missing providerWalletId.",
    );
  }

  return await db.$transaction(async (tx) => {
    const jobs = await tx.$queryRaw<
      Array<{
        id: string;
        accountId: string;
        status: string;
        fencingToken: bigint;
        dispatchedAt: Date | null;
      }>
    >`
      SELECT
        id, account_id AS "accountId", status, fencing_token AS "fencingToken",
        dispatched_at AS "dispatchedAt"
      FROM flow.wallet_provisioning_jobs
      WHERE id = ${jobId}::uuid
      FOR UPDATE
    `;

    const job = jobs[0];
    if (!job || job.accountId !== input.accountId) {
      throw new FlowError(
        "WALLET_ACCOUNT_MISMATCH",
        `Job ${jobId} does not belong to account ${input.accountId}.`,
      );
    }

    if (job.fencingToken !== fencingToken) {
      throw new FlowError(
        "STALE_FENCING_TOKEN",
        `Job ${jobId} fencing token ${fencingToken} is stale.`,
      );
    }

    if (job.status !== "SUBMITTED" || !job.dispatchedAt) {
      throw new FlowError(
        "INVALID_STATE_TRANSITION",
        `Job ${jobId} cannot transition to REGISTERED from status ${job.status} without recorded dispatch.`,
      );
    }

    const jobUpdate = await tx.$executeRaw`
      UPDATE flow.wallet_provisioning_jobs
      SET
        status = 'REGISTERED',
        last_error = NULL,
        failure_classification = NULL,
        updated_at = CURRENT_TIMESTAMP
      WHERE id = ${jobId}::uuid
        AND account_id = ${input.accountId}::uuid
        AND fencing_token = ${fencingToken}
        AND status = 'SUBMITTED'
    `;

    if (jobUpdate === 0) {
      throw new FlowError(
        "STALE_FENCING_TOKEN",
        `Job ${jobId} fencing token ${fencingToken} was invalidated during registration persistence.`,
      );
    }

    const safeHandoffUrl = scrubHandoffUrl(input.handoffUrl) ?? null;

    const walletResult = await tx.$queryRaw<{ id: string }[]>`
      INSERT INTO flow.wallets (
        account_id, provider, provider_wallet_id, near_account_id,
        encrypted_credential, key_id, key_digest, status, policy_state,
        controller_account_id, handoff_url, created_at, updated_at
      ) VALUES (
        ${input.accountId}::uuid, 'OUTLAYER', ${input.providerWalletId}, ${input.nearAccountId},
        ${input.encryptedCredential}, ${input.keyId}, ${input.keyDigest}, 'SETUP_PENDING'::flow.wallet_status,
        'none', NULL, ${safeHandoffUrl}, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
      )
      RETURNING id
    `;

    const wallet = walletResult[0];
    if (!wallet) {
      throw new FlowError(
        "DATABASE_UNAVAILABLE",
        "Failed to persist registered wallet record.",
      );
    }

    return wallet.id;
  });
}

/**
 * Stage 2: Attaches derived multi-chain addresses and baseline capabilities idempotently.
 *
 * Enforces:
 * - Job-to-wallet-to-account relationship (`wallet.account_id === job.account_id`)
 * - Active fencing token CAS (`job.fencing_token === fencingToken`)
 * - Valid state transition (`job.status IN ('LEASED', 'REGISTERED', 'PROVISIONED')`
 *   and `wallet.status IN ('SETUP_PENDING', 'PROVISIONING')`)
 * - Complete, format-verified addresses and capabilities for all required launch networks
 *   (`near`, `base`, `solana`) with `canReceive=false` and `canSignTransfer=false`
 * - Transitions wallet status to `PROVISIONING` (`policy_state='none'`) and job status to `PROVISIONED`.
 */
export async function attachWalletAddressesAndCapabilities(
  db: FlowDb,
  jobId: string,
  fencingToken: bigint,
  walletId: string,
  input: AttachAddressesInput,
): Promise<void> {
  await db.$transaction(async (tx) => {
    const jobs = await tx.$queryRaw<
      Array<{
        id: string;
        accountId: string;
        status: string;
        fencingToken: bigint;
      }>
    >`
      SELECT id, account_id AS "accountId", status, fencing_token AS "fencingToken"
      FROM flow.wallet_provisioning_jobs
      WHERE id = ${jobId}::uuid
      FOR UPDATE
    `;

    const wallets = await tx.$queryRaw<
      Array<{
        id: string;
        accountId: string;
        nearAccountId: string;
        status: string;
      }>
    >`
      SELECT id, account_id AS "accountId", near_account_id AS "nearAccountId", status::text AS status
      FROM flow.wallets
      WHERE id = ${walletId}::uuid
      FOR UPDATE
    `;

    const job = jobs[0];
    const wallet = wallets[0];

    if (!job || !wallet || job.accountId !== wallet.accountId) {
      throw new FlowError(
        "WALLET_ACCOUNT_MISMATCH",
        `Wallet ${walletId} does not belong to the account bound to provisioning job ${jobId}.`,
      );
    }

    if (job.fencingToken !== fencingToken) {
      throw new FlowError(
        "STALE_FENCING_TOKEN",
        `Job ${jobId} fencing token ${fencingToken} is stale on address attachment.`,
      );
    }

    if (
      job.status !== "LEASED" &&
      job.status !== "REGISTERED" &&
      job.status !== "PROVISIONED"
    ) {
      throw new FlowError(
        "INVALID_STATE_TRANSITION",
        `Cannot attach addresses for job ${jobId} in status ${job.status}.`,
      );
    }

    if (wallet.status !== "SETUP_PENDING" && wallet.status !== "PROVISIONING") {
      throw new FlowError(
        "INVALID_STATE_TRANSITION",
        `Cannot attach addresses for wallet ${walletId} in status ${wallet.status}.`,
      );
    }

    validateRequiredWalletProvisioning({
      nearAccountId: wallet.nearAccountId,
      addresses: input.addresses,
      capabilities: input.capabilities,
      policyVerified: false,
    });

    for (const addr of input.addresses) {
      await tx.$executeRaw`
        INSERT INTO flow.wallet_addresses (
          wallet_id, network, chain_id, address, public_key, created_at, updated_at
        ) VALUES (
          ${walletId}::uuid, ${addr.network}, ${addr.chainId}, ${addr.address}, ${addr.publicKey}, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
        )
        ON CONFLICT (wallet_id, network) DO UPDATE
        SET
          chain_id = EXCLUDED.chain_id,
          address = EXCLUDED.address,
          public_key = EXCLUDED.public_key,
          updated_at = CURRENT_TIMESTAMP
      `;
    }

    for (const cap of input.capabilities) {
      await tx.$executeRaw`
        INSERT INTO flow.wallet_capabilities (
          wallet_id, network, can_derive_address, can_receive,
          can_read_native_balance, can_read_intents_balance, can_sign_transfer,
          broadcast_mode, can_rotate_credentials, verified_at
        ) VALUES (
          ${walletId}::uuid, ${cap.network}, ${cap.canDeriveAddress}, false,
          ${cap.canReadNativeBalance}, ${cap.canReadIntentsBalance}, false,
          ${cap.broadcastMode}, ${cap.canRotateCredentials}, CURRENT_TIMESTAMP
        )
        ON CONFLICT (wallet_id, network) DO UPDATE
        SET
          can_derive_address = EXCLUDED.can_derive_address,
          can_receive = false,
          can_read_native_balance = EXCLUDED.can_read_native_balance,
          can_read_intents_balance = EXCLUDED.can_read_intents_balance,
          can_sign_transfer = false,
          broadcast_mode = EXCLUDED.broadcast_mode,
          can_rotate_credentials = EXCLUDED.can_rotate_credentials,
          verified_at = CURRENT_TIMESTAMP
      `;
    }

    await tx.$executeRaw`
      UPDATE flow.wallets
      SET
        status = 'PROVISIONING'::flow.wallet_status,
        policy_state = 'none',
        updated_at = CURRENT_TIMESTAMP
      WHERE id = ${walletId}::uuid
        AND account_id = ${job.accountId}::uuid
    `;

    await tx.$executeRaw`
      UPDATE flow.wallet_provisioning_jobs
      SET
        status = 'PROVISIONED',
        updated_at = CURRENT_TIMESTAMP
      WHERE id = ${jobId}::uuid
        AND account_id = ${job.accountId}::uuid
        AND fencing_token = ${fencingToken}
    `;
  });
}

/**
 * Transitions a provisioned job into `POLICY_VERIFYING` before querying `/wallet/v1/policy`.
 */
export async function startPolicyVerification(
  db: FlowDb,
  jobId: string,
  fencingToken: bigint,
  walletId: string,
): Promise<void> {
  await db.$transaction(async (tx) => {
    const jobs = await tx.$queryRaw<
      Array<{
        id: string;
        accountId: string;
        status: string;
        fencingToken: bigint;
      }>
    >`
      SELECT id, account_id AS "accountId", status, fencing_token AS "fencingToken"
      FROM flow.wallet_provisioning_jobs
      WHERE id = ${jobId}::uuid
      FOR UPDATE
    `;

    const wallets = await tx.$queryRaw<
      Array<{
        id: string;
        accountId: string;
        status: string;
      }>
    >`
      SELECT id, account_id AS "accountId", status::text AS status
      FROM flow.wallets
      WHERE id = ${walletId}::uuid
      FOR UPDATE
    `;

    const job = jobs[0];
    const wallet = wallets[0];

    if (!job || !wallet || job.accountId !== wallet.accountId) {
      throw new FlowError(
        "WALLET_ACCOUNT_MISMATCH",
        `Cannot start policy verification for wallet ${walletId}: job ${jobId} does not belong to the same account.`,
      );
    }

    if (job.fencingToken !== fencingToken) {
      throw new FlowError(
        "STALE_FENCING_TOKEN",
        `Job ${jobId} fencing token ${fencingToken} is stale on policy verification start.`,
      );
    }

    if (
      job.status !== "PROVISIONED" &&
      job.status !== "LEASED" &&
      job.status !== "POLICY_VERIFYING"
    ) {
      throw new FlowError(
        "INVALID_STATE_TRANSITION",
        `Job ${jobId} in status ${job.status} cannot transition to POLICY_VERIFYING.`,
      );
    }

    if (wallet.status !== "PROVISIONING") {
      throw new FlowError(
        "INVALID_STATE_TRANSITION",
        `Wallet ${walletId} in status ${wallet.status} cannot start policy verification; must be PROVISIONING.`,
      );
    }

    await tx.$executeRaw`
      UPDATE flow.wallet_provisioning_jobs
      SET
        status = 'POLICY_VERIFYING',
        updated_at = CURRENT_TIMESTAMP
      WHERE id = ${jobId}::uuid
        AND account_id = ${job.accountId}::uuid
        AND fencing_token = ${fencingToken}
    `;
  });
}

/**
 * Stage 3: Validates job-to-wallet-to-account binding, active fencing token,
 * tightened state transition (must be in `PROVISIONING` / `PROVISIONED` or `POLICY_VERIFYING`,
 * never directly from `SETUP_PENDING`, `PENDING`, `SUBMITTED`, or `REGISTERED`),
 * persisted multi-chain addresses/capabilities, and trusted-adapter custody policy evidence
 * before transitioning the wallet to `ACTIVE` (`policy_state='stored'`).
 *
 * NOTE: `ACTIVE` means custodial provisioning and policy verification are complete.
 * Live fund movement and fund readiness remain governed by `evaluateWalletFundReadiness()`
 * and are unconditionally blocked while `FLOW_EXECUTION=disabled`.
 */
export async function activateWalletIfReady(
  db: FlowDb,
  jobId: string,
  fencingToken: bigint,
  walletId: string,
  policyEvidence: ProviderPolicyEvidenceInput,
): Promise<void> {
  await db.$transaction(async (tx) => {
    const jobs = await tx.$queryRaw<
      Array<{
        id: string;
        accountId: string;
        status: string;
        fencingToken: bigint;
      }>
    >`
      SELECT id, account_id AS "accountId", status, fencing_token AS "fencingToken"
      FROM flow.wallet_provisioning_jobs
      WHERE id = ${jobId}::uuid
      FOR UPDATE
    `;

    const wallets = await tx.$queryRaw<
      Array<{
        id: string;
        accountId: string;
        providerWalletId: string;
        nearAccountId: string;
        status: string;
      }>
    >`
      SELECT
        id, account_id AS "accountId", provider_wallet_id AS "providerWalletId",
        near_account_id AS "nearAccountId", status::text AS status
      FROM flow.wallets
      WHERE id = ${walletId}::uuid
      FOR UPDATE
    `;

    const job = jobs[0];
    const wallet = wallets[0];

    if (!job || !wallet || job.accountId !== wallet.accountId) {
      throw new FlowError(
        "WALLET_ACCOUNT_MISMATCH",
        `Cannot activate wallet ${walletId}: job ${jobId} does not belong to the same account.`,
      );
    }

    if (job.fencingToken !== fencingToken) {
      throw new FlowError(
        "STALE_FENCING_TOKEN",
        `Job ${jobId} fencing token ${fencingToken} was invalidated before activation.`,
      );
    }

    if (
      job.status !== "PROVISIONED" &&
      job.status !== "POLICY_VERIFYING" &&
      job.status !== "LEASED"
    ) {
      throw new FlowError(
        "INVALID_STATE_TRANSITION",
        `Job ${jobId} in status ${job.status} cannot transition directly to ACTIVE. Must complete address derivation (PROVISIONED or POLICY_VERIFYING) first.`,
      );
    }

    if (wallet.status !== "PROVISIONING") {
      throw new FlowError(
        "INVALID_STATE_TRANSITION",
        `Wallet ${walletId} in status ${wallet.status} cannot transition directly to ACTIVE. Must complete Stage 2 address attachment (PROVISIONING) first.`,
      );
    }

    // 1. Verify provider-backed custody policy evidence (rejects caller-supplied strings)
    const verifiedPolicy = verifyCustodyPolicyEvidence(
      policyEvidence,
      wallet.providerWalletId,
    );

    // 2. Load and validate persisted multi-chain addresses and capabilities
    const dbAddresses = await tx.$queryRaw<
      Array<{
        network: string;
        chainId: string;
        address: string;
        publicKey: string;
      }>
    >`
      SELECT network, chain_id AS "chainId", address, public_key AS "publicKey"
      FROM flow.wallet_addresses
      WHERE wallet_id = ${walletId}::uuid
    `;

    const dbCapabilities = await tx.$queryRaw<
      Array<{
        network: string;
        canDeriveAddress: boolean;
        canReceive: boolean;
        canSignTransfer: boolean;
        broadcastMode: string;
      }>
    >`
      SELECT
        network, can_derive_address AS "canDeriveAddress", can_receive AS "canReceive",
        can_sign_transfer AS "canSignTransfer", broadcast_mode AS "broadcastMode"
      FROM flow.wallet_capabilities
      WHERE wallet_id = ${walletId}::uuid
    `;

    validateRequiredWalletProvisioning({
      nearAccountId: wallet.nearAccountId,
      addresses: dbAddresses,
      capabilities: dbCapabilities,
      policyVerified: true,
    });

    // 3. Grant receive capability now that policy is verified, keeping can_sign_transfer strictly false
    await tx.$executeRaw`
      UPDATE flow.wallet_capabilities
      SET
        can_receive = true,
        can_sign_transfer = false,
        verified_at = CURRENT_TIMESTAMP
      WHERE wallet_id = ${walletId}::uuid
    `;

    // 4. Transition wallet to ACTIVE with verified policy_state='stored' and controller_account_id
    const walletUpdate = await tx.$executeRaw`
      UPDATE flow.wallets
      SET
        status = 'ACTIVE'::flow.wallet_status,
        policy_state = ${verifiedPolicy.policyState},
        controller_account_id = ${verifiedPolicy.controllerAccountId},
        updated_at = CURRENT_TIMESTAMP
      WHERE id = ${walletId}::uuid
        AND account_id = ${job.accountId}::uuid
    `;

    if (walletUpdate === 0) {
      throw new FlowError(
        "WALLET_ACCOUNT_MISMATCH",
        `Wallet ${walletId} could not be activated for account ${job.accountId}.`,
      );
    }

    // 5. Transition job to ACTIVE and release lease
    const jobUpdate = await tx.$executeRaw`
      UPDATE flow.wallet_provisioning_jobs
      SET
        status = 'ACTIVE',
        lease_holder = NULL,
        lease_expires_at = NULL,
        last_error = NULL,
        failure_classification = NULL,
        updated_at = CURRENT_TIMESTAMP
      WHERE id = ${jobId}::uuid
        AND account_id = ${job.accountId}::uuid
        AND fencing_token = ${fencingToken}
    `;

    if (jobUpdate === 0) {
      throw new FlowError(
        "STALE_FENCING_TOKEN",
        `Job ${jobId} fencing token ${fencingToken} was invalidated during activation.`,
      );
    }
  });
}

/**
 * Commits complete wallet registration, encrypted credentials, derived addresses,
 * capabilities, and verified custody policy evidence in a single atomic transaction.
 * Enforces the exact same account-binding, fencing-token, address/capability, and
 * provider policy evidence invariants as the multi-stage pipeline.
 */
export async function commitJobSuccess(
  db: FlowDb,
  jobId: string,
  fencingToken: bigint,
  input: WalletCommitInput,
): Promise<string> {
  return await db.$transaction(async (tx) => {
    const jobs = await tx.$queryRaw<
      Array<{
        id: string;
        accountId: string;
        status: string;
        fencingToken: bigint;
      }>
    >`
      SELECT id, account_id AS "accountId", status, fencing_token AS "fencingToken"
      FROM flow.wallet_provisioning_jobs
      WHERE id = ${jobId}::uuid
      FOR UPDATE
    `;

    const job = jobs[0];
    if (!job || job.accountId !== input.accountId) {
      throw new FlowError(
        "WALLET_ACCOUNT_MISMATCH",
        `Job ${jobId} does not belong to account ${input.accountId}.`,
      );
    }

    if (job.fencingToken !== fencingToken) {
      throw new FlowError(
        "STALE_FENCING_TOKEN",
        `Job ${jobId} fencing token ${fencingToken} was invalidated before commit.`,
      );
    }

    if (
      job.status !== "SUBMITTED" &&
      job.status !== "LEASED" &&
      job.status !== "REGISTERED" &&
      job.status !== "PROVISIONED"
    ) {
      throw new FlowError(
        "INVALID_STATE_TRANSITION",
        `Job ${jobId} in status ${job.status} cannot commit wallet provisioning.`,
      );
    }

    const verifiedPolicy = verifyCustodyPolicyEvidence(
      input.policyEvidence,
      input.providerWalletId,
    );

    validateRequiredWalletProvisioning({
      nearAccountId: input.nearAccountId,
      addresses: input.addresses,
      capabilities: input.capabilities,
      policyVerified: true,
    });

    const jobUpdate = await tx.$executeRaw`
      UPDATE flow.wallet_provisioning_jobs
      SET
        status = 'ACTIVE',
        lease_holder = NULL,
        lease_expires_at = NULL,
        last_error = NULL,
        failure_classification = NULL,
        updated_at = CURRENT_TIMESTAMP
      WHERE id = ${jobId}::uuid
        AND account_id = ${input.accountId}::uuid
        AND fencing_token = ${fencingToken}
    `;

    if (jobUpdate === 0) {
      throw new FlowError(
        "STALE_FENCING_TOKEN",
        `Job ${jobId} fencing token ${fencingToken} was invalidated before commit.`,
      );
    }

    const safeHandoffUrl = scrubHandoffUrl(input.handoffUrl) ?? null;

    const walletResult = await tx.$queryRaw<{ id: string }[]>`
      INSERT INTO flow.wallets (
        account_id, provider, provider_wallet_id, near_account_id,
        encrypted_credential, key_id, key_digest, status, policy_state,
        controller_account_id, handoff_url, created_at, updated_at
      ) VALUES (
        ${input.accountId}::uuid, 'OUTLAYER', ${input.providerWalletId}, ${input.nearAccountId},
        ${input.encryptedCredential}, ${input.keyId}, ${input.keyDigest}, 'ACTIVE'::flow.wallet_status,
        ${verifiedPolicy.policyState}, ${verifiedPolicy.controllerAccountId}, ${safeHandoffUrl},
        CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
      )
      RETURNING id
    `;

    const wallet = walletResult[0];
    if (!wallet)
      throw new FlowError(
        "DATABASE_UNAVAILABLE",
        "Failed to persist wallet record.",
      );
    const walletId = wallet.id;

    for (const addr of input.addresses) {
      await tx.$executeRaw`
        INSERT INTO flow.wallet_addresses (
          wallet_id, network, chain_id, address, public_key, created_at, updated_at
        ) VALUES (
          ${walletId}::uuid, ${addr.network}, ${addr.chainId}, ${addr.address}, ${addr.publicKey}, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
        )
      `;
    }

    for (const cap of input.capabilities) {
      await tx.$executeRaw`
        INSERT INTO flow.wallet_capabilities (
          wallet_id, network, can_derive_address, can_receive,
          can_read_native_balance, can_read_intents_balance, can_sign_transfer,
          broadcast_mode, can_rotate_credentials, verified_at
        ) VALUES (
          ${walletId}::uuid, ${cap.network}, ${cap.canDeriveAddress}, true,
          ${cap.canReadNativeBalance}, ${cap.canReadIntentsBalance}, false,
          ${cap.broadcastMode}, ${cap.canRotateCredentials}, CURRENT_TIMESTAMP
        )
      `;
    }

    return walletId;
  });
}

/**
 * Reconciles expired leases after worker crashes.
 * Quarantines post-dispatch SUBMITTED/LEASED jobs (where no wallet record exists yet)
 * into UNKNOWN with an isolated structured failure record to prevent duplicate registrations.
 * For REGISTERED or PROVISIONED jobs (where the bearer key is already durably persisted),
 * clears the expired lease so a recovery worker can re-claim and complete provisioning
 * without registering another wallet.
 */
export async function reconcileCrashedJobs(db: FlowDb): Promise<number> {
  const crashedError = formatIsolatedProviderFailure(
    "POST_DISPATCH_AMBIGUOUS",
    {
      code: "POST_DISPATCH_AMBIGUOUS",
      endpoint: "/register",
    },
  );

  // 1. Quarantine ambiguous post-dispatch registration attempts where wallet was not yet persisted
  const quarantined = await db.$executeRaw`
    UPDATE flow.wallet_provisioning_jobs j
    SET
      status = 'UNKNOWN',
      failure_classification = 'POST_DISPATCH_AMBIGUOUS',
      last_error = ${crashedError},
      lease_holder = NULL,
      lease_expires_at = NULL,
      updated_at = CURRENT_TIMESTAMP
    WHERE j.status IN ('SUBMITTED', 'LEASED')
      AND j.dispatched_at IS NOT NULL
      AND j.lease_expires_at <= CURRENT_TIMESTAMP
      AND NOT EXISTS (
        SELECT 1 FROM flow.wallets w WHERE w.account_id = j.account_id
      )
  `;

  // 2. If a job was in LEASED (re-leased after REGISTERED/PROVISIONED) or REGISTERED/PROVISIONED
  // and a wallet already exists for the account, restore status to REGISTERED/PROVISIONED and clear lease
  await db.$executeRaw`
    UPDATE flow.wallet_provisioning_jobs j
    SET
      status = CASE
        WHEN EXISTS (
          SELECT 1 FROM flow.wallets w
          WHERE w.account_id = j.account_id AND w.status = 'PROVISIONING'::flow.wallet_status
        ) THEN 'PROVISIONED'
        ELSE 'REGISTERED'
      END,
      lease_holder = NULL,
      lease_expires_at = NULL,
      updated_at = CURRENT_TIMESTAMP
    WHERE j.status IN ('LEASED', 'REGISTERED', 'PROVISIONED', 'POLICY_VERIFYING')
      AND j.lease_expires_at <= CURRENT_TIMESTAMP
      AND EXISTS (
        SELECT 1 FROM flow.wallets w WHERE w.account_id = j.account_id
      )
  `;

  return quarantined;
}

/**
 * Queries a user-facing public wallet projection.
 * Strictly projects only public fields; `encrypted_credential`, `key_id`, and `key_digest`
 * are completely omitted at query time to preserve credential isolation.
 * Explicitly separates `provisioningComplete` (`status === 'ACTIVE'`) from `fundsReady`
 * (which is unconditionally `false` while `FLOW_EXECUTION=disabled`).
 */
export async function getAccountWalletPublicProjection(
  db: FlowDb,
  accountId: string,
): Promise<PublicWalletProjection | null> {
  const wallets = await db.$queryRaw<
    Array<{
      id: string;
      accountId: string;
      provider: string;
      providerWalletId: string;
      nearAccountId: string;
      status: string;
      policyState: string;
      controllerAccountId: string | null;
      handoffUrl: string | null;
      createdAt: Date;
      updatedAt: Date;
    }>
  >`
    SELECT
      id, account_id AS "accountId", provider, provider_wallet_id AS "providerWalletId",
      near_account_id AS "nearAccountId", status::text AS status, policy_state AS "policyState",
      controller_account_id AS "controllerAccountId",
      handoff_url AS "handoffUrl", created_at AS "createdAt", updated_at AS "updatedAt"
    FROM flow.wallets
    WHERE account_id = ${accountId}::uuid
  `;

  const wallet = wallets[0];
  if (!wallet) return null;

  const addresses = await db.$queryRaw<
    Array<{
      network: string;
      chainId: string;
      address: string;
      publicKey: string;
    }>
  >`
    SELECT network, chain_id AS "chainId", address, public_key AS "publicKey"
    FROM flow.wallet_addresses
    WHERE wallet_id = ${wallet.id}::uuid
  `;

  const capabilities = await db.$queryRaw<
    Array<{
      network: string;
      canDeriveAddress: boolean;
      canReceive: boolean;
      canReadNativeBalance: boolean;
      canReadIntentsBalance: boolean;
      canSignTransfer: boolean;
      broadcastMode: string;
    }>
  >`
    SELECT
      network, can_derive_address AS "canDeriveAddress", can_receive AS "canReceive",
      can_read_native_balance AS "canReadNativeBalance", can_read_intents_balance AS "canReadIntentsBalance",
      can_sign_transfer AS "canSignTransfer", broadcast_mode AS "broadcastMode"
    FROM flow.wallet_capabilities
    WHERE wallet_id = ${wallet.id}::uuid
  `;

  const policyState: OutLayerPolicyState = isValidPolicyState(
    wallet.policyState,
  )
    ? wallet.policyState
    : "unverified";

  const readiness = evaluateWalletFundReadiness({
    walletStatus: wallet.status,
    policySummary: {
      walletId: wallet.providerWalletId,
      controller: wallet.controllerAccountId ?? undefined,
      state: policyState,
      frozen: wallet.status === "FROZEN",
      allowsFinancialExecution: false,
    },
    derivedAddresses: addresses,
    capabilities,
    globalExecutionDisabled: true,
  });

  const policyVerified =
    policyState === "stored" &&
    typeof wallet.controllerAccountId === "string" &&
    isValidNearAddress(wallet.controllerAccountId);

  return {
    ...wallet,
    provisioningComplete: wallet.status === "ACTIVE" && policyVerified,
    policyVerified,
    fundsReady: readiness.isReady,
    canReceiveFunds: readiness.canReceiveFunds,
    canSignTransfers: readiness.canSignTransfers,
    addresses,
    capabilities,
  };
}

export const ALLOWED_MANUAL_REVIEW_REASON_CODES = [
  "AMBIGUOUS_REGISTRATION_OUTCOME",
  "CORRUPTED_PROVIDER_RESPONSE",
  "POLICY_VERIFICATION_ESCALATION",
  "OPERATOR_SECURITY_HOLD",
] as const;

export type ManualReviewReasonCode =
  (typeof ALLOWED_MANUAL_REVIEW_REASON_CODES)[number];

export const ALLOWED_PROVIDER_INSPECTION_SUMMARIES = [
  "NO_REMOTE_WALLET_FOUND",
  "REMOTE_WALLET_LOCATED",
  "PROVIDER_AUDIT_PENDING",
] as const;

export type ProviderInspectionSummary =
  (typeof ALLOWED_PROVIDER_INSPECTION_SUMMARIES)[number];

const OPERATOR_AUTH_ID_REGEX = /^[a-zA-Z0-9._:@-]{3,128}$/;

export interface EscalateToManualReviewInput {
  readonly jobId: string;
  readonly accountId: string;
  readonly expectedAccountKind?: "PERSONAL" | "BUSINESS";
  readonly operatorAuthId: string;
  readonly reasonCode: ManualReviewReasonCode;
  readonly providerInspectionSummary: ProviderInspectionSummary;
  readonly expectedDispatchAttemptId?: string;
  readonly requestId: string;
  readonly verifyOperatorInDatabase?: boolean;
}

/**
 * Operator-only workflow step 1: Escalates a quarantined `UNKNOWN` (or `FAILED`)
 * provisioning job into `MANUAL_REVIEW`, recording sanitized, allowlisted recovery
 * evidence in `flow.wallet_provisioning_jobs.recovery_evidence` and appending an
 * immutable audit event to `flow.security_audit_events`.
 */
export async function escalateJobToManualReview(
  db: FlowDb,
  input: EscalateToManualReviewInput,
): Promise<{ readonly jobId: string; readonly fencingToken: bigint }> {
  if (!OPERATOR_AUTH_ID_REGEX.test(input.operatorAuthId.trim())) {
    throw new FlowError(
      "INVALID_OPERATOR_IDENTITY",
      "Operator authentication identifier is missing or invalid.",
    );
  }
  if (!UUID_REGEX.test(input.requestId.trim())) {
    throw new FlowError(
      "INVALID_REQUEST_ID",
      "Recovery escalation requires a valid UUID requestId.",
    );
  }
  if (
    !(ALLOWED_MANUAL_REVIEW_REASON_CODES as readonly string[]).includes(
      input.reasonCode,
    )
  ) {
    throw new FlowError(
      "INVALID_RECOVERY_EVIDENCE",
      "Unallowlisted manual review reason code.",
    );
  }
  if (
    !(ALLOWED_PROVIDER_INSPECTION_SUMMARIES as readonly string[]).includes(
      input.providerInspectionSummary,
    )
  ) {
    throw new FlowError(
      "INVALID_RECOVERY_EVIDENCE",
      "Unallowlisted provider inspection summary.",
    );
  }

  return await db.$transaction(async (tx) => {
    const jobs = await tx.$queryRaw<
      Array<{
        id: string;
        accountId: string;
        status: string;
        fencingToken: bigint;
        dispatchAttemptId: string | null;
      }>
    >`
      SELECT
        id, account_id AS "accountId", status, fencing_token AS "fencingToken",
        dispatch_attempt_id AS "dispatchAttemptId"
      FROM flow.wallet_provisioning_jobs
      WHERE id = ${input.jobId}::uuid
      FOR UPDATE
    `;

    const job = jobs[0];
    if (!job || job.accountId !== input.accountId) {
      throw new FlowError(
        "WALLET_ACCOUNT_MISMATCH",
        `Job ${input.jobId} does not belong to account ${input.accountId}.`,
      );
    }

    if (input.verifyOperatorInDatabase) {
      const authUsers = await tx.$queryRaw<Array<{ id: string }>>`
        SELECT id FROM flow.auth_users WHERE id = ${input.operatorAuthId.trim()}
      `;
      if (!authUsers[0]) {
        throw new FlowError(
          "INVALID_OPERATOR_IDENTITY",
          `Operator ${input.operatorAuthId} is not a registered user in flow.auth_users.`,
        );
      }
    }

    if (input.expectedAccountKind !== undefined) {
      const accounts = await tx.$queryRaw<
        Array<{ id: string; kind: "PERSONAL" | "BUSINESS" }>
      >`
        SELECT id, kind::text AS kind
        FROM flow.accounts
        WHERE id = ${input.accountId}::uuid
      `;
      if (!accounts[0] || accounts[0].kind !== input.expectedAccountKind) {
        throw new FlowError(
          "WALLET_ACCOUNT_MISMATCH",
          `Account ${input.accountId} does not match expected kind ${input.expectedAccountKind}.`,
        );
      }
    }

    if (job.status !== "UNKNOWN" && job.status !== "FAILED") {
      throw new FlowError(
        "INVALID_STATE_TRANSITION",
        `Job ${input.jobId} cannot escalate to MANUAL_REVIEW from status ${job.status}.`,
      );
    }

    if (
      input.expectedDispatchAttemptId !== undefined &&
      job.dispatchAttemptId !== input.expectedDispatchAttemptId
    ) {
      throw new FlowError(
        "CUSTODY_PROVIDER_CORRELATION_ERROR",
        `Job ${input.jobId} dispatch_attempt_id does not match expected dispatch correlation ID.`,
      );
    }

    const nextFencingToken = job.fencingToken + 1n;
    const sanitizedEvidence = JSON.stringify({
      stage: "MANUAL_REVIEW_ESCALATED",
      initiatorOperatorAuthId: input.operatorAuthId.trim(),
      reasonCode: input.reasonCode,
      providerInspectionSummary: input.providerInspectionSummary,
      dispatchAttemptId: job.dispatchAttemptId,
      requestId: input.requestId.trim().toLowerCase(),
      escalatedAt: new Date().toISOString(),
    });

    await tx.$executeRaw`
      UPDATE flow.wallet_provisioning_jobs
      SET
        status = 'MANUAL_REVIEW',
        fencing_token = ${nextFencingToken},
        lease_holder = NULL,
        lease_expires_at = NULL,
        recovery_evidence = ${sanitizedEvidence},
        updated_at = CURRENT_TIMESTAMP
      WHERE id = ${input.jobId}::uuid
        AND account_id = ${input.accountId}::uuid
    `;

    await tx.$executeRaw`
      INSERT INTO flow.security_audit_events (
        kind, actor_auth_id, account_id, target_id, request_id, created_at
      ) VALUES (
        'wallet_recovery_escalated',
        ${input.operatorAuthId.trim()},
        ${input.accountId}::uuid,
        ${input.jobId},
        ${input.requestId.trim()}::uuid,
        CURRENT_TIMESTAMP
      )
    `;

    return { jobId: input.jobId, fencingToken: nextFencingToken };
  });
}

export type QuarantinedJobResolutionInput =
  | {
      readonly resolution: "ATTACH_RECOVERED_WALLET";
      readonly jobId: string;
      readonly accountId: string;
      readonly expectedAccountKind: "PERSONAL" | "BUSINESS";
      readonly expectedDispatchAttemptId: string;
      readonly initiatorOperatorAuthId: string;
      readonly approverOperatorAuthId: string;
      readonly providerWalletId: string;
      readonly nearAccountId: string;
      readonly nearPublicKey: string;
      readonly encryptedCredential: string;
      readonly keyId: string;
      readonly keyDigest: string;
      readonly handoffUrl?: string;
      readonly requestId: string;
      readonly verifyOperatorInDatabase?: boolean;
    }
  | {
      readonly resolution: "RESET_CONFIRMED_PRE_CREATION_FAILURE";
      readonly jobId: string;
      readonly accountId: string;
      readonly expectedAccountKind: "PERSONAL" | "BUSINESS";
      readonly expectedDispatchAttemptId: string;
      readonly initiatorOperatorAuthId: string;
      readonly approverOperatorAuthId: string;
      readonly requestId: string;
      readonly verifyOperatorInDatabase?: boolean;
    };

/**
 * Operator-only workflow step 2: Resolves a quarantined job in `UNKNOWN` or `MANUAL_REVIEW`
 * with mandatory two-person approval (`initiatorOperatorAuthId !== approverOperatorAuthId`),
 * account ownership and account-kind (`PERSONAL` vs. `BUSINESS`) verification, dispatch
 * attempt correlation verification, unrelated-wallet attachment prevention, cryptographic
 * NEAR public-key-to-address verification, and append-only `flow.security_audit_events` logging.
 */
export async function resolveQuarantinedProvisioningJob(
  db: FlowDb,
  input: QuarantinedJobResolutionInput,
): Promise<{
  readonly jobId: string;
  readonly status: string;
  readonly fencingToken: bigint;
  readonly walletId?: string;
}> {
  const initiator = input.initiatorOperatorAuthId.trim();
  const approver = input.approverOperatorAuthId.trim();
  if (
    !OPERATOR_AUTH_ID_REGEX.test(initiator) ||
    !OPERATOR_AUTH_ID_REGEX.test(approver)
  ) {
    throw new FlowError(
      "INVALID_OPERATOR_IDENTITY",
      "Both initiator and approver operator auth IDs must be valid non-empty identifiers.",
    );
  }
  if (initiator.toLowerCase() === approver.toLowerCase()) {
    throw new FlowError(
      "TWO_PERSON_APPROVAL_REQUIRED",
      "Quarantined wallet recovery requires two distinct operators (initiatorOperatorAuthId !== approverOperatorAuthId).",
    );
  }
  if (!UUID_REGEX.test(input.requestId.trim())) {
    throw new FlowError(
      "INVALID_REQUEST_ID",
      "Recovery resolution requires a valid UUID requestId.",
    );
  }
  if (!UUID_REGEX.test(input.expectedDispatchAttemptId.trim())) {
    throw new FlowError(
      "CUSTODY_PROVIDER_CORRELATION_ERROR",
      "Recovery resolution requires a valid UUID expectedDispatchAttemptId.",
    );
  }

  return await db.$transaction(async (tx) => {
    const accounts = await tx.$queryRaw<
      Array<{ id: string; kind: "PERSONAL" | "BUSINESS" }>
    >`
      SELECT id, kind::text AS kind
      FROM flow.accounts
      WHERE id = ${input.accountId}::uuid
    `;
    const account = accounts[0];
    if (!account || account.kind !== input.expectedAccountKind) {
      throw new FlowError(
        "WALLET_ACCOUNT_MISMATCH",
        `Target account ${input.accountId} does not exist or does not match expected kind ${input.expectedAccountKind}.`,
      );
    }

    const jobs = await tx.$queryRaw<
      Array<{
        id: string;
        accountId: string;
        status: string;
        fencingToken: bigint;
        dispatchAttemptId: string | null;
        dispatchedAt: Date | null;
        recoveryEvidence: string | null;
      }>
    >`
      SELECT
        id, account_id AS "accountId", status, fencing_token AS "fencingToken",
        dispatch_attempt_id AS "dispatchAttemptId", dispatched_at AS "dispatchedAt",
        recovery_evidence AS "recoveryEvidence"
      FROM flow.wallet_provisioning_jobs
      WHERE id = ${input.jobId}::uuid
      FOR UPDATE
    `;

    const job = jobs[0];
    if (!job || job.accountId !== input.accountId) {
      throw new FlowError(
        "WALLET_ACCOUNT_MISMATCH",
        `Job ${input.jobId} does not belong to account ${input.accountId}.`,
      );
    }

    if (input.verifyOperatorInDatabase) {
      const authUsers = await tx.$queryRaw<Array<{ id: string }>>`
        SELECT id FROM flow.auth_users WHERE id = ${initiator} OR id = ${approver}
      `;
      const foundIds = new Set(authUsers.map((u) => u.id));
      if (!foundIds.has(initiator) || !foundIds.has(approver)) {
        throw new FlowError(
          "INVALID_OPERATOR_IDENTITY",
          "Both initiator and approver must be registered users in flow.auth_users.",
        );
      }
    }

    if (input.expectedAccountKind !== undefined) {
      const accounts = await tx.$queryRaw<
        Array<{ id: string; kind: "PERSONAL" | "BUSINESS" }>
      >`
        SELECT id, kind::text AS kind
        FROM flow.accounts
        WHERE id = ${input.accountId}::uuid
      `;
      if (!accounts[0] || accounts[0].kind !== input.expectedAccountKind) {
        throw new FlowError(
          "WALLET_ACCOUNT_MISMATCH",
          `Account ${input.accountId} does not match expected kind ${input.expectedAccountKind}.`,
        );
      }
    }

    if (job.status !== "UNKNOWN" && job.status !== "MANUAL_REVIEW") {
      throw new FlowError(
        "INVALID_STATE_TRANSITION",
        `Operator recovery can only resolve jobs in UNKNOWN or MANUAL_REVIEW, not ${job.status}.`,
      );
    }

    if (
      !job.dispatchedAt ||
      !job.dispatchAttemptId ||
      job.dispatchAttemptId.toLowerCase() !==
        input.expectedDispatchAttemptId.trim().toLowerCase()
    ) {
      throw new FlowError(
        "CUSTODY_PROVIDER_CORRELATION_ERROR",
        `Job ${input.jobId} dispatch_attempt_id does not match expectedDispatchAttemptId.`,
      );
    }

    // If previously escalated, enforce that approver is not the escalation initiator
    let previousInspectionSummary: string | undefined;
    if (job.recoveryEvidence) {
      try {
        const parsedPrev = JSON.parse(job.recoveryEvidence) as Record<
          string,
          unknown
        >;
        if (
          typeof parsedPrev.initiatorOperatorAuthId === "string" &&
          parsedPrev.initiatorOperatorAuthId.trim().toLowerCase() ===
            approver.toLowerCase()
        ) {
          throw new FlowError(
            "TWO_PERSON_APPROVAL_REQUIRED",
            "Approver operator cannot be the same operator who initiated manual review escalation.",
          );
        }
        if (typeof parsedPrev.providerInspectionSummary === "string") {
          previousInspectionSummary = parsedPrev.providerInspectionSummary;
        }
      } catch (err) {
        if (err instanceof FlowError) throw err;
      }
    }

    const nextFencingToken = job.fencingToken + 1n;

    if (input.resolution === "ATTACH_RECOVERED_WALLET") {
      if (
        !UUID_REGEX.test(input.providerWalletId.trim()) ||
        !isValidNearAddress(input.nearAccountId)
      ) {
        throw new FlowError(
          "CUSTODY_INVALID_ADDRESS",
          "Recovered wallet requires a valid UUID providerWalletId and valid NEAR account ID.",
        );
      }

      const keyCheck = verifyPublicKeyMatchesAddress(
        "near",
        input.nearAccountId,
        input.nearPublicKey,
        { strict: true },
      );
      if (!keyCheck.valid || !keyCheck.verifiedCryptographically) {
        throw new FlowError(
          "CUSTODY_INVALID_ADDRESS",
          `Recovered NEAR public key is not cryptographically consistent with NEAR address: ${keyCheck.error ?? "unverified"}`,
        );
      }

      // Prevent attaching a wallet that is already bound to ANY account (or if target account already has a wallet)
      const conflictingWallets = await tx.$queryRaw<
        Array<{ id: string; accountId: string }>
      >`
        SELECT id, account_id AS "accountId"
        FROM flow.wallets
        WHERE account_id = ${input.accountId}::uuid
           OR provider_wallet_id = ${input.providerWalletId.trim()}
           OR lower(near_account_id) = lower(${input.nearAccountId.trim()})
      `;
      if (conflictingWallets.length > 0) {
        throw new FlowError(
          "WALLET_ACCOUNT_MISMATCH",
          "Cannot attach recovered wallet: provider_wallet_id, near_account_id, or target account is already bound to an existing wallet.",
        );
      }

      const safeHandoffUrl = scrubHandoffUrl(input.handoffUrl) ?? null;
      const insertedWallets = await tx.$queryRaw<Array<{ id: string }>>`
        INSERT INTO flow.wallets (
          account_id, provider, provider_wallet_id, near_account_id,
          encrypted_credential, key_id, key_digest, status, policy_state,
          controller_account_id, handoff_url, created_at, updated_at
        ) VALUES (
          ${input.accountId}::uuid, 'OUTLAYER', ${input.providerWalletId.trim()}, ${input.nearAccountId.trim().toLowerCase()},
          ${input.encryptedCredential}, ${input.keyId}, ${input.keyDigest}, 'SETUP_PENDING'::flow.wallet_status,
          'none', NULL, ${safeHandoffUrl}, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
        )
        RETURNING id
      `;
      const wallet = insertedWallets[0];
      if (!wallet) {
        throw new FlowError(
          "DATABASE_UNAVAILABLE",
          "Failed to persist recovered wallet.",
        );
      }

      const resolutionEvidence = JSON.stringify({
        stage: "RESOLVED_ATTACH_WALLET",
        resolution: input.resolution,
        accountKind: account.kind,
        initiatorOperatorAuthId: initiator,
        approverOperatorAuthId: approver,
        dispatchAttemptId: job.dispatchAttemptId,
        providerWalletId: input.providerWalletId.trim(),
        walletId: wallet.id,
        requestId: input.requestId.trim().toLowerCase(),
        resolvedAt: new Date().toISOString(),
      });

      await tx.$executeRaw`
        UPDATE flow.wallet_provisioning_jobs
        SET
          status = 'REGISTERED',
          fencing_token = ${nextFencingToken},
          lease_holder = NULL,
          lease_expires_at = NULL,
          last_error = NULL,
          failure_classification = NULL,
          recovery_evidence = ${resolutionEvidence},
          updated_at = CURRENT_TIMESTAMP
        WHERE id = ${input.jobId}::uuid
          AND account_id = ${input.accountId}::uuid
      `;

      await tx.$executeRaw`
        INSERT INTO flow.security_audit_events (
          kind, actor_auth_id, account_id, target_id, request_id, created_at
        ) VALUES
          (
            'wallet_recovery_initiated',
            ${initiator},
            ${input.accountId}::uuid,
            ${wallet.id},
            ${input.requestId.trim()}::uuid,
            CURRENT_TIMESTAMP
          ),
          (
            'wallet_recovery_approved_attach',
            ${approver},
            ${input.accountId}::uuid,
            ${wallet.id},
            ${input.requestId.trim()}::uuid,
            CURRENT_TIMESTAMP
          )
      `;

      return {
        jobId: input.jobId,
        status: "REGISTERED",
        fencingToken: nextFencingToken,
        walletId: wallet.id,
      };
    }

    // Resolution Mode B: RESET_CONFIRMED_PRE_CREATION_FAILURE
    if (
      job.status !== "MANUAL_REVIEW" ||
      previousInspectionSummary !== "NO_REMOTE_WALLET_FOUND"
    ) {
      throw new FlowError(
        "INVALID_STATE_TRANSITION",
        "Resetting a quarantined job to PENDING requires prior escalation to MANUAL_REVIEW with providerInspectionSummary='NO_REMOTE_WALLET_FOUND'.",
      );
    }

    const existingWallets = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT id FROM flow.wallets WHERE account_id = ${input.accountId}::uuid
    `;
    if (existingWallets.length > 0) {
      throw new FlowError(
        "INVALID_STATE_TRANSITION",
        "Cannot reset job to PENDING when a wallet record already exists for the account.",
      );
    }

    const resetEvidence = JSON.stringify({
      stage: "RESOLVED_RESET_PRE_CREATION",
      resolution: input.resolution,
      accountKind: account.kind,
      initiatorOperatorAuthId: initiator,
      approverOperatorAuthId: approver,
      previousDispatchAttemptId: job.dispatchAttemptId,
      requestId: input.requestId.trim().toLowerCase(),
      resolvedAt: new Date().toISOString(),
    });

    await tx.$executeRaw`
      UPDATE flow.wallet_provisioning_jobs
      SET
        status = 'PENDING',
        fencing_token = ${nextFencingToken},
        lease_holder = NULL,
        lease_expires_at = NULL,
        dispatched_at = NULL,
        dispatch_attempt_id = NULL,
        last_error = NULL,
        failure_classification = NULL,
        recovery_evidence = ${resetEvidence},
        updated_at = CURRENT_TIMESTAMP
      WHERE id = ${input.jobId}::uuid
        AND account_id = ${input.accountId}::uuid
    `;

    await tx.$executeRaw`
      INSERT INTO flow.security_audit_events (
        kind, actor_auth_id, account_id, target_id, request_id, created_at
      ) VALUES
        (
          'wallet_recovery_initiated',
          ${initiator},
          ${input.accountId}::uuid,
          ${input.jobId},
          ${input.requestId.trim()}::uuid,
          CURRENT_TIMESTAMP
        ),
        (
          'wallet_recovery_approved_reset',
          ${approver},
          ${input.accountId}::uuid,
          ${input.jobId},
          ${input.requestId.trim()}::uuid,
          CURRENT_TIMESTAMP
        )
    `;

    return {
      jobId: input.jobId,
      status: "PENDING",
      fencingToken: nextFencingToken,
    };
  });
}

/**
 * Asserts that an operator authentication identifier exists as an active user in `flow.auth_users`.
 * Used by administrative controllers to reject fabricated or unauthenticated operator identifiers.
 */
export async function assertOperatorIdentityRegistered(
  db: FlowDb,
  operatorAuthId: string,
): Promise<void> {
  const trimmed = operatorAuthId.trim();
  if (!OPERATOR_AUTH_ID_REGEX.test(trimmed)) {
    throw new FlowError(
      "INVALID_OPERATOR_IDENTITY",
      "Operator authentication identifier format is invalid.",
    );
  }
  const users = await db.$queryRaw<Array<{ id: string }>>`
    SELECT id FROM flow.auth_users WHERE id = ${trimmed}
  `;
  if (!users[0]) {
    throw new FlowError(
      "INVALID_OPERATOR_IDENTITY",
      `Operator ${trimmed} is not a registered user in flow.auth_users.`,
    );
  }
}

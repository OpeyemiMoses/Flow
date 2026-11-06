import { FlowError } from "../../foundation/errors.ts";
import type { FlowDb } from "../../foundation/prisma.ts";

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
  readonly policyState?: "none" | "stored";
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
 * Atomically claims an execution lease for a provisioning job.
 * Enforces pre-dispatch retry safety: only claims if PENDING or if previous lease
 * expired BEFORE any external network dispatch occurred (dispatched_at IS NULL).
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
      AND (
        (status = 'PENDING')
        OR (status = 'LEASED' AND lease_expires_at <= CURRENT_TIMESTAMP AND dispatched_at IS NULL)
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
 */
export async function recordJobAmbiguous(
  db: FlowDb,
  jobId: string,
  fencingToken: bigint,
  error: string,
): Promise<void> {
  const result = await db.$executeRaw`
    UPDATE flow.wallet_provisioning_jobs
    SET
      status = 'UNKNOWN',
      failure_classification = 'POST_DISPATCH_AMBIGUOUS',
      last_error = ${error},
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
 * Records an explicit, terminal failure (e.g. 400 bad request, 429 rate limit).
 */
export async function recordJobTerminalFailure(
  db: FlowDb,
  jobId: string,
  fencingToken: bigint,
  error: string,
  classification: string,
): Promise<void> {
  const result = await db.$executeRaw`
    UPDATE flow.wallet_provisioning_jobs
    SET
      status = 'FAILED',
      failure_classification = ${classification},
      last_error = ${error},
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
 * Commits successful wallet registration, encrypted credentials, derived addresses,
 * and capabilities in a single short transaction, verifying the fencing token.
 */
export async function commitJobSuccess(
  db: FlowDb,
  jobId: string,
  fencingToken: bigint,
  input: WalletCommitInput,
): Promise<string> {
  // 1. Verify fencing token & update job status
  const jobUpdate = await db.$executeRaw`
    UPDATE flow.wallet_provisioning_jobs
    SET
      status = 'ACTIVE',
      lease_holder = NULL,
      lease_expires_at = NULL,
      last_error = NULL,
      updated_at = CURRENT_TIMESTAMP
    WHERE id = ${jobId}::uuid
      AND fencing_token = ${fencingToken}
  `;

  if (jobUpdate === 0) {
    throw new FlowError(
      "STALE_FENCING_TOKEN",
      `Job ${jobId} fencing token ${fencingToken} was invalidated before commit.`,
    );
  }

  // 2. Insert wallet record
  const walletResult = await db.$queryRaw<{ id: string }[]>`
    INSERT INTO flow.wallets (
      account_id, provider, provider_wallet_id, near_account_id,
      encrypted_credential, key_id, key_digest, status, policy_state,
      handoff_url, created_at, updated_at
    ) VALUES (
      ${input.accountId}::uuid, 'OUTLAYER', ${input.providerWalletId}, ${input.nearAccountId},
      ${input.encryptedCredential}, ${input.keyId}, ${input.keyDigest}, 'ACTIVE'::flow.wallet_status,
      ${input.policyState ?? "none"}, ${input.handoffUrl ?? null}, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
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

  // 3. Insert multi-chain addresses
  for (const addr of input.addresses) {
    await db.$executeRaw`
      INSERT INTO flow.wallet_addresses (
        wallet_id, network, chain_id, address, public_key, created_at, updated_at
      ) VALUES (
        ${walletId}::uuid, ${addr.network}, ${addr.chainId}, ${addr.address}, ${addr.publicKey}, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
      )
    `;
  }

  // 4. Insert network capabilities
  for (const cap of input.capabilities) {
    await db.$executeRaw`
      INSERT INTO flow.wallet_capabilities (
        wallet_id, network, can_derive_address, can_receive,
        can_read_native_balance, can_read_intents_balance, can_sign_transfer,
        broadcast_mode, can_rotate_credentials, verified_at
      ) VALUES (
        ${walletId}::uuid, ${cap.network}, ${cap.canDeriveAddress}, ${cap.canReceive},
        ${cap.canReadNativeBalance}, ${cap.canReadIntentsBalance}, ${cap.canSignTransfer},
        ${cap.broadcastMode}, ${cap.canRotateCredentials}, CURRENT_TIMESTAMP
      )
    `;
  }

  return walletId;
}

/**
 * Reconciles expired leases after worker crashes.
 * Quarantines any post-dispatch leases into UNKNOWN to prevent duplicate registrations.
 */
export async function reconcileCrashedJobs(db: FlowDb): Promise<number> {
  const quarantined = await db.$executeRaw`
    UPDATE flow.wallet_provisioning_jobs
    SET
      status = 'UNKNOWN',
      failure_classification = 'POST_DISPATCH_AMBIGUOUS',
      last_error = 'Worker crashed or lease expired after external dispatch',
      lease_holder = NULL,
      lease_expires_at = NULL,
      updated_at = CURRENT_TIMESTAMP
    WHERE status IN ('SUBMITTED', 'LEASED')
      AND dispatched_at IS NOT NULL
      AND lease_expires_at <= CURRENT_TIMESTAMP
  `;

  return quarantined;
}

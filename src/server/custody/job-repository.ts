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

export interface PersistRegisteredWalletInput {
  readonly accountId: string;
  readonly providerWalletId: string;
  readonly nearAccountId: string;
  readonly encryptedCredential: string;
  readonly keyId: string;
  readonly keyDigest: string;
  readonly handoffUrl?: string;
  readonly policyState?: "none" | "stored";
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
  readonly handoffUrl: string | null;
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

function sanitizeErrorMessage(msg: string): string {
  return msg
    .replace(/\bwk_[\w-]+/g, "[REDACTED_API_KEY]")
    .replace(/<[^>]*>/g, "")
    .trim()
    .slice(0, 500);
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
 * expired BEFORE any external network dispatch occurred (dispatched_at IS NULL),
 * OR if the job is already REGISTERED (bearer key durably persisted) and lease expired
 * during address derivation, allowing safe recovery without duplicate registration.
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
        OR (status = 'REGISTERED' AND (lease_expires_at IS NULL OR lease_expires_at <= CURRENT_TIMESTAMP))
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
 * Sanitizes the error message to prevent arbitrary HTML or sensitive tokens from leaking.
 */
export async function recordJobAmbiguous(
  db: FlowDb,
  jobId: string,
  fencingToken: bigint,
  error: string,
): Promise<void> {
  const sanitized = sanitizeErrorMessage(error);
  const result = await db.$executeRaw`
    UPDATE flow.wallet_provisioning_jobs
    SET
      status = 'UNKNOWN',
      failure_classification = 'POST_DISPATCH_AMBIGUOUS',
      last_error = ${sanitized},
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
 * Sanitizes the error message.
 */
export async function recordJobTerminalFailure(
  db: FlowDb,
  jobId: string,
  fencingToken: bigint,
  error: string,
  classification: string,
): Promise<void> {
  const sanitized = sanitizeErrorMessage(error);
  const result = await db.$executeRaw`
    UPDATE flow.wallet_provisioning_jobs
    SET
      status = 'FAILED',
      failure_classification = ${classification},
      last_error = ${sanitized},
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
 * Sets wallet status to SETUP_PENDING and advances job to REGISTERED.
 */
export async function persistRegisteredWallet(
  db: FlowDb,
  jobId: string,
  fencingToken: bigint,
  input: PersistRegisteredWalletInput,
): Promise<string> {
  return await db.$transaction(async (tx) => {
    // 1. Verify fencing token and advance job to REGISTERED
    const jobUpdate = await tx.$executeRaw`
      UPDATE flow.wallet_provisioning_jobs
      SET
        status = 'REGISTERED',
        last_error = NULL,
        updated_at = CURRENT_TIMESTAMP
      WHERE id = ${jobId}::uuid
        AND fencing_token = ${fencingToken}
        AND status IN ('SUBMITTED', 'LEASED')
    `;

    if (jobUpdate === 0) {
      throw new FlowError(
        "STALE_FENCING_TOKEN",
        `Job ${jobId} fencing token ${fencingToken} was invalidated or job not in valid registration state.`,
      );
    }

    // 2. Insert wallet record with status 'SETUP_PENDING'
    const walletResult = await tx.$queryRaw<{ id: string }[]>`
      INSERT INTO flow.wallets (
        account_id, provider, provider_wallet_id, near_account_id,
        encrypted_credential, key_id, key_digest, status, policy_state,
        handoff_url, created_at, updated_at
      ) VALUES (
        ${input.accountId}::uuid, 'OUTLAYER', ${input.providerWalletId}, ${input.nearAccountId},
        ${input.encryptedCredential}, ${input.keyId}, ${input.keyDigest}, 'SETUP_PENDING'::flow.wallet_status,
        ${input.policyState ?? "none"}, ${input.handoffUrl ?? null}, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
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
 * Stage 2: Attaches derived multi-chain addresses and capabilities idempotently.
 */
export async function attachWalletAddressesAndCapabilities(
  db: FlowDb,
  walletId: string,
  input: AttachAddressesInput,
): Promise<void> {
  await db.$transaction(async (tx) => {
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
          ${walletId}::uuid, ${cap.network}, ${cap.canDeriveAddress}, ${cap.canReceive},
          ${cap.canReadNativeBalance}, ${cap.canReadIntentsBalance}, ${cap.canSignTransfer},
          ${cap.broadcastMode}, ${cap.canRotateCredentials}, CURRENT_TIMESTAMP
        )
        ON CONFLICT (wallet_id, network) DO UPDATE
        SET
          can_derive_address = EXCLUDED.can_derive_address,
          can_receive = EXCLUDED.can_receive,
          can_read_native_balance = EXCLUDED.can_read_native_balance,
          can_read_intents_balance = EXCLUDED.can_read_intents_balance,
          can_sign_transfer = EXCLUDED.can_sign_transfer,
          broadcast_mode = EXCLUDED.broadcast_mode,
          can_rotate_credentials = EXCLUDED.can_rotate_credentials,
          verified_at = CURRENT_TIMESTAMP
      `;
    }
  });
}

/**
 * Stage 3: Evaluates policy/address readiness and transitions wallet to ACTIVE status.
 */
export async function activateWalletIfReady(
  db: FlowDb,
  jobId: string,
  fencingToken: bigint,
  walletId: string,
  policyState = "none",
): Promise<void> {
  await db.$transaction(async (tx) => {
    const jobUpdate = await tx.$executeRaw`
      UPDATE flow.wallet_provisioning_jobs
      SET
        status = 'ACTIVE',
        lease_holder = NULL,
        lease_expires_at = NULL,
        last_error = NULL,
        updated_at = CURRENT_TIMESTAMP
      WHERE id = ${jobId}::uuid
        AND fencing_token = ${fencingToken}
        AND status IN ('LEASED', 'REGISTERED')
    `;

    if (jobUpdate === 0) {
      throw new FlowError(
        "STALE_FENCING_TOKEN",
        `Job ${jobId} fencing token ${fencingToken} was invalidated before activation.`,
      );
    }

    const walletUpdate = await tx.$executeRaw`
      UPDATE flow.wallets
      SET
        status = 'ACTIVE'::flow.wallet_status,
        policy_state = ${policyState},
        updated_at = CURRENT_TIMESTAMP
      WHERE id = ${walletId}::uuid
    `;

    if (walletUpdate === 0) {
      throw new FlowError(
        "DATABASE_UNAVAILABLE",
        `Wallet ${walletId} not found for activation.`,
      );
    }
  });
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
  return await db.$transaction(async (tx) => {
    // 1. Verify fencing token & update job status
    const jobUpdate = await tx.$executeRaw`
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
    const walletResult = await tx.$queryRaw<{ id: string }[]>`
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
      await tx.$executeRaw`
        INSERT INTO flow.wallet_addresses (
          wallet_id, network, chain_id, address, public_key, created_at, updated_at
        ) VALUES (
          ${walletId}::uuid, ${addr.network}, ${addr.chainId}, ${addr.address}, ${addr.publicKey}, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
        )
      `;
    }

    // 4. Insert network capabilities
    for (const cap of input.capabilities) {
      await tx.$executeRaw`
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
  });
}

/**
 * Reconciles expired leases after worker crashes.
 * Quarantines post-dispatch SUBMITTED/LEASED jobs into UNKNOWN to prevent duplicate registrations.
 * For REGISTERED jobs (where bearer key is already durably persisted), clears the expired lease
 * so a recovery worker can re-claim and complete address derivation without duplicate registration.
 */
export async function reconcileCrashedJobs(db: FlowDb): Promise<number> {
  // 1. Quarantine ambiguous post-dispatch registration attempts
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

  // 2. Clear expired leases on REGISTERED jobs to allow safe resumption of address derivation
  await db.$executeRaw`
    UPDATE flow.wallet_provisioning_jobs
    SET
      lease_holder = NULL,
      lease_expires_at = NULL,
      updated_at = CURRENT_TIMESTAMP
    WHERE status = 'REGISTERED'
      AND lease_expires_at <= CURRENT_TIMESTAMP
  `;

  return quarantined;
}

/**
 * Queries a user-facing public wallet projection.
 * Strictly projects only public fields; encrypted_credential, key_id, and key_digest
 * are completely omitted at query time to preserve credential isolation.
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
      handoffUrl: string | null;
      createdAt: Date;
      updatedAt: Date;
    }>
  >`
    SELECT
      id, account_id AS "accountId", provider, provider_wallet_id AS "providerWalletId",
      near_account_id AS "nearAccountId", status, policy_state AS "policyState",
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

  return {
    ...wallet,
    addresses,
    capabilities,
  };
}

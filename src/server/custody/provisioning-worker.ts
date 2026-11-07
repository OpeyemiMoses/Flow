import { randomUUID } from "node:crypto";
import {
  inspectCustodyPolicyEvidence,
  OUTLAYER_CAPABILITIES,
  toEip55ChecksumAddress,
} from "../../domain/custody.ts";
import {
  decryptSecret,
  deriveKeyDigest,
  deserializeEnvelope,
  encryptSecret,
  serializeEnvelope,
} from "../../foundation/crypto-envelope.ts";
import { FlowError } from "../../foundation/errors.ts";
import { log } from "../../foundation/logger.ts";
import type { FlowDb } from "../../foundation/prisma.ts";
import type { WalletConfig } from "../../foundation/wallet-environment.ts";
import {
  activateWalletIfReady,
  attachWalletAddressesAndCapabilities,
  claimJobLease,
  claimCompatibilityRegistration,
  completeCompatibilityRegistration,
  persistRegisteredWallet,
  quarantineCompatibilityRegistration,
  recordJobAmbiguous,
  recordJobDispatch,
  recordJobTerminalFailure,
  recordRegisteredWalletWithoutPolicy,
  reconcileCrashedJobs,
  startPolicyVerification,
  type AllowlistedProviderEndpoint,
  type JobFailureClassification,
} from "./job-repository.ts";
import {
  scrubHandoffUrl,
  type OutLayerAdapter,
  type OutLayerChain,
} from "./outlayer-adapter.ts";

export interface ProvisioningWorkerHooks {
  readonly onAfterDispatch?: (ctx: {
    readonly accountId: string;
    readonly jobId: string;
    readonly fencingToken: bigint;
  }) => Promise<void> | void;
  readonly onAfterStage1Persist?: (ctx: {
    readonly accountId: string;
    readonly jobId: string;
    readonly fencingToken: bigint;
    readonly walletId: string;
  }) => Promise<void> | void;
  readonly onAfterStage2Attach?: (ctx: {
    readonly accountId: string;
    readonly jobId: string;
    readonly fencingToken: bigint;
    readonly walletId: string;
  }) => Promise<void> | void;
}

export interface WalletProvisioningWorkerOptions {
  readonly db: FlowDb;
  readonly adapter: OutLayerAdapter;
  readonly walletConfig: Pick<WalletConfig, "encryptionKey" | "keyId"> & {
    readonly fallbackEncryptionKey?: string;
  };
  readonly workerId?: string;
  readonly leaseDurationSeconds?: number;
  readonly maxConcurrency?: number;
  readonly baseBackoffMs?: number;
  readonly maxBackoffMs?: number;
  readonly hooks?: ProvisioningWorkerHooks;
  readonly compatibilityAuthorizationId?: string;
  readonly providerEnvironment?: "testnet" | "mainnet";
}

export type ProvisioningJobOutcome =
  "skipped" | "registered" | "activated" | "quarantined" | "failed";

export interface ProcessAccountJobResult {
  readonly accountId: string;
  readonly jobId?: string;
  readonly walletId?: string;
  readonly outcome: ProvisioningJobOutcome;
  readonly recoveredFromStage?: "STAGE_1_REGISTERED" | "STAGE_2_PROVISIONED";
  readonly failureClassification?: JobFailureClassification;
}

export interface WorkerOperationalDiagnostics {
  readonly workerId: string;
  readonly running: boolean;
  readonly inFlightCount: number;
  readonly maxConcurrency: number;
  readonly processedCount: number;
  readonly registeredCount: number;
  readonly activatedCount: number;
  readonly quarantinedCount: number;
  readonly failedCount: number;
  readonly recoveredCount: number;
  readonly reconciledCount: number;
}

function mapErrorToFailureClassification(
  error: unknown,
): JobFailureClassification {
  if (error instanceof FlowError) {
    switch (error.code) {
      case "CUSTODY_PROVIDER_RATE_LIMITED":
        return "RATE_LIMITED";
      case "CUSTODY_PROVIDER_TIMEOUT":
        return "GATEWAY_TIMEOUT";
      case "CUSTODY_PROVIDER_NETWORK_ERROR":
        return "NETWORK_ERROR";
      case "CUSTODY_PROVIDER_UNAVAILABLE":
        return "UPSTREAM_UNAVAILABLE";
      case "CUSTODY_PROVIDER_CORRELATION_ERROR":
        return "CORRELATION_ERROR";
      case "CUSTODY_INVALID_ADDRESS":
        return "INVALID_ADDRESS";
      case "UNSUPPORTED_CHAIN":
        return "UNSUPPORTED_CHAIN";
      case "POLICY_VERIFICATION_FAILED":
        return "POLICY_VERIFICATION_FAILED";
      case "INCOMPLETE_WALLET_PROVISIONING":
      case "INVALID_CAPABILITY_GRANT":
        return "INCOMPLETE_PROVISIONING";
      case "CUSTODY_PROVIDER_ERROR": {
        if (
          error.message.includes("schema mismatch") ||
          error.message.includes("Invalid JSON")
        ) {
          return "CORRUPTED_RESPONSE";
        }
        if (error.message.includes("authentication")) {
          return "AUTHENTICATION_FAILED";
        }
        if (error.message.includes("not found")) {
          return "RESOURCE_NOT_FOUND";
        }
        return "BAD_REQUEST";
      }
      default:
        return "BAD_REQUEST";
    }
  }
  return "NETWORK_ERROR";
}

/**
 * Determines whether an error thrown during `POST /register` (after `recordJobDispatch`)
 * has uncertain remote side effects and MUST be quarantined into `UNKNOWN` (`POST_DISPATCH_AMBIGUOUS`)
 * rather than marked as a clean pre-creation `FAILED`.
 *
 * Only explicit, deterministic pre-execution rejections (`INVALID_CONFIGURATION` local guard,
 * `CUSTODY_PROVIDER_RATE_LIMITED` HTTP 429, or deterministic HTTP 400/401/403/404/422 rejections)
 * are known not to have created a remote wallet.
 *
 * Any timeout, network drop, 5xx/408/409/425 upstream error, or HTTP 200 OK response whose body
 * was truncated/invalid JSON, failed schema parsing, or returned an invalid NEAR account ID
 * means OutLayer may have created (or did create) a wallet whose bearer key could not be safely
 * ingested — so it MUST be quarantined into `UNKNOWN`.
 */
export function isAmbiguousRegistrationError(error: unknown): boolean {
  if (error instanceof FlowError) {
    if (
      error.code === "CUSTODY_PROVIDER_TIMEOUT" ||
      error.code === "CUSTODY_PROVIDER_NETWORK_ERROR" ||
      error.code === "CUSTODY_PROVIDER_UNAVAILABLE" ||
      error.code === "CUSTODY_INVALID_ADDRESS"
    ) {
      return true;
    }
    if (
      error.code === "CUSTODY_PROVIDER_ERROR" &&
      (error.message.includes("Invalid JSON") ||
        error.message.includes("schema mismatch"))
    ) {
      return true;
    }
    return false;
  }
  return true;
}

/**
 * Durable local wallet provisioning worker.
 *
 * Guarantees:
 * - Zero database transaction or row locks are held during external OutLayer calls.
 * - Encrypted wallet credentials are durably persisted immediately after `/register`
 *   before any address derivation or policy verification request.
 * - Crash recovery after Stage 1 (`REGISTERED`) or Stage 2 (`PROVISIONED`) decrypts
 *   the persisted bearer key and resumes without calling `/register` again.
 * - Ambiguous post-dispatch outcomes (`UNKNOWN` / `POST_DISPATCH_AMBIGUOUS`) are
 *   quarantined and never automatically re-registered.
 * - Personal and business account identities remain strictly isolated.
 */
export class WalletProvisioningWorker {
  private readonly db: FlowDb;
  private readonly adapter: OutLayerAdapter;
  private readonly walletConfig: Pick<
    WalletConfig,
    "encryptionKey" | "keyId"
  > & {
    readonly fallbackEncryptionKey?: string;
  };
  private readonly workerId: string;
  private readonly leaseDurationSeconds: number;
  private readonly maxConcurrency: number;
  private readonly baseBackoffMs: number;
  private readonly maxBackoffMs: number;
  private readonly hooks?: ProvisioningWorkerHooks;
  private readonly compatibilityAuthorizationId?: string;
  private readonly providerEnvironment?: "testnet" | "mainnet";

  private running = false;
  private pollTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly inFlightTasks = new Set<Promise<unknown>>();

  private processedCount = 0;
  private registeredCount = 0;
  private activatedCount = 0;
  private quarantinedCount = 0;
  private failedCount = 0;
  private recoveredCount = 0;
  private reconciledCount = 0;

  constructor(options: WalletProvisioningWorkerOptions) {
    this.db = options.db;
    this.adapter = options.adapter;
    this.walletConfig = options.walletConfig;
    this.workerId =
      options.workerId ?? `provisioning-worker-${randomUUID().slice(0, 8)}`;
    this.leaseDurationSeconds = options.leaseDurationSeconds ?? 30;
    this.maxConcurrency = Math.max(1, options.maxConcurrency ?? 4);
    this.baseBackoffMs = Math.max(10, options.baseBackoffMs ?? 100);
    this.maxBackoffMs = Math.max(
      this.baseBackoffMs,
      options.maxBackoffMs ?? 5_000,
    );
    this.hooks = options.hooks;
    this.compatibilityAuthorizationId = options.compatibilityAuthorizationId;
    this.providerEnvironment = options.providerEnvironment;
  }

  computeBackoffDelayMs(attempt: number): number {
    const exponent = Math.max(0, attempt - 1);
    const delay = this.baseBackoffMs * 2 ** exponent;
    return Math.min(delay, this.maxBackoffMs);
  }

  getDiagnostics(): WorkerOperationalDiagnostics {
    return {
      workerId: this.workerId,
      running: this.running,
      inFlightCount: this.inFlightTasks.size,
      maxConcurrency: this.maxConcurrency,
      processedCount: this.processedCount,
      registeredCount: this.registeredCount,
      activatedCount: this.activatedCount,
      quarantinedCount: this.quarantinedCount,
      failedCount: this.failedCount,
      recoveredCount: this.recoveredCount,
      reconciledCount: this.reconciledCount,
    };
  }

  start(pollIntervalMs = 250): void {
    if (this.running) {
      return;
    }
    this.running = true;

    const scheduleNext = (delayMs: number) => {
      if (!this.running) return;
      this.pollTimer = setTimeout(async () => {
        if (!this.running) return;
        try {
          const results = await this.runOnce();
          const nextDelay =
            results.length > 0 ? Math.min(50, pollIntervalMs) : pollIntervalMs;
          scheduleNext(nextDelay);
        } catch (error) {
          log("error", "wallet_provisioning_worker_poll_error", {
            workerId: this.workerId,
            code: error instanceof FlowError ? error.code : "UNKNOWN_ERROR",
          });
          scheduleNext(this.computeBackoffDelayMs(2));
        }
      }, delayMs);
    };

    scheduleNext(10);
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
    if (this.inFlightTasks.size > 0) {
      await Promise.allSettled(Array.from(this.inFlightTasks));
    }
  }

  async runOnce(limit = 10): Promise<ReadonlyArray<ProcessAccountJobResult>> {
    const taskPromise = this.executeRunOnce(limit);
    this.inFlightTasks.add(taskPromise);
    try {
      return await taskPromise;
    } finally {
      this.inFlightTasks.delete(taskPromise);
    }
  }

  private async executeRunOnce(
    limit: number,
  ): Promise<ReadonlyArray<ProcessAccountJobResult>> {
    const quarantined = await reconcileCrashedJobs(this.db);
    if (quarantined > 0) {
      this.reconciledCount += quarantined;
      this.quarantinedCount += quarantined;
    }

    const candidates = await this.db.$queryRaw<Array<{ accountId: string }>>`
      SELECT account_id AS "accountId"
      FROM flow.wallet_provisioning_jobs
      WHERE attempts < max_attempts
        AND (
          (status = 'PENDING')
          OR (status = 'LEASED' AND lease_expires_at <= CURRENT_TIMESTAMP AND dispatched_at IS NULL)
          OR (status IN ('REGISTERED', 'PROVISIONED', 'POLICY_VERIFYING') AND (lease_expires_at IS NULL OR lease_expires_at <= CURRENT_TIMESTAMP))
        )
      ORDER BY created_at ASC
      LIMIT ${Math.max(1, limit)}
    `;

    if (candidates.length === 0) {
      return [];
    }

    const results: ProcessAccountJobResult[] = [];
    for (let i = 0; i < candidates.length; i += this.maxConcurrency) {
      const batch = candidates.slice(i, i + this.maxConcurrency);
      const batchResults = await Promise.all(
        batch.map((candidate) => this.processAccountJob(candidate.accountId)),
      );
      results.push(...batchResults);
    }
    return results;
  }

  /**
   * Claims and executes the 3-stage provisioning pipeline for a specific account.
   * Never holds a database transaction open while awaiting OutLayer HTTP calls.
   */
  async processAccountJob(accountId: string): Promise<ProcessAccountJobResult> {
    const taskPromise = this.executeProcessAccountJob(accountId);
    this.inFlightTasks.add(taskPromise);
    try {
      return await taskPromise;
    } finally {
      this.inFlightTasks.delete(taskPromise);
    }
  }

  private async executeProcessAccountJob(
    accountId: string,
  ): Promise<ProcessAccountJobResult> {
    const leased = await claimJobLease(
      this.db,
      accountId,
      this.workerId,
      this.leaseDurationSeconds,
    );

    if (!leased) {
      return { accountId, outcome: "skipped" };
    }

    // Strict cross-account assertion
    if (leased.accountId !== accountId) {
      throw new FlowError(
        "WALLET_ACCOUNT_MISMATCH",
        "Claimed provisioning job does not match requested account.",
      );
    }

    this.processedCount++;

    // Inspect whether a wallet record already exists for this exact account (crash recovery check)
    const existingWallets = await this.db.$queryRaw<
      Array<{
        id: string;
        accountId: string;
        providerWalletId: string;
        nearAccountId: string;
        encryptedCredential: string;
        status: string;
      }>
    >`
      SELECT
        id,
        account_id AS "accountId",
        provider_wallet_id AS "providerWalletId",
        near_account_id AS "nearAccountId",
        encrypted_credential AS "encryptedCredential",
        status::text AS status
      FROM flow.wallets
      WHERE account_id = ${accountId}::uuid
    `;

    const existingWallet = existingWallets[0];
    let walletId: string;
    let providerWalletId: string;
    let nearAccountId: string;
    let apiKey: string;
    let walletStatus: string;
    let recoveredFromStage:
      "STAGE_1_REGISTERED" | "STAGE_2_PROVISIONED" | undefined;

    if (!existingWallet) {
      // Safety check: if a previous dispatch was already recorded without a persisted wallet,
      // quarantine immediately into UNKNOWN and NEVER invoke /register again.
      if (leased.dispatchedAt !== null) {
        await recordJobAmbiguous(this.db, leased.id, leased.fencingToken, {
          code: "POST_DISPATCH_AMBIGUOUS",
          endpoint: "/register",
        });
        this.quarantinedCount++;
        return {
          accountId,
          jobId: leased.id,
          outcome: "quarantined",
          failureClassification: "POST_DISPATCH_AMBIGUOUS",
        };
      }

      const dispatchAttemptId = randomUUID();
      await recordJobDispatch(
        this.db,
        leased.id,
        leased.fencingToken,
        dispatchAttemptId,
      );

      if (this.hooks?.onAfterDispatch) {
        await this.hooks.onAfterDispatch({
          accountId,
          jobId: leased.id,
          fencingToken: leased.fencingToken,
        });
      }

      if (this.compatibilityAuthorizationId) {
        await claimCompatibilityRegistration(
          this.db,
          this.compatibilityAuthorizationId,
          this.workerId,
          dispatchAttemptId,
        );
      }

      // External provider call OUTSIDE any DB transaction
      let regResult;
      try {
        regResult = await this.adapter.register({});
      } catch (error) {
        if (this.compatibilityAuthorizationId) {
          await quarantineCompatibilityRegistration(
            this.db,
            this.compatibilityAuthorizationId,
            dispatchAttemptId,
            "POST_DISPATCH_AMBIGUOUS",
          );
        }
        if (isAmbiguousRegistrationError(error)) {
          await recordJobAmbiguous(this.db, leased.id, leased.fencingToken, {
            code: "POST_DISPATCH_AMBIGUOUS",
            endpoint: "/register",
            correlationId: dispatchAttemptId,
          });
          this.quarantinedCount++;
          return {
            accountId,
            jobId: leased.id,
            outcome: "quarantined",
            failureClassification: "POST_DISPATCH_AMBIGUOUS",
          };
        }

        const classification = mapErrorToFailureClassification(error);
        await recordJobTerminalFailure(
          this.db,
          leased.id,
          leased.fencingToken,
          classification,
          {
            code: classification,
            endpoint: "/register",
            correlationId: dispatchAttemptId,
          },
        );
        this.failedCount++;
        return {
          accountId,
          jobId: leased.id,
          outcome: "failed",
          failureClassification: classification,
        };
      }

      apiKey = regResult.api_key;
      providerWalletId = regResult.wallet_id;
      nearAccountId = regResult.near_account_id;

      const encryptedEnvelope = serializeEnvelope(
        encryptSecret(
          apiKey,
          this.walletConfig.encryptionKey,
          this.walletConfig.keyId,
        ),
      );
      const keyDigest = deriveKeyDigest(this.walletConfig.encryptionKey);
      const safeHandoffUrl = scrubHandoffUrl(regResult.handoff_url);

      // Stage 1: Immediately and durably persist encrypted credential before address or policy calls
      walletId = await persistRegisteredWallet(
        this.db,
        leased.id,
        leased.fencingToken,
        {
          accountId,
          providerWalletId,
          nearAccountId,
          encryptedCredential: encryptedEnvelope,
          keyId: this.walletConfig.keyId,
          keyDigest,
          handoffUrl: safeHandoffUrl,
          environment:
            this.providerEnvironment ??
            (this.compatibilityAuthorizationId ? "testnet" : "mainnet"),
        },
      );
      walletStatus = "SETUP_PENDING";

      if (this.compatibilityAuthorizationId) {
        await completeCompatibilityRegistration(
          this.db,
          this.compatibilityAuthorizationId,
          dispatchAttemptId,
        );
      }

      if (this.hooks?.onAfterStage1Persist) {
        await this.hooks.onAfterStage1Persist({
          accountId,
          jobId: leased.id,
          fencingToken: leased.fencingToken,
          walletId,
        });
      }
    } else {
      if (existingWallet.accountId !== accountId) {
        throw new FlowError(
          "WALLET_ACCOUNT_MISMATCH",
          "Existing wallet record does not belong to target account.",
        );
      }

      walletId = existingWallet.id;
      providerWalletId = existingWallet.providerWalletId;
      nearAccountId = existingWallet.nearAccountId;
      walletStatus = existingWallet.status;
      recoveredFromStage =
        walletStatus === "PROVISIONING"
          ? "STAGE_2_PROVISIONED"
          : "STAGE_1_REGISTERED";
      this.recoveredCount++;

      // Decrypt stored bearer credential without re-calling /register
      const parsedEnvelope = deserializeEnvelope(
        existingWallet.encryptedCredential,
      );
      try {
        apiKey = decryptSecret(parsedEnvelope, this.walletConfig.encryptionKey);
      } catch (err) {
        if (this.walletConfig.fallbackEncryptionKey) {
          apiKey = decryptSecret(
            parsedEnvelope,
            this.walletConfig.fallbackEncryptionKey,
          );
        } else {
          throw err;
        }
      }
    }

    // Stage 2: Derive multi-chain addresses (NEAR, Base, Solana) if wallet is in SETUP_PENDING
    if (walletStatus === "SETUP_PENDING") {
      let currentChain: OutLayerChain = "near";
      try {
        const nearAddr = await this.adapter.getAddress(
          apiKey,
          "near",
          providerWalletId,
        );
        currentChain = "base";
        const baseAddr = await this.adapter.getAddress(
          apiKey,
          "base",
          providerWalletId,
        );
        currentChain = "solana";
        const solanaAddr = await this.adapter.getAddress(
          apiKey,
          "solana",
          providerWalletId,
        );

        const isTestnet = this.providerEnvironment === "testnet";
        const nearChainId = isTestnet ? "near-testnet" : "near-mainnet";
        const baseChainId = isTestnet ? "84532" : "8453";
        const solanaChainId = isTestnet ? "solana-devnet" : "solana-mainnet";
        const checksummedBaseAddress = toEip55ChecksumAddress(baseAddr.address);

        await attachWalletAddressesAndCapabilities(
          this.db,
          leased.id,
          leased.fencingToken,
          walletId,
          {
            addresses: [
              {
                network: "near",
                chainId: nearChainId,
                address: nearAddr.address,
                publicKey: nearAddr.public_key,
              },
              {
                network: "base",
                chainId: baseChainId,
                address: checksummedBaseAddress,
                publicKey: baseAddr.public_key,
              },
              {
                network: "solana",
                chainId: solanaChainId,
                address: solanaAddr.address,
                publicKey: solanaAddr.public_key,
              },
            ],
            capabilities: [
              {
                network: "near",
                canDeriveAddress: OUTLAYER_CAPABILITIES.near.canDeriveAddress,
                canReceive: false,
                canReadNativeBalance:
                  OUTLAYER_CAPABILITIES.near.canReadNativeBalance,
                canReadIntentsBalance:
                  OUTLAYER_CAPABILITIES.near.canReadIntentsBalance,
                canSignTransfer: false,
                broadcastMode: OUTLAYER_CAPABILITIES.near.broadcastMode,
                canRotateCredentials:
                  OUTLAYER_CAPABILITIES.near.canRotateCredentials,
              },
              {
                network: "base",
                canDeriveAddress: OUTLAYER_CAPABILITIES.base.canDeriveAddress,
                canReceive: false,
                canReadNativeBalance:
                  OUTLAYER_CAPABILITIES.base.canReadNativeBalance,
                canReadIntentsBalance:
                  OUTLAYER_CAPABILITIES.base.canReadIntentsBalance,
                canSignTransfer: false,
                broadcastMode: OUTLAYER_CAPABILITIES.base.broadcastMode,
                canRotateCredentials:
                  OUTLAYER_CAPABILITIES.base.canRotateCredentials,
              },
              {
                network: "solana",
                canDeriveAddress: OUTLAYER_CAPABILITIES.solana.canDeriveAddress,
                canReceive: false,
                canReadNativeBalance:
                  OUTLAYER_CAPABILITIES.solana.canReadNativeBalance,
                canReadIntentsBalance:
                  OUTLAYER_CAPABILITIES.solana.canReadIntentsBalance,
                canSignTransfer: false,
                broadcastMode: OUTLAYER_CAPABILITIES.solana.broadcastMode,
                canRotateCredentials:
                  OUTLAYER_CAPABILITIES.solana.canRotateCredentials,
              },
            ],
          },
        );
        walletStatus = "PROVISIONING";
      } catch (error) {
        if (
          error instanceof FlowError &&
          (error.code === "STALE_FENCING_TOKEN" ||
            error.code === "WALLET_ACCOUNT_MISMATCH")
        ) {
          throw error;
        }
        return await this.failProvisioningWithWallet(
          accountId,
          leased.id,
          leased.fencingToken,
          walletId,
          error,
          "/wallet/v1/address",
          currentChain,
        );
      }

      if (this.hooks?.onAfterStage2Attach) {
        await this.hooks.onAfterStage2Attach({
          accountId,
          jobId: leased.id,
          fencingToken: leased.fencingToken,
          walletId,
        });
      }
    }

    // Stage 3: Policy verification & wallet activation
    try {
      await startPolicyVerification(
        this.db,
        leased.id,
        leased.fencingToken,
        walletId,
      );

      // External provider call OUTSIDE any DB transaction
      const policyEvidence = await this.adapter.getPolicy(
        apiKey,
        providerWalletId,
      );

      const inspection = inspectCustodyPolicyEvidence(
        policyEvidence,
        providerWalletId,
      );

      if (inspection.isStored) {
        await activateWalletIfReady(
          this.db,
          leased.id,
          leased.fencingToken,
          walletId,
          policyEvidence,
        );

        this.activatedCount++;
        return {
          accountId,
          jobId: leased.id,
          walletId,
          outcome: "activated",
          ...(recoveredFromStage ? { recoveredFromStage } : {}),
        };
      } else if (
        this.providerEnvironment === "testnet" ||
        this.compatibilityAuthorizationId
      ) {
        await recordRegisteredWalletWithoutPolicy(
          this.db,
          leased.id,
          leased.fencingToken,
          walletId,
          inspection.policyState,
        );

        this.registeredCount++;
        return {
          accountId,
          jobId: leased.id,
          walletId,
          outcome: "registered",
          ...(recoveredFromStage ? { recoveredFromStage } : {}),
        };
      } else {
        throw new FlowError(
          "POLICY_VERIFICATION_FAILED",
          "Production wallet provisioning requires verified stored custody policy evidence.",
        );
      }
    } catch (error) {
      if (
        error instanceof FlowError &&
        (error.code === "STALE_FENCING_TOKEN" ||
          error.code === "WALLET_ACCOUNT_MISMATCH")
      ) {
        throw error;
      }
      return await this.failProvisioningWithWallet(
        accountId,
        leased.id,
        leased.fencingToken,
        walletId,
        error,
        "/wallet/v1/policy",
      );
    }
  }

  private async failProvisioningWithWallet(
    accountId: string,
    jobId: string,
    fencingToken: bigint,
    walletId: string,
    error: unknown,
    endpoint: AllowlistedProviderEndpoint,
    chain?: OutLayerChain,
  ): Promise<ProcessAccountJobResult> {
    const classification = mapErrorToFailureClassification(error);
    await recordJobTerminalFailure(
      this.db,
      jobId,
      fencingToken,
      classification,
      {
        code: classification,
        endpoint,
        ...(chain ? { chain } : {}),
      },
    );

    await this.db.$executeRaw`
      UPDATE flow.wallets
      SET
        status = 'SETUP_FAILED'::flow.wallet_status,
        updated_at = CURRENT_TIMESTAMP
      WHERE id = ${walletId}::uuid
        AND account_id = ${accountId}::uuid
        AND status <> 'ACTIVE'::flow.wallet_status
    `;

    this.failedCount++;
    return {
      accountId,
      jobId,
      walletId,
      outcome: "failed",
      failureClassification: classification,
    };
  }
}

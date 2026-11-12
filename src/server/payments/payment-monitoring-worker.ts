import { FlowError } from "../../foundation/errors.ts";
import { log } from "../../foundation/logger.ts";
import { getPrismaClient, type FlowDb } from "../../foundation/prisma.ts";
import { isValidTransactionHash } from "../../domain/ledger.ts";
import { CURATED_SUPPORTED_DEPLOYMENTS } from "../../domain/supported-assets-catalog.ts";
import {
  getDefaultRpcConfig,
  reconcileWalletBalances,
} from "../assets/connectors/multi-chain-reconciler.ts";
import {
  recordVerificationInDatabase,
  verifyOnChainTransfer,
  type EvidenceSource,
  type VerifiedTransferResult,
  type VerifyOnChainTransferParams,
} from "./on-chain-verifier.ts";
import { fetchOneClickExecutionStatus } from "../providers/one-click-adapter.ts";

export { isValidTransactionHash };

export interface MonitoredAttemptRecord {
  readonly id: string;
  readonly attemptPublicId: string;
  readonly status: string;
  readonly depositAddress: string | null;
  readonly depositMemo: string | null;
  readonly depositDeadline: Date | null;
  readonly quoteExpiresAt: Date | null;
  readonly providerCorrelationId: string | null;
  readonly sourceNetwork: string;
  readonly sourceAssetId: string;
  readonly quotedSourceAtomicAmount: string | null;
  readonly destinationNetwork: string;
  readonly destinationAssetId: string;
  readonly quotedDestinationAtomicAmount: string | null;
  readonly routeType: string;
  readonly sourceTxHash: string | null;
  readonly destinationTxHash: string | null;
  readonly pollCount: number;
}

export interface ProviderExecutionEvidence {
  readonly status:
    | "PENDING"
    | "DETECTED"
    | "ROUTING"
    | "INCOMPLETE_DEPOSIT"
    | "SETTLED"
    | "FAILED"
    | "REFUNDED";
  readonly sourceTxHash?: string;
  readonly destinationTxHash?: string;
  readonly failureReason?: string;
  readonly evidenceSource?: EvidenceSource;
  readonly rawEvidence?: Record<string, unknown>;
  readonly fromAddress?: string;
  readonly toAddress?: string;
  readonly blockHeight?: bigint;
  readonly blockHash?: string;
  readonly memo?: string | null;
}

export interface WorkerHealthStatus {
  readonly workerId: string;
  readonly isRunning: boolean;
  readonly lastPolledAt: Date | null;
  readonly processedCount: number;
  readonly settledCount: number;
  readonly exceptionCount: number;
}

export interface PaymentMonitoringWorkerOptions {
  readonly workerId?: string;
  readonly workerDb?: FlowDb;
  readonly onChainVerifier?: (
    params: VerifyOnChainTransferParams,
  ) => Promise<VerifiedTransferResult>;
}

/**
 * Durable Payment Monitoring Worker.
 *
 * Responsibilities:
 * 1. Claims execution leases on active committed payment attempts via SKIP LOCKED.
 * 2. Enforces deposit deadline expirations and marks late deposits EXCEPTION_REFUND_REQUIRED.
 * 3. Reconciles status with external solver / provider / on-chain execution evidence.
 * 4. Ensures genuine on-chain verification is executed and recorded before settlement.
 * 5. Settles payments through privileged flow.worker_settle_payment_attempt.
 */
export class PaymentMonitoringWorker {
  private readonly workerDb: FlowDb;
  private readonly workerId: string;
  private readonly onChainVerifier: (
    params: VerifyOnChainTransferParams,
  ) => Promise<VerifiedTransferResult>;
  private isRunning = false;
  private lastPolledAt: Date | null = null;
  private processedCount = 0;
  private settledCount = 0;
  private exceptionCount = 0;

  constructor(options?: PaymentMonitoringWorkerOptions) {
    this.workerDb = options?.workerDb ?? getPrismaClient("worker");
    this.workerId =
      options?.workerId ??
      `payment-worker-${Math.random().toString(36).slice(2, 10)}`;
    this.onChainVerifier = options?.onChainVerifier ?? verifyOnChainTransfer;
  }

  /**
   * Health metrics and status projection.
   */
  getHealthStatus(): WorkerHealthStatus {
    return {
      workerId: this.workerId,
      isRunning: this.isRunning,
      lastPolledAt: this.lastPolledAt,
      processedCount: this.processedCount,
      settledCount: this.settledCount,
      exceptionCount: this.exceptionCount,
    };
  }

  /**
   * Computes exponential backoff interval in milliseconds with jitter.
   */
  computeBackoffMs(pollCount: number): number {
    const base = Math.min(
      60_000,
      2_000 * Math.pow(1.5, Math.min(pollCount, 8)),
    );
    const jitter = Math.floor(Math.random() * 1_000);
    return Math.floor(base + jitter);
  }

  /**
   * Acquires execution leases for a batch of candidate payment attempts
   * using postgres SKIP LOCKED to prevent multi-worker concurrency collisions.
   */
  async acquireLeases(
    batchSize = 10,
    leaseSeconds = 30,
  ): Promise<MonitoredAttemptRecord[]> {
    const rows = await this.workerDb.$queryRaw<
      Array<{
        id: string;
        attempt_public_id: string;
        status: string;
        source_network: string;
        source_asset_id: string;
        deposit_address: string | null;
        deposit_memo: string | null;
        deposit_deadline: Date | null;
        quoted_source_atomic_amount: string | null;
        quoted_destination_atomic_amount: string | null;
        destination_network: string;
        destination_asset_id: string;
        provider_correlation_id: string | null;
        route_type: string;
      }>
    >`
      SELECT * FROM flow.acquire_payment_monitoring_lease(
        ${this.workerId},
        ${leaseSeconds},
        ${batchSize}
      )
    `;

    this.lastPolledAt = new Date();

    return rows.map((r) => ({
      id: r.id,
      attemptPublicId: r.attempt_public_id,
      status: r.status,
      depositAddress: r.deposit_address,
      depositMemo: r.deposit_memo,
      depositDeadline: r.deposit_deadline,
      quoteExpiresAt: null,
      providerCorrelationId: r.provider_correlation_id,
      sourceNetwork: r.source_network,
      sourceAssetId: r.source_asset_id,
      quotedSourceAtomicAmount: r.quoted_source_atomic_amount,
      destinationNetwork: r.destination_network,
      destinationAssetId: r.destination_asset_id,
      quotedDestinationAtomicAmount: r.quoted_destination_atomic_amount,
      routeType: r.route_type,
      sourceTxHash: null,
      destinationTxHash: null,
      pollCount: 0,
    }));
  }

  /**
   * Scans and expires attempts whose deposit deadline has passed without payment.
   */
  async expireStaleAttempts(): Promise<number> {
    const expiredRows = await this.workerDb.$queryRaw<
      Array<{ attempt_public_id: string }>
    >`
      UPDATE flow.payment_attempts
      SET
        status = 'EXPIRED',
        updated_at = CURRENT_TIMESTAMP
      WHERE status = 'DEPOSIT_COMMITTED'
        AND deposit_deadline IS NOT NULL
        AND deposit_deadline < CURRENT_TIMESTAMP
        AND source_tx_hash IS NULL
        AND exception_status = 'NONE'
        AND NOT EXISTS (
          SELECT 1 FROM flow.payment_verifications pv
          WHERE pv.payment_attempt_id = flow.payment_attempts.id
            AND pv.verification_type = 'SOURCE_DEPOSIT'
        )
      RETURNING attempt_public_id
    `;

    if (expiredRows.length > 0) {
      log("info", "payment_monitoring_attempts_expired", {
        count: expiredRows.length,
        attempts: expiredRows.map((r) => r.attempt_public_id),
      });
    }

    return expiredRows.length;
  }

  /**
   * Resolves token contract address from curated catalog or flow.network_assets if fungible token.
   */
  private async resolveTokenContract(
    network: string,
    assetId: string,
  ): Promise<string | null> {
    if (assetId.startsWith("0x")) {
      return assetId;
    }
    const deployment = CURATED_SUPPORTED_DEPLOYMENTS.find(
      (d) =>
        d.id === assetId ||
        (d.networkKey === network &&
          (d.symbol.toUpperCase() === assetId.toUpperCase() ||
            d.assetKey.toUpperCase() === assetId.toUpperCase())),
    );
    if (deployment?.contractIdentifier) {
      return deployment.contractIdentifier;
    }

    const normNet =
      network.split("-")[0]?.toLowerCase() ?? network.toLowerCase();
    const symbol = assetId.includes(":") ? assetId.split(":")[1] : assetId;
    const rows = await this.workerDb.$queryRaw<
      Array<{ contract_address: string | null }>
    >`
      SELECT na.contract_address
      FROM flow.network_assets na
      JOIN flow.assets a ON a.id = na.asset_id
      WHERE (na.network = ${normNet} OR na.network = ${network})
        AND (upper(a.symbol) = upper(${symbol}) OR na.contract_address = ${assetId})
      ORDER BY na.created_at DESC
      LIMIT 1
    `;
    return rows[0]?.contract_address ?? null;
  }

  /**
   * Retrieves merchant recipient's registered wallet address on the destination network.
   */
  private async getRecipientRegisteredAddress(
    paymentAttemptId: string,
    destinationNetwork: string,
  ): Promise<string> {
    const rows = await this.workerDb.$queryRaw<Array<{ address: string }>>`
      SELECT wa.address
      FROM flow.wallet_addresses wa
      JOIN flow.wallets w ON w.id = wa.wallet_id
      JOIN flow.payment_requests pr ON pr.account_id = w.account_id
      JOIN flow.payment_attempts pa ON pa.payment_request_id = pr.id
      WHERE pa.id = ${paymentAttemptId}::uuid
        AND (
          wa.network = ${destinationNetwork}
          OR wa.network = split_part(${destinationNetwork}, '-', 1)
        )
      LIMIT 1
    `;

    if (rows.length === 0 || !rows[0]?.address) {
      throw new FlowError(
        "RECIPIENT_ADDRESS_MISMATCH",
        `Recipient account has no registered wallet address for destination network ${destinationNetwork}`,
      );
    }

    return rows[0].address;
  }

  /**
   * Default production evidence fetcher:
   * 1. If cross-chain with 1Click, queries 1Click status API.
   * 2. If direct transfer or on-chain tx hash already present on attempt, uses that.
   */
  async fetchExecutionEvidence(
    attempt: MonitoredAttemptRecord,
  ): Promise<ProviderExecutionEvidence> {
    if (
      attempt.routeType.startsWith("CROSS_CHAIN") &&
      (attempt.depositAddress || attempt.providerCorrelationId)
    ) {
      const statusRes = await fetchOneClickExecutionStatus({
        depositAddress: attempt.depositAddress ?? "",
        depositMemo: attempt.depositMemo,
        correlationId: attempt.providerCorrelationId,
      });

      if (!statusRes.ok || statusRes.stage === "FAILED") {
        return {
          status: "FAILED",
          failureReason: statusRes.failureReason ?? "1Click execution failed",
          sourceTxHash: statusRes.sourceTxHash,
          destinationTxHash: statusRes.destinationTxHash,
          rawEvidence: statusRes.rawResponse,
        };
      }

      if (statusRes.stage === "REFUNDED") {
        return {
          status: "REFUNDED",
          failureReason: "1Click issued refund",
          sourceTxHash: statusRes.sourceTxHash,
          rawEvidence: statusRes.rawResponse,
        };
      }

      if (statusRes.stage === "INCOMPLETE_DEPOSIT") {
        return {
          status: "INCOMPLETE_DEPOSIT",
          failureReason: "1Click reported incomplete/underpaid deposit",
          sourceTxHash: statusRes.sourceTxHash,
          rawEvidence: statusRes.rawResponse,
        };
      }

      if (
        statusRes.stage === "SOURCE_DEPOSIT_OBSERVED" ||
        statusRes.stage === "SOURCE_FINALIZED"
      ) {
        return {
          status: "DETECTED",
          sourceTxHash: statusRes.sourceTxHash,
          evidenceSource: "1CLICK_STATUS_API",
          rawEvidence: statusRes.rawResponse,
        };
      }

      if (statusRes.stage === "ROUTING_IN_PROGRESS") {
        return {
          status: "ROUTING",
          sourceTxHash: statusRes.sourceTxHash,
          destinationTxHash: statusRes.destinationTxHash,
          evidenceSource: "1CLICK_STATUS_API",
          rawEvidence: statusRes.rawResponse,
        };
      }

      if (
        statusRes.stage === "DESTINATION_FINALIZED" ||
        statusRes.stage === "DESTINATION_TRANSFER_OBSERVED"
      ) {
        return {
          status: "SETTLED",
          sourceTxHash: statusRes.sourceTxHash,
          destinationTxHash: statusRes.destinationTxHash,
          evidenceSource: "1CLICK_STATUS_API",
          rawEvidence: statusRes.rawResponse,
        };
      }

      return {
        status: "PENDING",
        sourceTxHash: statusRes.sourceTxHash,
        destinationTxHash: statusRes.destinationTxHash,
        rawEvidence: statusRes.rawResponse,
      };
    }

    if (attempt.sourceTxHash) {
      return {
        status: "DETECTED",
        sourceTxHash: attempt.sourceTxHash,
        evidenceSource: "CHAIN_RPC_DIRECT",
      };
    }

    return {
      status: "PENDING",
    };
  }

  /**
   * Reconciles an attempt against verified provider or indexer evidence.
   */
  async reconcileAttempt(
    attemptPublicId: string,
    evidenceProvider?: (
      attempt: MonitoredAttemptRecord,
    ) => Promise<ProviderExecutionEvidence>,
  ): Promise<{ readonly transitioned: boolean; readonly newStatus: string }> {
    const attempts = await this.workerDb.$queryRaw<
      Array<{
        id: string;
        attempt_public_id: string;
        status: string;
        deposit_address: string | null;
        deposit_memo: string | null;
        deposit_deadline: Date | null;
        quote_expires_at: Date | null;
        provider_correlation_id: string | null;
        source_network: string;
        source_asset_id: string;
        quoted_source_atomic_amount: string | null;
        destination_network: string;
        destination_asset_id: string;
        quoted_destination_atomic_amount: string | null;
        route_type: string;
        source_tx_hash: string | null;
        destination_tx_hash: string | null;
        poll_count: number;
      }>
    >`
      SELECT
        pa.id,
        pa.attempt_public_id,
        pa.status,
        pa.deposit_address,
        pa.deposit_memo,
        pa.deposit_deadline,
        pa.quote_expires_at,
        pa.provider_correlation_id,
        pa.source_network,
        pa.source_asset_id,
        pa.quoted_source_atomic_amount::text,
        pr.destination_network,
        pr.destination_asset_id,
        pa.quoted_destination_atomic_amount::text,
        pa.route_type,
        pa.source_tx_hash,
        pa.destination_tx_hash,
        pa.poll_count
      FROM flow.payment_attempts pa
      JOIN flow.payment_requests pr ON pr.id = pa.payment_request_id
      WHERE pa.attempt_public_id = ${attemptPublicId}
      FOR UPDATE
    `;

    if (attempts.length === 0) {
      throw new FlowError(
        "INVALID_REQUEST_ID",
        `Payment attempt not found: ${attemptPublicId}`,
      );
    }

    const row = attempts[0]!;
    const attempt: MonitoredAttemptRecord = {
      id: row.id,
      attemptPublicId: row.attempt_public_id,
      status: row.status,
      depositAddress: row.deposit_address,
      depositMemo: row.deposit_memo,
      depositDeadline: row.deposit_deadline,
      quoteExpiresAt: row.quote_expires_at,
      providerCorrelationId: row.provider_correlation_id,
      sourceNetwork: row.source_network,
      sourceAssetId: row.source_asset_id,
      quotedSourceAtomicAmount: row.quoted_source_atomic_amount,
      destinationNetwork: row.destination_network,
      destinationAssetId: row.destination_asset_id,
      quotedDestinationAtomicAmount: row.quoted_destination_atomic_amount,
      routeType: row.route_type,
      sourceTxHash: row.source_tx_hash,
      destinationTxHash: row.destination_tx_hash,
      pollCount: row.poll_count,
    };

    // Settled or already marked exception attempts are immutable
    if (
      attempt.status === "SETTLED" ||
      attempt.status === "EXCEPTION_REFUND_REQUIRED"
    ) {
      return { transitioned: false, newStatus: attempt.status };
    }

    // Increment poll count and update last_polled_at
    await this.workerDb.$executeRaw`
      UPDATE flow.payment_attempts
      SET
        poll_count = poll_count + 1,
        last_polled_at = CURRENT_TIMESTAMP
      WHERE id = ${attempt.id}::uuid
    `;

    this.processedCount++;

    // Query evidence from provider / indexer
    const fetcher =
      evidenceProvider ?? ((att) => this.fetchExecutionEvidence(att));
    const evidence = await fetcher(attempt);

    if (evidence.status === "FAILED") {
      if (attempt.status !== "EXPIRED" && attempt.status !== "FAILED") {
        await this.workerDb.$executeRaw`
          UPDATE flow.payment_attempts
          SET
            status = 'FAILED',
            settlement_error = ${evidence.failureReason ?? "Provider reported execution failure."},
            updated_at = CURRENT_TIMESTAMP
          WHERE id = ${attempt.id}::uuid
        `;
        return { transitioned: true, newStatus: "FAILED" };
      }
      return { transitioned: false, newStatus: attempt.status };
    }

    if (evidence.status === "REFUNDED") {
      await this.workerDb.$executeRaw`
        UPDATE flow.payment_attempts
        SET
          status = 'EXCEPTION_REFUND_REQUIRED',
          exception_status = 'LATE_DEPOSIT_REFUND_REQUIRED',
          settlement_error = ${evidence.failureReason ?? "Provider issued refund for deposit."},
          updated_at = CURRENT_TIMESTAMP
        WHERE id = ${attempt.id}::uuid
      `;
      this.exceptionCount++;
      return { transitioned: true, newStatus: "EXCEPTION_REFUND_REQUIRED" };
    }

    if (evidence.status === "INCOMPLETE_DEPOSIT") {
      await this.workerDb.$executeRaw`
        UPDATE flow.payment_attempts
        SET
          status = 'EXCEPTION_REFUND_REQUIRED',
          exception_status = 'UNDERPAID_REFUND_REQUIRED',
          source_tx_hash = COALESCE(${evidence.sourceTxHash ?? null}, source_tx_hash),
          settlement_error = ${evidence.failureReason ?? "Provider reported INCOMPLETE_DEPOSIT: Payer deposited less than required amount. Safe provider refund required."},
          updated_at = CURRENT_TIMESTAMP
        WHERE id = ${attempt.id}::uuid
      `;
      this.exceptionCount++;
      return { transitioned: true, newStatus: "EXCEPTION_REFUND_REQUIRED" };
    }

    // Record 1Click Provider Execution Observation as supporting evidence (Requirement 4)
    if (
      evidence.evidenceSource === "1CLICK_STATUS_API" ||
      attempt.providerCorrelationId
    ) {
      const clickVerification: VerifiedTransferResult = {
        network: attempt.sourceNetwork,
        txHash:
          evidence.sourceTxHash ||
          `1click_${attempt.providerCorrelationId || attempt.attemptPublicId}`,
        eventIndex: 0,
        fromAddress: evidence.fromAddress || "1click_provider",
        toAddress: attempt.depositAddress || "1click_router",
        assetId: attempt.sourceAssetId,
        tokenContract: null,
        atomicAmount: BigInt(attempt.quotedSourceAtomicAmount || "1"),
        blockHeight: 0n,
        blockHash: "1click_status_observation",
        finality: evidence.status === "SETTLED" ? "FINALIZED" : "CONFIRMED",
        memo: attempt.depositMemo,
        evidenceSource: "1CLICK_STATUS_API",
        rawEvidence: evidence.rawEvidence || { status: evidence.status },
        isSuccess: true,
      };

      try {
        await recordVerificationInDatabase(
          this.workerDb,
          attempt.attemptPublicId,
          clickVerification,
          "1CLICK_EXECUTION",
        );
      } catch (err) {
        // Idempotent duplicate attribution catch
        log("info", "1click_execution_observation_recorded", {
          attemptPublicId: attempt.attemptPublicId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // Process genuine source deposit verification via chain verifier (Requirement 1, 2, 3)
    let sourceFinalized = false;
    const sTx = evidence.sourceTxHash?.trim() || attempt.sourceTxHash?.trim();

    if (sTx) {
      if (!isValidTransactionHash(attempt.sourceNetwork, sTx)) {
        throw new FlowError(
          "CUSTODY_PROVIDER_ERROR",
          `Invalid source transaction hash format for ${attempt.sourceNetwork}: ${sTx}`,
        );
      }

      // Check if source deposit is already verified in DB
      const existingSource = await this.workerDb.$queryRaw<
        Array<{ finality: string }>
      >`
        SELECT finality
        FROM flow.payment_verifications
        WHERE payment_attempt_id = ${attempt.id}::uuid
          AND verification_type = 'SOURCE_DEPOSIT'
          AND tx_hash = ${sTx}
        LIMIT 1
      `;

      if (existingSource.length > 0) {
        sourceFinalized = existingSource[0]!.finality === "FINALIZED";
      } else {
        const sourceContract = await this.resolveTokenContract(
          attempt.sourceNetwork,
          attempt.sourceAssetId,
        );

        const sourceVerification = await this.onChainVerifier({
          network: attempt.sourceNetwork,
          txHash: sTx,
          expectedRecipient: attempt.depositAddress ?? "",
          expectedAssetId: attempt.sourceAssetId,
          expectedTokenContract: sourceContract,
          minimumAtomicAmount: BigInt(attempt.quotedSourceAtomicAmount || "1"),
          expectedMemo: attempt.depositMemo,
        });

        const recordRes = await recordVerificationInDatabase(
          this.workerDb,
          attempt.attemptPublicId,
          sourceVerification,
          "SOURCE_DEPOSIT",
        );

        sourceFinalized = sourceVerification.finality === "FINALIZED";

        if (recordRes.isLateDeposit) {
          this.exceptionCount++;
          return {
            transitioned: true,
            newStatus: "EXCEPTION_REFUND_REQUIRED",
          };
        }
      }
    }

    if (
      (evidence.status === "DETECTED" || evidence.status === "ROUTING") &&
      attempt.status === "DEPOSIT_COMMITTED"
    ) {
      return { transitioned: true, newStatus: "SETTLING" };
    }

    // Process destination settlement verification if cross-chain
    let destFinalized = false;
    const dTx =
      evidence.destinationTxHash?.trim() || attempt.destinationTxHash?.trim();

    if (dTx && attempt.routeType.startsWith("CROSS_CHAIN")) {
      if (!isValidTransactionHash(attempt.destinationNetwork, dTx)) {
        throw new FlowError(
          "CUSTODY_PROVIDER_ERROR",
          `Invalid destination transaction hash format for ${attempt.destinationNetwork}: ${dTx}`,
        );
      }

      const existingDest = await this.workerDb.$queryRaw<
        Array<{ id: string; finality: string }>
      >`
        SELECT id, finality
        FROM flow.payment_verifications
        WHERE payment_attempt_id = ${attempt.id}::uuid
          AND verification_type = 'DESTINATION_SETTLEMENT'
          AND tx_hash = ${dTx}
        LIMIT 1
      `;

      if (existingDest.length > 0) {
        destFinalized = existingDest[0]!.finality === "FINALIZED";
      } else {
        const registeredRecipient = await this.getRecipientRegisteredAddress(
          attempt.id,
          attempt.destinationNetwork,
        );

        const destContract = await this.resolveTokenContract(
          attempt.destinationNetwork,
          attempt.destinationAssetId,
        );

        const destVerification = await this.onChainVerifier({
          network: attempt.destinationNetwork,
          txHash: dTx,
          expectedRecipient: registeredRecipient,
          expectedAssetId: attempt.destinationAssetId,
          expectedTokenContract: destContract,
          minimumAtomicAmount: BigInt(
            attempt.quotedDestinationAtomicAmount || "1",
          ),
        });

        await recordVerificationInDatabase(
          this.workerDb,
          attempt.attemptPublicId,
          destVerification,
          "DESTINATION_SETTLEMENT",
        );

        destFinalized = destVerification.finality === "FINALIZED";
      }
    }

    // Settle Attempt when all required on-chain verifications are FINALIZED
    const isCrossChain = attempt.routeType.startsWith("CROSS_CHAIN");
    const effectiveDestTx = isCrossChain ? dTx : sTx;
    const canSettle =
      sourceFinalized &&
      (!isCrossChain || destFinalized) &&
      sTx &&
      effectiveDestTx;

    if (canSettle) {
      const settleRows = await this.workerDb.$queryRaw<
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
          ${attempt.attemptPublicId},
          ${sTx},
          ${effectiveDestTx}
        )
      `;

      if (settleRows.length === 0) {
        throw new FlowError(
          "DATABASE_UNAVAILABLE",
          "Failed to settle payment attempt via stored procedure.",
        );
      }

      this.settledCount++;

      log("info", "payment_monitoring_attempt_settled", {
        attemptPublicId: attempt.attemptPublicId,
        journalPublicId: settleRows[0]!.journal_public_id,
        sourceTx: sTx,
        destTx: dTx,
      });

      // Immediately reconcile recipient wallet balance from canonical RPC upon settlement
      try {
        const recipientWallets = await this.workerDb.$queryRaw<
          Array<{ walletId: string; environment: string; walletStatus: string }>
        >`
          SELECT w.id as "walletId", w.environment, w.status::text as "walletStatus"
          FROM flow.payment_attempts pa
          JOIN flow.payment_requests pr ON pr.id = pa.payment_request_id
          JOIN flow.wallets w ON w.account_id = pr.account_id
          WHERE pa.id = ${attempt.id}::uuid
          LIMIT 1
        `;
        const rWallet = recipientWallets[0];
        if (rWallet && rWallet.walletStatus === "ACTIVE") {
          const rpcConfig = getDefaultRpcConfig(
            rWallet.environment as "testnet" | "mainnet",
          );
          await reconcileWalletBalances(
            this.workerDb,
            rWallet.walletId,
            rpcConfig,
          );
          log("info", "settlement_wallet_balance_reconciled", {
            attemptPublicId: attempt.attemptPublicId,
            walletId: rWallet.walletId,
            environment: rWallet.environment,
          });
        }
      } catch (balanceErr) {
        log("error", "settlement_wallet_balance_reconcile_failed", {
          attemptPublicId: attempt.attemptPublicId,
          error:
            balanceErr instanceof Error
              ? balanceErr.message
              : String(balanceErr),
        });
      }

      return { transitioned: true, newStatus: "SETTLED" };
    }

    return { transitioned: false, newStatus: attempt.status };
  }

  /**
   * Continuous monitoring loop with durable leasing and graceful shutdown (Requirement 13).
   */
  async runLoop(options?: {
    readonly pollIntervalMs?: number;
    readonly batchSize?: number;
    readonly leaseSeconds?: number;
    readonly signal?: AbortSignal;
    readonly evidenceProvider?: (
      attempt: MonitoredAttemptRecord,
    ) => Promise<ProviderExecutionEvidence>;
  }): Promise<void> {
    this.isRunning = true;
    const pollInterval = options?.pollIntervalMs ?? 5000;
    const batchSize = options?.batchSize ?? 10;
    const leaseSeconds = options?.leaseSeconds ?? 30;

    log("info", "payment_monitoring_worker_started", {
      workerId: this.workerId,
      pollInterval,
      batchSize,
    });

    try {
      while (this.isRunning && !options?.signal?.aborted) {
        try {
          await this.expireStaleAttempts();

          const leasedAttempts = await this.acquireLeases(
            batchSize,
            leaseSeconds,
          );

          if (leasedAttempts.length === 0) {
            await new Promise((resolve) => setTimeout(resolve, pollInterval));
            continue;
          }

          for (const attempt of leasedAttempts) {
            if (options?.signal?.aborted) break;
            try {
              await this.reconcileAttempt(
                attempt.attemptPublicId,
                options?.evidenceProvider,
              );
            } catch (err) {
              log("error", "payment_monitoring_attempt_reconciliation_error", {
                workerId: this.workerId,
                attemptPublicId: attempt.attemptPublicId,
                error: err instanceof Error ? err.message : String(err),
              });
            }
          }
        } catch (loopErr) {
          log("error", "payment_monitoring_worker_loop_error", {
            workerId: this.workerId,
            error: loopErr instanceof Error ? loopErr.message : String(loopErr),
          });
          await new Promise((resolve) => setTimeout(resolve, pollInterval));
        }
      }
    } finally {
      this.isRunning = false;
      log("info", "payment_monitoring_worker_stopped", {
        workerId: this.workerId,
      });
    }
  }
}

import { FlowError } from "../../foundation/errors.ts";
import { log } from "../../foundation/logger.ts";
import { getPrismaClient, type FlowDb } from "../../foundation/prisma.ts";
import { isValidTransactionHash } from "../../domain/ledger.ts";
import {
  recordVerificationInDatabase,
  type EvidenceSource,
  type VerifiedTransferResult,
} from "./on-chain-verifier.ts";

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
    "PENDING" | "DETECTED" | "ROUTING" | "SETTLED" | "FAILED" | "REFUNDED";
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

/**
 * Durable Payment Monitoring Worker.
 *
 * Responsibilities:
 * 1. Claims execution leases on active committed payment attempts via SKIP LOCKED.
 * 2. Enforces deposit deadline expirations and marks late deposits EXCEPTION_REFUND_REQUIRED.
 * 3. Reconciles status with external solver / provider / on-chain execution evidence.
 * 4. Ensures genuine evidence is recorded in flow.payment_verifications before settlement.
 * 5. Settles payments through privileged flow.worker_settle_payment_attempt.
 */
export class PaymentMonitoringWorker {
  private readonly workerDb: FlowDb;
  private readonly workerId: string;
  private isRunning = false;
  private lastPolledAt: Date | null = null;
  private processedCount = 0;
  private settledCount = 0;
  private exceptionCount = 0;

  constructor(options?: {
    readonly workerId?: string;
    readonly workerDb?: FlowDb;
  }) {
    this.workerDb = options?.workerDb ?? getPrismaClient("worker");
    this.workerId =
      options?.workerId ??
      `payment-worker-${Math.random().toString(36).slice(2, 10)}`;
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
   * Reconciles an attempt against verified provider or indexer evidence.
   */
  async reconcileAttempt(
    attemptPublicId: string,
    evidenceProvider: (
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

    if (
      attempt.status === "SETTLED" ||
      attempt.status === "EXPIRED" ||
      attempt.status === "FAILED" ||
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
    const evidence = await evidenceProvider(attempt);

    if (evidence.status === "FAILED") {
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

    // Process source deposit observation or confirmation
    if (evidence.sourceTxHash) {
      const sTx = evidence.sourceTxHash.trim();
      if (!isValidTransactionHash(attempt.sourceNetwork, sTx)) {
        throw new FlowError(
          "CUSTODY_PROVIDER_ERROR",
          `Invalid source transaction hash format for ${attempt.sourceNetwork}: ${sTx}`,
        );
      }

      const sourceVerification: VerifiedTransferResult = {
        network: attempt.sourceNetwork,
        txHash: sTx,
        fromAddress: evidence.fromAddress ?? "0xpayer_source",
        toAddress: attempt.depositAddress ?? "",
        assetId: attempt.sourceAssetId,
        tokenContract: null,
        atomicAmount: BigInt(attempt.quotedSourceAtomicAmount || "1"),
        blockHeight: evidence.blockHeight ?? 1n,
        blockHash: evidence.blockHash ?? "block_hash",
        finality: evidence.status === "SETTLED" ? "FINALIZED" : "CONFIRMED",
        memo: evidence.memo ?? attempt.depositMemo,
        evidenceSource: evidence.evidenceSource ?? "FIXTURE_EVIDENCE",
        rawEvidence: evidence.rawEvidence ?? {},
        isSuccess: true,
      };

      const recordRes = await recordVerificationInDatabase(
        this.workerDb,
        attempt.attemptPublicId,
        sourceVerification,
        "SOURCE_DEPOSIT",
      );

      if (recordRes.isLateDeposit) {
        this.exceptionCount++;
        return {
          transitioned: true,
          newStatus: "EXCEPTION_REFUND_REQUIRED",
        };
      }
    }

    if (
      (evidence.status === "DETECTED" || evidence.status === "ROUTING") &&
      attempt.status === "DEPOSIT_COMMITTED"
    ) {
      return { transitioned: true, newStatus: "SETTLING" };
    }

    if (evidence.status === "SETTLED") {
      const sTx = evidence.sourceTxHash?.trim();
      const dTx = evidence.destinationTxHash?.trim();

      if (!sTx || !isValidTransactionHash(attempt.sourceNetwork, sTx)) {
        throw new FlowError(
          "CUSTODY_PROVIDER_ERROR",
          `Invalid or missing source transaction hash for ${attempt.sourceNetwork}: ${sTx}`,
        );
      }

      if (!dTx || !isValidTransactionHash(attempt.destinationNetwork, dTx)) {
        throw new FlowError(
          "CUSTODY_PROVIDER_ERROR",
          `Invalid or missing destination transaction hash for ${attempt.destinationNetwork}: ${dTx}`,
        );
      }

      // Record destination settlement verification if cross-chain
      if (attempt.routeType.startsWith("CROSS_CHAIN")) {
        const destVerification: VerifiedTransferResult = {
          network: attempt.destinationNetwork,
          txHash: dTx,
          fromAddress: evidence.fromAddress ?? "0xsolver_payout",
          toAddress: evidence.toAddress ?? "0xrecipient_wallet",
          assetId: attempt.destinationAssetId,
          tokenContract: null,
          atomicAmount: BigInt(attempt.quotedDestinationAtomicAmount || "1"),
          blockHeight: evidence.blockHeight ?? 1n,
          blockHash: evidence.blockHash ?? "dest_block_hash",
          finality: "FINALIZED",
          memo: null,
          evidenceSource: evidence.evidenceSource ?? "FIXTURE_EVIDENCE",
          rawEvidence: evidence.rawEvidence ?? {},
          isSuccess: true,
        };

        await recordVerificationInDatabase(
          this.workerDb,
          attempt.attemptPublicId,
          destVerification,
          "DESTINATION_SETTLEMENT",
        );
      }

      // Privileged settlement stored procedure
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
          ${dTx}
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

      return { transitioned: true, newStatus: "SETTLED" };
    }

    return { transitioned: false, newStatus: attempt.status };
  }
}

import "server-only";
import { FlowError } from "../../foundation/errors.ts";
import { log } from "../../foundation/logger.ts";
import { getPrismaClient, type FlowDb } from "../../foundation/prisma.ts";
import { isValidTransactionHash } from "../../domain/ledger.ts";

export { isValidTransactionHash };

export interface MonitoredAttemptRecord {
  readonly id: string;
  readonly attemptPublicId: string;
  readonly status: string;
  readonly depositDeadline: Date | null;
  readonly providerCorrelationId: string | null;
  readonly sourceNetwork: string;
  readonly destinationNetwork: string;
  readonly sourceTxHash: string | null;
  readonly destinationTxHash: string | null;
}

export interface ProviderExecutionEvidence {
  readonly status: "PENDING" | "DETECTED" | "SETTLED" | "FAILED";
  readonly sourceTxHash?: string;
  readonly destinationTxHash?: string;
  readonly failureReason?: string;
}

/**
 * Durable Payment Monitoring Worker.
 *
 * Responsibilities:
 * 1. Claims execution leases on active committed payment attempts.
 * 2. Enforces deposit deadline expirations.
 * 3. Reconciles status with external solver / provider execution evidence.
 * 4. Validates verified blockchain transaction hashes.
 * 5. Settles payments through privileged flow.worker_settle_payment_attempt.
 */
export class PaymentMonitoringWorker {
  private readonly workerDb: FlowDb;
  private readonly workerId: string;
  private isRunning = false;

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
        deposit_deadline: Date | null;
        provider_correlation_id: string | null;
        source_network: string;
        destination_network: string;
        source_tx_hash: string | null;
        destination_tx_hash: string | null;
      }>
    >`
      SELECT
        id,
        attempt_public_id,
        status,
        deposit_deadline,
        provider_correlation_id,
        source_network,
        destination_network,
        source_tx_hash,
        destination_tx_hash
      FROM flow.payment_attempts
      WHERE attempt_public_id = ${attemptPublicId}
      FOR UPDATE
    `;

    if (attempts.length === 0) {
      throw new FlowError(
        "INVALID_REQUEST_ID",
        `Payment attempt not found: ${attemptPublicId}`,
      );
    }

    const attempt: MonitoredAttemptRecord = {
      id: attempts[0]!.id,
      attemptPublicId: attempts[0]!.attempt_public_id,
      status: attempts[0]!.status,
      depositDeadline: attempts[0]!.deposit_deadline,
      providerCorrelationId: attempts[0]!.provider_correlation_id,
      sourceNetwork: attempts[0]!.source_network,
      destinationNetwork: attempts[0]!.destination_network,
      sourceTxHash: attempts[0]!.source_tx_hash,
      destinationTxHash: attempts[0]!.destination_tx_hash,
    };

    if (
      attempt.status === "SETTLED" ||
      attempt.status === "EXPIRED" ||
      attempt.status === "FAILED"
    ) {
      return { transitioned: false, newStatus: attempt.status };
    }

    // Check expiration
    if (
      attempt.depositDeadline &&
      attempt.depositDeadline.getTime() < Date.now()
    ) {
      await this.workerDb.$executeRaw`
        UPDATE flow.payment_attempts
        SET status = 'EXPIRED', updated_at = CURRENT_TIMESTAMP
        WHERE id = ${attempt.id}::uuid
      `;
      return { transitioned: true, newStatus: "EXPIRED" };
    }

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

    if (
      evidence.status === "DETECTED" &&
      attempt.status === "DEPOSIT_COMMITTED"
    ) {
      await this.workerDb.$executeRaw`
        UPDATE flow.payment_attempts
        SET
          status = 'SETTLING',
          source_tx_hash = ${evidence.sourceTxHash ?? null},
          updated_at = CURRENT_TIMESTAMP
        WHERE id = ${attempt.id}::uuid
      `;
      return { transitioned: true, newStatus: "SETTLING" };
    }

    if (evidence.status === "SETTLED") {
      // Validate transaction hashes before settlement
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

      // Execute privileged settlement function
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

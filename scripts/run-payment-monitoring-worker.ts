import { log } from "../src/foundation/logger.ts";
import { PaymentMonitoringWorker } from "../src/server/payments/payment-monitoring-worker.ts";

/**
 * Dedicated Background Payment Monitoring Worker Runner.
 *
 * Continuously monitors active payment links and claims PostgreSQL leases via SKIP LOCKED.
 * Performs truthful reconciliation against provider status APIs and on-chain RPC verification.
 * Gracefully shuts down on SIGINT or SIGTERM signals.
 */
async function main(): Promise<void> {
  const workerId =
    process.env.FLOW_MONITORING_WORKER_ID ||
    `payment-monitor-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;

  const pollIntervalMs = Number(
    process.env.FLOW_MONITORING_POLL_INTERVAL_MS || "5000",
  );
  const batchSize = Number(process.env.FLOW_MONITORING_BATCH_SIZE || "10");
  const leaseSeconds = Number(
    process.env.FLOW_MONITORING_LEASE_SECONDS || "30",
  );

  const abortController = new AbortController();

  const shutdown = (signal: string) => {
    log("info", "worker_shutdown_signal_received", { workerId, signal });
    abortController.abort();
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  log("info", "payment_monitoring_runner_started", {
    workerId,
    pollIntervalMs,
    batchSize,
    leaseSeconds,
  });

  const worker = new PaymentMonitoringWorker({ workerId });

  try {
    await worker.runLoop({
      pollIntervalMs,
      batchSize,
      leaseSeconds,
      signal: abortController.signal,
    });
  } catch (err) {
    log("error", "payment_monitoring_runner_crashed", {
      workerId,
      error: err instanceof Error ? err.message : String(err),
      stack: err instanceof Error ? err.stack : undefined,
    });
    process.exit(1);
  }

  log("info", "payment_monitoring_runner_finished", { workerId });
  process.exit(0);
}

void main();

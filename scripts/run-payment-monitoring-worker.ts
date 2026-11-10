import { log } from "../src/foundation/logger.ts";
import { getPrismaClient } from "../src/foundation/prisma.ts";
import { readWalletConfig } from "../src/foundation/wallet-environment.ts";
import { OutLayerAdapter } from "../src/server/custody/outlayer-adapter.ts";
import { WalletProvisioningWorker } from "../src/server/custody/provisioning-worker.ts";
import { PaymentMonitoringWorker } from "../src/server/payments/payment-monitoring-worker.ts";

/**
 * Dedicated Background Payment & Wallet Provisioning Worker Runner.
 *
 * Continuously monitors active payment links and claims PostgreSQL leases via SKIP LOCKED.
 * Also processes queued OutLayer wallet provisioning jobs when custody environment is configured.
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
  let walletWorker: WalletProvisioningWorker | null = null;

  if (
    process.env.FLOW_OUTLAYER_API_URL &&
    process.env.FLOW_WALLET_ENCRYPTION_KEY
  ) {
    try {
      const walletConfig = readWalletConfig(process.env);
      const adapter = new OutLayerAdapter(
        process.env.FLOW_OUTLAYER_API_URL || walletConfig.apiUrl,
        5_000,
        { compatibilityConfig: walletConfig.compatibility },
      );
      walletWorker = new WalletProvisioningWorker({
        db: getPrismaClient("worker"),
        adapter,
        walletConfig,
        workerId: `${workerId}-custody`,
      });
      walletWorker.start(pollIntervalMs);
    } catch (err) {
      log("info", "wallet_provisioning_worker_not_started", {
        workerId,
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const shutdown = (signal: string) => {
    log("info", "worker_shutdown_signal_received", { workerId, signal });
    abortController.abort();
    if (walletWorker) {
      void walletWorker.stop();
    }
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

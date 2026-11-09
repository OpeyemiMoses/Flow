import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { isValidTransactionHash } from "../src/domain/ledger.ts";
import { PaymentMonitoringWorker } from "../src/server/payments/payment-monitoring-worker.ts";
import type { FlowDb } from "../src/foundation/prisma.ts";

describe("payments: payment monitoring worker & hash validation", () => {
  it("validates EVM transaction hashes (0x + 64 hex characters)", () => {
    const validEvmHash = "0x" + "a".repeat(64);
    const validMixedHex =
      "0x4f3edf983ac636a65a842ce7c78d9aa706d3b113bce9c46f30d7d21715b23b1d";
    assert.equal(isValidTransactionHash("base-mainnet", validEvmHash), true);
    assert.equal(
      isValidTransactionHash("ethereum-mainnet", validMixedHex),
      true,
    );
    assert.equal(isValidTransactionHash("eip155:8453", validEvmHash), true);

    // Invalid EVM hashes
    assert.equal(isValidTransactionHash("base-mainnet", "0x1234"), false); // too short
    assert.equal(
      isValidTransactionHash("base-mainnet", "0x" + "g".repeat(64)),
      false,
    ); // non-hex
    assert.equal(isValidTransactionHash("base-mainnet", "not_a_hash"), false);
    assert.equal(isValidTransactionHash("base-mainnet", ""), false);
  });

  it("validates Solana transaction signatures (Base58 80-90 characters)", () => {
    const validSolanaSig =
      "5VERv8NMvzbJMEdV8xnrLkEaWR436xQsGhmGLxrNdEd137KqD5N2wK1i4tGv3d8nZbG1mR6tWv2tB9gH8yK3mQp2";
    assert.equal(
      isValidTransactionHash("solana-mainnet", validSolanaSig),
      true,
    );

    // Invalid Solana signatures
    assert.equal(isValidTransactionHash("solana-mainnet", "too_short"), false);
    assert.equal(
      isValidTransactionHash("solana-mainnet", "0x" + "a".repeat(64)),
      false,
    ); // EVM format on Solana
    assert.equal(isValidTransactionHash("solana-mainnet", ""), false);
  });

  it("validates NEAR transaction hashes (Base58 40-50 characters)", () => {
    const validNearHash = "9tVNmJcQ1qXzZ6yL2p8bW4vR7mK5nE3tY1uH8oP6aDsF";
    assert.equal(isValidTransactionHash("near-mainnet", validNearHash), true);

    // Invalid NEAR hashes
    assert.equal(isValidTransactionHash("near-mainnet", "short"), false);
    assert.equal(isValidTransactionHash("near-mainnet", ""), false);
  });

  it("calculates exponential backoff intervals with jitter", () => {
    const worker = new PaymentMonitoringWorker({
      workerId: "test-worker-1",
      workerDb: {} as unknown as FlowDb,
    });

    const b0 = worker.computeBackoffMs(0);
    const b1 = worker.computeBackoffMs(1);
    const b2 = worker.computeBackoffMs(2);
    const b8 = worker.computeBackoffMs(8);

    assert.ok(b0 >= 2000 && b0 <= 3000);
    assert.ok(b1 >= 3000 && b1 <= 4000);
    assert.ok(b2 >= 4500 && b2 <= 5500);
    assert.ok(b8 <= 61000);

    const health = worker.getHealthStatus();
    assert.equal(health.workerId, "test-worker-1");
    assert.equal(health.isRunning, false);
    assert.equal(health.processedCount, 0);
  });

  it("runLoop gracefully handles cancellation via AbortSignal", async () => {
    const mockDb = {
      $queryRaw: async () => [],
    } as unknown as FlowDb;

    const worker = new PaymentMonitoringWorker({
      workerId: "test-loop-worker",
      workerDb: mockDb,
    });

    const ac = new AbortController();
    setTimeout(() => ac.abort(), 50);

    await worker.runLoop({
      pollIntervalMs: 10,
      signal: ac.signal,
    });

    const health = worker.getHealthStatus();
    assert.equal(health.isRunning, false);
  });
});

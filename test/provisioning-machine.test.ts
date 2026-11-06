import assert from "node:assert/strict";
import { test } from "node:test";
import {
  reduceProvisioningState,
  type ProvisioningMachineState,
} from "../src/domain/provisioning-machine.ts";

function initialPending(accountId = "acc-1"): ProvisioningMachineState {
  return {
    accountId,
    status: "PENDING",
    attempts: 0,
  };
}

test("happy path: progresses through lease, submission, provisioning, and active verification", () => {
  const t0 = new Date("2026-11-06T12:00:00Z");
  const t1 = new Date("2026-11-06T12:00:01Z");
  const t2 = new Date("2026-11-06T12:00:02Z");
  const t3 = new Date("2026-11-06T12:00:03Z");
  const t4 = new Date("2026-11-06T12:00:04Z");

  // 1. Acquire lease
  const s1 = reduceProvisioningState(initialPending(), {
    type: "ACQUIRE_LEASE",
    leaseExpiresAt: new Date(t0.getTime() + 30_000),
    leaseHolder: "worker-1",
    now: t0,
  });
  assert.equal(s1.status, "LEASED");
  assert.equal(s1.attempts, 1);
  assert.equal(s1.leaseHolder, "worker-1");

  // 2. Dispatch call
  const s2 = reduceProvisioningState(s1, {
    type: "RECORD_DISPATCH",
    requestId: "req-1",
    now: t1,
  });
  assert.equal(s2.status, "SUBMITTED");

  // 3. Receive OutLayer success
  const s3 = reduceProvisioningState(s2, {
    type: "RECEIVE_SUCCESS",
    walletId: "outlayer-wallet-uuid",
    nearAccountId:
      "98793cd91a3f870fb126f66285808c7e094afcfc4eda8a970f6644ac0a4961ac",
    now: t2,
  });
  assert.equal(s3.status, "PROVISIONED");
  assert.equal(s3.walletId, "outlayer-wallet-uuid");
  assert.equal(s3.leaseHolder, undefined);

  // 4. Policy verification
  const s4 = reduceProvisioningState(s3, {
    type: "START_POLICY_VERIFICATION",
    now: t3,
  });
  assert.equal(s4.status, "POLICY_VERIFYING");

  // 5. Policy verified -> ACTIVE
  const s5 = reduceProvisioningState(s4, {
    type: "POLICY_VERIFIED",
    controller: "owner.near",
    now: t4,
  });
  assert.equal(s5.status, "ACTIVE");
});

test("critical safety: ambiguous provider response transitions to UNKNOWN and blocks auto-retry", () => {
  const t0 = new Date("2026-11-06T12:00:00Z");
  const t1 = new Date("2026-11-06T12:00:01Z");
  const t2 = new Date("2026-11-06T12:00:15Z");

  const s1 = reduceProvisioningState(initialPending(), {
    type: "ACQUIRE_LEASE",
    leaseExpiresAt: new Date(t0.getTime() + 30_000),
    leaseHolder: "worker-1",
    now: t0,
  });
  const s2 = reduceProvisioningState(s1, {
    type: "RECORD_DISPATCH",
    requestId: "req-2",
    now: t1,
  });

  // Ambiguous outcome (e.g. gateway timeout or TCP connection reset after request sent)
  const s3 = reduceProvisioningState(s2, {
    type: "RECEIVE_AMBIGUOUS_ERROR",
    error: "GATEWAY_TIMEOUT_504",
    now: t2,
  });

  assert.equal(s3.status, "UNKNOWN");
  assert.equal(s3.lastError, "GATEWAY_TIMEOUT_504");

  // CRITICAL CHECK: Attempting to re-acquire lease automatically must throw
  assert.throws(
    () =>
      reduceProvisioningState(s3, {
        type: "ACQUIRE_LEASE",
        leaseExpiresAt: new Date(t2.getTime() + 30_000),
        leaseHolder: "worker-2",
        now: t2,
      }),
    (err: unknown) => {
      return (
        err !== null &&
        typeof err === "object" &&
        "code" in err &&
        err.code === "INVALID_STATE_TRANSITION"
      );
    },
  );
});

test("escalates UNKNOWN to MANUAL_REVIEW and allows operator resolution", () => {
  const t0 = new Date("2026-11-06T12:00:00Z");
  const unknownState: ProvisioningMachineState = {
    accountId: "acc-ambiguous",
    status: "UNKNOWN",
    attempts: 1,
    lastError: "ETIMEDOUT",
  };

  // Escalate
  const reviewed = reduceProvisioningState(unknownState, {
    type: "ESCALATE_TO_MANUAL_REVIEW",
    reason: "Investigating OutLayer logs for possible orphan wallet",
    now: t0,
  });
  assert.equal(reviewed.status, "MANUAL_REVIEW");
  assert.equal(
    reviewed.manualReviewReason,
    "Investigating OutLayer logs for possible orphan wallet",
  );

  // Operator confirms wallet was indeed created and supplies recovered wallet ID
  const resolved = reduceProvisioningState(reviewed, {
    type: "OPERATOR_RESOLVE_WALLET",
    walletId: "recovered-wallet-id",
    now: t0,
  });
  assert.equal(resolved.status, "PROVISIONED");
  assert.equal(resolved.walletId, "recovered-wallet-id");
});

test("allows lease recovery if previous lease expired before dispatch", () => {
  const t0 = new Date("2026-11-06T12:00:00Z");
  const s1 = reduceProvisioningState(initialPending(), {
    type: "ACQUIRE_LEASE",
    leaseExpiresAt: new Date(t0.getTime() + 10_000),
    leaseHolder: "worker-dead",
    now: t0,
  });

  // 15 seconds later (lease expired without dispatch)
  const t1 = new Date(t0.getTime() + 15_000);
  const s2 = reduceProvisioningState(s1, {
    type: "ACQUIRE_LEASE",
    leaseExpiresAt: new Date(t1.getTime() + 30_000),
    leaseHolder: "worker-alive",
    now: t1,
  });

  assert.equal(s2.status, "LEASED");
  assert.equal(s2.attempts, 2);
  assert.equal(s2.leaseHolder, "worker-alive");
});

test("rejects invalid state transitions", () => {
  const pending = initialPending();
  const now = new Date();

  // Cannot jump directly from PENDING to ACTIVE
  assert.throws(() =>
    reduceProvisioningState(pending, { type: "POLICY_VERIFIED", now }),
  );

  // Cannot dispatch without lease
  assert.throws(() =>
    reduceProvisioningState(pending, {
      type: "RECORD_DISPATCH",
      requestId: "r",
      now,
    }),
  );
});

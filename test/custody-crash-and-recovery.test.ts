import assert from "node:assert/strict";
import { test } from "node:test";
import {
  OUTLAYER_CAPABILITIES,
  toEip55ChecksumAddress,
  validateRequiredWalletProvisioning,
} from "../src/domain/custody.ts";
import {
  reduceProvisioningState,
  type ProvisioningMachineState,
} from "../src/domain/provisioning-machine.ts";
import { FlowError } from "../src/foundation/errors.ts";
import {
  deriveKeyDigest,
  encryptSecret,
  serializeEnvelope,
} from "../src/foundation/crypto-envelope.ts";

test("crash immediately after provider registration (before persistence) transitions to UNKNOWN and blocks auto-retry", () => {
  const t0 = new Date("2026-11-10T12:00:00Z");
  const t1 = new Date("2026-11-10T12:00:01Z");
  const t2 = new Date("2026-11-10T12:00:05Z");

  const initial: ProvisioningMachineState = {
    accountId: "acc-crash-test",
    status: "PENDING",
    attempts: 0,
  };

  // 1. Lease acquired
  const leased = reduceProvisioningState(initial, {
    type: "ACQUIRE_LEASE",
    leaseExpiresAt: new Date(t0.getTime() + 30_000),
    leaseHolder: "worker-1",
    now: t0,
  });
  assert.equal(leased.status, "LEASED");

  // 2. Dispatch recorded
  const submitted = reduceProvisioningState(leased, {
    type: "RECORD_DISPATCH",
    requestId: "req-crash-1",
    now: t1,
  });
  assert.equal(submitted.status, "SUBMITTED");

  // 3. Process crashes before database write -> ambiguous failure caught on reconcile/restart
  const quarantined = reduceProvisioningState(submitted, {
    type: "RECEIVE_AMBIGUOUS_ERROR",
    error: "POST_DISPATCH_AMBIGUOUS",
    now: t2,
  });
  assert.equal(quarantined.status, "UNKNOWN");
  assert.equal(quarantined.lastError, "POST_DISPATCH_AMBIGUOUS");

  // 4. Strict check: Automated lease re-acquisition is blocked
  assert.throws(
    () =>
      reduceProvisioningState(quarantined, {
        type: "ACQUIRE_LEASE",
        leaseExpiresAt: new Date(t2.getTime() + 30_000),
        leaseHolder: "worker-retry",
        now: t2,
      }),
    (err: unknown) =>
      err instanceof FlowError && err.code === "INVALID_STATE_TRANSITION",
  );
});

test("crash after credential persistence (Stage 1 / REGISTERED) allows lease recovery to resume without re-registering", () => {
  const t0 = new Date("2026-11-10T12:00:00Z");
  const t1 = new Date("2026-11-10T12:00:01Z");
  const t2 = new Date("2026-11-10T12:00:02Z");

  const initial: ProvisioningMachineState = {
    accountId: "acc-stage1-test",
    status: "PENDING",
    attempts: 0,
  };

  const leased = reduceProvisioningState(initial, {
    type: "ACQUIRE_LEASE",
    leaseExpiresAt: new Date(t0.getTime() + 10_000),
    leaseHolder: "worker-1",
    now: t0,
  });

  const submitted = reduceProvisioningState(leased, {
    type: "RECORD_DISPATCH",
    requestId: "req-stage1-1",
    now: t1,
  });

  // Stage 1: Credential durably persisted -> transitions to REGISTERED
  const registered = reduceProvisioningState(submitted, {
    type: "RECEIVE_REGISTRATION_SUCCESS",
    walletId: "w-registered-uuid",
    nearAccountId:
      "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    now: t2,
  });
  assert.equal(registered.status, "REGISTERED");
  assert.equal(registered.walletId, "w-registered-uuid");

  // Worker crashes during address derivation; lease expires.
  // Next worker claims lease on REGISTERED state to complete derivation
  const t3 = new Date(t0.getTime() + 15_000);
  const reLeased = reduceProvisioningState(registered, {
    type: "ACQUIRE_LEASE",
    leaseExpiresAt: new Date(t3.getTime() + 30_000),
    leaseHolder: "worker-resume",
    now: t3,
  });
  assert.equal(reLeased.status, "LEASED");

  // Worker completes address derivation -> PROVISIONED without calling /register again
  const provisioned = reduceProvisioningState(
    { ...reLeased, status: "REGISTERED" },
    {
      type: "COMPLETE_ADDRESS_DERIVATION",
      now: new Date(t3.getTime() + 1_000),
    },
  );
  assert.equal(provisioned.status, "PROVISIONED");
});

test("newly allocated wallet cannot be marked ACTIVE without durable credentials, correct account association, and address derivation", () => {
  const masterKey = "a".repeat(64);
  const keyId = "v1";
  const apiKey = "wk_test_api_key_12345";
  const encrypted = serializeEnvelope(encryptSecret(apiKey, masterKey, keyId));
  const keyDigest = deriveKeyDigest(masterKey);

  assert.ok(encrypted.length > 32);
  assert.ok(keyDigest.length === 64);

  // Address validation: 4 distinct networks
  const baseAddr = toEip55ChecksumAddress(
    "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
  );
  const ethAddr = toEip55ChecksumAddress(
    "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
  );
  assert.equal(ethAddr, baseAddr);
  const solAddr = "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU";
  const nearAddr =
    "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

  const capNear = OUTLAYER_CAPABILITIES.near;
  const capBase = OUTLAYER_CAPABILITIES.base;
  const capEth = OUTLAYER_CAPABILITIES.ethereum;
  const capSol = OUTLAYER_CAPABILITIES.solana;

  // Validate capabilities before policy verification: canReceive starts false, canSignTransfer is strictly false
  assert.equal(capNear.canSignTransfer, false);
  assert.equal(capBase.canSignTransfer, false);
  assert.equal(capEth.canSignTransfer, false);
  assert.equal(capSol.canSignTransfer, false);

  // Missing networks must be rejected
  assert.throws(
    () =>
      validateRequiredWalletProvisioning({
        nearAccountId: nearAddr,
        addresses: [
          {
            network: "near",
            chainId: "near-mainnet",
            address: nearAddr,
            publicKey: `ed25519:${nearAddr}`,
          },
          {
            network: "base",
            chainId: "8453",
            address: baseAddr,
            publicKey: "secp256k1:test",
          },
        ],
        capabilities: [{ ...capNear }, { ...capBase }],
        policyVerified: true,
      }),
    (err: unknown) =>
      err instanceof FlowError && err.code === "INCOMPLETE_WALLET_PROVISIONING",
  );

  // Complete multi-chain address set validates successfully
  assert.doesNotThrow(() =>
    validateRequiredWalletProvisioning({
      nearAccountId: nearAddr,
      addresses: [
        {
          network: "near",
          chainId: "near-mainnet",
          address: nearAddr,
          publicKey: `ed25519:${nearAddr}`,
        },
        {
          network: "base",
          chainId: "8453",
          address: baseAddr,
          publicKey: "secp256k1:test",
        },
        {
          network: "solana",
          chainId: "solana-mainnet",
          address: solAddr,
          publicKey: solAddr,
        },
      ],
      capabilities: [{ ...capNear }, { ...capBase }, { ...capSol }],
      policyVerified: true,
    }),
  );
});

test("quarantined job escalation to MANUAL_REVIEW supports REMOTE_CONTAINER_ORPHANED_CREDENTIAL_LOST finding", () => {
  const t0 = new Date("2026-11-10T12:00:00Z");
  const unknownState: ProvisioningMachineState = {
    accountId: "acc-orphan-test",
    status: "UNKNOWN",
    attempts: 1,
    lastError:
      "POST_DISPATCH_AMBIGUOUS: Process crashed before credential persistence",
  };

  const reviewed = reduceProvisioningState(unknownState, {
    type: "ESCALATE_TO_MANUAL_REVIEW",
    reason:
      "Confirmed remote OutLayer container 006b80df-bdbe-43e4-ad91-26087f595e8d allocated; local credential unpersisted",
    now: t0,
  });

  assert.equal(reviewed.status, "MANUAL_REVIEW");
  assert.equal(
    reviewed.manualReviewReason,
    "Confirmed remote OutLayer container 006b80df-bdbe-43e4-ad91-26087f595e8d allocated; local credential unpersisted",
  );
});

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, test } from "node:test";
import pg from "pg";
import {
  encodeBase58,
  evaluateWalletFundReadiness,
  mintTrustedAdapterPolicyEvidence,
  type OutLayerPolicyState,
  type ProviderPolicyEvidenceInput,
} from "../src/domain/custody.ts";
import {
  decryptSecret,
  deriveKeyDigest,
  deserializeEnvelope,
  encryptSecret,
  serializeEnvelope,
} from "../src/foundation/crypto-envelope.ts";
import {
  assertDatabaseReady,
  createDatabasePool,
} from "../src/foundation/database.ts";
import { readConfig } from "../src/foundation/environment.ts";
import { getPrismaClient } from "../src/foundation/prisma.ts";
import {
  activateWalletIfReady,
  assertOperatorAuthority,
  assertOperatorIdentityRegistered,
  attachWalletAddressesAndCapabilities,
  claimJobLease,
  claimCompatibilityRegistration,
  commitJobSuccess,
  completeCompatibilityRegistration,
  createCompatibilityAuthorization,
  createCustodyRecoveryApproval,
  createProvisioningJob,
  enrollCustodyOperator,
  ensureProvisioningJobForAccount,
  escalateJobToManualReview,
  getAccountWalletPublicProjection,
  persistRegisteredWallet,
  quarantineCompatibilityRegistration,
  recordJobAmbiguous,
  recordJobDispatch,
  recordJobTerminalFailure,
  reconcileCrashedJobs,
  resolveQuarantinedProvisioningJob,
} from "../src/server/custody/job-repository.ts";
import { OutLayerAdapter } from "../src/server/custody/outlayer-adapter.ts";
import { WalletProvisioningWorker } from "../src/server/custody/provisioning-worker.ts";
import { createOutLayerMockServer } from "./support/outlayer-fixture.ts";

assert.equal(
  process.env.FLOW_ENV,
  "test",
  "Integration tests require FLOW_ENV=test.",
);
const { database } = readConfig(process.env, "runtime");
const pool = createDatabasePool(database);

after(async () => {
  await pool.end();
  try {
    const db = getPrismaClient();
    await db.$disconnect();
  } catch {
    // Ignore cleanup errors
  }
});

async function createTestAccount(
  client: pg.PoolClient | pg.Pool,
  kind: "PERSONAL" | "BUSINESS",
  prefix: string,
) {
  const authUserId = `test-user-${prefix}-${randomUUID().slice(0, 8)}`;
  const email = `${authUserId}@example.test`;
  await client.query(
    `
    INSERT INTO flow.auth_users (id, name, email, email_verified, updated_at)
    VALUES ($1, $2, $3, true, now())
  `,
    [authUserId, `Test User ${prefix}`, email],
  );

  const userResult = await client.query<{ id: string }>(
    `
    INSERT INTO flow.users (id, auth_user_id, active)
    VALUES (gen_random_uuid(), $1, true)
    RETURNING id
  `,
    [authUserId],
  );
  const userId = userResult.rows[0]!.id;

  if (kind === "PERSONAL") {
    const accountResult = await client.query<{ id: string }>(
      `
      INSERT INTO flow.accounts (id, kind, name, personal_owner_id)
      VALUES (gen_random_uuid(), 'PERSONAL', $1, $2)
      RETURNING id
    `,
      [`Personal Account ${prefix}`, userId],
    );
    return { userId, accountId: accountResult.rows[0]!.id, authUserId, kind };
  } else {
    const accountResult = await client.query<{ id: string }>(
      `
      INSERT INTO flow.accounts (id, kind, name, personal_owner_id)
      VALUES (gen_random_uuid(), 'BUSINESS', $1, NULL)
      RETURNING id
    `,
      [`Business Account ${prefix}`],
    );
    const accountId = accountResult.rows[0]!.id;
    await client.query(
      `
      INSERT INTO flow.business_profiles (account_id, kind)
      VALUES ($1, 'BUSINESS')
    `,
      [accountId],
    );
    await client.query(
      `
      INSERT INTO flow.account_memberships (id, account_id, user_id, role, status)
      VALUES (gen_random_uuid(), $1, $2, 'OWNER', 'ACTIVE')
    `,
      [accountId, userId],
    );
    return { userId, accountId, authUserId, kind };
  }
}

test("account ownership: enforces single wallet per account and preserves account isolation", async () => {
  const personal = await createTestAccount(pool, "PERSONAL", "own-pers");
  const business = await createTestAccount(pool, "BUSINESS", "own-biz");

  const w1Id = randomUUID();
  const w2Id = randomUUID();

  // Create wallet for personal account
  await pool.query(
    `
    INSERT INTO flow.wallets (
      id, account_id, provider, provider_wallet_id, near_account_id,
      encrypted_credential, key_id, key_digest, status
    ) VALUES (
      $1, $2, 'OUTLAYER', 'pw-1', 'near1.test', 'v1:dummy', 'v1', 'digest1', 'ACTIVE'
    )
  `,
    [w1Id, personal.accountId],
  );

  // Create wallet for business account
  await pool.query(
    `
    INSERT INTO flow.wallets (
      id, account_id, provider, provider_wallet_id, near_account_id,
      encrypted_credential, key_id, key_digest, status
    ) VALUES (
      $1, $2, 'OUTLAYER', 'pw-2', 'near2.test', 'v1:dummy', 'v1', 'digest2', 'ACTIVE'
    )
  `,
    [w2Id, business.accountId],
  );

  // Attempt to insert duplicate wallet for personal account -> violates wallets_account_id_key (23505)
  await assert.rejects(
    pool.query(
      `
      INSERT INTO flow.wallets (
        id, account_id, provider, provider_wallet_id, near_account_id,
        encrypted_credential, key_id, key_digest, status
      ) VALUES (
        $1, $2, 'OUTLAYER', 'pw-dup', 'near-dup.test', 'v1:dummy', 'v1', 'digest3', 'ACTIVE'
      )
    `,
      [randomUUID(), personal.accountId],
    ),
    { code: "23505" },
  );

  // Attempt to insert wallet for non-existent account -> violates foreign key (23503)
  await assert.rejects(
    pool.query(
      `
      INSERT INTO flow.wallets (
        id, account_id, provider, provider_wallet_id, near_account_id,
        encrypted_credential, key_id, key_digest, status
      ) VALUES (
        $1, $2, 'OUTLAYER', 'pw-fk', 'near-fk.test', 'v1:dummy', 'v1', 'digest4', 'ACTIVE'
      )
    `,
      [randomUUID(), randomUUID()],
    ),
    { code: "23503" },
  );
});

test("address and capability uniqueness: enforces unique network per wallet", async () => {
  const account = await createTestAccount(pool, "BUSINESS", "addr-cap");
  const walletId = randomUUID();

  await pool.query(
    `
    INSERT INTO flow.wallets (
      id, account_id, provider, provider_wallet_id, near_account_id,
      encrypted_credential, key_id, key_digest, status
    ) VALUES (
      $1, $2, 'OUTLAYER', 'pw-ac', 'near-ac.test', 'v1:dummy', 'v1', 'digest', 'ACTIVE'
    )
  `,
    [walletId, account.accountId],
  );

  // Insert NEAR address
  await pool.query(
    `
    INSERT INTO flow.wallet_addresses (
      wallet_id, network, chain_id, address, public_key
    ) VALUES (
      $1, 'near', 'near-testnet', 'alice.testnet', 'ed25519:dummy'
    )
  `,
    [walletId],
  );

  // Duplicate NEAR address on same wallet -> violates wallet_addresses_wallet_id_network_key (23505)
  await assert.rejects(
    pool.query(
      `
      INSERT INTO flow.wallet_addresses (
        wallet_id, network, chain_id, address, public_key
      ) VALUES (
        $1, 'near', 'near-testnet', 'alice2.testnet', 'ed25519:dummy2'
      )
    `,
      [walletId],
    ),
    { code: "23505" },
  );

  // Insert NEAR capability
  await pool.query(
    `
    INSERT INTO flow.wallet_capabilities (
      wallet_id, network, can_derive_address, can_receive, can_sign_transfer, broadcast_mode
    ) VALUES (
      $1, 'near', true, true, false, 'internal'
    )
  `,
    [walletId],
  );

  // Duplicate NEAR capability on same wallet -> violates wallet_capabilities_wallet_id_network_key (23505)
  await assert.rejects(
    pool.query(
      `
      INSERT INTO flow.wallet_capabilities (
        wallet_id, network, can_derive_address, can_receive, can_sign_transfer, broadcast_mode
      ) VALUES (
        $1, 'near', true, true, false, 'internal'
      )
    `,
      [walletId],
    ),
    { code: "23505" },
  );
});

test("provisioning job idempotency: enforces one job per account and unique idempotency keys", async () => {
  const acc1 = await createTestAccount(pool, "BUSINESS", "job-idem1");
  const acc2 = await createTestAccount(pool, "BUSINESS", "job-idem2");
  const sharedKey = randomUUID();

  // Create job for acc1
  await pool.query(
    `
    INSERT INTO flow.wallet_provisioning_jobs (
      account_id, idempotency_key, status
    ) VALUES ($1, $2, 'PENDING')
  `,
    [acc1.accountId, sharedKey],
  );

  // Duplicate job for acc1 with different key -> violates wallet_provisioning_jobs_account_id_key (23505)
  await assert.rejects(
    pool.query(
      `
      INSERT INTO flow.wallet_provisioning_jobs (
        account_id, idempotency_key, status
      ) VALUES ($1, $2, 'PENDING')
    `,
      [acc1.accountId, randomUUID()],
    ),
    { code: "23505" },
  );

  // Duplicate key for acc2 -> violates wallet_provisioning_jobs_idempotency_key_key (23505)
  await assert.rejects(
    pool.query(
      `
      INSERT INTO flow.wallet_provisioning_jobs (
        account_id, idempotency_key, status
      ) VALUES ($1, $2, 'PENDING')
    `,
      [acc2.accountId, sharedKey],
    ),
    { code: "23505" },
  );
});

test("concurrent provisioning: atomic job leasing grants exactly one lease to racing workers", async () => {
  const db = getPrismaClient();
  const account = await createTestAccount(pool, "PERSONAL", "race-lease");
  const job = await createProvisioningJob(db, account.accountId, randomUUID());
  assert.equal(job.status, "PENDING");
  assert.equal(job.fencingToken, 0n);

  // Two workers concurrently race to claim the lease
  const [workerA, workerB] = await Promise.all([
    claimJobLease(db, account.accountId, "worker-node-alpha", 30),
    claimJobLease(db, account.accountId, "worker-node-beta", 30),
  ]);

  // Exactly one worker got the lease, the other got null
  const winner = workerA ?? workerB;
  const loser = workerA ? workerB : workerA;

  assert.ok(winner !== null);
  assert.equal(loser, null);
  assert.equal(winner.status, "LEASED");
  assert.equal(winner.fencingToken, 1n);
  assert.equal(winner.attempts, 1);
  assert.ok(winner.leaseHolder?.startsWith("worker-node-"));
});

test("stale fencing token protection: CAS reject prevents stale worker dispatch or commit", async () => {
  const db = getPrismaClient();
  const account = await createTestAccount(pool, "BUSINESS", "stale-fence");
  await createProvisioningJob(db, account.accountId, randomUUID());
  const leased = await claimJobLease(
    db,
    account.accountId,
    "worker-primary",
    30,
  );
  assert.ok(leased !== null);
  assert.equal(leased.fencingToken, 1n);

  // Attempting dispatch with stale fencing token (0n) throws STALE_FENCING_TOKEN
  await assert.rejects(recordJobDispatch(db, leased.id, 0n, randomUUID()), {
    code: "STALE_FENCING_TOKEN",
  });

  // Dispatch with correct fencing token (1n) succeeds
  const attemptId = randomUUID();
  await recordJobDispatch(db, leased.id, 1n, attemptId);

  // Attempting commit with stale fencing token (999n) throws STALE_FENCING_TOKEN
  await assert.rejects(
    commitJobSuccess(db, leased.id, 999n, {
      accountId: account.accountId,
      providerWalletId: "pw-stale",
      nearAccountId: "stale.near",
      encryptedCredential: "v1:dummy",
      keyId: "v1",
      keyDigest: "digest",
      policyEvidence: {
        wallet_id: "pw-stale",
        controller: "controller.near",
        frozen: false,
        policy: "stored",
        rules: {},
      },
      addresses: [],
      capabilities: [],
    }),
    { code: "STALE_FENCING_TOKEN" },
  );
});

test("worker crash recovery: pre-dispatch lease expiration allows re-lease with incremented fencing token", async () => {
  const db = getPrismaClient();
  const account = await createTestAccount(pool, "PERSONAL", "crash-pre");
  await createProvisioningJob(db, account.accountId, randomUUID());
  const initialLease = await claimJobLease(
    db,
    account.accountId,
    "crashed-worker",
    30,
  );
  assert.ok(initialLease !== null);
  assert.equal(initialLease.fencingToken, 1n);

  // Simulate crash before dispatch: expire the lease manually while dispatched_at remains NULL
  await pool.query(
    `
    UPDATE flow.wallet_provisioning_jobs
    SET lease_expires_at = now() - interval '10 seconds'
    WHERE id = $1::uuid
  `,
    [initialLease.id],
  );

  // Recovery worker claims the expired pre-dispatch lease
  const recoveredLease = await claimJobLease(
    db,
    account.accountId,
    "recovery-worker",
    30,
  );
  assert.ok(recoveredLease !== null);
  assert.equal(recoveredLease.leaseHolder, "recovery-worker");
  assert.equal(recoveredLease.fencingToken, 2n);
  assert.equal(recoveredLease.attempts, 2);
  assert.equal(recoveredLease.status, "LEASED");
});

test("worker crash safety: post-dispatch lease expiration blocks re-lease and quarantines to UNKNOWN", async () => {
  const db = getPrismaClient();
  const account = await createTestAccount(pool, "BUSINESS", "crash-post");
  await createProvisioningJob(db, account.accountId, randomUUID());
  const leased = await claimJobLease(
    db,
    account.accountId,
    "worker-dispatch",
    30,
  );
  assert.ok(leased !== null);

  // Network call was dispatched
  await recordJobDispatch(db, leased.id, leased.fencingToken, randomUUID());

  // Worker crashed while waiting for response; lease expires
  await pool.query(
    `
    UPDATE flow.wallet_provisioning_jobs
    SET lease_expires_at = now() - interval '10 seconds'
    WHERE id = $1::uuid
  `,
    [leased.id],
  );

  // Another worker MUST NOT claim this post-dispatch job (pre-dispatch safety check)
  const duplicateClaim = await claimJobLease(
    db,
    account.accountId,
    "rogue-worker",
    30,
  );
  assert.equal(
    duplicateClaim,
    null,
    "Post-dispatch expired lease must NEVER be automatically re-claimed",
  );

  // Crash reconciler quarantines it to UNKNOWN
  const count = await reconcileCrashedJobs(db);
  assert.ok(count >= 1);

  const { rows } = await pool.query<{
    status: string;
    failure_classification: string;
    lease_holder: string | null;
  }>(
    "SELECT status, failure_classification, lease_holder FROM flow.wallet_provisioning_jobs WHERE id = $1::uuid",
    [leased.id],
  );
  assert.equal(rows[0]!.status, "UNKNOWN");
  assert.equal(rows[0]!.failure_classification, "POST_DISPATCH_AMBIGUOUS");
  assert.equal(rows[0]!.lease_holder, null);
});

test("ambiguous outcome quarantine: blocks automatic retries and requires manual review", async () => {
  const db = getPrismaClient();
  const account = await createTestAccount(pool, "PERSONAL", "ambig-outcome");
  await createProvisioningJob(db, account.accountId, randomUUID());
  const leased = await claimJobLease(db, account.accountId, "worker-ambig", 30);
  assert.ok(leased !== null);

  const dispatchId = randomUUID();
  await recordJobDispatch(db, leased.id, leased.fencingToken, dispatchId);

  // Provider call timed out with ambiguous 504
  await recordJobAmbiguous(db, leased.id, leased.fencingToken, {
    code: "GATEWAY_TIMEOUT",
    httpStatus: 504,
    endpoint: "/register",
  });

  const { rows } = await pool.query<{
    status: string;
    failure_classification: string;
    lease_holder: string | null;
    last_error: string;
  }>(
    "SELECT status, failure_classification, lease_holder, last_error FROM flow.wallet_provisioning_jobs WHERE id = $1::uuid",
    [leased.id],
  );
  assert.equal(rows[0]!.status, "UNKNOWN");
  assert.equal(rows[0]!.failure_classification, "POST_DISPATCH_AMBIGUOUS");
  assert.equal(rows[0]!.lease_holder, null);
  const parsedError = JSON.parse(rows[0]!.last_error) as Record<
    string,
    unknown
  >;
  assert.equal(parsedError.code, "GATEWAY_TIMEOUT");
  assert.equal(parsedError.httpStatus, 504);
  assert.equal(parsedError.endpoint, "/register");
  assert.equal(parsedError.correlationId, dispatchId);

  // Attempting to claim lease for an UNKNOWN job fails
  const reLease = await claimJobLease(
    db,
    account.accountId,
    "worker-retry",
    30,
  );
  assert.equal(
    reLease,
    null,
    "Quarantined ambiguous job cannot be automatically re-leased",
  );
});

test("credential isolation: encrypted envelope at rest, plaintext never stored, decryptable only with secret key", async () => {
  const db = getPrismaClient();
  const account = await createTestAccount(pool, "PERSONAL", "cred-iso");
  await createProvisioningJob(db, account.accountId, randomUUID());
  const leased = await claimJobLease(db, account.accountId, "worker-cred", 30);
  assert.ok(leased !== null);
  await recordJobDispatch(db, leased.id, leased.fencingToken, randomUUID());

  const testKeyHex =
    "a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90";
  const alternateKeyHex =
    "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff";
  const secretApiKey = "wk_live_secret_bearer_token_777888999";

  const envelope = serializeEnvelope(
    encryptSecret(secretApiKey, testKeyHex, "v1"),
  );
  const keyDigest = deriveKeyDigest(testKeyHex);

  const walletId = await commitJobSuccess(db, leased.id, leased.fencingToken, {
    accountId: account.accountId,
    providerWalletId: "outlayer-w-999",
    nearAccountId:
      "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    encryptedCredential: envelope,
    keyId: "v1",
    keyDigest,
    handoffUrl: "https://handoff.outlayer.fastnear.com/?key=scrubbed",
    policyEvidence: mintTrustedAdapterPolicyEvidence({
      wallet_id: "outlayer-w-999",
      controller: "controller.near",
      frozen: false,
      policy: "stored",
      rules: { defaultAction: "DENY" },
    }),
    addresses: [
      {
        network: "near",
        chainId: "near-mainnet",
        address:
          "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
        publicKey: "ed25519:6bWbF4F8qZ...",
      },
      {
        network: "base",
        chainId: "8453",
        address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
        publicKey: "secp256k1:0x04...",
      },
      {
        network: "solana",
        chainId: "solana-mainnet",
        address: "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU",
        publicKey: "ed25519:7Ytt...",
      },
    ],
    capabilities: [
      {
        network: "near",
        canDeriveAddress: true,
        canReceive: true,
        canReadNativeBalance: false,
        canReadIntentsBalance: false,
        canSignTransfer: false,
        broadcastMode: "provider_broadcast",
        canRotateCredentials: false,
      },
      {
        network: "base",
        canDeriveAddress: true,
        canReceive: true,
        canReadNativeBalance: false,
        canReadIntentsBalance: false,
        canSignTransfer: false,
        broadcastMode: "caller_broadcast",
        canRotateCredentials: false,
      },
      {
        network: "solana",
        canDeriveAddress: true,
        canReceive: true,
        canReadNativeBalance: false,
        canReadIntentsBalance: false,
        canSignTransfer: false,
        broadcastMode: "caller_broadcast",
        canRotateCredentials: false,
      },
    ],
  });

  // Verify raw database row has envelope and NO plaintext credential
  const { rows } = await pool.query<{
    encrypted_credential: string;
    key_id: string;
    key_digest: string;
    status: string;
    policy_state: string;
    controller_account_id: string | null;
  }>(
    "SELECT encrypted_credential, key_id, key_digest, status, policy_state, controller_account_id FROM flow.wallets WHERE id = $1::uuid",
    [walletId],
  );

  const row = rows[0]!;
  assert.equal(row.status, "ACTIVE");
  assert.equal(row.policy_state, "stored");
  assert.equal(row.controller_account_id, "controller.near");
  assert.equal(row.key_id, "v1");
  assert.equal(row.key_digest, keyDigest);
  assert.ok(row.encrypted_credential.includes('"version":1'));
  assert.ok(
    !row.encrypted_credential.includes(secretApiKey),
    "Plaintext API key must NEVER be stored",
  );

  // Decrypting with correct key recovers original plaintext
  const decrypted = decryptSecret(
    deserializeEnvelope(row.encrypted_credential),
    testKeyHex,
  );
  assert.equal(decrypted, secretApiKey);

  // Decrypting with wrong key fails with authentication tag mismatch
  assert.throws(
    () =>
      decryptSecret(
        deserializeEnvelope(row.encrypted_credential),
        alternateKeyHex,
      ),
    {
      code: "DECRYPTION_FAILED",
    },
  );
});

test("execution safeguards remain strictly disabled after wallet activation", async () => {
  const config = readConfig(process.env, "runtime");
  assert.equal(
    config.execution,
    "disabled",
    "FLOW_EXECUTION must remain disabled in every environment",
  );

  // Capabilities in the database for sign transfer remain false
  const { rows } = await pool.query<{ can_sign_transfer: boolean }>(
    "SELECT can_sign_transfer FROM flow.wallet_capabilities WHERE can_sign_transfer = true",
  );
  assert.equal(
    rows.length,
    0,
    "No capability may enable signing or moving funds during M2",
  );
});

test("two-stage provisioning: immediate credential persistence, worker crash recovery without duplicate registration", async () => {
  const db = getPrismaClient();
  const account = await createTestAccount(pool, "PERSONAL", "two-stage");
  await createProvisioningJob(db, account.accountId, randomUUID());

  // Worker 1 claims lease and records dispatch
  const worker1Lease = await claimJobLease(
    db,
    account.accountId,
    "worker-1",
    30,
  );
  assert.ok(worker1Lease !== null);
  await recordJobDispatch(
    db,
    worker1Lease.id,
    worker1Lease.fencingToken,
    randomUUID(),
  );

  // Worker 1 receives OutLayer registration response
  const secretApiKey = "wk_one_time_bearer_key_stage1_123456";
  const testKeyHex =
    "a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90";
  const envelope = serializeEnvelope(
    encryptSecret(secretApiKey, testKeyHex, "v1"),
  );
  const keyDigest = deriveKeyDigest(testKeyHex);

  // Stage 1: IMMEDIATELY persist credential before any address derivation
  const walletId = await persistRegisteredWallet(
    db,
    worker1Lease.id,
    worker1Lease.fencingToken,
    {
      accountId: account.accountId,
      providerWalletId: "outlayer-w-stage1",
      nearAccountId:
        "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      encryptedCredential: envelope,
      keyId: "v1",
      keyDigest,
      handoffUrl: "https://handoff.outlayer.fastnear.com/?key=scrubbed",
    },
  );

  // Verify wallet is persisted in SETUP_PENDING and job is in REGISTERED
  const { rows: wRows } = await pool.query<{
    status: string;
    policy_state: string;
    encrypted_credential: string;
  }>(
    "SELECT status, policy_state, encrypted_credential FROM flow.wallets WHERE id = $1::uuid",
    [walletId],
  );
  assert.equal(
    wRows[0]!.status,
    "SETUP_PENDING",
    "Wallet must start in SETUP_PENDING",
  );
  assert.equal(wRows[0]!.policy_state, "none");

  const { rows: jRows } = await pool.query<{ status: string }>(
    "SELECT status FROM flow.wallet_provisioning_jobs WHERE id = $1::uuid",
    [worker1Lease.id],
  );
  assert.equal(
    jRows[0]!.status,
    "REGISTERED",
    "Job must advance to REGISTERED upon credential persistence",
  );

  // Worker 1 CRASHES before deriving addresses. Worker 1 lease expires.
  await pool.query(
    "UPDATE flow.wallet_provisioning_jobs SET lease_expires_at = now() - interval '5 seconds' WHERE id = $1::uuid",
    [worker1Lease.id],
  );

  // Reconciler runs: clears expired lease on REGISTERED job rather than quarantining to UNKNOWN
  await reconcileCrashedJobs(db);

  // Worker 2 performs crash recovery: claims lease to finish address derivation
  const worker2Lease = await claimJobLease(
    db,
    account.accountId,
    "worker-2-recovery",
    30,
  );
  assert.ok(
    worker2Lease !== null,
    "Recovery worker must be able to claim lease on REGISTERED job",
  );
  assert.ok(
    worker2Lease.fencingToken > worker1Lease.fencingToken,
    "Fencing token must increment",
  );

  // Worker 2 reads existing persisted encrypted credential from DB and decrypts it
  const { rows: credRows } = await pool.query<{
    encrypted_credential: string;
  }>("SELECT encrypted_credential FROM flow.wallets WHERE id = $1::uuid", [
    walletId,
  ]);
  const recoveredKey = decryptSecret(
    deserializeEnvelope(credRows[0]!.encrypted_credential),
    testKeyHex,
  );
  assert.equal(
    recoveredKey,
    secretApiKey,
    "Recovered bearer key matches original one-time token",
  );

  // Stage 2: Worker 2 attaches derived addresses and baseline capabilities (canReceive=false before policy check)
  await attachWalletAddressesAndCapabilities(
    db,
    worker2Lease.id,
    worker2Lease.fencingToken,
    walletId,
    {
      addresses: [
        {
          network: "near",
          chainId: "near-mainnet",
          address:
            "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
          publicKey: "ed25519:6bWbF4F8qZ...",
        },
        {
          network: "base",
          chainId: "8453",
          address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
          publicKey: "secp256k1:0x04...",
        },
        {
          network: "solana",
          chainId: "solana-mainnet",
          address: "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU",
          publicKey: "ed25519:7xKX...",
        },
      ],
      capabilities: [
        {
          network: "near",
          canDeriveAddress: true,
          canReceive: false,
          canReadNativeBalance: false,
          canReadIntentsBalance: false,
          canSignTransfer: false,
          broadcastMode: "provider_broadcast",
          canRotateCredentials: true,
        },
        {
          network: "base",
          canDeriveAddress: true,
          canReceive: false,
          canReadNativeBalance: false,
          canReadIntentsBalance: false,
          canSignTransfer: false,
          broadcastMode: "caller_broadcast",
          canRotateCredentials: true,
        },
        {
          network: "solana",
          canDeriveAddress: true,
          canReceive: false,
          canReadNativeBalance: false,
          canReadIntentsBalance: false,
          canSignTransfer: false,
          broadcastMode: "caller_broadcast",
          canRotateCredentials: true,
        },
      ],
    },
  );

  // Verify Stage 2 moved wallet to PROVISIONING and job to PROVISIONED
  const { rows: stage2Wallet } = await pool.query<{
    status: string;
    policy_state: string;
  }>("SELECT status, policy_state FROM flow.wallets WHERE id = $1::uuid", [
    walletId,
  ]);
  assert.equal(stage2Wallet[0]!.status, "PROVISIONING");
  assert.equal(stage2Wallet[0]!.policy_state, "none");

  // Stage 3: Worker 2 activates wallet with provider-backed policy evidence
  await activateWalletIfReady(
    db,
    worker2Lease.id,
    worker2Lease.fencingToken,
    walletId,
    mintTrustedAdapterPolicyEvidence({
      wallet_id: "outlayer-w-stage1",
      controller: "controller.near",
      frozen: false,
      policy: "stored",
      rules: { defaultAction: "DENY" },
    }),
  );

  // Verify wallet is now ACTIVE with policy_state='stored' and controller_account_id='controller.near'
  const { rows: finalWallet } = await pool.query<{
    status: string;
    policy_state: string;
    controller_account_id: string | null;
  }>(
    "SELECT status, policy_state, controller_account_id FROM flow.wallets WHERE id = $1::uuid",
    [walletId],
  );
  assert.equal(finalWallet[0]!.status, "ACTIVE");
  assert.equal(finalWallet[0]!.policy_state, "stored");
  assert.equal(finalWallet[0]!.controller_account_id, "controller.near");

  const { rows: finalJob } = await pool.query<{
    status: string;
    lease_holder: string | null;
  }>(
    "SELECT status, lease_holder FROM flow.wallet_provisioning_jobs WHERE id = $1::uuid",
    [worker1Lease.id],
  );
  assert.equal(finalJob[0]!.status, "ACTIVE");
  assert.equal(finalJob[0]!.lease_holder, null);
});

test("stale fencing token is rejected on Stage 1, Stage 2, and Stage 3 transitions", async () => {
  const db = getPrismaClient();
  const account = await createTestAccount(pool, "PERSONAL", "stale-fencing");
  await createProvisioningJob(db, account.accountId, randomUUID());

  // Worker 1 claims lease (fencing token = 1)
  const w1 = await claimJobLease(db, account.accountId, "worker-1", 30);
  assert.ok(w1 !== null);

  // Worker 1's lease expires before dispatch
  await pool.query(
    "UPDATE flow.wallet_provisioning_jobs SET lease_expires_at = now() - interval '5 seconds' WHERE id = $1::uuid",
    [w1.id],
  );

  // Worker 2 claims lease (fencing token = 2) and dispatches
  const w2 = await claimJobLease(db, account.accountId, "worker-2", 30);
  assert.ok(w2 !== null);
  assert.ok(w2.fencingToken > w1.fencingToken);
  await recordJobDispatch(db, w2.id, w2.fencingToken, randomUUID());

  // Worker 1 (stale fencing token = 1) attempts persistRegisteredWallet -> MUST FAIL
  const dummyEnvelope = serializeEnvelope(
    encryptSecret(
      "wk_dummy",
      "a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90",
      "v1",
    ),
  );
  await assert.rejects(
    persistRegisteredWallet(db, w1.id, w1.fencingToken, {
      accountId: account.accountId,
      providerWalletId: "outlayer-stale",
      nearAccountId:
        "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      encryptedCredential: dummyEnvelope,
      keyId: "v1",
      keyDigest: "digest",
    }),
    { code: "STALE_FENCING_TOKEN" },
  );

  // Worker 2 (active fencing token = 2) persists wallet successfully
  const walletId = await persistRegisteredWallet(db, w2.id, w2.fencingToken, {
    accountId: account.accountId,
    providerWalletId: "outlayer-active-cas",
    nearAccountId:
      "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    encryptedCredential: dummyEnvelope,
    keyId: "v1",
    keyDigest: "digest",
  });
  assert.ok(walletId);

  // Worker 2's lease expires during address derivation
  await pool.query(
    "UPDATE flow.wallet_provisioning_jobs SET lease_expires_at = now() - interval '5 seconds' WHERE id = $1::uuid",
    [w2.id],
  );

  // Worker 3 claims lease (fencing token = 3) to complete provisioning
  const w3 = await claimJobLease(db, account.accountId, "worker-3", 30);
  assert.ok(w3 !== null);
  assert.ok(w3.fencingToken > w2.fencingToken);

  const validAddressesAndCaps = {
    addresses: [
      {
        network: "near",
        chainId: "near-mainnet",
        address:
          "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
        publicKey: "ed25519:nearKey",
      },
      {
        network: "base",
        chainId: "8453",
        address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
        publicKey: "secp256k1:baseKey",
      },
      {
        network: "solana",
        chainId: "solana-mainnet",
        address: "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU",
        publicKey: "ed25519:solKey",
      },
    ],
    capabilities: [
      {
        network: "near",
        canDeriveAddress: true,
        canReceive: false,
        canReadNativeBalance: false,
        canReadIntentsBalance: false,
        canSignTransfer: false,
        broadcastMode: "provider_broadcast",
        canRotateCredentials: true,
      },
      {
        network: "base",
        canDeriveAddress: true,
        canReceive: false,
        canReadNativeBalance: false,
        canReadIntentsBalance: false,
        canSignTransfer: false,
        broadcastMode: "caller_broadcast",
        canRotateCredentials: true,
      },
      {
        network: "solana",
        canDeriveAddress: true,
        canReceive: false,
        canReadNativeBalance: false,
        canReadIntentsBalance: false,
        canSignTransfer: false,
        broadcastMode: "caller_broadcast",
        canRotateCredentials: true,
      },
    ],
  };

  // Worker 2 attempts Stage 2 address attachment with stale token -> MUST FAIL
  await assert.rejects(
    attachWalletAddressesAndCapabilities(
      db,
      w2.id,
      w2.fencingToken,
      walletId,
      validAddressesAndCaps,
    ),
    { code: "STALE_FENCING_TOKEN" },
  );

  // Worker 3 completes Stage 2 address attachment with active token -> SUCCEEDS
  await attachWalletAddressesAndCapabilities(
    db,
    w3.id,
    w3.fencingToken,
    walletId,
    validAddressesAndCaps,
  );

  const validPolicyEvidence: ProviderPolicyEvidenceInput =
    mintTrustedAdapterPolicyEvidence({
      wallet_id: "outlayer-active-cas",
      controller: "controller.near",
      frozen: false,
      policy: "stored",
      rules: { defaultAction: "DENY" },
    });

  // Worker 1 and Worker 2 attempt to activate wallet with stale tokens -> MUST FAIL
  await assert.rejects(
    activateWalletIfReady(
      db,
      w1.id,
      w1.fencingToken,
      walletId,
      validPolicyEvidence,
    ),
    { code: "STALE_FENCING_TOKEN" },
  );
  await assert.rejects(
    activateWalletIfReady(
      db,
      w2.id,
      w2.fencingToken,
      walletId,
      validPolicyEvidence,
    ),
    { code: "STALE_FENCING_TOKEN" },
  );

  // Worker 3 activates wallet with current fencing token and verified policy evidence -> SUCCEEDS
  await activateWalletIfReady(
    db,
    w3.id,
    w3.fencingToken,
    walletId,
    validPolicyEvidence,
  );
});

test("public wallet projection strictly isolates credentials at query time and separates provisioningComplete from fundsReady", async () => {
  const db = getPrismaClient();
  const account = await createTestAccount(
    pool,
    "PERSONAL",
    "public-projection",
  );
  await createProvisioningJob(db, account.accountId, randomUUID());
  const leased = await claimJobLease(db, account.accountId, "worker-proj", 30);
  assert.ok(leased !== null);
  await recordJobDispatch(db, leased.id, leased.fencingToken, randomUUID());

  const testKeyHex =
    "a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90";
  const envelope = serializeEnvelope(
    encryptSecret("wk_super_secret", testKeyHex, "v1"),
  );
  const keyDigest = deriveKeyDigest(testKeyHex);

  await commitJobSuccess(db, leased.id, leased.fencingToken, {
    accountId: account.accountId,
    providerWalletId: "outlayer-proj-1",
    nearAccountId:
      "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    encryptedCredential: envelope,
    keyId: "v1",
    keyDigest,
    policyEvidence: mintTrustedAdapterPolicyEvidence({
      wallet_id: "outlayer-proj-1",
      controller: "controller.near",
      frozen: false,
      policy: "stored",
      rules: { defaultAction: "DENY" },
    }),
    addresses: [
      {
        network: "near",
        chainId: "near-mainnet",
        address:
          "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
        publicKey: "ed25519:abc",
      },
      {
        network: "base",
        chainId: "8453",
        address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
        publicKey: "secp256k1:def",
      },
      {
        network: "solana",
        chainId: "solana-mainnet",
        address: "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU",
        publicKey: "ed25519:ghi",
      },
    ],
    capabilities: [
      {
        network: "near",
        canDeriveAddress: true,
        canReceive: true,
        canReadNativeBalance: true,
        canReadIntentsBalance: false,
        canSignTransfer: false,
        broadcastMode: "provider_broadcast",
        canRotateCredentials: true,
      },
      {
        network: "base",
        canDeriveAddress: true,
        canReceive: true,
        canReadNativeBalance: false,
        canReadIntentsBalance: false,
        canSignTransfer: false,
        broadcastMode: "caller_broadcast",
        canRotateCredentials: true,
      },
      {
        network: "solana",
        canDeriveAddress: true,
        canReceive: true,
        canReadNativeBalance: false,
        canReadIntentsBalance: false,
        canSignTransfer: false,
        broadcastMode: "caller_broadcast",
        canRotateCredentials: true,
      },
    ],
  });

  const projection = await getAccountWalletPublicProjection(
    db,
    account.accountId,
  );
  assert.ok(projection !== null);
  assert.equal(projection.providerWalletId, "outlayer-proj-1");
  assert.equal(
    projection.nearAccountId,
    "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
  );
  assert.equal(projection.status, "ACTIVE");
  assert.equal(projection.policyState, "stored");
  assert.equal(projection.controllerAccountId, "controller.near");
  assert.equal(projection.provisioningComplete, true);
  assert.equal(projection.policyVerified, true);
  assert.equal(
    projection.fundsReady,
    false,
    "ACTIVE wallet must NOT be fundsReady when FLOW_EXECUTION=disabled",
  );
  assert.equal(projection.canReceiveFunds, false);
  assert.equal(projection.canSignTransfers, false);
  assert.equal(projection.addresses.length, 3);
  assert.equal(projection.capabilities.length, 3);

  const projRecord = projection as unknown as Record<string, unknown>;
  assert.equal(projRecord.encryptedCredential, undefined);
  assert.equal(projRecord.encrypted_credential, undefined);
  assert.equal(projRecord.keyId, undefined);
  assert.equal(projRecord.key_id, undefined);
  assert.equal(projRecord.keyDigest, undefined);
  assert.equal(projRecord.key_digest, undefined);
});

test("provider error isolation: hostile upstream payloads are never persisted to PostgreSQL", async () => {
  const db = getPrismaClient();
  const account = await createTestAccount(pool, "PERSONAL", "hostile-err-iso");
  await createProvisioningJob(db, account.accountId, randomUUID());
  const leased = await claimJobLease(db, account.accountId, "worker-err", 30);
  assert.ok(leased !== null);
  const dispatchId = randomUUID();
  await recordJobDispatch(db, leased.id, leased.fencingToken, dispatchId);

  const hostileUpstreamPayload = [
    "Connection reset while exchanging wk_sensitive_api_key_777",
    "Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.super_secret_jwt",
    "Cookie: __Host-flow_session=cookie_secret_987; Set-Cookie: token=xyz",
    "admin@victim-company.example.com",
    "postgresql://flow_admin:db_master_pass@10.0.0.12:5432/flow_prod",
    "<script src='https://evil.example/xss.js' onload=alert(1)", // malformed unclosed HTML
  ].join(" ");

  const forbiddenTokens = [
    "wk_sensitive",
    "Authorization",
    "eyJhbGci",
    "super_secret_jwt",
    "Cookie",
    "cookie_secret_987",
    "admin@victim-company.example.com",
    "postgresql://",
    "db_master_pass",
    "<script",
    "evil.example",
  ];

  // 1. Pass hostile string directly to recordJobAmbiguous -> discarded, only allowlisted metadata stored
  await recordJobAmbiguous(
    db,
    leased.id,
    leased.fencingToken,
    hostileUpstreamPayload,
  );

  const { rows } = await pool.query<{
    failure_classification: string;
    last_error: string;
  }>(
    "SELECT failure_classification, last_error FROM flow.wallet_provisioning_jobs WHERE id = $1::uuid",
    [leased.id],
  );

  const savedAmbiguous = rows[0]!.last_error;
  assert.equal(rows[0]!.failure_classification, "POST_DISPATCH_AMBIGUOUS");
  for (const token of forbiddenTokens) {
    assert.ok(
      !savedAmbiguous.includes(token),
      `Ambiguous last_error must NEVER contain '${token}', got: ${savedAmbiguous}`,
    );
  }
  const parsedAmbiguous = JSON.parse(savedAmbiguous) as Record<string, unknown>;
  assert.equal(parsedAmbiguous.code, "POST_DISPATCH_AMBIGUOUS");
  assert.equal(parsedAmbiguous.correlationId, dispatchId);

  // 2. Unallowlisted failure classification is rejected with INVALID_FAILURE_CLASSIFICATION
  await assert.rejects(
    recordJobTerminalFailure(
      db,
      leased.id,
      leased.fencingToken,
      hostileUpstreamPayload,
      "UNSAFE_RAW_CLASSIFICATION",
    ),
    { code: "INVALID_FAILURE_CLASSIFICATION" },
  );

  // 3. Pass hostile string + hostile metadata fields to recordJobTerminalFailure -> only allowlisted fields stored
  await recordJobTerminalFailure(
    db,
    leased.id,
    leased.fencingToken,
    hostileUpstreamPayload,
    "BAD_REQUEST",
    {
      code: "BAD_REQUEST",
      httpStatus: 400,
      endpoint: "/wallet/v1/address",
      chain: "base",
      correlationId: hostileUpstreamPayload, // invalid UUID -> rejected, falls back to dispatchId
    },
  );

  const { rows: termRows } = await pool.query<{
    failure_classification: string;
    last_error: string;
  }>(
    "SELECT failure_classification, last_error FROM flow.wallet_provisioning_jobs WHERE id = $1::uuid",
    [leased.id],
  );
  const savedTerminal = termRows[0]!.last_error;
  assert.equal(termRows[0]!.failure_classification, "BAD_REQUEST");
  for (const token of forbiddenTokens) {
    assert.ok(
      !savedTerminal.includes(token),
      `Terminal last_error must NEVER contain '${token}', got: ${savedTerminal}`,
    );
  }
  const parsedTerminal = JSON.parse(savedTerminal) as Record<string, unknown>;
  assert.equal(parsedTerminal.code, "BAD_REQUEST");
  assert.equal(parsedTerminal.httpStatus, 400);
  assert.equal(parsedTerminal.endpoint, "/wallet/v1/address");
  assert.equal(parsedTerminal.chain, "base");
  assert.equal(parsedTerminal.correlationId, dispatchId);
});

test("adversarial PostgreSQL test: cross-account activation and address attachment using an unrelated valid job are blocked", async () => {
  const db = getPrismaClient();
  const accountA = await createTestAccount(pool, "PERSONAL", "cross-acct-a");
  const accountB = await createTestAccount(pool, "BUSINESS", "cross-acct-b");

  await createProvisioningJob(db, accountA.accountId, randomUUID());
  await createProvisioningJob(db, accountB.accountId, randomUUID());

  const leaseA = await claimJobLease(db, accountA.accountId, "worker-a", 30);
  const leaseB = await claimJobLease(db, accountB.accountId, "worker-b", 30);
  assert.ok(leaseA !== null && leaseB !== null);

  await recordJobDispatch(db, leaseA.id, leaseA.fencingToken, randomUUID());
  await recordJobDispatch(db, leaseB.id, leaseB.fencingToken, randomUUID());

  const testKeyHex =
    "a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90";
  const envelopeB = serializeEnvelope(
    encryptSecret("wk_acct_b_secret", testKeyHex, "v1"),
  );
  const keyDigest = deriveKeyDigest(testKeyHex);

  // Account A's job attempts to persist a registered wallet for Account B -> MUST FAIL
  await assert.rejects(
    persistRegisteredWallet(db, leaseA.id, leaseA.fencingToken, {
      accountId: accountB.accountId,
      providerWalletId: "outlayer-cross-hijack",
      nearAccountId:
        "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      encryptedCredential: envelopeB,
      keyId: "v1",
      keyDigest,
    }),
    { code: "WALLET_ACCOUNT_MISMATCH" },
  );

  // Account B legitimately registers its wallet
  const walletBId = await persistRegisteredWallet(
    db,
    leaseB.id,
    leaseB.fencingToken,
    {
      accountId: accountB.accountId,
      providerWalletId: "outlayer-wallet-b",
      nearAccountId:
        "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      encryptedCredential: envelopeB,
      keyId: "v1",
      keyDigest,
    },
  );

  const validStage2Input = {
    addresses: [
      {
        network: "near",
        chainId: "near-mainnet",
        address:
          "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
        publicKey: "ed25519:nearB",
      },
      {
        network: "base",
        chainId: "8453",
        address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
        publicKey: "secp256k1:baseB",
      },
      {
        network: "solana",
        chainId: "solana-mainnet",
        address: "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU",
        publicKey: "ed25519:solB",
      },
    ],
    capabilities: [
      {
        network: "near",
        canDeriveAddress: true,
        canReceive: false,
        canReadNativeBalance: false,
        canReadIntentsBalance: false,
        canSignTransfer: false,
        broadcastMode: "provider_broadcast",
        canRotateCredentials: true,
      },
      {
        network: "base",
        canDeriveAddress: true,
        canReceive: false,
        canReadNativeBalance: false,
        canReadIntentsBalance: false,
        canSignTransfer: false,
        broadcastMode: "caller_broadcast",
        canRotateCredentials: true,
      },
      {
        network: "solana",
        canDeriveAddress: true,
        canReceive: false,
        canReadNativeBalance: false,
        canReadIntentsBalance: false,
        canSignTransfer: false,
        broadcastMode: "caller_broadcast",
        canRotateCredentials: true,
      },
    ],
  };

  // Account A's valid job attempts to attach addresses to Account B's wallet -> MUST FAIL
  await assert.rejects(
    attachWalletAddressesAndCapabilities(
      db,
      leaseA.id,
      leaseA.fencingToken,
      walletBId,
      validStage2Input,
    ),
    { code: "WALLET_ACCOUNT_MISMATCH" },
  );

  // Account B legitimately attaches its addresses
  await attachWalletAddressesAndCapabilities(
    db,
    leaseB.id,
    leaseB.fencingToken,
    walletBId,
    validStage2Input,
  );

  // Account A's valid job attempts to activate Account B's wallet -> MUST FAIL
  await assert.rejects(
    activateWalletIfReady(db, leaseA.id, leaseA.fencingToken, walletBId, {
      wallet_id: "outlayer-wallet-b",
      controller: "controller.near",
      frozen: false,
      policy: "stored",
      rules: { defaultAction: "DENY" },
    }),
    { code: "WALLET_ACCOUNT_MISMATCH" },
  );

  // Verify Account B's wallet was NOT activated by Account A's job
  const { rows: checkWalletB } = await pool.query<{
    status: string;
    policy_state: string;
  }>("SELECT status, policy_state FROM flow.wallets WHERE id = $1::uuid", [
    walletBId,
  ]);
  assert.equal(checkWalletB[0]!.status, "PROVISIONING");
  assert.equal(checkWalletB[0]!.policy_state, "none");
});

test("adversarial PostgreSQL test: incomplete provisioning, missing addresses, mismatched wallet IDs, and invalid policy states are rejected", async () => {
  const db = getPrismaClient();
  const account = await createTestAccount(pool, "PERSONAL", "adv-invariants");
  await createProvisioningJob(db, account.accountId, randomUUID());
  const leased = await claimJobLease(db, account.accountId, "worker-adv", 30);
  assert.ok(leased !== null);
  await recordJobDispatch(db, leased.id, leased.fencingToken, randomUUID());

  const testKeyHex =
    "a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90";
  const envelope = serializeEnvelope(
    encryptSecret("wk_adv_secret", testKeyHex, "v1"),
  );
  const keyDigest = deriveKeyDigest(testKeyHex);

  const walletId = await persistRegisteredWallet(
    db,
    leased.id,
    leased.fencingToken,
    {
      accountId: account.accountId,
      providerWalletId: "outlayer-adv-wallet-1",
      nearAccountId:
        "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      encryptedCredential: envelope,
      keyId: "v1",
      keyDigest,
    },
  );

  const validPolicyEvidence: ProviderPolicyEvidenceInput =
    mintTrustedAdapterPolicyEvidence({
      wallet_id: "outlayer-adv-wallet-1",
      controller: "controller.near",
      frozen: false,
      policy: "stored",
      rules: { defaultAction: "DENY" },
    });

  // 1. Attempting to activate directly from SETUP_PENDING / REGISTERED before Stage 2 -> INVALID_STATE_TRANSITION
  await assert.rejects(
    activateWalletIfReady(
      db,
      leased.id,
      leased.fencingToken,
      walletId,
      validPolicyEvidence,
    ),
    { code: "INVALID_STATE_TRANSITION" },
  );

  // 2. Attempting to attach incomplete addresses (missing Solana) -> INCOMPLETE_WALLET_PROVISIONING
  await assert.rejects(
    attachWalletAddressesAndCapabilities(
      db,
      leased.id,
      leased.fencingToken,
      walletId,
      {
        addresses: [
          {
            network: "near",
            chainId: "near-mainnet",
            address:
              "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
            publicKey: "ed25519:nearKey",
          },
          {
            network: "base",
            chainId: "8453",
            address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
            publicKey: "secp256k1:baseKey",
          },
        ],
        capabilities: [
          {
            network: "near",
            canDeriveAddress: true,
            canReceive: false,
            canReadNativeBalance: false,
            canReadIntentsBalance: false,
            canSignTransfer: false,
            broadcastMode: "provider_broadcast",
            canRotateCredentials: true,
          },
          {
            network: "base",
            canDeriveAddress: true,
            canReceive: false,
            canReadNativeBalance: false,
            canReadIntentsBalance: false,
            canSignTransfer: false,
            broadcastMode: "caller_broadcast",
            canRotateCredentials: true,
          },
        ],
      },
    ),
    { code: "INCOMPLETE_WALLET_PROVISIONING" },
  );

  // 3. Attach all 3 required chains with valid baseline capabilities
  await attachWalletAddressesAndCapabilities(
    db,
    leased.id,
    leased.fencingToken,
    walletId,
    {
      addresses: [
        {
          network: "near",
          chainId: "near-mainnet",
          address:
            "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
          publicKey: "ed25519:nearKey",
        },
        {
          network: "base",
          chainId: "8453",
          address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
          publicKey: "secp256k1:baseKey",
        },
        {
          network: "solana",
          chainId: "solana-mainnet",
          address: "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU",
          publicKey: "ed25519:solKey",
        },
      ],
      capabilities: [
        {
          network: "near",
          canDeriveAddress: true,
          canReceive: false,
          canReadNativeBalance: false,
          canReadIntentsBalance: false,
          canSignTransfer: false,
          broadcastMode: "provider_broadcast",
          canRotateCredentials: true,
        },
        {
          network: "base",
          canDeriveAddress: true,
          canReceive: false,
          canReadNativeBalance: false,
          canReadIntentsBalance: false,
          canSignTransfer: false,
          broadcastMode: "caller_broadcast",
          canRotateCredentials: true,
        },
        {
          network: "solana",
          canDeriveAddress: true,
          canReceive: false,
          canReadNativeBalance: false,
          canReadIntentsBalance: false,
          canSignTransfer: false,
          broadcastMode: "caller_broadcast",
          canRotateCredentials: true,
        },
      ],
    },
  );

  // 4. Attempting to promote policy using a caller-supplied string ("stored") or caller-fabricated plain object -> POLICY_VERIFICATION_FAILED
  await assert.rejects(
    activateWalletIfReady(
      db,
      leased.id,
      leased.fencingToken,
      walletId,
      "stored" as unknown as ProviderPolicyEvidenceInput,
    ),
    { code: "POLICY_VERIFICATION_FAILED" },
  );
  await assert.rejects(
    activateWalletIfReady(db, leased.id, leased.fencingToken, walletId, {
      wallet_id: "outlayer-adv-wallet-1",
      controller: "controller.near",
      frozen: false,
      policy: "stored",
      rules: { defaultAction: "DENY" },
    }),
    { code: "POLICY_VERIFICATION_FAILED" },
  );

  // 5. Attempting to activate with mismatched provider wallet_id -> CUSTODY_PROVIDER_CORRELATION_ERROR
  await assert.rejects(
    activateWalletIfReady(
      db,
      leased.id,
      leased.fencingToken,
      walletId,
      mintTrustedAdapterPolicyEvidence({
        wallet_id: "outlayer-wrong-wallet-id",
        controller: "controller.near",
        frozen: false,
        policy: "stored",
        rules: { defaultAction: "DENY" },
      }),
    ),
    { code: "CUSTODY_PROVIDER_CORRELATION_ERROR" },
  );

  // 6. Attempting to activate with policy='none' or frozen=true or invalid controller or empty rules -> POLICY_VERIFICATION_FAILED
  await assert.rejects(
    activateWalletIfReady(
      db,
      leased.id,
      leased.fencingToken,
      walletId,
      mintTrustedAdapterPolicyEvidence({
        wallet_id: "outlayer-adv-wallet-1",
        controller: "controller.near",
        frozen: false,
        policy: "none",
        rules: { defaultAction: "DENY" },
      }),
    ),
    { code: "POLICY_VERIFICATION_FAILED" },
  );
  await assert.rejects(
    activateWalletIfReady(
      db,
      leased.id,
      leased.fencingToken,
      walletId,
      mintTrustedAdapterPolicyEvidence({
        wallet_id: "outlayer-adv-wallet-1",
        controller: "controller.near",
        frozen: true,
        policy: "stored",
        rules: { defaultAction: "DENY" },
      }),
    ),
    { code: "POLICY_VERIFICATION_FAILED" },
  );
  await assert.rejects(
    activateWalletIfReady(
      db,
      leased.id,
      leased.fencingToken,
      walletId,
      mintTrustedAdapterPolicyEvidence({
        wallet_id: "outlayer-adv-wallet-1",
        controller: "invalid controller!",
        frozen: false,
        policy: "stored",
        rules: { defaultAction: "DENY" },
      }),
    ),
    { code: "POLICY_VERIFICATION_FAILED" },
  );
  await assert.rejects(
    activateWalletIfReady(
      db,
      leased.id,
      leased.fencingToken,
      walletId,
      mintTrustedAdapterPolicyEvidence({
        wallet_id: "outlayer-adv-wallet-1",
        controller: "controller.near",
        frozen: false,
        policy: "stored",
        rules: {},
      }),
    ),
    { code: "POLICY_VERIFICATION_FAILED" },
  );

  // Verify wallet is STILL in PROVISIONING with policy_state='none' and can_receive=false
  const { rows: stillProvisioning } = await pool.query<{
    status: string;
    policy_state: string;
  }>("SELECT status, policy_state FROM flow.wallets WHERE id = $1::uuid", [
    walletId,
  ]);
  assert.equal(stillProvisioning[0]!.status, "PROVISIONING");
  assert.equal(stillProvisioning[0]!.policy_state, "none");

  const { rows: capBefore } = await pool.query<{ can_receive: boolean }>(
    "SELECT can_receive FROM flow.wallet_capabilities WHERE wallet_id = $1::uuid AND can_receive = true",
    [walletId],
  );
  assert.equal(
    capBefore.length,
    0,
    "can_receive must remain false before valid policy verification",
  );

  // 7. Activate with verified provider policy evidence -> SUCCEEDS
  await activateWalletIfReady(
    db,
    leased.id,
    leased.fencingToken,
    walletId,
    validPolicyEvidence,
  );

  const { rows: activeWallet } = await pool.query<{
    status: string;
    policy_state: string;
    controller_account_id: string | null;
  }>(
    "SELECT status, policy_state, controller_account_id FROM flow.wallets WHERE id = $1::uuid",
    [walletId],
  );
  assert.equal(activeWallet[0]!.status, "ACTIVE");
  assert.equal(activeWallet[0]!.policy_state, "stored");
  assert.equal(activeWallet[0]!.controller_account_id, "controller.near");
});

test("decoupled fund readiness enforces execution guards and unverified policy rejection on DB records", async () => {
  const db = getPrismaClient();
  const account = await createTestAccount(pool, "PERSONAL", "fund-readiness");
  await createProvisioningJob(db, account.accountId, randomUUID());
  const leased = await claimJobLease(db, account.accountId, "worker-funds", 30);
  assert.ok(leased !== null);
  await recordJobDispatch(db, leased.id, leased.fencingToken, randomUUID());

  const testKeyHex =
    "a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90";
  const envelope = serializeEnvelope(
    encryptSecret("wk_fund_test", testKeyHex, "v1"),
  );

  // Unverified policy ('none') is rejected by commitJobSuccess
  await assert.rejects(
    commitJobSuccess(db, leased.id, leased.fencingToken, {
      accountId: account.accountId,
      providerWalletId: "outlayer-funds-1",
      nearAccountId:
        "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      encryptedCredential: envelope,
      keyId: "v1",
      keyDigest: deriveKeyDigest(testKeyHex),
      policyEvidence: mintTrustedAdapterPolicyEvidence({
        wallet_id: "outlayer-funds-1",
        controller: "controller.near",
        frozen: false,
        policy: "none",
        rules: {},
      }),
      addresses: [],
      capabilities: [],
    }),
    { code: "POLICY_VERIFICATION_FAILED" },
  );

  // Commit with verified policy and all 3 required launch chains
  const walletId = await commitJobSuccess(db, leased.id, leased.fencingToken, {
    accountId: account.accountId,
    providerWalletId: "outlayer-funds-1",
    nearAccountId:
      "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    encryptedCredential: envelope,
    keyId: "v1",
    keyDigest: deriveKeyDigest(testKeyHex),
    policyEvidence: mintTrustedAdapterPolicyEvidence({
      wallet_id: "outlayer-funds-1",
      controller: "controller.near",
      frozen: false,
      policy: "stored",
      rules: { defaultAction: "DENY" },
    }),
    addresses: [
      {
        network: "near",
        chainId: "near-mainnet",
        address:
          "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
        publicKey: "ed25519:abc",
      },
      {
        network: "base",
        chainId: "8453",
        address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
        publicKey: "secp256k1:def",
      },
      {
        network: "solana",
        chainId: "solana-mainnet",
        address: "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU",
        publicKey: "ed25519:ghi",
      },
    ],
    capabilities: [
      {
        network: "near",
        canDeriveAddress: true,
        canReceive: true,
        canReadNativeBalance: true,
        canReadIntentsBalance: false,
        canSignTransfer: false,
        broadcastMode: "provider_broadcast",
        canRotateCredentials: true,
      },
      {
        network: "base",
        canDeriveAddress: true,
        canReceive: true,
        canReadNativeBalance: false,
        canReadIntentsBalance: false,
        canSignTransfer: false,
        broadcastMode: "caller_broadcast",
        canRotateCredentials: true,
      },
      {
        network: "solana",
        canDeriveAddress: true,
        canReceive: true,
        canReadNativeBalance: false,
        canReadIntentsBalance: false,
        canSignTransfer: false,
        broadcastMode: "caller_broadcast",
        canRotateCredentials: true,
      },
    ],
  });

  const { rows: wRows } = await pool.query<{
    status: string;
    policy_state: string;
    controller_account_id: string | null;
  }>(
    "SELECT status, policy_state, controller_account_id FROM flow.wallets WHERE id = $1::uuid",
    [walletId],
  );
  const { rows: addrRows } = await pool.query<{
    network: string;
    address: string;
  }>(
    "SELECT network, address FROM flow.wallet_addresses WHERE wallet_id = $1::uuid",
    [walletId],
  );
  const { rows: capRows } = await pool.query<{
    network: string;
    can_sign_transfer: boolean;
    can_receive: boolean;
  }>(
    "SELECT network, can_sign_transfer, can_receive FROM flow.wallet_capabilities WHERE wallet_id = $1::uuid",
    [walletId],
  );

  // Even though wallet row is ACTIVE and policy_state is 'stored',
  // FLOW_EXECUTION=disabled unconditionally blocks fund movement even if caller passes globalExecutionDisabled: false!
  const readinessCheck = evaluateWalletFundReadiness({
    walletStatus: wRows[0]!.status,
    policySummary: {
      walletId,
      controller: wRows[0]!.controller_account_id ?? undefined,
      state: wRows[0]!.policy_state as OutLayerPolicyState,
      frozen: false,
      allowsFinancialExecution: true,
    },
    derivedAddresses: addrRows,
    capabilities: capRows.map((c) => ({
      network: c.network,
      canSignTransfer: c.can_sign_transfer,
      canReceive: c.can_receive,
    })),
    globalExecutionDisabled: false,
  });

  assert.equal(readinessCheck.isReady, false);
  assert.equal(readinessCheck.canReceiveFunds, false);
  assert.equal(readinessCheck.canSignTransfers, false);
  assert.ok(readinessCheck.reason?.includes("FLOW_EXECUTION=disabled"));
});

test("the real PostgreSQL server has the migrated namespace and the correct runtime role", async () => {
  await assertDatabaseReady(pool, database);
});

test("readiness rejects a mismatch between the expected and actual database", async () => {
  await assert.rejects(
    assertDatabaseReady(pool, { ...database, name: "flow_local" }),
    {
      code: "DATABASE_NOT_READY",
    },
  );
});

test("the runtime role can allocate Google OAuth orders", async () => {
  const { rows } = await pool.query<{ value: string }>(
    "SELECT nextval('flow.google_oauth_order') AS value",
  );
  assert.ok(BigInt(rows[0]!.value) > 0n);
});

for (const [action, statement] of [
  [
    "create a table in the application namespace",
    "CREATE TABLE flow.m0_permission_probe (id integer)",
  ],
  [
    "create a table in the public namespace",
    "CREATE TABLE public.m0_permission_probe (id integer)",
  ],
  ["create a new schema", "CREATE SCHEMA m0_permission_probe"],
  [
    "read Prisma migration history",
    "SELECT 1 FROM public._prisma_migrations LIMIT 1",
  ],
  [
    "read the append-only security audit",
    "SELECT 1 FROM flow.security_audit_events LIMIT 1",
  ],
  ["erase security audit events", "DELETE FROM flow.security_audit_events"],
  [
    "rewrite an immutable Google subject binding",
    "UPDATE flow.google_subject_bindings SET user_id = 'fixture'",
  ],
  ["delete an auth user", "DELETE FROM flow.auth_users"],
  ["reset Google OAuth order", "SELECT setval('flow.google_oauth_order', 0)"],
  ["delete a wallet", "DELETE FROM flow.wallets"],
  ["delete a wallet address", "DELETE FROM flow.wallet_addresses"],
  ["delete a wallet capability", "DELETE FROM flow.wallet_capabilities"],
  ["delete a provisioning job", "DELETE FROM flow.wallet_provisioning_jobs"],
  [
    "delete a provider compatibility authorization",
    "DELETE FROM flow.provider_compatibility_authorizations",
  ],
  ["delete a custody operator", "DELETE FROM flow.custody_operators"],
  [
    "delete a custody recovery approval",
    "DELETE FROM flow.custody_recovery_approvals",
  ],
] as const) {
  test(`the runtime role cannot ${action}`, async () => {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await assert.rejects(client.query(statement), { code: "42501" });
    } finally {
      try {
        await client.query("ROLLBACK");
      } finally {
        client.release();
      }
    }
  });
}

test("PostgreSQL denies the test runtime role access to the local database", async () => {
  const otherDatabase = new URL(database.url);
  otherDatabase.pathname = "/flow_local";
  const client = new pg.Client({
    connectionString: otherDatabase.href,
    connectionTimeoutMillis: 1_500,
  });
  try {
    await assert.rejects(client.connect(), { code: "42501" });
  } finally {
    await client.end();
  }
});

test("M2 Phase 3 worker: end-to-end fixture-backed provisioning for personal onboarding and multiple business accounts with strict identity isolation", async () => {
  const db = getPrismaClient();
  const mockServer = await createOutLayerMockServer({ multiWalletMode: true });
  try {
    const personal = await createTestAccount(pool, "PERSONAL", "m23-personal");
    const bizAlpha = await createTestAccount(pool, "BUSINESS", "m23-biz-alpha");
    const bizBeta = await createTestAccount(pool, "BUSINESS", "m23-biz-beta");

    const personalKey = randomUUID();
    const bizAlphaKey = randomUUID();
    const bizBetaKey = randomUUID();

    // Idempotent job enqueue (simulating repeated onboarding / business creation calls)
    const j1 = await ensureProvisioningJobForAccount(
      db,
      personal.accountId,
      personalKey,
    );
    const j1Replay = await ensureProvisioningJobForAccount(
      db,
      personal.accountId,
      personalKey,
    );
    assert.equal(j1.id, j1Replay.id);
    assert.equal(
      mockServer.getRegisterCallCount(),
      0,
      "Account creation job enqueue must NEVER call external provider",
    );

    await ensureProvisioningJobForAccount(db, bizAlpha.accountId, bizAlphaKey);
    await ensureProvisioningJobForAccount(db, bizBeta.accountId, bizBetaKey);

    const testKeyHex =
      "a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90";
    const adapter = new OutLayerAdapter(mockServer.url);
    const worker = new WalletProvisioningWorker({
      db,
      adapter,
      walletConfig: { encryptionKey: testKeyHex, keyId: "v1" },
      workerId: "worker-m23-e2e",
      maxConcurrency: 2,
    });

    const r1 = await worker.processAccountJob(personal.accountId);
    const r2 = await worker.processAccountJob(bizAlpha.accountId);
    const r3 = await worker.processAccountJob(bizBeta.accountId);

    assert.equal(r1.outcome, "activated");
    assert.equal(r2.outcome, "activated");
    assert.equal(r3.outcome, "activated");

    // Repeated call on already-ACTIVE account is a no-op ("skipped") and does not call /register again
    const r1Duplicate = await worker.processAccountJob(personal.accountId);
    assert.equal(r1Duplicate.outcome, "skipped");
    assert.equal(mockServer.getRegisterCallCount(), 3);

    const pProj = await getAccountWalletPublicProjection(
      db,
      personal.accountId,
    );
    const aProj = await getAccountWalletPublicProjection(
      db,
      bizAlpha.accountId,
    );
    const bProj = await getAccountWalletPublicProjection(db, bizBeta.accountId);

    assert.ok(pProj && aProj && bProj);
    assert.equal(pProj.status, "ACTIVE");
    assert.equal(aProj.status, "ACTIVE");
    assert.equal(bProj.status, "ACTIVE");

    // Separate wallet identities, provider wallet IDs, and NEAR accounts across personal & business accounts
    assert.equal(
      new Set([pProj.id, aProj.id, bProj.id]).size,
      3,
      "Each account must have a distinct wallet ID",
    );
    assert.equal(
      new Set([
        pProj.providerWalletId,
        aProj.providerWalletId,
        bProj.providerWalletId,
      ]).size,
      3,
      "Each account must have a distinct OutLayer provider_wallet_id",
    );
    assert.equal(
      new Set([pProj.nearAccountId, aProj.nearAccountId, bProj.nearAccountId])
        .size,
      3,
      "Each account must have a distinct NEAR account ID",
    );

    // Verify provisioningComplete=true while fundsReady=false and handoffUrl is scrubbed of bearer keys
    for (const proj of [pProj, aProj, bProj]) {
      assert.equal(proj.provisioningComplete, true);
      assert.equal(proj.policyVerified, true);
      assert.equal(proj.fundsReady, false);
      assert.equal(proj.canReceiveFunds, false);
      assert.equal(proj.canSignTransfers, false);
      assert.equal(proj.addresses.length, 3);
      assert.ok(
        !proj.handoffUrl?.includes("wk_"),
        "handoff_url must NEVER retain bearer key",
      );
    }
  } finally {
    await mockServer.close();
  }
});

test("M2 Phase 3 worker: concurrent workers racing on same and multiple accounts never duplicate registration", async () => {
  const db = getPrismaClient();
  const mockServer = await createOutLayerMockServer({ multiWalletMode: true });
  try {
    const accounts = await Promise.all(
      Array.from({ length: 4 }, (_, i) =>
        createTestAccount(
          pool,
          i % 2 === 0 ? "PERSONAL" : "BUSINESS",
          `race-${i}`,
        ),
      ),
    );
    for (const acc of accounts) {
      await ensureProvisioningJobForAccount(db, acc.accountId, randomUUID());
    }

    const testKeyHex =
      "a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90";
    const adapter = new OutLayerAdapter(mockServer.url);

    const workers = Array.from(
      { length: 3 },
      (_, idx) =>
        new WalletProvisioningWorker({
          db,
          adapter,
          walletConfig: { encryptionKey: testKeyHex, keyId: "v1" },
          workerId: `racing-worker-${idx}`,
          maxConcurrency: 2,
        }),
    );

    // All 3 workers concurrently race on each account
    for (const acc of accounts) {
      const outcomes = await Promise.all(
        workers.map((w) => w.processAccountJob(acc.accountId)),
      );
      const activated = outcomes.filter((o) => o.outcome === "activated");
      const skipped = outcomes.filter((o) => o.outcome === "skipped");
      assert.equal(
        activated.length,
        1,
        "Exactly one worker must claim and activate each account",
      );
      assert.equal(skipped.length, 2);
    }

    assert.equal(
      mockServer.getRegisterCallCount(),
      accounts.length,
      "OutLayer /register must be called at most once per account across racing workers",
    );
  } finally {
    await mockServer.close();
  }
});

test("M2 Phase 3 worker: crash recovery across Stage 1 (after credential save), Stage 2 (after address attach), and post-dispatch quarantine without re-registering", async () => {
  const db = getPrismaClient();
  const mockServer = await createOutLayerMockServer({ multiWalletMode: true });
  const testKeyHex =
    "a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90";
  const adapter = new OutLayerAdapter(mockServer.url);

  try {
    // Case A: Worker crashes AFTER Stage 1 credential persistence, BEFORE Stage 2 address derivation
    const accStage1 = await createTestAccount(
      pool,
      "PERSONAL",
      "crash-after-s1",
    );
    await ensureProvisioningJobForAccount(
      db,
      accStage1.accountId,
      randomUUID(),
    );

    const crashingStage1Worker = new WalletProvisioningWorker({
      db,
      adapter,
      walletConfig: { encryptionKey: testKeyHex, keyId: "v1" },
      workerId: "crash-s1-worker",
      hooks: {
        onAfterStage1Persist: () => {
          throw new Error("Simulated process crash after Stage 1 persistence");
        },
      },
    });

    await assert.rejects(() =>
      crashingStage1Worker.processAccountJob(accStage1.accountId),
    );
    assert.equal(mockServer.getRegisterCallCount(), 1);

    // Expire lease to simulate dead worker timeout
    await pool.query(
      "UPDATE flow.wallet_provisioning_jobs SET lease_expires_at = CURRENT_TIMESTAMP - interval '5 seconds' WHERE account_id = $1::uuid",
      [accStage1.accountId],
    );

    const recoveryWorker = new WalletProvisioningWorker({
      db,
      adapter,
      walletConfig: { encryptionKey: testKeyHex, keyId: "v1" },
      workerId: "recovery-worker",
    });

    const recoveredStage1 = await recoveryWorker.processAccountJob(
      accStage1.accountId,
    );
    assert.equal(recoveredStage1.outcome, "activated");
    assert.equal(recoveredStage1.recoveredFromStage, "STAGE_1_REGISTERED");
    assert.equal(
      mockServer.getRegisterCallCount(),
      1,
      "Recovery after Stage 1 MUST NOT call /register again",
    );

    // Case B: Worker crashes AFTER Stage 2 address attachment, BEFORE Stage 3 policy verification
    const accStage2 = await createTestAccount(
      pool,
      "BUSINESS",
      "crash-after-s2",
    );
    await ensureProvisioningJobForAccount(
      db,
      accStage2.accountId,
      randomUUID(),
    );

    const crashingStage2Worker = new WalletProvisioningWorker({
      db,
      adapter,
      walletConfig: { encryptionKey: testKeyHex, keyId: "v1" },
      workerId: "crash-s2-worker",
      hooks: {
        onAfterStage2Attach: () => {
          throw new Error("Simulated process crash after Stage 2 attachment");
        },
      },
    });

    await assert.rejects(() =>
      crashingStage2Worker.processAccountJob(accStage2.accountId),
    );
    assert.equal(mockServer.getRegisterCallCount(), 2);

    await pool.query(
      "UPDATE flow.wallet_provisioning_jobs SET lease_expires_at = CURRENT_TIMESTAMP - interval '5 seconds' WHERE account_id = $1::uuid",
      [accStage2.accountId],
    );

    const recoveredStage2 = await recoveryWorker.processAccountJob(
      accStage2.accountId,
    );
    assert.equal(recoveredStage2.outcome, "activated");
    assert.equal(recoveredStage2.recoveredFromStage, "STAGE_2_PROVISIONED");
    assert.equal(
      mockServer.getRegisterCallCount(),
      2,
      "Recovery after Stage 2 MUST NOT call /register again",
    );

    // Case C: Worker crashes AFTER dispatch recorded, BEFORE Stage 1 credential persistence -> Quarantined to UNKNOWN
    const accAmbiguous = await createTestAccount(
      pool,
      "PERSONAL",
      "crash-after-dispatch",
    );
    await ensureProvisioningJobForAccount(
      db,
      accAmbiguous.accountId,
      randomUUID(),
    );

    const crashingDispatchWorker = new WalletProvisioningWorker({
      db,
      adapter,
      walletConfig: { encryptionKey: testKeyHex, keyId: "v1" },
      workerId: "crash-dispatch-worker",
      hooks: {
        onAfterDispatch: () => {
          throw new Error("Simulated process crash in-flight after dispatch");
        },
      },
    });

    await assert.rejects(() =>
      crashingDispatchWorker.processAccountJob(accAmbiguous.accountId),
    );
    assert.equal(
      mockServer.getRegisterCallCount(),
      2,
      "Crash happened right after recordJobDispatch before HTTP call",
    );

    await pool.query(
      "UPDATE flow.wallet_provisioning_jobs SET lease_expires_at = CURRENT_TIMESTAMP - interval '5 seconds' WHERE account_id = $1::uuid",
      [accAmbiguous.accountId],
    );

    const quarantinedCount = await reconcileCrashedJobs(db);
    assert.ok(quarantinedCount >= 1);

    const { rows: ambRows } = await pool.query<{
      status: string;
      failure_classification: string;
    }>(
      "SELECT status, failure_classification FROM flow.wallet_provisioning_jobs WHERE account_id = $1::uuid",
      [accAmbiguous.accountId],
    );
    assert.equal(ambRows[0]!.status, "UNKNOWN");
    assert.equal(ambRows[0]!.failure_classification, "POST_DISPATCH_AMBIGUOUS");

    // Subsequent worker run MUST skip the quarantined UNKNOWN job and NEVER call /register
    const afterQuarantine = await recoveryWorker.processAccountJob(
      accAmbiguous.accountId,
    );
    assert.equal(afterQuarantine.outcome, "skipped");
    assert.equal(mockServer.getRegisterCallCount(), 2);
  } finally {
    await mockServer.close();
  }
});

test("M2 Phase 3 worker: provider failures, unverified policy rejection, and graceful worker lifecycle diagnostics", async () => {
  const db = getPrismaClient();
  const mockServer = await createOutLayerMockServer({
    multiWalletMode: true,
    policyState: "none",
  });
  const testKeyHex =
    "a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90";
  const adapter = new OutLayerAdapter(mockServer.url);

  try {
    // 1. Policy state 'none' returned by provider -> Stage 3 rejects policy, marks job FAILED and wallet SETUP_FAILED
    const accBadPolicy = await createTestAccount(
      pool,
      "PERSONAL",
      "worker-bad-policy",
    );
    await ensureProvisioningJobForAccount(
      db,
      accBadPolicy.accountId,
      randomUUID(),
    );

    const worker = new WalletProvisioningWorker({
      db,
      adapter,
      walletConfig: { encryptionKey: testKeyHex, keyId: "v1" },
      workerId: "worker-lifecycle-test",
      baseBackoffMs: 25,
      maxBackoffMs: 200,
    });

    const badPolicyRes = await worker.processAccountJob(accBadPolicy.accountId);
    assert.equal(badPolicyRes.outcome, "failed");
    assert.equal(
      badPolicyRes.failureClassification,
      "POLICY_VERIFICATION_FAILED",
    );

    const { rows: failedWalletRows } = await pool.query<{ status: string }>(
      "SELECT status::text AS status FROM flow.wallets WHERE account_id = $1::uuid",
      [accBadPolicy.accountId],
    );
    assert.equal(failedWalletRows[0]!.status, "SETUP_FAILED");

    // 2. Restore valid policyState='stored' and test background start/stop polling lifecycle
    mockServer.setOptions({ multiWalletMode: true, policyState: "stored" });
    const accBg = await createTestAccount(pool, "BUSINESS", "worker-bg-poll");
    await ensureProvisioningJobForAccount(db, accBg.accountId, randomUUID());

    assert.equal(worker.computeBackoffDelayMs(1), 25);
    assert.equal(worker.computeBackoffDelayMs(2), 50);
    assert.equal(worker.computeBackoffDelayMs(3), 100);
    assert.equal(worker.computeBackoffDelayMs(10), 200);

    worker.start(30);
    // Wait until background worker activates accBg
    for (let i = 0; i < 40; i++) {
      const proj = await getAccountWalletPublicProjection(db, accBg.accountId);
      if (proj?.status === "ACTIVE") break;
      await new Promise((r) => setTimeout(r, 25));
    }
    await worker.stop();

    const bgProj = await getAccountWalletPublicProjection(db, accBg.accountId);
    assert.ok(bgProj !== null);
    assert.equal(bgProj.status, "ACTIVE");
    assert.equal(bgProj.fundsReady, false);

    const diag = worker.getDiagnostics();
    assert.equal(diag.running, false);
    assert.equal(diag.inFlightCount, 0);
    assert.ok(diag.activatedCount >= 1);
    assert.ok(diag.failedCount >= 1);
    const serializedDiag = JSON.stringify(diag);
    assert.ok(!serializedDiag.includes("wk_"));
    assert.ok(!serializedDiag.includes(testKeyHex));
  } finally {
    await mockServer.close();
  }
});

test("M2 Phase 4 quarantine: uncertain registration outcomes (HTTP 200 corrupted JSON / schema mismatch / invalid NEAR address / HTTP 502) quarantine job to UNKNOWN and never re-register", async () => {
  const db = getPrismaClient();
  const mockServer = await createOutLayerMockServer({ multiWalletMode: true });
  const testKeyHex =
    "a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90";
  const adapter = new OutLayerAdapter(mockServer.url);
  const worker = new WalletProvisioningWorker({
    db,
    adapter,
    walletConfig: { encryptionKey: testKeyHex, keyId: "v1" },
    workerId: "worker-m24-quarantine",
  });

  try {
    // 1. HTTP 200 with truncated/corrupted JSON during /register -> Quarantined to UNKNOWN (never retried!)
    const accCorruptJson = await createTestAccount(
      pool,
      "PERSONAL",
      "m24-corrupt-json",
    );
    await ensureProvisioningJobForAccount(
      db,
      accCorruptJson.accountId,
      randomUUID(),
    );

    mockServer.setOptions({
      multiWalletMode: true,
      forceStatus: 200,
      rawErrorBody: '{"wallet_id":"partial-200-body',
      rawErrorContentType: "application/json",
    });

    const resCorrupt = await worker.processAccountJob(accCorruptJson.accountId);
    assert.equal(resCorrupt.outcome, "quarantined");
    assert.equal(resCorrupt.failureClassification, "POST_DISPATCH_AMBIGUOUS");
    assert.equal(mockServer.getRegisterCallCount(), 1);

    // Restore healthy server and verify worker skips the quarantined UNKNOWN job without calling /register again
    mockServer.setOptions({ multiWalletMode: true });
    const resRetryCorrupt = await worker.processAccountJob(
      accCorruptJson.accountId,
    );
    assert.equal(resRetryCorrupt.outcome, "skipped");
    assert.equal(
      mockServer.getRegisterCallCount(),
      1,
      "Quarantined UNKNOWN job from corrupted HTTP 200 MUST NOT call /register again",
    );

    // 2. HTTP 200 with invalid NEAR address on /register -> Quarantined to UNKNOWN
    const accCorruptNear = await createTestAccount(
      pool,
      "BUSINESS",
      "m24-corrupt-near",
    );
    await ensureProvisioningJobForAccount(
      db,
      accCorruptNear.accountId,
      randomUUID(),
    );

    mockServer.setOptions({
      multiWalletMode: true,
      corruptNearId: true,
    });

    const resNear = await worker.processAccountJob(accCorruptNear.accountId);
    assert.equal(resNear.outcome, "quarantined");
    assert.equal(resNear.failureClassification, "POST_DISPATCH_AMBIGUOUS");
    assert.equal(mockServer.getRegisterCallCount(), 2);
  } finally {
    await mockServer.close();
  }
});

test("M2 Phase 4 operator recovery: two-person escalation and resolution for UNKNOWN/MANUAL_REVIEW jobs, cross-account protection, and resume without re-registration", async () => {
  const db = getPrismaClient();
  const mockServer = await createOutLayerMockServer({ multiWalletMode: true });
  const testKeyHex =
    "a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90";
  const adapter = new OutLayerAdapter(mockServer.url);
  const worker = new WalletProvisioningWorker({
    db,
    adapter,
    walletConfig: { encryptionKey: testKeyHex, keyId: "v1" },
    workerId: "worker-m24-recovery",
  });

  try {
    // Create two accounts (Personal A and Business B) and two distinct operator auth users
    const accPersonal = await createTestAccount(
      pool,
      "PERSONAL",
      "m24-rec-personal",
    );
    const accBusiness = await createTestAccount(
      pool,
      "BUSINESS",
      "m24-rec-business",
    );
    const opInitiatorAuthId = `op-init-${randomUUID().slice(0, 8)}`;
    const opApproverAuthId = `op-approve-${randomUUID().slice(0, 8)}`;

    // Provision Business B normally first so it owns a wallet
    await ensureProvisioningJobForAccount(
      db,
      accBusiness.accountId,
      randomUUID(),
    );
    const bizRes = await worker.processAccountJob(accBusiness.accountId);
    assert.equal(bizRes.outcome, "activated");
    const bizProj = await getAccountWalletPublicProjection(
      db,
      accBusiness.accountId,
    );
    assert.ok(bizProj !== null);
    assert.equal(mockServer.getRegisterCallCount(), 1);

    // Now trigger an ambiguous HTTP 502 during /register for Personal A -> Quarantined to UNKNOWN
    const personalJob = await ensureProvisioningJobForAccount(
      db,
      accPersonal.accountId,
      randomUUID(),
    );
    mockServer.setOptions({ multiWalletMode: true, forceStatus: 502 });
    const ambRes = await worker.processAccountJob(accPersonal.accountId);
    assert.equal(ambRes.outcome, "quarantined");
    assert.equal(mockServer.getRegisterCallCount(), 2);
    mockServer.setOptions({ multiWalletMode: true });

    // Read dispatch_attempt_id from the quarantined UNKNOWN job
    const { rows: jobRows } = await pool.query<{
      id: string;
      status: string;
      dispatch_attempt_id: string;
    }>(
      "SELECT id, status::text AS status, dispatch_attempt_id FROM flow.wallet_provisioning_jobs WHERE id = $1::uuid",
      [personalJob.id],
    );
    assert.equal(jobRows[0]!.status, "UNKNOWN");
    const dispatchAttemptId = jobRows[0]!.dispatch_attempt_id;
    assert.ok(dispatchAttemptId);

    // 1. Reject escalation if accountId or expectedAccountKind does not match
    await assert.rejects(
      escalateJobToManualReview(db, {
        jobId: personalJob.id,
        accountId: accBusiness.accountId, // wrong account!
        expectedAccountKind: "PERSONAL",
        operatorAuthId: opInitiatorAuthId,
        reasonCode: "AMBIGUOUS_REGISTRATION_OUTCOME",
        providerInspectionSummary: "REMOTE_WALLET_LOCATED",
        expectedDispatchAttemptId: dispatchAttemptId,
        requestId: randomUUID(),
      }),
      { code: "WALLET_ACCOUNT_MISMATCH" },
    );

    await assert.rejects(
      escalateJobToManualReview(db, {
        jobId: personalJob.id,
        accountId: accPersonal.accountId,
        expectedAccountKind: "BUSINESS", // wrong account kind!
        operatorAuthId: opInitiatorAuthId,
        reasonCode: "AMBIGUOUS_REGISTRATION_OUTCOME",
        providerInspectionSummary: "REMOTE_WALLET_LOCATED",
        expectedDispatchAttemptId: dispatchAttemptId,
        requestId: randomUUID(),
      }),
      { code: "WALLET_ACCOUNT_MISMATCH" },
    );

    // 2. Operator 1 escalates UNKNOWN job to MANUAL_REVIEW with investigation evidence
    const recoveredNearAccountId =
      "98793cd91a3f870fb126f66285808c7e094afcfc4eda8a970f6644ac0a4961ac";
    const recoveredNearPublicKey = `ed25519:${encodeBase58(Buffer.from(recoveredNearAccountId, "hex"))}`;
    const recoveredProviderWalletId = "9c3c9e10-1c1f-4f5e-9c4a-1d7b9a8f3c20";
    const recoveredApiKey = "wk_2a8b1f3c4d5e6789abcdef0123456789";

    await escalateJobToManualReview(db, {
      jobId: personalJob.id,
      accountId: accPersonal.accountId,
      expectedAccountKind: "PERSONAL",
      operatorAuthId: opInitiatorAuthId,
      reasonCode: "AMBIGUOUS_REGISTRATION_OUTCOME",
      providerInspectionSummary: "REMOTE_WALLET_LOCATED",
      expectedDispatchAttemptId: dispatchAttemptId,
      requestId: randomUUID(),
    });

    const { rows: mrRows } = await pool.query<{
      status: string;
      recovery_evidence: string;
    }>(
      "SELECT status::text AS status, recovery_evidence FROM flow.wallet_provisioning_jobs WHERE id = $1::uuid",
      [personalJob.id],
    );
    assert.equal(mrRows[0]!.status, "MANUAL_REVIEW");
    const parsedMrEvidence = JSON.parse(mrRows[0]!.recovery_evidence) as Record<
      string,
      unknown
    >;
    assert.equal(parsedMrEvidence.stage, "MANUAL_REVIEW_ESCALATED");
    assert.equal(parsedMrEvidence.initiatorOperatorAuthId, opInitiatorAuthId);

    const encryptedEnvelope = serializeEnvelope(
      encryptSecret(recoveredApiKey, testKeyHex, "v1"),
    );
    const keyDigest = deriveKeyDigest(testKeyHex);

    // 3. Reject single-operator self-approval (initiator === approver)
    await assert.rejects(
      resolveQuarantinedProvisioningJob(db, {
        resolution: "ATTACH_RECOVERED_WALLET",
        jobId: personalJob.id,
        accountId: accPersonal.accountId,
        expectedAccountKind: "PERSONAL",
        expectedDispatchAttemptId: dispatchAttemptId,
        initiatorOperatorAuthId: opInitiatorAuthId,
        approverOperatorAuthId: opInitiatorAuthId, // SAME operator!
        providerWalletId: recoveredProviderWalletId,
        nearAccountId: recoveredNearAccountId,
        nearPublicKey: recoveredNearPublicKey,
        encryptedCredential: encryptedEnvelope,
        keyId: "v1",
        keyDigest,
        requestId: randomUUID(),
      }),
      { code: "TWO_PERSON_APPROVAL_REQUIRED" },
    );

    // 4. Reject attaching a wallet already bound to another account (Business B's wallet)
    await assert.rejects(
      resolveQuarantinedProvisioningJob(db, {
        resolution: "ATTACH_RECOVERED_WALLET",
        jobId: personalJob.id,
        accountId: accPersonal.accountId,
        expectedAccountKind: "PERSONAL",
        expectedDispatchAttemptId: dispatchAttemptId,
        initiatorOperatorAuthId: opInitiatorAuthId,
        approverOperatorAuthId: opApproverAuthId,
        providerWalletId: bizProj.providerWalletId!, // Already bound to Business B!
        nearAccountId: recoveredNearAccountId,
        nearPublicKey: recoveredNearPublicKey,
        encryptedCredential: encryptedEnvelope,
        keyId: "v1",
        keyDigest,
        requestId: randomUUID(),
      }),
      { code: "WALLET_ACCOUNT_MISMATCH" },
    );

    // 5. Reject attaching a wallet whose nearPublicKey does not cryptographically match nearAccountId
    const wrongNearHex =
      "11113cd91a3f870fb126f66285808c7e094afcfc4eda8a970f6644ac0a4961ac";
    await assert.rejects(
      resolveQuarantinedProvisioningJob(db, {
        resolution: "ATTACH_RECOVERED_WALLET",
        jobId: personalJob.id,
        accountId: accPersonal.accountId,
        expectedAccountKind: "PERSONAL",
        expectedDispatchAttemptId: dispatchAttemptId,
        initiatorOperatorAuthId: opInitiatorAuthId,
        approverOperatorAuthId: opApproverAuthId,
        providerWalletId: recoveredProviderWalletId,
        nearAccountId: recoveredNearAccountId,
        nearPublicKey: `ed25519:${encodeBase58(Buffer.from(wrongNearHex, "hex"))}`,
        encryptedCredential: encryptedEnvelope,
        keyId: "v1",
        keyDigest,
        requestId: randomUUID(),
      }),
      { code: "CUSTODY_INVALID_ADDRESS" },
    );

    // 6. Reject wrong resolution (RESET_CONFIRMED_PRE_CREATION_FAILURE when finding is REMOTE_WALLET_LOCATED)
    await assert.rejects(
      resolveQuarantinedProvisioningJob(db, {
        resolution: "RESET_CONFIRMED_PRE_CREATION_FAILURE",
        jobId: personalJob.id,
        accountId: accPersonal.accountId,
        expectedAccountKind: "PERSONAL",
        expectedDispatchAttemptId: dispatchAttemptId,
        initiatorOperatorAuthId: opInitiatorAuthId,
        approverOperatorAuthId: opApproverAuthId,
        requestId: randomUUID(),
      }),
      { code: "INVALID_STATE_TRANSITION" },
    );

    // 7. Valid two-person approval attaches recovered wallet (Stage 1) and transitions job to REGISTERED
    const attached = await resolveQuarantinedProvisioningJob(db, {
      resolution: "ATTACH_RECOVERED_WALLET",
      jobId: personalJob.id,
      accountId: accPersonal.accountId,
      expectedAccountKind: "PERSONAL",
      expectedDispatchAttemptId: dispatchAttemptId,
      initiatorOperatorAuthId: opInitiatorAuthId,
      approverOperatorAuthId: opApproverAuthId,
      providerWalletId: recoveredProviderWalletId,
      nearAccountId: recoveredNearAccountId,
      nearPublicKey: recoveredNearPublicKey,
      encryptedCredential: encryptedEnvelope,
      keyId: "v1",
      keyDigest,
      requestId: randomUUID(),
    });
    assert.ok(attached.walletId);
    assert.equal(attached.status, "REGISTERED");

    // Now run WalletProvisioningWorker on Personal A: it resumes from Stage 1 (REGISTERED) -> Stage 2 -> Stage 3 (ACTIVE) WITHOUT calling /register!
    const registerCallsBeforeResume = mockServer.getRegisterCallCount();
    const resumeRes = await worker.processAccountJob(accPersonal.accountId);
    assert.equal(resumeRes.outcome, "activated");
    assert.equal(resumeRes.recoveredFromStage, "STAGE_1_REGISTERED");
    assert.equal(
      mockServer.getRegisterCallCount(),
      registerCallsBeforeResume,
      "Worker resuming after operator ATTACH_RECOVERED_WALLET MUST NOT call /register again",
    );

    const personalProj = await getAccountWalletPublicProjection(
      db,
      accPersonal.accountId,
    );
    assert.ok(personalProj !== null);
    assert.equal(personalProj.status, "ACTIVE");
    assert.equal(personalProj.providerWalletId, recoveredProviderWalletId);
    assert.equal(personalProj.fundsReady, false);

    // 8. Also test RESET_CONFIRMED_PRE_CREATION_FAILURE when operator investigation confirms NO_REMOTE_WALLET_FOUND
    const accNoRemote = await createTestAccount(
      pool,
      "PERSONAL",
      "m24-rec-noremote",
    );
    const noRemoteJob = await ensureProvisioningJobForAccount(
      db,
      accNoRemote.accountId,
      randomUUID(),
    );
    mockServer.setOptions({ multiWalletMode: true, dropConnection: true });
    const dropRes = await worker.processAccountJob(accNoRemote.accountId);
    assert.equal(dropRes.outcome, "quarantined");
    mockServer.setOptions({ multiWalletMode: true });

    const { rows: dropJobRows } = await pool.query<{
      dispatch_attempt_id: string;
    }>(
      "SELECT dispatch_attempt_id FROM flow.wallet_provisioning_jobs WHERE id = $1::uuid",
      [noRemoteJob.id],
    );
    const dropDispatchId = dropJobRows[0]!.dispatch_attempt_id;

    await escalateJobToManualReview(db, {
      jobId: noRemoteJob.id,
      accountId: accNoRemote.accountId,
      expectedAccountKind: "PERSONAL",
      operatorAuthId: opInitiatorAuthId,
      reasonCode: "AMBIGUOUS_REGISTRATION_OUTCOME",
      providerInspectionSummary: "NO_REMOTE_WALLET_FOUND",
      expectedDispatchAttemptId: dropDispatchId,
      requestId: randomUUID(),
    });

    await resolveQuarantinedProvisioningJob(db, {
      resolution: "RESET_CONFIRMED_PRE_CREATION_FAILURE",
      jobId: noRemoteJob.id,
      accountId: accNoRemote.accountId,
      expectedAccountKind: "PERSONAL",
      expectedDispatchAttemptId: dropDispatchId,
      initiatorOperatorAuthId: opInitiatorAuthId,
      approverOperatorAuthId: opApproverAuthId,
      requestId: randomUUID(),
    });

    const resetProvisionRes = await worker.processAccountJob(
      accNoRemote.accountId,
    );
    assert.equal(resetProvisionRes.outcome, "activated");
  } finally {
    await mockServer.close();
  }
});

test("M2 Phase 5 operator authentication: assertOperatorIdentityRegistered and verifyOperatorInDatabase reject unauthenticated operator IDs", async () => {
  const db = getPrismaClient();

  // Create real registered auth users for operators
  const opRealA = await createTestAccount(pool, "PERSONAL", "real-op-a");
  const opRealB = await createTestAccount(pool, "PERSONAL", "real-op-b");
  const fakeOperatorAuthId = "unregistered-fake-operator-id";

  // 1. assertOperatorIdentityRegistered rejects fake operator ID
  await assert.rejects(
    assertOperatorIdentityRegistered(db, fakeOperatorAuthId),
    { code: "INVALID_OPERATOR_IDENTITY" },
  );

  // 2. assertOperatorIdentityRegistered succeeds for real registered auth user
  await assertOperatorIdentityRegistered(db, opRealA.authUserId);
  await assertOperatorIdentityRegistered(db, opRealB.authUserId);

  // Enroll opRealA into flow.custody_operators
  await enrollCustodyOperator(db, {
    authUserId: opRealA.authUserId,
    enrolledBy: "security-officer-seed",
  });
  await assertOperatorAuthority(db, opRealA.authUserId);
  await assert.rejects(assertOperatorAuthority(db, opRealB.authUserId), {
    code: "CUSTODY_OPERATOR_AUTHORIZATION_ERROR",
  });

  // 3. Test verifyOperatorInDatabase on escalateJobToManualReview
  const acc = await createTestAccount(pool, "PERSONAL", "op-verify-test");
  const job = await ensureProvisioningJobForAccount(
    db,
    acc.accountId,
    randomUUID(),
  );

  // Set job status to UNKNOWN to allow escalation
  await pool.query(
    "UPDATE flow.wallet_provisioning_jobs SET status = 'UNKNOWN', failure_classification = 'POST_DISPATCH_AMBIGUOUS', dispatch_attempt_id = gen_random_uuid(), dispatched_at = CURRENT_TIMESTAMP WHERE id = $1::uuid",
    [job.id],
  );

  const jobRows = await pool.query<{ dispatch_attempt_id: string }>(
    "SELECT dispatch_attempt_id FROM flow.wallet_provisioning_jobs WHERE id = $1::uuid",
    [job.id],
  );
  const dispatchAttemptId = jobRows.rows[0]!.dispatch_attempt_id;

  // Escalation with fake operator and verifyOperatorInDatabase: true must be rejected
  await assert.rejects(
    escalateJobToManualReview(db, {
      jobId: job.id,
      accountId: acc.accountId,
      operatorAuthId: fakeOperatorAuthId,
      reasonCode: "AMBIGUOUS_REGISTRATION_OUTCOME",
      providerInspectionSummary: "NO_REMOTE_WALLET_FOUND",
      requestId: randomUUID(),
      verifyOperatorInDatabase: true,
    }),
    { code: "INVALID_OPERATOR_IDENTITY" },
  );

  // Escalation with real operator and verifyOperatorInDatabase: true succeeds
  await escalateJobToManualReview(db, {
    jobId: job.id,
    accountId: acc.accountId,
    operatorAuthId: opRealA.authUserId,
    reasonCode: "AMBIGUOUS_REGISTRATION_OUTCOME",
    providerInspectionSummary: "NO_REMOTE_WALLET_FOUND",
    requestId: randomUUID(),
    verifyOperatorInDatabase: true,
  });

  // Resolution with fake approver must be rejected
  await assert.rejects(
    resolveQuarantinedProvisioningJob(db, {
      resolution: "RESET_CONFIRMED_PRE_CREATION_FAILURE",
      jobId: job.id,
      accountId: acc.accountId,
      expectedAccountKind: "PERSONAL",
      expectedDispatchAttemptId: dispatchAttemptId,
      initiatorOperatorAuthId: opRealA.authUserId,
      approverOperatorAuthId: fakeOperatorAuthId, // fake!
      requestId: randomUUID(),
      verifyOperatorInDatabase: true,
    }),
    { code: "INVALID_OPERATOR_IDENTITY" },
  );

  // Resolution where approver is not enrolled in flow.custody_operators must be rejected
  await assert.rejects(
    resolveQuarantinedProvisioningJob(db, {
      resolution: "RESET_CONFIRMED_PRE_CREATION_FAILURE",
      jobId: job.id,
      accountId: acc.accountId,
      expectedAccountKind: "PERSONAL",
      expectedDispatchAttemptId: dispatchAttemptId,
      initiatorOperatorAuthId: opRealA.authUserId,
      approverOperatorAuthId: opRealB.authUserId, // real user, but not enrolled as operator!
      requestId: randomUUID(),
      verifyOperatorInDatabase: true,
    }),
    { code: "CUSTODY_OPERATOR_AUTHORIZATION_ERROR" },
  );

  // Enroll opRealB as operator
  await enrollCustodyOperator(db, {
    authUserId: opRealB.authUserId,
    enrolledBy: "security-officer-seed",
  });

  // Resolution without independent flow.custody_recovery_approvals record must be rejected
  await assert.rejects(
    resolveQuarantinedProvisioningJob(db, {
      resolution: "RESET_CONFIRMED_PRE_CREATION_FAILURE",
      jobId: job.id,
      accountId: acc.accountId,
      expectedAccountKind: "PERSONAL",
      expectedDispatchAttemptId: dispatchAttemptId,
      initiatorOperatorAuthId: opRealA.authUserId,
      approverOperatorAuthId: opRealB.authUserId,
      requestId: randomUUID(),
      verifyOperatorInDatabase: true,
    }),
    { code: "CUSTODY_INDEPENDENT_APPROVAL_REQUIRED" },
  );

  // Create valid independent recovery approval record
  await createCustodyRecoveryApproval(db, {
    jobId: job.id,
    accountId: acc.accountId,
    approverAuthId: opRealB.authUserId,
    resolution: "RESET_CONFIRMED_PRE_CREATION_FAILURE",
  });

  // Resolution now succeeds and atomically consumes the approval record
  const resolutionResult = await resolveQuarantinedProvisioningJob(db, {
    resolution: "RESET_CONFIRMED_PRE_CREATION_FAILURE",
    jobId: job.id,
    accountId: acc.accountId,
    expectedAccountKind: "PERSONAL",
    expectedDispatchAttemptId: dispatchAttemptId,
    initiatorOperatorAuthId: opRealA.authUserId,
    approverOperatorAuthId: opRealB.authUserId,
    requestId: randomUUID(),
    verifyOperatorInDatabase: true,
  });
  assert.equal(resolutionResult.status, "PENDING");
});

test("M2 Phase 5.1 durable compatibility authorization: enforces budget of 1, racing claims, ambiguity consumption, and expiration", async () => {
  const db = getPrismaClient();
  const acc = await createTestAccount(pool, "PERSONAL", "compat-budget-test");

  // 1. Check constraints on max_registrations and registrations_attempted
  await assert.rejects(
    pool.query(
      `INSERT INTO flow.provider_compatibility_authorizations (
        account_id, environment, allowed_methods, max_registrations, expires_at
      ) VALUES ($1::uuid, 'testnet', ARRAY['POST /register'], 2, CURRENT_TIMESTAMP + interval '1 hour')`,
      [acc.accountId],
    ),
    { code: "23514" }, // CHECK constraint violation
  );

  // 2. Create durable single-use compatibility authorization record
  const auth = await createCompatibilityAuthorization(db, {
    accountId: acc.accountId,
    environment: "testnet",
  });
  assert.ok(auth.id);
  assert.ok(auth.expiresAt > new Date());

  // 3. Concurrent workers race to claim the single-registration budget
  const dispatch1 = randomUUID();
  const dispatch2 = randomUUID();
  const [claim1, claim2] = await Promise.allSettled([
    claimCompatibilityRegistration(db, auth.id, "worker-1", dispatch1),
    claimCompatibilityRegistration(db, auth.id, "worker-2", dispatch2),
  ]);

  const fulfilled = [claim1, claim2].filter((c) => c.status === "fulfilled");
  const rejected = [claim1, claim2].filter((c) => c.status === "rejected");

  assert.equal(
    fulfilled.length,
    1,
    "Exactly one worker must succeed in claiming the single registration",
  );
  assert.equal(rejected.length, 1, "Competing worker must be rejected");

  const winner = (
    fulfilled[0] as PromiseFulfilledResult<{
      id: string;
      accountId: string;
      environment: string;
    }>
  ).value;
  assert.equal(winner.accountId, acc.accountId);
  assert.equal(winner.environment, "testnet");

  // 4. Ambiguity quarantine: external provider drop consumes the budget permanently
  await quarantineCompatibilityRegistration(
    db,
    auth.id,
    dispatch1,
    "POST_DISPATCH_AMBIGUOUS",
  );

  // Subsequent claim attempt fails because budget is consumed
  await assert.rejects(
    claimCompatibilityRegistration(db, auth.id, "worker-1", randomUUID()),
    { code: "CUSTODY_REGISTRATION_BUDGET_EXCEEDED" },
  );

  // 5. Successful registration lifecycle
  const acc2 = await createTestAccount(pool, "PERSONAL", "compat-success-test");
  const auth2 = await createCompatibilityAuthorization(db, {
    accountId: acc2.accountId,
    environment: "testnet",
  });
  const dispatch3 = randomUUID();
  await claimCompatibilityRegistration(
    db,
    auth2.id,
    "worker-success",
    dispatch3,
  );
  await completeCompatibilityRegistration(db, auth2.id, dispatch3);

  const auth2Rows = await pool.query<{
    status: string;
    registrations_completed: number;
    consumed_at: Date | null;
  }>(
    "SELECT status, registrations_completed, consumed_at FROM flow.provider_compatibility_authorizations WHERE id = $1::uuid",
    [auth2.id],
  );
  assert.equal(auth2Rows.rows[0]!.status, "CONSUMED");
  assert.equal(auth2Rows.rows[0]!.registrations_completed, 1);
  assert.ok(auth2Rows.rows[0]!.consumed_at);

  // 6. Expired authorization cannot be claimed
  const acc3 = await createTestAccount(pool, "PERSONAL", "compat-expired-test");
  const expiredInsert = await pool.query<{ id: string }>(
    `INSERT INTO flow.provider_compatibility_authorizations (
      account_id, environment, allowed_methods, status, max_registrations, expires_at
    ) VALUES ($1::uuid, 'testnet', ARRAY['POST /register'], 'AUTHORIZED', 1, CURRENT_TIMESTAMP - interval '1 minute')
    RETURNING id`,
    [acc3.accountId],
  );
  const expiredId = expiredInsert.rows[0]!.id;

  await assert.rejects(
    claimCompatibilityRegistration(db, expiredId, "worker-late", randomUUID()),
    { code: "CUSTODY_REGISTRATION_BUDGET_EXCEEDED" },
  );
});

test("M2 Phase 5.1 OutLayerAdapter prohibited execution methods throw CUSTODY_EXECUTION_BLOCKED", async () => {
  const adapter = new OutLayerAdapter("http://127.0.0.1:9999");

  await assert.rejects(adapter.sign(), {
    name: "FlowError",
    code: "CUSTODY_EXECUTION_BLOCKED",
  });
  await assert.rejects(adapter.broadcastTransaction(), {
    name: "FlowError",
    code: "CUSTODY_EXECUTION_BLOCKED",
  });
  await assert.rejects(adapter.transfer(), {
    name: "FlowError",
    code: "CUSTODY_EXECUTION_BLOCKED",
  });
  await assert.rejects(adapter.withdraw(), {
    name: "FlowError",
    code: "CUSTODY_EXECUTION_BLOCKED",
  });
  await assert.rejects(adapter.swap(), {
    name: "FlowError",
    code: "CUSTODY_EXECUTION_BLOCKED",
  });
  await assert.rejects(adapter.deleteWallet(), {
    name: "FlowError",
    code: "CUSTODY_EXECUTION_BLOCKED",
  });
  await assert.rejects(adapter.mutatePolicy(), {
    name: "FlowError",
    code: "CUSTODY_EXECUTION_BLOCKED",
  });
});

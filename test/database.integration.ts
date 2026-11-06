import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, test } from "node:test";
import pg from "pg";
import {
  evaluateWalletFundReadiness,
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
  attachWalletAddressesAndCapabilities,
  claimJobLease,
  commitJobSuccess,
  createProvisioningJob,
  getAccountWalletPublicProjection,
  persistRegisteredWallet,
  recordJobAmbiguous,
  recordJobDispatch,
  recordJobTerminalFailure,
  reconcileCrashedJobs,
} from "../src/server/custody/job-repository.ts";

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
    return { userId, accountId: accountResult.rows[0]!.id, kind };
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
    return { userId, accountId, kind };
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
    policyEvidence: {
      wallet_id: "outlayer-w-999",
      controller: "controller.near",
      frozen: false,
      policy: "stored",
      rules: { defaultAction: "DENY" },
    },
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
        address: "0x1234567890123456789012345678901234567890",
        publicKey: "secp256k1:0x04...",
      },
      {
        network: "solana",
        chainId: "solana-mainnet",
        address: "7YttLkHDoNj9wyDur5pM1x9XYf42G4y9m5t5aZ5r4i4o",
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
    {
      wallet_id: "outlayer-w-stage1",
      controller: "controller.near",
      frozen: false,
      policy: "stored",
      rules: { defaultAction: "DENY" },
    },
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

  const validPolicyEvidence: ProviderPolicyEvidenceInput = {
    wallet_id: "outlayer-active-cas",
    controller: "controller.near",
    frozen: false,
    policy: "stored",
    rules: { defaultAction: "DENY" },
  };

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
    policyEvidence: {
      wallet_id: "outlayer-proj-1",
      controller: "controller.near",
      frozen: false,
      policy: "stored",
      rules: { defaultAction: "DENY" },
    },
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

  const validPolicyEvidence: ProviderPolicyEvidenceInput = {
    wallet_id: "outlayer-adv-wallet-1",
    controller: "controller.near",
    frozen: false,
    policy: "stored",
    rules: { defaultAction: "DENY" },
  };

  // 1. Attempting to activate before addresses/capabilities are attached -> INCOMPLETE_WALLET_PROVISIONING
  await assert.rejects(
    activateWalletIfReady(
      db,
      leased.id,
      leased.fencingToken,
      walletId,
      validPolicyEvidence,
    ),
    { code: "INCOMPLETE_WALLET_PROVISIONING" },
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

  // 4. Attempting to promote policy using a caller-supplied string ("stored") -> POLICY_VERIFICATION_FAILED
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

  // 5. Attempting to activate with mismatched provider wallet_id -> CUSTODY_PROVIDER_CORRELATION_ERROR
  await assert.rejects(
    activateWalletIfReady(db, leased.id, leased.fencingToken, walletId, {
      ...validPolicyEvidence,
      wallet_id: "outlayer-wrong-wallet-id",
    }),
    { code: "CUSTODY_PROVIDER_CORRELATION_ERROR" },
  );

  // 6. Attempting to activate with policy='none' or frozen=true or invalid controller -> POLICY_VERIFICATION_FAILED
  await assert.rejects(
    activateWalletIfReady(db, leased.id, leased.fencingToken, walletId, {
      ...validPolicyEvidence,
      policy: "none",
    }),
    { code: "POLICY_VERIFICATION_FAILED" },
  );
  await assert.rejects(
    activateWalletIfReady(db, leased.id, leased.fencingToken, walletId, {
      ...validPolicyEvidence,
      frozen: true,
    }),
    { code: "POLICY_VERIFICATION_FAILED" },
  );
  await assert.rejects(
    activateWalletIfReady(db, leased.id, leased.fencingToken, walletId, {
      ...validPolicyEvidence,
      controller: "invalid controller!",
    }),
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
      policyEvidence: {
        wallet_id: "outlayer-funds-1",
        controller: "controller.near",
        frozen: false,
        policy: "none",
        rules: {},
      },
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
    policyEvidence: {
      wallet_id: "outlayer-funds-1",
      controller: "controller.near",
      frozen: false,
      policy: "stored",
      rules: { defaultAction: "DENY" },
    },
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

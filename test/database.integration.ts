import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, test } from "node:test";
import pg from "pg";
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
  claimJobLease,
  commitJobSuccess,
  createProvisioningJob,
  recordJobAmbiguous,
  recordJobDispatch,
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

  await recordJobDispatch(db, leased.id, leased.fencingToken, randomUUID());

  // Provider call timed out with ambiguous 504
  await recordJobAmbiguous(
    db,
    leased.id,
    leased.fencingToken,
    "Gateway timeout (504)",
  );

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
  assert.equal(rows[0]!.last_error, "Gateway timeout (504)");

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
    policyState: "stored",
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
        broadcastMode: "internal",
        canRotateCredentials: false,
      },
      {
        network: "base",
        canDeriveAddress: true,
        canReceive: true,
        canReadNativeBalance: false,
        canReadIntentsBalance: false,
        canSignTransfer: false,
        broadcastMode: "caller",
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
  }>(
    "SELECT encrypted_credential, key_id, key_digest, status FROM flow.wallets WHERE id = $1::uuid",
    [walletId],
  );

  const row = rows[0]!;
  assert.equal(row.status, "ACTIVE");
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

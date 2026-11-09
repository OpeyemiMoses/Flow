import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
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
import { FlowError } from "../src/foundation/errors.ts";
import {
  disconnectPrismaClients,
  getPrismaClient,
} from "../src/foundation/prisma.ts";
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
  createOperatorSession,
  createProvisioningJob,
  deriveOperatorContext,
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
import {
  createRehearsalAuthorization,
  formatSanitizedCliError,
  isJobPristineInitial,
  runTestnetRehearsal,
} from "../scripts/rehearse-testnet-registration.ts";
import { prepareIsolatedTestnetAccount } from "../scripts/prepare-testnet-account.ts";
import {
  listSupportedAssets,
  getAccountBalances,
  upsertWalletBalance,
} from "../src/server/assets/asset-service.ts";

assert.equal(
  process.env.FLOW_ENV,
  "test",
  "Integration tests require FLOW_ENV=test.",
);
const { database: appDbConfig } = readConfig(process.env, "runtime");
const pool = createDatabasePool(appDbConfig);
const appDb = getPrismaClient("runtime");

const { database: workerDbConfig } = readConfig(process.env, "worker");
const workerPool = createDatabasePool(workerDbConfig);
const db = getPrismaClient("worker");

const { database: operatorDbConfig } = readConfig(process.env, "operator");
const operatorPool = createDatabasePool(operatorDbConfig);
const operatorDb = getPrismaClient("operator");

after(async () => {
  await pool.end();
  await workerPool.end();
  await operatorPool.end();
  try {
    await disconnectPrismaClients();
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
    return {
      userId,
      accountId: accountResult.rows[0]!.id,
      authUserId,
      email,
      kind,
    };
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
    return { userId, accountId, authUserId, email, kind };
  }
}

async function createTestSession(
  client: pg.PoolClient | pg.Pool,
  authUserId: string,
  expiresInSeconds = 3600,
): Promise<string> {
  const token = `sess-${randomUUID()}`;
  const slot = `test-slot-${randomUUID()}`;
  const nonce = randomUUID();
  const nonceDigest = createHash("sha256").update(nonce).digest("hex");
  const pgClient = client instanceof pg.Pool ? await client.connect() : client;
  const shouldRelease = client instanceof pg.Pool;
  try {
    const userRes = await pgClient.query<{ email: string }>(
      `SELECT email FROM flow.auth_users WHERE id = $1`,
      [authUserId],
    );
    const email = userRes.rows[0]?.email ?? `${authUserId}@example.test`;
    await pgClient.query(
      `INSERT INTO flow.auth_intents (slot, digest, purpose, email, user_id, issued_at, expires_at)
       VALUES ($1, $2, 'sign-in-email', $3, $4, now(), now() + interval '5 minutes')`,
      [slot, nonceDigest, email, authUserId],
    );
    const ticketRes = await workerPool.query<{ id: string }>(
      `SELECT flow.issue_email_auth_ticket($1, $2) AS id`,
      [slot, nonceDigest],
    );
    await pgClient.query("BEGIN");
    await pgClient.query(
      `SELECT set_config('flow.active_auth_ticket_id', $1, true)`,
      [ticketRes.rows[0]!.id],
    );
    await pgClient.query(
      `INSERT INTO flow.auth_sessions (id, token, user_id, expires_at, created_at, updated_at)
       VALUES (gen_random_uuid(), $1, $2, now() + ($3 || ' seconds')::interval, now(), now())`,
      [token, authUserId, expiresInSeconds],
    );
    await pgClient.query("COMMIT");
  } catch (err) {
    await pgClient.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    if (shouldRelease) {
      (pgClient as pg.PoolClient).release();
    }
  }
  return token;
}

test("account ownership: enforces single wallet per account and preserves account isolation", async () => {
  const personal = await createTestAccount(pool, "PERSONAL", "own-pers");
  const business = await createTestAccount(pool, "BUSINESS", "own-biz");

  const w1Id = randomUUID();
  const w2Id = randomUUID();

  // Create wallet for personal account
  await workerPool.query(
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
  await workerPool.query(
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
    workerPool.query(
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
    workerPool.query(
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

  await workerPool.query(
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
  await workerPool.query(
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
    workerPool.query(
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
  await workerPool.query(
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
    workerPool.query(
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
  await workerPool.query(
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
  await workerPool.query(
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
  const { rows } = await workerPool.query<{
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
  const { rows: wRows } = await workerPool.query<{
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
  await workerPool.query(
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
  const { rows: credRows } = await workerPool.query<{
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
  const account = await createTestAccount(pool, "PERSONAL", "stale-fencing");
  await createProvisioningJob(db, account.accountId, randomUUID());

  // Worker 1 claims lease (fencing token = 1)
  const w1 = await claimJobLease(db, account.accountId, "worker-1", 30);
  assert.ok(w1 !== null);

  // Worker 1's lease expires before dispatch
  await workerPool.query(
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
  await workerPool.query(
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
  await assertDatabaseReady(pool, appDbConfig);
});

test("readiness rejects a mismatch between the expected and actual database", async () => {
  await assert.rejects(
    assertDatabaseReady(pool, { ...appDbConfig, name: "flow_local" }),
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
  const otherDatabase = new URL(appDbConfig.url);
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
    await workerPool.query(
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

    await workerPool.query(
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

    await workerPool.query(
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
    const { rows: jobRows } = await workerPool.query<{
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
      escalateJobToManualReview(operatorDb, {
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
      escalateJobToManualReview(operatorDb, {
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

    await escalateJobToManualReview(operatorDb, {
      jobId: personalJob.id,
      accountId: accPersonal.accountId,
      expectedAccountKind: "PERSONAL",
      operatorAuthId: opInitiatorAuthId,
      reasonCode: "AMBIGUOUS_REGISTRATION_OUTCOME",
      providerInspectionSummary: "REMOTE_WALLET_LOCATED",
      expectedDispatchAttemptId: dispatchAttemptId,
      requestId: randomUUID(),
    });

    const { rows: mrRows } = await workerPool.query<{
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
      resolveQuarantinedProvisioningJob(operatorDb, {
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
      resolveQuarantinedProvisioningJob(operatorDb, {
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
      resolveQuarantinedProvisioningJob(operatorDb, {
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
      resolveQuarantinedProvisioningJob(operatorDb, {
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
    const attached = await resolveQuarantinedProvisioningJob(operatorDb, {
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

    const { rows: dropJobRows } = await workerPool.query<{
      dispatch_attempt_id: string;
    }>(
      "SELECT dispatch_attempt_id FROM flow.wallet_provisioning_jobs WHERE id = $1::uuid",
      [noRemoteJob.id],
    );
    const dropDispatchId = dropJobRows[0]!.dispatch_attempt_id;

    await escalateJobToManualReview(operatorDb, {
      jobId: noRemoteJob.id,
      accountId: accNoRemote.accountId,
      expectedAccountKind: "PERSONAL",
      operatorAuthId: opInitiatorAuthId,
      reasonCode: "AMBIGUOUS_REGISTRATION_OUTCOME",
      providerInspectionSummary: "NO_REMOTE_WALLET_FOUND",
      expectedDispatchAttemptId: dropDispatchId,
      requestId: randomUUID(),
    });

    await resolveQuarantinedProvisioningJob(operatorDb, {
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
  await operatorPool.query(
    "SET LOCAL flow.allow_test_cleanup = 'on'; DELETE FROM flow.custody_recovery_approvals; DELETE FROM flow.custody_operators; DELETE FROM flow.provider_compatibility_authorizations;",
  );
  // Create real registered auth users for operators
  const secOfficer = await createTestAccount(pool, "PERSONAL", "sec-officer");
  const opRealA = await createTestAccount(pool, "PERSONAL", "real-op-a");
  const opRealB = await createTestAccount(pool, "PERSONAL", "real-op-b");
  const fakeOperatorAuthId = "unregistered-fake-operator-id";

  // 1. assertOperatorIdentityRegistered rejects fake operator ID
  await assert.rejects(
    assertOperatorIdentityRegistered(operatorDb, fakeOperatorAuthId),
    { code: "INVALID_OPERATOR_IDENTITY" },
  );

  // 2. assertOperatorIdentityRegistered succeeds for real registered auth user
  await assertOperatorIdentityRegistered(operatorDb, opRealA.authUserId);
  await assertOperatorIdentityRegistered(operatorDb, opRealB.authUserId);

  // Bootstrap initial security officer operator
  await enrollCustodyOperator(operatorDb, {
    authUserId: secOfficer.authUserId,
    role: "SECURITY_OFFICER",
    enrolledBy: opRealA.authUserId,
  });

  const secSession = await createOperatorSession(
    operatorDb,
    secOfficer.authUserId,
  );

  // Enroll opRealA into flow.custody_operators
  await enrollCustodyOperator(operatorDb, {
    authUserId: opRealA.authUserId,
    role: "CUSTODY_OPERATOR",
    enrolledBy: secOfficer.authUserId,
    enrolledBySessionToken: secSession.sessionToken,
  });
  await assertOperatorAuthority(operatorDb, opRealA.authUserId);
  await assert.rejects(
    assertOperatorAuthority(operatorDb, opRealB.authUserId),
    {
      code: "CUSTODY_OPERATOR_AUTHORIZATION_ERROR",
    },
  );

  // 3. Test verifyOperatorInDatabase on escalateJobToManualReview
  const acc = await createTestAccount(pool, "PERSONAL", "op-verify-test");
  const job = await ensureProvisioningJobForAccount(
    db,
    acc.accountId,
    randomUUID(),
  );

  // Set job status to UNKNOWN to allow escalation
  await operatorPool.query(
    "UPDATE flow.wallet_provisioning_jobs SET status = 'UNKNOWN', failure_classification = 'POST_DISPATCH_AMBIGUOUS', dispatch_attempt_id = gen_random_uuid(), dispatched_at = CURRENT_TIMESTAMP WHERE id = $1::uuid",
    [job.id],
  );

  const jobRows = await operatorPool.query<{ dispatch_attempt_id: string }>(
    "SELECT dispatch_attempt_id FROM flow.wallet_provisioning_jobs WHERE id = $1::uuid",
    [job.id],
  );
  const dispatchAttemptId = jobRows.rows[0]!.dispatch_attempt_id;

  // Escalation with fake operator and verifyOperatorInDatabase: true must be rejected
  await assert.rejects(
    escalateJobToManualReview(operatorDb, {
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
  await escalateJobToManualReview(operatorDb, {
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
    resolveQuarantinedProvisioningJob(operatorDb, {
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
    resolveQuarantinedProvisioningJob(operatorDb, {
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
  await enrollCustodyOperator(operatorDb, {
    authUserId: opRealB.authUserId,
    role: "CUSTODY_OPERATOR",
    enrolledBy: secOfficer.authUserId,
    enrolledBySessionToken: secSession.sessionToken,
  });

  // Resolution without independent flow.custody_recovery_approvals record must be rejected
  await assert.rejects(
    resolveQuarantinedProvisioningJob(operatorDb, {
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
  const opRealASession = await createOperatorSession(
    operatorDb,
    opRealA.authUserId,
  );
  const opRealBSession = await createOperatorSession(
    operatorDb,
    opRealB.authUserId,
  );
  await createCustodyRecoveryApproval(operatorDb, {
    jobId: job.id,
    accountId: acc.accountId,
    initiatorOperatorAuthId: opRealA.authUserId,
    initiatorSessionToken: opRealASession.sessionToken,
    approverAuthId: opRealB.authUserId,
    approverSessionToken: opRealBSession.sessionToken,
    expectedDispatchAttemptId: dispatchAttemptId,
    resolution: "RESET_CONFIRMED_PRE_CREATION_FAILURE",
  });

  // Resolution now succeeds and atomically consumes the approval record
  const resolutionResult = await resolveQuarantinedProvisioningJob(operatorDb, {
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
  await operatorPool.query(
    "SET LOCAL flow.allow_test_cleanup = 'on'; DELETE FROM flow.custody_recovery_approvals; DELETE FROM flow.custody_operators; DELETE FROM flow.provider_compatibility_authorizations;",
  );
  const acc = await createTestAccount(pool, "PERSONAL", "compat-budget-test");
  const opAuthUser = await createTestAccount(
    pool,
    "PERSONAL",
    "compat-op-user",
  );
  const secUser = await createTestAccount(pool, "PERSONAL", "compat-sec-user");

  await enrollCustodyOperator(operatorDb, {
    authUserId: secUser.authUserId,
    role: "SECURITY_OFFICER",
    enrolledBy: opAuthUser.authUserId,
  });
  const secUserSession = await createOperatorSession(
    operatorDb,
    secUser.authUserId,
  );
  await enrollCustodyOperator(operatorDb, {
    authUserId: opAuthUser.authUserId,
    role: "CUSTODY_OPERATOR",
    enrolledBy: secUser.authUserId,
    enrolledBySessionToken: secUserSession.sessionToken,
  });
  const opAuthUserSession = await createOperatorSession(
    operatorDb,
    opAuthUser.authUserId,
  );

  // 1. Check constraints on max_registrations and registrations_attempted
  await assert.rejects(
    operatorPool.query(
      `INSERT INTO flow.provider_compatibility_authorizations (
        account_id, environment, allowed_methods, max_registrations, expires_at
      ) VALUES ($1::uuid, 'testnet', ARRAY['POST /register'], 2, CURRENT_TIMESTAMP + interval '1 hour')`,
      [acc.accountId],
    ),
    { code: "23514" }, // CHECK constraint violation
  );

  // 2. Create durable single-use compatibility authorization record
  const auth = await createCompatibilityAuthorization(operatorDb, {
    accountId: acc.accountId,
    environment: "testnet",
    operatorAuthId: opAuthUser.authUserId,
    operatorSessionToken: opAuthUserSession.sessionToken,
  });
  assert.ok(auth.id);
  assert.ok(auth.expiresAt > new Date());

  // Creating duplicate authorization while singleton scope exists must fail
  await assert.rejects(
    createCompatibilityAuthorization(operatorDb, {
      accountId: acc.accountId,
      environment: "testnet",
      operatorAuthId: opAuthUser.authUserId,
      operatorSessionToken: opAuthUserSession.sessionToken,
    }),
    { code: "CUSTODY_REGISTRATION_BUDGET_EXCEEDED" },
  );

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

  // 5. Successful registration lifecycle: clean up previous singleton before creating next test
  await operatorPool.query(
    "SET LOCAL flow.allow_test_cleanup = 'on'; DELETE FROM flow.provider_compatibility_authorizations",
  );
  const acc2 = await createTestAccount(pool, "PERSONAL", "compat-success-test");
  const auth2 = await createCompatibilityAuthorization(operatorDb, {
    accountId: acc2.accountId,
    environment: "testnet",
    operatorAuthId: opAuthUser.authUserId,
    operatorSessionToken: opAuthUserSession.sessionToken,
  });
  const dispatch3 = randomUUID();
  await claimCompatibilityRegistration(
    db,
    auth2.id,
    "worker-success",
    dispatch3,
  );
  await completeCompatibilityRegistration(db, auth2.id, dispatch3);

  const auth2Rows = await operatorPool.query<{
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

  // 6. Expired authorization cannot be claimed: clean up previous singleton first
  await operatorPool.query(
    "SET LOCAL flow.allow_test_cleanup = 'on'; DELETE FROM flow.provider_compatibility_authorizations",
  );
  const acc3 = await createTestAccount(pool, "PERSONAL", "compat-expired-test");
  const expiredInsert = await operatorPool.query<{ id: string }>(
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

test("M2 Phase 5.2 Adversarial Test: Database privilege separation blocks permission abuse across roles", async () => {
  const acc = await createTestAccount(pool, "PERSONAL", "priv-abuse");
  const dummyWalletId = randomUUID();

  // 1. App role (pool) CANNOT insert into flow.wallets (42501 permission denied)
  await assert.rejects(
    pool.query(
      `INSERT INTO flow.wallets (
        id, account_id, provider, provider_wallet_id, near_account_id,
        encrypted_credential, key_id, key_digest, status
      ) VALUES ($1, $2, 'OUTLAYER', 'pw-bad', 'bad.near', 'v1:dummy', 'v1', 'digest', 'ACTIVE')`,
      [dummyWalletId, acc.accountId],
    ),
    { code: "42501" },
  );

  // 2. App role (pool) CANNOT insert or update flow.custody_operators (42501)
  await assert.rejects(
    pool.query(
      `INSERT INTO flow.custody_operators (auth_user_id, role, status, enrolled_by)
       VALUES ($1, 'CUSTODY_ADMIN', 'ACTIVE', $1)`,
      [acc.authUserId],
    ),
    { code: "42501" },
  );

  // 3. App role (pool) CANNOT insert or update flow.custody_recovery_approvals (42501)
  await assert.rejects(
    pool.query(
      `INSERT INTO flow.custody_recovery_approvals (
        job_id, account_id, approver_auth_id, initiator_operator_auth_id,
        dispatch_attempt_id, resolution, approval_token_hash, status, expires_at
      ) VALUES (gen_random_uuid(), $1, $2, $2, gen_random_uuid(), 'ATTACH_RECOVERED_WALLET', 'dummy-hash', 'PENDING', now() + interval '1 hour')`,
      [acc.accountId, acc.authUserId],
    ),
    { code: "42501" },
  );

  // 4. App role (pool) CANNOT insert or update flow.provider_compatibility_authorizations (42501)
  await assert.rejects(
    pool.query(
      `INSERT INTO flow.provider_compatibility_authorizations (
        account_id, environment, allowed_methods, status, max_registrations, expires_at
      ) VALUES ($1, 'testnet', ARRAY['POST /register'], 'AUTHORIZED', 1, now() + interval '1 hour')`,
      [acc.accountId],
    ),
    { code: "42501" },
  );

  // 5. App role (pool) CANNOT update flow.wallet_capabilities (42501)
  await assert.rejects(
    pool.query(`UPDATE flow.wallet_capabilities SET can_sign_transfer = true`),
    { code: "42501" },
  );

  // 6. Worker role (workerPool) CANNOT insert into flow.custody_operators (42501)
  await assert.rejects(
    workerPool.query(
      `INSERT INTO flow.custody_operators (auth_user_id, role, status, enrolled_by)
       VALUES ($1, 'CUSTODY_OPERATOR', 'ACTIVE', $1)`,
      [acc.authUserId],
    ),
    { code: "42501" },
  );

  // 7. Worker role (workerPool) CANNOT insert into flow.custody_recovery_approvals (42501)
  await assert.rejects(
    workerPool.query(
      `INSERT INTO flow.custody_recovery_approvals (
        job_id, account_id, approver_auth_id, initiator_operator_auth_id,
        dispatch_attempt_id, resolution, approval_token_hash, status, expires_at
      ) VALUES (gen_random_uuid(), $1, $2, $2, gen_random_uuid(), 'ATTACH_RECOVERED_WALLET', 'dummy-hash-worker', 'PENDING', now() + interval '1 hour')`,
      [acc.accountId, acc.authUserId],
    ),
    { code: "42501" },
  );

  // 8. Worker role (workerPool) CANNOT insert into flow.provider_compatibility_authorizations (42501)
  await assert.rejects(
    workerPool.query(
      `INSERT INTO flow.provider_compatibility_authorizations (
        account_id, environment, allowed_methods, status, max_registrations, expires_at
      ) VALUES ($1, 'testnet', ARRAY['POST /register'], 'AUTHORIZED', 1, now() + interval '1 hour')`,
      [acc.accountId],
    ),
    { code: "42501" },
  );

  // 9. Operator role (operatorPool) CANNOT insert into flow.wallet_addresses (42501)
  await assert.rejects(
    operatorPool.query(
      `INSERT INTO flow.wallet_addresses (wallet_id, network, chain_id, address, public_key)
       VALUES (gen_random_uuid(), 'near', 'near-testnet', 'alice.testnet', 'ed25519:dummy')`,
    ),
    { code: "42501" },
  );

  // 10. Operator role (operatorPool) CANNOT insert into flow.wallet_capabilities (42501)
  await assert.rejects(
    operatorPool.query(
      `INSERT INTO flow.wallet_capabilities (wallet_id, network, can_derive_address, can_receive, can_sign_transfer, broadcast_mode)
       VALUES (gen_random_uuid(), 'near', true, true, false, 'internal')`,
    ),
    { code: "42501" },
  );
});

test("M2 Phase 5.2 Adversarial Test: Operator self-enrollment, self-approval, approval replay, and correlation mismatch rejection", async () => {
  await operatorPool.query(
    "SET LOCAL flow.allow_test_cleanup = 'on'; DELETE FROM flow.custody_recovery_approvals; DELETE FROM flow.custody_operators; DELETE FROM flow.provider_compatibility_authorizations;",
  );
  const op1 = await createTestAccount(pool, "PERSONAL", "adv-op1");
  const op2 = await createTestAccount(pool, "PERSONAL", "adv-op2");
  const targetAcc = await createTestAccount(pool, "PERSONAL", "adv-target");

  // 1. Operator self-enrollment rejection (initiator === approver / enrolledBy)
  await assert.rejects(
    enrollCustodyOperator(operatorDb, {
      authUserId: op1.authUserId,
      enrolledBy: op1.authUserId, // self-enrollment!
    }),
    { code: "TWO_PERSON_APPROVAL_REQUIRED" },
  );

  // Bootstrap initial security officer
  await enrollCustodyOperator(operatorDb, {
    authUserId: op1.authUserId,
    role: "SECURITY_OFFICER",
    enrolledBy: op2.authUserId,
  });
  const op1Session = await createOperatorSession(operatorDb, op1.authUserId);
  await enrollCustodyOperator(operatorDb, {
    authUserId: op2.authUserId,
    role: "CUSTODY_OPERATOR",
    enrolledBy: op1.authUserId,
    enrolledBySessionToken: op1Session.sessionToken,
  });
  const op2Session = await createOperatorSession(operatorDb, op2.authUserId);

  // Setup quarantined job
  const job = await ensureProvisioningJobForAccount(
    db,
    targetAcc.accountId,
    randomUUID(),
  );
  const dispatchAttemptId = randomUUID();
  await operatorPool.query(
    "UPDATE flow.wallet_provisioning_jobs SET status = 'UNKNOWN', failure_classification = 'POST_DISPATCH_AMBIGUOUS', dispatch_attempt_id = $1::uuid, dispatched_at = CURRENT_TIMESTAMP WHERE id = $2::uuid",
    [dispatchAttemptId, job.id],
  );

  // Escalate to MANUAL_REVIEW with providerInspectionSummary='NO_REMOTE_WALLET_FOUND'
  await escalateJobToManualReview(operatorDb, {
    jobId: job.id,
    accountId: targetAcc.accountId,
    operatorAuthId: op1.authUserId,
    reasonCode: "AMBIGUOUS_REGISTRATION_OUTCOME",
    providerInspectionSummary: "NO_REMOTE_WALLET_FOUND",
    requestId: randomUUID(),
    verifyOperatorInDatabase: true,
  });

  // 2. Recovery self-approval rejection (initiator === approver)
  await assert.rejects(
    createCustodyRecoveryApproval(operatorDb, {
      jobId: job.id,
      accountId: targetAcc.accountId,
      initiatorOperatorAuthId: op1.authUserId,
      initiatorSessionToken: op1Session.sessionToken,
      approverAuthId: op1.authUserId, // self-approval!
      approverSessionToken: op1Session.sessionToken,
      expectedDispatchAttemptId: dispatchAttemptId,
      resolution: "RESET_CONFIRMED_PRE_CREATION_FAILURE",
    }),
    { code: "TWO_PERSON_APPROVAL_REQUIRED" },
  );

  // Direct DB insert check constraint rejection: custody_recovery_approvals_self_approval_check
  await assert.rejects(
    operatorPool.query(
      `INSERT INTO flow.custody_recovery_approvals (
        job_id, account_id, approver_auth_id, initiator_operator_auth_id,
        dispatch_attempt_id, resolution, approval_token_hash, status, expires_at
      ) VALUES ($1::uuid, $2::uuid, $3, $3, $4::uuid, 'RESET_CONFIRMED_PRE_CREATION_FAILURE', 'hash-self', 'PENDING', now() + interval '1 hour')`,
      [job.id, targetAcc.accountId, op1.authUserId, dispatchAttemptId],
    ),
    { code: "23514" }, // CHECK constraint violation
  );

  // 3. Dispatch attempt ID mismatch: approval created for dispatch attempt A cannot be used for B
  const wrongDispatchId = randomUUID();
  await assert.rejects(
    createCustodyRecoveryApproval(operatorDb, {
      jobId: job.id,
      accountId: targetAcc.accountId,
      initiatorOperatorAuthId: op1.authUserId,
      initiatorSessionToken: op1Session.sessionToken,
      approverAuthId: op2.authUserId,
      approverSessionToken: op2Session.sessionToken,
      expectedDispatchAttemptId: wrongDispatchId, // wrong dispatch ID!
      resolution: "RESET_CONFIRMED_PRE_CREATION_FAILURE",
    }),
    { code: "CUSTODY_PROVIDER_CORRELATION_ERROR" },
  );

  // 4. Valid recovery approval creation
  const approval = await createCustodyRecoveryApproval(operatorDb, {
    jobId: job.id,
    accountId: targetAcc.accountId,
    initiatorOperatorAuthId: op1.authUserId,
    initiatorSessionToken: op1Session.sessionToken,
    approverAuthId: op2.authUserId,
    approverSessionToken: op2Session.sessionToken,
    expectedDispatchAttemptId: dispatchAttemptId,
    resolution: "RESET_CONFIRMED_PRE_CREATION_FAILURE",
  });
  assert.ok(approval.id);
  assert.ok(approval.token);

  // 5. Recovery resolution consumes the approval record
  await resolveQuarantinedProvisioningJob(operatorDb, {
    resolution: "RESET_CONFIRMED_PRE_CREATION_FAILURE",
    jobId: job.id,
    accountId: targetAcc.accountId,
    expectedAccountKind: "PERSONAL",
    expectedDispatchAttemptId: dispatchAttemptId,
    initiatorOperatorAuthId: op1.authUserId,
    approverOperatorAuthId: op2.authUserId,
    approvalToken: approval.token,
    requestId: randomUUID(),
    verifyOperatorInDatabase: true,
  });

  // Check approval record is now CONSUMED in PostgreSQL
  const { rows: appRows } = await operatorPool.query<{
    status: string;
    consumed_at: Date | null;
  }>(
    "SELECT status, consumed_at FROM flow.custody_recovery_approvals WHERE id = $1::uuid",
    [approval.id],
  );
  assert.equal(appRows[0]!.status, "CONSUMED");
  assert.ok(appRows[0]!.consumed_at);

  // 6. Approval replay rejection: attempting to resolve again with same consumed approval MUST FAIL
  await operatorPool.query(
    "UPDATE flow.wallet_provisioning_jobs SET status = 'MANUAL_REVIEW' WHERE id = $1::uuid",
    [job.id],
  );
  await assert.rejects(
    resolveQuarantinedProvisioningJob(operatorDb, {
      resolution: "RESET_CONFIRMED_PRE_CREATION_FAILURE",
      jobId: job.id,
      accountId: targetAcc.accountId,
      expectedAccountKind: "PERSONAL",
      expectedDispatchAttemptId: dispatchAttemptId,
      initiatorOperatorAuthId: op1.authUserId,
      approverOperatorAuthId: op2.authUserId,
      approvalToken: approval.token, // REPLAY!
      requestId: randomUUID(),
      verifyOperatorInDatabase: true,
    }),
    { code: "CUSTODY_INDEPENDENT_APPROVAL_REQUIRED" },
  );
});

test("M2 Phase 5.2 Adversarial Test: Database singleton_scope UNIQUE constraint prevents multiple authorization grants", async () => {
  await operatorPool.query(
    "SET LOCAL flow.allow_test_cleanup = 'on'; DELETE FROM flow.custody_recovery_approvals; DELETE FROM flow.custody_operators; DELETE FROM flow.provider_compatibility_authorizations;",
  );
  const accA = await createTestAccount(pool, "PERSONAL", "adv-singleton-a");
  const accB = await createTestAccount(pool, "PERSONAL", "adv-singleton-b");
  const opUser = await createTestAccount(pool, "PERSONAL", "adv-singleton-op");
  const secUser = await createTestAccount(
    pool,
    "PERSONAL",
    "adv-singleton-sec",
  );

  await enrollCustodyOperator(operatorDb, {
    authUserId: secUser.authUserId,
    role: "SECURITY_OFFICER",
    enrolledBy: opUser.authUserId,
  });
  const secUserSession = await createOperatorSession(
    operatorDb,
    secUser.authUserId,
  );
  await enrollCustodyOperator(operatorDb, {
    authUserId: opUser.authUserId,
    role: "CUSTODY_OPERATOR",
    enrolledBy: secUser.authUserId,
    enrolledBySessionToken: secUserSession.sessionToken,
  });
  const opUserSession = await createOperatorSession(
    operatorDb,
    opUser.authUserId,
  );

  await operatorPool.query(
    "SET LOCAL flow.allow_test_cleanup = 'on'; DELETE FROM flow.provider_compatibility_authorizations",
  );

  // Create first authorization record
  const authA = await createCompatibilityAuthorization(operatorDb, {
    accountId: accA.accountId,
    environment: "testnet",
    operatorAuthId: opUser.authUserId,
    operatorSessionToken: opUserSession.sessionToken,
  });
  assert.ok(authA.id);

  // Attempting to insert a 2nd record directly via SQL fails with UNIQUE constraint violation on singleton_scope (23505)
  await assert.rejects(
    operatorPool.query(
      `INSERT INTO flow.provider_compatibility_authorizations (
        account_id, environment, allowed_methods, status, max_registrations, singleton_scope, expires_at
      ) VALUES ($1::uuid, 'testnet', ARRAY['POST /register'], 'AUTHORIZED', 1, 'GLOBAL_TESTNET_REHEARSAL', now() + interval '1 hour')`,
      [accB.accountId],
    ),
    { code: "23505" }, // Unique constraint violation
  );

  // Attempting to bypass singleton_scope with a different scope value fails with CHECK constraint violation (23514)
  await assert.rejects(
    operatorPool.query(
      `INSERT INTO flow.provider_compatibility_authorizations (
        account_id, environment, allowed_methods, status, max_registrations, singleton_scope, expires_at
      ) VALUES ($1::uuid, 'testnet', ARRAY['POST /register'], 'AUTHORIZED', 1, 'BYPASS_ATTEMPT', now() + interval '1 hour')`,
      [accB.accountId],
    ),
    { code: "23514" }, // Check constraint violation
  );

  // Clean up
  await operatorPool.query(
    "SET LOCAL flow.allow_test_cleanup = 'on'; DELETE FROM flow.provider_compatibility_authorizations",
  );
});

test("M2 Phase 5.2 Testnet wallet projection segregation: never eligible for deposits and displays deposit warning", async () => {
  const accTestnet = await createTestAccount(pool, "PERSONAL", "proj-testnet");
  const accMainnet = await createTestAccount(pool, "PERSONAL", "proj-mainnet");

  // Create testnet wallet
  const wTestnetId = randomUUID();
  await workerPool.query(
    `INSERT INTO flow.wallets (
      id, account_id, provider, provider_wallet_id, near_account_id,
      encrypted_credential, key_id, key_digest, status, policy_state,
      controller_account_id, environment
    ) VALUES (
      $1, $2, 'OUTLAYER', 'pw-testnet-1', 'testnet-wallet.near',
      'v1:dummy', 'v1', 'digest', 'ACTIVE', 'stored', 'controller.near', 'testnet'
    )`,
    [wTestnetId, accTestnet.accountId],
  );

  // Create mainnet wallet
  const wMainnetId = randomUUID();
  await workerPool.query(
    `INSERT INTO flow.wallets (
      id, account_id, provider, provider_wallet_id, near_account_id,
      encrypted_credential, key_id, key_digest, status, policy_state,
      controller_account_id, environment
    ) VALUES (
      $1, $2, 'OUTLAYER', 'pw-mainnet-1', 'mainnet-wallet.near',
      'v1:dummy', 'v1', 'digest', 'ACTIVE', 'stored', 'controller.near', 'mainnet'
    )`,
    [wMainnetId, accMainnet.accountId],
  );

  // Public projection for testnet wallet
  const testnetProj = await getAccountWalletPublicProjection(
    appDb,
    accTestnet.accountId,
  );
  assert.ok(testnetProj !== null);
  assert.equal(testnetProj.environment, "testnet");
  assert.equal(testnetProj.isTestnet, true);
  assert.equal(
    testnetProj.eligibleForDeposits,
    false,
    "Testnet wallet must NEVER be eligible for deposits",
  );
  assert.equal(
    testnetProj.fundsReady,
    false,
    "Testnet wallet must NEVER be fundsReady",
  );
  assert.ok(
    testnetProj.depositWarning !== null,
    "Testnet wallet must include deposit warning",
  );
  assert.match(testnetProj.depositWarning!, /NEVER send mainnet or real funds/);

  // Public projection for mainnet wallet
  const mainnetProj = await getAccountWalletPublicProjection(
    appDb,
    accMainnet.accountId,
  );
  assert.ok(mainnetProj !== null);
  assert.equal(mainnetProj.environment, "mainnet");
  assert.equal(mainnetProj.isTestnet, false);
  assert.equal(mainnetProj.depositWarning, null);
});

test("M2 Phase 5.3 PostgreSQL column-level privilege isolation: app_role cannot select custody secret columns even via direct SQL", async () => {
  const account = await createTestAccount(pool, "PERSONAL", "col-priv-iso");
  const walletId = randomUUID();

  // Insert wallet with custody secret columns via workerPool
  await workerPool.query(
    `INSERT INTO flow.wallets (
      id, account_id, provider, provider_wallet_id, near_account_id,
      encrypted_credential, key_id, key_digest, status, policy_state,
      controller_account_id, environment
    ) VALUES (
      $1, $2, 'OUTLAYER', 'pw-sec-test-1', 'sec-test.near',
      'v1:sensitive_encrypted_credential', 'v1', 'key_digest_123', 'PROVISIONING', 'none',
      'controller.near', 'testnet'
    )`,
    [walletId, account.accountId],
  );

  // 1. Direct SQL by app role (pool) for encrypted_credential must fail with 42501 (permission denied)
  await assert.rejects(
    pool.query("SELECT encrypted_credential FROM flow.wallets WHERE id = $1", [
      walletId,
    ]),
    { code: "42501" },
  );

  // 2. Direct SQL by app role (pool) for key_id and key_digest must fail with 42501
  await assert.rejects(
    pool.query("SELECT key_id, key_digest FROM flow.wallets WHERE id = $1", [
      walletId,
    ]),
    { code: "42501" },
  );

  // 3. Direct SQL by app role (pool) for SELECT * must fail with 42501
  await assert.rejects(
    pool.query("SELECT * FROM flow.wallets WHERE id = $1", [walletId]),
    { code: "42501" },
  );

  // 4. Direct SQL by app role (pool) for permitted columns must SUCCEED
  const permittedResult = await pool.query<{
    id: string;
    near_account_id: string;
    status: string;
    environment: string;
  }>(
    `SELECT id, account_id, provider, environment, provider_wallet_id,
            near_account_id, status, policy_state, controller_account_id,
            handoff_url, created_at, updated_at
     FROM flow.wallets WHERE id = $1`,
    [walletId],
  );
  assert.equal(permittedResult.rows.length, 1);
  assert.equal(permittedResult.rows[0]!.id, walletId);
  assert.equal(permittedResult.rows[0]!.near_account_id, "sec-test.near");

  // 5. Querying the safe public view flow.wallet_public_projections as app role must SUCCEED
  const viewResult = await pool.query<{ id: string; near_account_id: string }>(
    "SELECT * FROM flow.wallet_public_projections WHERE id = $1",
    [walletId],
  );
  assert.equal(viewResult.rows.length, 1);
  assert.equal(viewResult.rows[0]!.near_account_id, "sec-test.near");

  // 6. getAccountWalletPublicProjection via appDb works seamlessly without errors
  const projection = await getAccountWalletPublicProjection(
    appDb,
    account.accountId,
  );
  assert.ok(projection !== null);
  assert.equal(projection.id, walletId);
  assert.equal(projection.nearAccountId, "sec-test.near");
  assert.equal(projection.environment, "testnet");
  assert.equal(projection.isTestnet, true);
  assert.equal(projection.fundsReady, false);
});

test("M2 Phase 5.3 Permanent durability: DELETE revoked and trigger prevents resetting or tampering with compatibility authorization", async () => {
  await operatorPool.query(
    "SET LOCAL flow.allow_test_cleanup = 'on'; DELETE FROM flow.custody_recovery_approvals; DELETE FROM flow.custody_operators; DELETE FROM flow.provider_compatibility_authorizations;",
  );
  const account = await createTestAccount(pool, "PERSONAL", "auth-durability");
  const secUser = await createTestAccount(pool, "PERSONAL", "sec-durability");
  const opUser = await createTestAccount(pool, "PERSONAL", "op-durability");

  await enrollCustodyOperator(operatorDb, {
    authUserId: secUser.authUserId,
    role: "SECURITY_OFFICER",
    enrolledBy: opUser.authUserId,
  });
  const secUserSession = await createOperatorSession(
    operatorDb,
    secUser.authUserId,
  );
  await enrollCustodyOperator(operatorDb, {
    authUserId: opUser.authUserId,
    role: "CUSTODY_OPERATOR",
    enrolledBy: secUser.authUserId,
    enrolledBySessionToken: secUserSession.sessionToken,
  });
  const opUserSession = await createOperatorSession(
    operatorDb,
    opUser.authUserId,
  );

  const auth = await createCompatibilityAuthorization(operatorDb, {
    accountId: account.accountId,
    environment: "testnet",
    operatorAuthId: opUser.authUserId,
    operatorSessionToken: opUserSession.sessionToken,
  });
  assert.ok(auth.id);

  // 1. Worker role CANNOT DELETE from flow.provider_compatibility_authorizations (42501)
  await assert.rejects(
    workerPool.query(
      "DELETE FROM flow.provider_compatibility_authorizations WHERE id = $1",
      [auth.id],
    ),
    { code: "42501" },
  );

  // 2. App role CANNOT DELETE from flow.provider_compatibility_authorizations (42501)
  await assert.rejects(
    pool.query(
      "DELETE FROM flow.provider_compatibility_authorizations WHERE id = $1",
      [auth.id],
    ),
    { code: "42501" },
  );

  // Claim and consume the authorization
  const dispatchAttemptId = randomUUID();
  await claimCompatibilityRegistration(
    db,
    auth.id,
    "test-worker",
    dispatchAttemptId,
  );
  await completeCompatibilityRegistration(db, auth.id, dispatchAttemptId);

  // 3. Operator CANNOT delete a consumed authorization (42501 - immutability trigger)
  await assert.rejects(
    operatorPool.query(
      "DELETE FROM flow.provider_compatibility_authorizations WHERE id = $1",
      [auth.id],
    ),
    { code: "42501" },
  );

  // 4. Operator CANNOT reset status back to AUTHORIZED (23514 - trigger check)
  await assert.rejects(
    operatorPool.query(
      "UPDATE flow.provider_compatibility_authorizations SET status = 'AUTHORIZED' WHERE id = $1",
      [auth.id],
    ),
    { code: "23514" },
  );

  // 5. Operator CANNOT decrement registrations_attempted (23514 - trigger check)
  await assert.rejects(
    operatorPool.query(
      "UPDATE flow.provider_compatibility_authorizations SET registrations_attempted = 0 WHERE id = $1",
      [auth.id],
    ),
    { code: "23514" },
  );

  // 6. Operator CANNOT tamper with account_id or singleton_scope on consumed authorization (23514)
  await assert.rejects(
    operatorPool.query(
      "UPDATE flow.provider_compatibility_authorizations SET account_id = gen_random_uuid() WHERE id = $1",
      [auth.id],
    ),
    { code: "23514" },
  );

  // Clean up using test cleanup setting
  await operatorPool.query(
    "SET LOCAL flow.allow_test_cleanup = 'on'; DELETE FROM flow.provider_compatibility_authorizations;",
  );
});

test("M2 Phase 5.3 Testnet rehearsal lifecycle: anonymous registration with policy='none' completes with outcome: registered and PROVISIONING status", async () => {
  const account = await createTestAccount(
    pool,
    "PERSONAL",
    "rehearsal-lifecycle",
  );
  const fixture = await createOutLayerMockServer({
    policyState: "none", // Anonymous registration on testnet has policy='none'
  });

  try {
    await ensureProvisioningJobForAccount(db, account.accountId, randomUUID());

    const adapter = new OutLayerAdapter(fixture.url, 5_000);
    const worker = new WalletProvisioningWorker({
      db,
      adapter,
      walletConfig: {
        encryptionKey:
          "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
        keyId: "v1",
      },
      providerEnvironment: "testnet",
    });

    const result = await worker.processAccountJob(account.accountId);
    assert.equal(result.outcome, "registered");
    assert.ok(result.walletId);

    // Verify wallet status is PROVISIONING, NOT ACTIVE
    const walletRows = await workerPool.query<{
      status: string;
      policy_state: string;
      environment: string;
    }>(
      "SELECT status, policy_state, environment FROM flow.wallets WHERE id = $1::uuid",
      [result.walletId],
    );
    assert.equal(walletRows.rows[0]!.status, "PROVISIONING");
    assert.equal(walletRows.rows[0]!.policy_state, "none");
    assert.equal(walletRows.rows[0]!.environment, "testnet");

    // Verify job status is PROVISIONED
    const jobRows = await workerPool.query<{ status: string }>(
      "SELECT status FROM flow.wallet_provisioning_jobs WHERE id = $1::uuid",
      [result.jobId],
    );
    assert.equal(jobRows.rows[0]!.status, "PROVISIONED");

    // Verify public projection
    const projection = await getAccountWalletPublicProjection(
      appDb,
      account.accountId,
    );
    assert.ok(projection !== null);
    assert.equal(projection.status, "PROVISIONING");
    assert.equal(projection.environment, "testnet");
    assert.equal(projection.isTestnet, true);
    assert.equal(projection.fundsReady, false);
    assert.equal(projection.canReceiveFunds, false);
    assert.equal(projection.canSignTransfers, false);
    assert.equal(projection.eligibleForDeposits, false);
    assert.ok(projection.depositWarning !== null);
  } finally {
    await fixture.close();
    await operatorPool.query(
      "SET LOCAL flow.allow_test_cleanup = 'on'; DELETE FROM flow.provider_compatibility_authorizations;",
    );
  }
});

test("M2 Phase 5.3 Operator identity derivation: requires active custody operator authority and validates session", async () => {
  await operatorPool.query(
    "SET LOCAL flow.allow_test_cleanup = 'on'; DELETE FROM flow.custody_recovery_approvals; DELETE FROM flow.custody_operators; DELETE FROM flow.provider_compatibility_authorizations;",
  );
  const normalUser = await createTestAccount(pool, "PERSONAL", "unauthed-user");
  const targetAcc = await createTestAccount(pool, "PERSONAL", "target-acc");

  // Attempting to create compatibility authorization using a regular user ID lacking operator authority fails
  await assert.rejects(
    createCompatibilityAuthorization(operatorDb, {
      accountId: targetAcc.accountId,
      environment: "testnet",
      operatorAuthId: normalUser.authUserId,
    }),
    (err: unknown) =>
      err instanceof FlowError &&
      (err.code === "CUSTODY_OPERATOR_AUTHORIZATION_ERROR" ||
        err.code === "CUSTODY_OPERATOR_AUTHENTICATION_REQUIRED"),
  );

  // Attempting to derive operator context without ANY session token or execution key fails (Requirement 4 & 5)
  await assert.rejects(
    deriveOperatorContext(operatorDb, {
      operatorAuthId: normalUser.authUserId,
    }),
    (err: unknown) =>
      err instanceof FlowError &&
      (err.code === "CUSTODY_OPERATOR_AUTHORIZATION_ERROR" ||
        err.code === "CUSTODY_OPERATOR_AUTHENTICATION_REQUIRED"),
  );

  // Attempting to derive operator context with an invalid session token fails
  await assert.rejects(
    deriveOperatorContext(operatorDb, {
      operatorAuthId: normalUser.authUserId,
      sessionToken: "invalid_session_token_12345",
    }),
    (err: unknown) =>
      err instanceof FlowError &&
      (err.code === "CUSTODY_OPERATOR_AUTHORIZATION_ERROR" ||
        err.code === "CUSTODY_OPERATOR_AUTHENTICATION_REQUIRED"),
  );

  // Enroll operator and verify session derivation
  const secUser = await createTestAccount(pool, "PERSONAL", "sec-sess-user");
  await enrollCustodyOperator(operatorDb, {
    authUserId: secUser.authUserId,
    role: "SECURITY_OFFICER",
    enrolledBy: normalUser.authUserId,
  });

  const session = await createOperatorSession(
    operatorDb,
    secUser.authUserId,
    30,
  );
  assert.ok(session.sessionId);
  assert.ok(session.sessionToken);

  const derived = await deriveOperatorContext(operatorDb, {
    operatorAuthId: secUser.authUserId,
    sessionToken: session.sessionToken,
  });
  assert.equal(derived.operatorAuthId, secUser.authUserId);
  assert.equal(derived.role, "SECURITY_OFFICER");
  assert.equal(derived.verificationMethod, "SESSION");
  assert.equal(derived.sessionId, session.sessionId);
});

test("M2 Phase 5.4 Deterministic one-time rehearsal command (runTestnetRehearsal): dry-run, explicit authorization, and simulated provider rehearsal", async () => {
  await operatorPool.query(
    "SET LOCAL flow.allow_test_cleanup = 'on'; DELETE FROM flow.custody_recovery_approvals; DELETE FROM flow.custody_operators; DELETE FROM flow.provider_compatibility_authorizations;",
  );
  const targetAcc = await createTestAccount(
    pool,
    "PERSONAL",
    "rehearsal-cmd-acc",
  );
  const opUser = await createTestAccount(pool, "PERSONAL", "rehearsal-cmd-op");

  await enrollCustodyOperator(operatorDb, {
    authUserId: opUser.authUserId,
    role: "SECURITY_OFFICER",
    enrolledBy: targetAcc.authUserId,
  });

  const opSession = await createOperatorSession(operatorDb, opUser.authUserId);

  const fixture = await createOutLayerMockServer({
    policyState: "none",
  });

  try {
    const testEnv: Record<string, string | undefined> = {
      ...process.env,
      FLOW_ENV: "test",
      FLOW_EXECUTION: "disabled",
      FLOW_PROVIDER_COMPATIBILITY_MODE: "authorized",
      FLOW_PROVIDER_COMPATIBILITY_ACCOUNT_ID: targetAcc.accountId,
      FLOW_PROVIDER_COMPATIBILITY_TOKEN: "valid_test_token_12345678",
      FLOW_WALLET_PROVIDER: "outlayer",
      FLOW_WALLET_ENCRYPTION_KEY:
        "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      FLOW_WALLET_KEY_ID: "v1",
      FLOW_OUTLAYER_API_URL: fixture.url,
      FLOW_CUSTODY_OPERATOR_AUTH_ID: opUser.authUserId,
      FLOW_CUSTODY_OPERATOR_SESSION_TOKEN: opSession.sessionToken,
    };

    // 1. Dry run BEFORE authorization is created: inspects safely, reports missing authorization, ZERO writes
    const preAuthDryRun = await runTestnetRehearsal({
      dryRun: true,
      accountId: targetAcc.accountId,
      operatorAuthId: opUser.authUserId,
      operatorSessionToken: opSession.sessionToken,
      offlineTestMode: true,
      env: testEnv,
    });
    assert.equal(preAuthDryRun.success, true);
    assert.equal(preAuthDryRun.dryRun, true);
    assert.equal(preAuthDryRun.preflight.prerequisitesSatisfied, false);
    assert.ok(
      preAuthDryRun.preflight.missingPrerequisites.includes(
        "COMPATIBILITY_AUTHORIZATION_MISSING",
      ),
    );

    // Verify ZERO writes were made during dry-run
    const noWallets = await workerPool.query(
      "SELECT id FROM flow.wallets WHERE account_id = $1::uuid",
      [targetAcc.accountId],
    );
    assert.equal(noWallets.rows.length, 0);

    const noAuths = await operatorPool.query(
      "SELECT id FROM flow.provider_compatibility_authorizations WHERE singleton_scope = 'GLOBAL_TESTNET_REHEARSAL'",
    );
    assert.equal(noAuths.rows.length, 0);

    // 2. Explicitly create authorization separately (Requirement 3)
    const createdAuth = await createRehearsalAuthorization({
      accountId: targetAcc.accountId,
      operatorAuthId: opUser.authUserId,
      operatorSessionToken: opSession.sessionToken,
      env: testEnv,
    });
    assert.ok(createdAuth.id);
    assert.equal(createdAuth.accountId, targetAcc.accountId);

    // 3. Dry run AFTER authorization is created: all prerequisites satisfied, ZERO writes
    const postAuthDryRun = await runTestnetRehearsal({
      dryRun: true,
      accountId: targetAcc.accountId,
      operatorAuthId: opUser.authUserId,
      operatorSessionToken: opSession.sessionToken,
      offlineTestMode: true,
      env: testEnv,
    });
    assert.equal(postAuthDryRun.success, true);
    assert.equal(postAuthDryRun.dryRun, true);
    assert.equal(postAuthDryRun.preflight.prerequisitesSatisfied, true);
    assert.equal(postAuthDryRun.preflight.authorizationId, createdAuth.id);
    assert.equal(postAuthDryRun.preflight.authorizationStatus, "AUTHORIZED");
    assert.equal(postAuthDryRun.preflight.authorizationValid, true);

    // 4. Full Rehearsal execution
    const customAdapter = new OutLayerAdapter(fixture.url, 5_000, {
      compatibilityConfig: {
        mode: "authorized",
        providerEnvironment: "testnet",
        maxRegistrations: 1,
      },
    });

    const executionResult = await runTestnetRehearsal({
      dryRun: false,
      accountId: targetAcc.accountId,
      operatorAuthId: opUser.authUserId,
      operatorSessionToken: opSession.sessionToken,
      customAdapter,
      offlineTestMode: true,
      env: testEnv,
    });

    assert.equal(executionResult.success, true);
    assert.equal(executionResult.dryRun, false);
    assert.equal(executionResult.outcome, "registered");
    assert.equal(executionResult.fundsReady, false);
    assert.equal(executionResult.eligibleForDeposits, false);
    assert.equal(executionResult.budgetExceededPrevented, true);

    // 5. Credential encrypted immediately
    const walletRecord = await workerPool.query<{
      encrypted_credential: string;
      key_id: string;
    }>(
      "SELECT encrypted_credential, key_id FROM flow.wallets WHERE id = $1::uuid",
      [executionResult.walletId],
    );
    assert.equal(walletRecord.rows.length, 1);
    const parsedEnvelope = deserializeEnvelope(
      walletRecord.rows[0]!.encrypted_credential,
    );
    assert.equal(parsedEnvelope.version, 1);
    assert.equal(parsedEnvelope.keyId, "v1");
    assert.equal(walletRecord.rows[0]!.key_id, "v1");

    // 6. Authorization is consumed
    const authRecord = await operatorPool.query<{
      status: string;
      registrations_completed: number;
    }>(
      "SELECT status, registrations_completed FROM flow.provider_compatibility_authorizations WHERE singleton_scope = 'GLOBAL_TESTNET_REHEARSAL'",
    );
    assert.equal(authRecord.rows[0]!.status, "CONSUMED");
    assert.equal(authRecord.rows[0]!.registrations_completed, 1);

    // 7. Subsequent rehearsal execution fails with CUSTODY_REGISTRATION_BUDGET_EXCEEDED
    const targetAcc2 = await createTestAccount(
      pool,
      "PERSONAL",
      "rehearsal-target-acc-2",
    );
    await assert.rejects(
      runTestnetRehearsal({
        dryRun: false,
        accountId: targetAcc2.accountId,
        operatorAuthId: opUser.authUserId,
        operatorSessionToken: opSession.sessionToken,
        customAdapter,
        offlineTestMode: true,
        env: {
          ...testEnv,
          FLOW_PROVIDER_COMPATIBILITY_ACCOUNT_ID: targetAcc2.accountId,
        },
      }),
      { code: "CUSTODY_REGISTRATION_BUDGET_EXCEEDED" },
    );
  } finally {
    await fixture.close();
    await operatorPool.query(
      "SET LOCAL flow.allow_test_cleanup = 'on'; DELETE FROM flow.provider_compatibility_authorizations;",
    );
  }
});

test("M2 Phase 5.4 Adversarial Test: --dry-run is database-read-only and performs ZERO writes across all tables", async () => {
  await operatorPool.query(
    "SET LOCAL flow.allow_test_cleanup = 'on'; DELETE FROM flow.custody_recovery_approvals; DELETE FROM flow.custody_operators; DELETE FROM flow.provider_compatibility_authorizations;",
  );
  const targetAcc = await createTestAccount(pool, "PERSONAL", "readonly-acc");
  const opUser = await createTestAccount(pool, "PERSONAL", "readonly-op");

  await enrollCustodyOperator(operatorDb, {
    authUserId: opUser.authUserId,
    role: "SECURITY_OFFICER",
    enrolledBy: targetAcc.authUserId,
  });

  const opSession = await createOperatorSession(operatorDb, opUser.authUserId);

  const testEnv: Record<string, string | undefined> = {
    ...process.env,
    FLOW_ENV: "test",
    FLOW_EXECUTION: "disabled",
    FLOW_PROVIDER_COMPATIBILITY_MODE: "authorized",
    FLOW_PROVIDER_COMPATIBILITY_TOKEN: "valid_test_token_12345678",
    FLOW_PROVIDER_COMPATIBILITY_ACCOUNT_ID: targetAcc.accountId,
    FLOW_WALLET_PROVIDER: "outlayer",
    FLOW_WALLET_ENCRYPTION_KEY:
      "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    FLOW_WALLET_KEY_ID: "v1",
    FLOW_OUTLAYER_API_URL: "https://testnet-api.outlayer.ai",
    FLOW_CUSTODY_OPERATOR_AUTH_ID: opUser.authUserId,
    FLOW_CUSTODY_OPERATOR_SESSION_TOKEN: opSession.sessionToken,
  };

  // Pre-snapshot counts
  const countWalletsBefore = await pool.query(
    "SELECT COUNT(*)::int as count FROM flow.wallets",
  );
  const countJobsBefore = await pool.query(
    "SELECT COUNT(*)::int as count FROM flow.wallet_provisioning_jobs",
  );
  const countAuthsBefore = await pool.query(
    "SELECT COUNT(*)::int as count FROM flow.provider_compatibility_authorizations",
  );
  const countSessionsBefore = await pool.query(
    "SELECT COUNT(*)::int as count FROM flow.auth_sessions",
  );
  const countOpsBefore = await pool.query(
    "SELECT COUNT(*)::int as count FROM flow.custody_operators",
  );

  // Run dry run
  const dryRunResult = await runTestnetRehearsal({
    dryRun: true,
    accountId: targetAcc.accountId,
    operatorAuthId: opUser.authUserId,
    operatorSessionToken: opSession.sessionToken,
    env: testEnv,
  });

  assert.equal(dryRunResult.success, true);
  assert.equal(dryRunResult.dryRun, true);

  // Post-snapshot counts
  const countWalletsAfter = await pool.query(
    "SELECT COUNT(*)::int as count FROM flow.wallets",
  );
  const countJobsAfter = await pool.query(
    "SELECT COUNT(*)::int as count FROM flow.wallet_provisioning_jobs",
  );
  const countAuthsAfter = await pool.query(
    "SELECT COUNT(*)::int as count FROM flow.provider_compatibility_authorizations",
  );
  const countSessionsAfter = await pool.query(
    "SELECT COUNT(*)::int as count FROM flow.auth_sessions",
  );
  const countOpsAfter = await pool.query(
    "SELECT COUNT(*)::int as count FROM flow.custody_operators",
  );

  assert.equal(
    countWalletsAfter.rows[0]!.count,
    countWalletsBefore.rows[0]!.count,
  );
  assert.equal(countJobsAfter.rows[0]!.count, countJobsBefore.rows[0]!.count);
  assert.equal(countAuthsAfter.rows[0]!.count, countAuthsBefore.rows[0]!.count);
  assert.equal(
    countSessionsAfter.rows[0]!.count,
    countSessionsBefore.rows[0]!.count,
  );
  assert.equal(countOpsAfter.rows[0]!.count, countOpsBefore.rows[0]!.count);
});

test("M2 Phase 5.4 Adversarial Test: Missing compatibility authorization cannot be auto-created during rehearsal", async () => {
  await operatorPool.query(
    "SET LOCAL flow.allow_test_cleanup = 'on'; DELETE FROM flow.custody_recovery_approvals; DELETE FROM flow.custody_operators; DELETE FROM flow.provider_compatibility_authorizations;",
  );
  const targetAcc = await createTestAccount(
    pool,
    "PERSONAL",
    "no-autocreate-acc",
  );
  const opUser = await createTestAccount(pool, "PERSONAL", "no-autocreate-op");

  await enrollCustodyOperator(operatorDb, {
    authUserId: opUser.authUserId,
    role: "SECURITY_OFFICER",
    enrolledBy: targetAcc.authUserId,
  });

  const opSession = await createOperatorSession(operatorDb, opUser.authUserId);

  const fixture = await createOutLayerMockServer({ policyState: "none" });

  try {
    const testEnv: Record<string, string | undefined> = {
      ...process.env,
      FLOW_ENV: "test",
      FLOW_EXECUTION: "disabled",
      FLOW_PROVIDER_COMPATIBILITY_MODE: "authorized",
      FLOW_PROVIDER_COMPATIBILITY_TOKEN: "valid_test_token_12345678",
      FLOW_PROVIDER_COMPATIBILITY_ACCOUNT_ID: targetAcc.accountId,
      FLOW_WALLET_PROVIDER: "outlayer",
      FLOW_WALLET_ENCRYPTION_KEY:
        "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      FLOW_WALLET_KEY_ID: "v1",
      FLOW_OUTLAYER_API_URL: fixture.url,
      FLOW_CUSTODY_OPERATOR_AUTH_ID: opUser.authUserId,
      FLOW_CUSTODY_OPERATOR_SESSION_TOKEN: opSession.sessionToken,
    };

    // Attempting live rehearsal without prior authorization MUST FAIL with CUSTODY_OPERATOR_AUTHORIZATION_ERROR
    await assert.rejects(
      runTestnetRehearsal({
        dryRun: false,
        accountId: targetAcc.accountId,
        operatorAuthId: opUser.authUserId,
        operatorSessionToken: opSession.sessionToken,
        offlineTestMode: true,
        env: testEnv,
      }),
      { code: "CUSTODY_OPERATOR_AUTHORIZATION_ERROR" },
    );

    // Verify NO authorization record was auto-created in database
    const authCount = await operatorPool.query(
      "SELECT COUNT(*)::int as count FROM flow.provider_compatibility_authorizations WHERE singleton_scope = 'GLOBAL_TESTNET_REHEARSAL'",
    );
    assert.equal(authCount.rows[0]!.count, 0);

    // Verify NO job was created
    const jobCount = await pool.query(
      "SELECT COUNT(*)::int as count FROM flow.wallet_provisioning_jobs WHERE account_id = $1::uuid",
      [targetAcc.accountId],
    );
    assert.equal(jobCount.rows[0]!.count, 0);
  } finally {
    await fixture.close();
  }
});

test("M2 Phase 5.4 Adversarial Test: Forged operator IDs without session proof or key are strictly rejected", async () => {
  await operatorPool.query(
    "SET LOCAL flow.allow_test_cleanup = 'on'; DELETE FROM flow.custody_recovery_approvals; DELETE FROM flow.custody_operators; DELETE FROM flow.provider_compatibility_authorizations;",
  );
  const targetAcc = await createTestAccount(pool, "PERSONAL", "forged-op-acc");
  const legitOp = await createTestAccount(pool, "PERSONAL", "legit-op-user");

  await enrollCustodyOperator(operatorDb, {
    authUserId: legitOp.authUserId,
    role: "SECURITY_OFFICER",
    enrolledBy: targetAcc.authUserId,
  });

  // 1. Direct deriveOperatorContext with only operatorAuthId (no sessionToken, no key) fails
  await assert.rejects(
    deriveOperatorContext(operatorDb, {
      operatorAuthId: legitOp.authUserId,
    }),
    { code: "CUSTODY_OPERATOR_AUTHENTICATION_REQUIRED" },
  );

  // 2. createRehearsalAuthorization without session token or key fails
  await assert.rejects(
    createRehearsalAuthorization({
      accountId: targetAcc.accountId,
      operatorAuthId: legitOp.authUserId,
      env: {
        ...process.env,
        FLOW_ENV: "test",
        FLOW_EXECUTION: "disabled",
        FLOW_CUSTODY_OPERATOR_SESSION_TOKEN: undefined,
        FLOW_CUSTODY_OPERATOR_SESSION_FILE: undefined,
        FLOW_OPERATOR_TRUSTED_EXECUTION_KEY: undefined,
      },
    }),
    { code: "CUSTODY_OPERATOR_AUTHENTICATION_REQUIRED" },
  );

  // 3. runTestnetRehearsal with only operatorAuthId fails
  await assert.rejects(
    runTestnetRehearsal({
      dryRun: false,
      accountId: targetAcc.accountId,
      operatorAuthId: legitOp.authUserId,
      env: {
        ...process.env,
        FLOW_ENV: "test",
        FLOW_EXECUTION: "disabled",
        FLOW_PROVIDER_COMPATIBILITY_MODE: "authorized",
        FLOW_PROVIDER_COMPATIBILITY_TOKEN: "valid_test_token_12345678",
        FLOW_PROVIDER_COMPATIBILITY_ACCOUNT_ID: targetAcc.accountId,
        FLOW_WALLET_PROVIDER: "outlayer",
        FLOW_WALLET_ENCRYPTION_KEY:
          "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
        FLOW_OUTLAYER_API_URL: "https://testnet-api.outlayer.ai",
        FLOW_CUSTODY_OPERATOR_SESSION_TOKEN: undefined,
        FLOW_CUSTODY_OPERATOR_SESSION_FILE: undefined,
        FLOW_OPERATOR_TRUSTED_EXECUTION_KEY: undefined,
      },
    }),
    { code: "CUSTODY_OPERATOR_AUTHENTICATION_REQUIRED" },
  );
});

test("M2 Phase 5.4 Adversarial Test: Stale, expired, or other-user operator sessions are strictly rejected", async () => {
  await operatorPool.query(
    "SET LOCAL flow.allow_test_cleanup = 'on'; DELETE FROM flow.custody_recovery_approvals; DELETE FROM flow.custody_operators; DELETE FROM flow.provider_compatibility_authorizations;",
  );
  const opUser = await createTestAccount(pool, "PERSONAL", "session-victim-op");
  const otherUser = await createTestAccount(
    pool,
    "PERSONAL",
    "session-attacker",
  );

  await enrollCustodyOperator(operatorDb, {
    authUserId: opUser.authUserId,
    role: "SECURITY_OFFICER",
    enrolledBy: otherUser.authUserId,
  });

  // Expired session for opUser (negative validity creates a session in the past)
  const expiredSession = await createOperatorSession(
    operatorDb,
    opUser.authUserId,
    -60,
  );

  await assert.rejects(
    deriveOperatorContext(operatorDb, {
      operatorAuthId: opUser.authUserId,
      sessionToken: expiredSession.sessionToken,
    }),
    { code: "CUSTODY_OPERATOR_AUTHENTICATION_REQUIRED" },
  );

  // Valid session for otherUser cannot authenticate as opUser
  const otherSession = await createOperatorSession(
    operatorDb,
    otherUser.authUserId,
  );
  await assert.rejects(
    deriveOperatorContext(operatorDb, {
      operatorAuthId: opUser.authUserId,
      sessionToken: otherSession.sessionToken,
    }),
    { code: "CUSTODY_OPERATOR_AUTHENTICATION_REQUIRED" },
  );
});

test("M2 Phase 5.4 Adversarial Test: Malformed or non-canonical testnet coordinator URLs are strictly rejected", async () => {
  const targetAcc = await createTestAccount(pool, "PERSONAL", "url-test-acc");
  const opUser = await createTestAccount(pool, "PERSONAL", "url-test-op");

  const malformedUrls = [
    "https://attacker.com/testnet-api.outlayer.ai",
    "https://testnet-api.outlayer.ai.attacker.com",
    "https://api.outlayer.ai",
    "http://testnet-api.outlayer.ai",
    "http://127.0.0.1:8080",
  ];

  for (const badUrl of malformedUrls) {
    const badEnv = {
      ...process.env,
      FLOW_ENV: "local",
      FLOW_EXECUTION: "disabled",
      FLOW_PROVIDER_COMPATIBILITY_MODE: "authorized",
      FLOW_WALLET_PROVIDER: "outlayer",
      FLOW_WALLET_ENCRYPTION_KEY:
        "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      FLOW_OUTLAYER_API_URL: badUrl,
      FLOW_CUSTODY_OPERATOR_AUTH_ID: opUser.authUserId,
    };

    await assert.rejects(
      runTestnetRehearsal({
        dryRun: true,
        accountId: targetAcc.accountId,
        operatorAuthId: opUser.authUserId,
        env: badEnv,
      }),
      (err: unknown) =>
        err instanceof FlowError && err.code === "INVALID_CONFIGURATION",
      `Expected ${badUrl} to be rejected with INVALID_CONFIGURATION`,
    );
  }
});

test("M2 Phase 5.4 Adversarial Test: Target accounts with existing wallets (any status) or prior provisioning jobs are strictly rejected", async () => {
  await operatorPool.query(
    "SET LOCAL flow.allow_test_cleanup = 'on'; DELETE FROM flow.custody_recovery_approvals; DELETE FROM flow.custody_operators; DELETE FROM flow.provider_compatibility_authorizations;",
  );
  const targetAccWithWallet = await createTestAccount(
    pool,
    "PERSONAL",
    "existing-wallet-acc",
  );
  const targetAccWithJob = await createTestAccount(
    pool,
    "PERSONAL",
    "existing-job-acc",
  );
  const opUser = await createTestAccount(
    pool,
    "PERSONAL",
    "existing-wallet-op",
  );

  await enrollCustodyOperator(operatorDb, {
    authUserId: opUser.authUserId,
    role: "SECURITY_OFFICER",
    enrolledBy: targetAccWithWallet.authUserId,
  });

  const opSession = await createOperatorSession(operatorDb, opUser.authUserId);

  // 1. Insert wallet with status 'PROVISIONING' (not ACTIVE) for targetAccWithWallet
  await workerPool.query(
    `INSERT INTO flow.wallets (
      account_id, provider, provider_wallet_id, near_account_id,
      encrypted_credential, key_id, key_digest, status, policy_state, environment
    ) VALUES (
      $1::uuid, 'OUTLAYER', 'pw_existing_123', 'existing.near',
      'v1:sensitive', 'v1', 'key_digest_123', 'PROVISIONING', 'none', 'testnet'
    )`,
    [targetAccWithWallet.accountId],
  );

  const testEnvWithWallet = {
    ...process.env,
    FLOW_ENV: "test",
    FLOW_EXECUTION: "disabled",
    FLOW_PROVIDER_COMPATIBILITY_MODE: "authorized",
    FLOW_PROVIDER_COMPATIBILITY_TOKEN: "valid_test_token_12345678",
    FLOW_PROVIDER_COMPATIBILITY_ACCOUNT_ID: targetAccWithWallet.accountId,
    FLOW_WALLET_PROVIDER: "outlayer",
    FLOW_WALLET_ENCRYPTION_KEY:
      "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    FLOW_OUTLAYER_API_URL: "https://testnet-api.outlayer.ai",
    FLOW_CUSTODY_OPERATOR_AUTH_ID: opUser.authUserId,
    FLOW_CUSTODY_OPERATOR_SESSION_TOKEN: opSession.sessionToken,
  };

  // createRehearsalAuthorization must REJECT targetAccWithWallet
  await assert.rejects(
    createRehearsalAuthorization({
      accountId: targetAccWithWallet.accountId,
      operatorAuthId: opUser.authUserId,
      operatorSessionToken: opSession.sessionToken,
      env: testEnvWithWallet,
    }),
    { code: "INVALID_CONFIGURATION" },
  );

  // runTestnetRehearsal (dryRun: false) must REJECT targetAccWithWallet
  await assert.rejects(
    runTestnetRehearsal({
      dryRun: false,
      accountId: targetAccWithWallet.accountId,
      operatorAuthId: opUser.authUserId,
      operatorSessionToken: opSession.sessionToken,
      env: testEnvWithWallet,
    }),
    { code: "INVALID_CONFIGURATION" },
  );

  // 2. Insert provisioning job with status 'UNKNOWN' for targetAccWithJob
  await workerPool.query(
    `INSERT INTO flow.wallet_provisioning_jobs (
      account_id, idempotency_key, status, failure_classification, fencing_token
    ) VALUES (
      $1::uuid, $2::uuid, 'UNKNOWN', 'POST_DISPATCH_AMBIGUOUS', 1
    )`,
    [targetAccWithJob.accountId, randomUUID()],
  );

  const testEnvWithJob = {
    ...process.env,
    FLOW_ENV: "test",
    FLOW_EXECUTION: "disabled",
    FLOW_PROVIDER_COMPATIBILITY_MODE: "authorized",
    FLOW_PROVIDER_COMPATIBILITY_TOKEN: "valid_test_token_12345678",
    FLOW_PROVIDER_COMPATIBILITY_ACCOUNT_ID: targetAccWithJob.accountId,
    FLOW_WALLET_PROVIDER: "outlayer",
    FLOW_WALLET_ENCRYPTION_KEY:
      "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    FLOW_OUTLAYER_API_URL: "https://testnet-api.outlayer.ai",
    FLOW_CUSTODY_OPERATOR_AUTH_ID: opUser.authUserId,
    FLOW_CUSTODY_OPERATOR_SESSION_TOKEN: opSession.sessionToken,
  };

  // createRehearsalAuthorization must REJECT targetAccWithJob
  await assert.rejects(
    createRehearsalAuthorization({
      accountId: targetAccWithJob.accountId,
      operatorAuthId: opUser.authUserId,
      operatorSessionToken: opSession.sessionToken,
      env: testEnvWithJob,
    }),
    { code: "INVALID_CONFIGURATION" },
  );

  // runTestnetRehearsal (dryRun: false) must REJECT targetAccWithJob
  await assert.rejects(
    runTestnetRehearsal({
      dryRun: false,
      accountId: targetAccWithJob.accountId,
      operatorAuthId: opUser.authUserId,
      operatorSessionToken: opSession.sessionToken,
      env: testEnvWithJob,
    }),
    { code: "INVALID_CONFIGURATION" },
  );
});

test("M2 Phase 5.5 Operational Preflight: Pristine onboarding job vs in-flight job distinction, account preparation, and CLI error sanitization", async () => {
  await operatorPool.query(
    "SET LOCAL flow.allow_test_cleanup = 'on'; DELETE FROM flow.custody_recovery_approvals; DELETE FROM flow.custody_operators; DELETE FROM flow.provider_compatibility_authorizations;",
  );

  const creatorUser = await createTestAccount(pool, "PERSONAL", "p55-creator");
  const opUser = await createTestAccount(pool, "PERSONAL", "p55-op");

  await enrollCustodyOperator(operatorDb, {
    authUserId: opUser.authUserId,
    role: "SECURITY_OFFICER",
    enrolledBy: creatorUser.authUserId,
  });

  const opSession = await createOperatorSession(operatorDb, opUser.authUserId);

  // 1. prepareIsolatedTestnetAccount creates an isolated account with pristine initial PENDING job
  const prepared = await prepareIsolatedTestnetAccount({
    operatorAuthId: opUser.authUserId,
    operatorSessionToken: opSession.sessionToken,
    email: `isolated-rehearsal-${randomUUID().slice(0, 8)}@example.test`,
  });

  assert.ok(prepared.accountId);
  assert.equal(prepared.kind, "PERSONAL");
  assert.equal(prepared.jobStatus, "PENDING");
  assert.equal(prepared.walletCount, 0);
  assert.equal(prepared.isNew, true);

  // Idempotent re-run returns the same account
  const rePrepared = await prepareIsolatedTestnetAccount({
    operatorAuthId: opUser.authUserId,
    operatorSessionToken: opSession.sessionToken,
    email: prepared.email,
  });
  assert.equal(rePrepared.accountId, prepared.accountId);
  assert.equal(rePrepared.isNew, false);

  // 2. isJobPristineInitial accepts pristine initial job
  assert.equal(
    isJobPristineInitial({
      status: "PENDING",
      fencingToken: 0n,
      leaseExpiresAt: null,
      dispatchedAt: null,
      attempts: 0,
      failureClassification: null,
    }),
    true,
  );

  // isJobPristineInitial rejects non-zero fencing token
  assert.equal(
    isJobPristineInitial({
      status: "PENDING",
      fencingToken: 1n,
      leaseExpiresAt: null,
      dispatchedAt: null,
      attempts: 0,
      failureClassification: null,
    }),
    false,
  );

  // isJobPristineInitial rejects non-PENDING status
  assert.equal(
    isJobPristineInitial({
      status: "LEASED",
      fencingToken: 0n,
      leaseExpiresAt: null,
      dispatchedAt: null,
      attempts: 0,
      failureClassification: null,
    }),
    false,
  );

  // isJobPristineInitial rejects dispatched job
  assert.equal(
    isJobPristineInitial({
      status: "PENDING",
      fencingToken: 0n,
      leaseExpiresAt: null,
      dispatchedAt: new Date(),
      attempts: 0,
      failureClassification: null,
    }),
    false,
  );

  // isJobPristineInitial rejects attempts > 0
  assert.equal(
    isJobPristineInitial({
      status: "PENDING",
      fencingToken: 0n,
      leaseExpiresAt: null,
      dispatchedAt: null,
      attempts: 1,
      failureClassification: null,
    }),
    false,
  );

  // 3. Dry-run evaluates the prepared account with pristine job as clean
  const dryRunEnv = {
    ...process.env,
    FLOW_ENV: "test",
    FLOW_EXECUTION: "disabled",
    FLOW_PROVIDER_COMPATIBILITY_MODE: "authorized",
    FLOW_PROVIDER_COMPATIBILITY_TOKEN: "valid_test_token_12345678",
    FLOW_PROVIDER_COMPATIBILITY_ACCOUNT_ID: prepared.accountId,
    FLOW_WALLET_PROVIDER: "outlayer",
    FLOW_WALLET_ENCRYPTION_KEY:
      "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    FLOW_OUTLAYER_API_URL: "https://testnet-api.outlayer.ai",
    FLOW_CUSTODY_OPERATOR_AUTH_ID: opUser.authUserId,
    FLOW_CUSTODY_OPERATOR_SESSION_TOKEN: opSession.sessionToken,
  };

  const dryRunResult = await runTestnetRehearsal({
    dryRun: true,
    accountId: prepared.accountId,
    operatorAuthId: opUser.authUserId,
    operatorSessionToken: opSession.sessionToken,
    env: dryRunEnv,
  });

  assert.equal(dryRunResult.dryRun, true);
  assert.equal(dryRunResult.preflight.targetAccountClean, true);
  // Authorization is missing because requirement 8 forbids premature authorization creation
  assert.deepEqual(dryRunResult.preflight.missingPrerequisites, [
    "COMPATIBILITY_AUTHORIZATION_MISSING",
  ]);

  // 4. CLI error sanitization: emits allowlisted error codes and sanitized diagnostics
  const flowErr = new FlowError(
    "INVALID_CONFIGURATION",
    "Sensitive DB query leaked: SELECT * FROM secrets WHERE key='raw_secret'",
  );
  const sanitizedFlowErr = formatSanitizedCliError(flowErr);
  assert.equal(sanitizedFlowErr.code, "INVALID_CONFIGURATION");
  assert.ok(!sanitizedFlowErr.diagnostic.includes("secrets"));
  assert.ok(!sanitizedFlowErr.diagnostic.includes("raw_secret"));
  assert.ok(sanitizedFlowErr.diagnostic.includes("preconditions"));

  const rawErr = new Error(
    "Connection refused: postgresql://admin:super_secret_pw@db.internal:5432/flow_prod",
  );
  const sanitizedRawErr = formatSanitizedCliError(rawErr);
  assert.equal(sanitizedRawErr.code, "UNEXPECTED_ERROR");
  assert.ok(!sanitizedRawErr.diagnostic.includes("super_secret_pw"));
  assert.ok(!sanitizedRawErr.diagnostic.includes("postgresql"));
  assert.ok(sanitizedRawErr.diagnostic.includes("audit logs"));
});

test("m3 phase 1: asset registry, schema constraints, role separation and tenant isolation", async () => {
  // 1. Seeded assets and network deployments integrity (queried by appDb)
  const allAssets = await listSupportedAssets(appDb);
  assert.ok(
    allAssets.length >= 12,
    `Expected at least 12 network assets, got ${allAssets.length}`,
  );

  // Verify NEAR Native
  const nearNative = allAssets.find(
    (a) =>
      a.network === "near" &&
      a.chainId === "near-mainnet" &&
      a.asset.symbol === "NEAR",
  );
  assert.ok(nearNative);
  assert.equal(nearNative.tokenStandard, "NATIVE");
  assert.equal(nearNative.contractAddress, null);
  assert.equal(nearNative.decimals, 24);

  // Verify Circle Native USDC on NEAR Mainnet (authoritative contract)
  const nearUsdc = allAssets.find(
    (a) =>
      a.network === "near" &&
      a.chainId === "near-mainnet" &&
      a.asset.symbol === "USDC",
  );
  assert.ok(nearUsdc);
  assert.equal(
    nearUsdc.contractAddress,
    "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1",
  );
  assert.equal(nearUsdc.decimals, 6);
  assert.equal(nearUsdc.tokenStandard, "NEP141");

  // Verify Bridged USDC.e on NEAR Mainnet
  const nearUsdce = allAssets.find(
    (a) =>
      a.network === "near" &&
      a.chainId === "near-mainnet" &&
      a.asset.symbol === "USDC.e",
  );
  assert.ok(nearUsdce);
  assert.equal(
    nearUsdce.contractAddress,
    "a0b86991c6218b36c1d19d4a2e9eb0ce3606eb48.factory.bridge.near",
  );
  assert.equal(nearUsdce.decimals, 6);

  // Verify NO unverified USDC on near-testnet
  const nearTestnetUsdc = allAssets.find(
    (a) =>
      a.network === "near" &&
      a.chainId === "near-testnet" &&
      a.asset.symbol === "USDC",
  );
  assert.equal(
    nearTestnetUsdc,
    undefined,
    "Unverified USDC must not be seeded on near-testnet",
  );

  // Verify Base Mainnet USDC (EIP-55 checksummed)
  const baseUsdc = allAssets.find(
    (a) =>
      a.network === "base" && a.chainId === "8453" && a.asset.symbol === "USDC",
  );
  assert.ok(baseUsdc);
  assert.equal(
    baseUsdc.contractAddress,
    "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  );
  assert.equal(baseUsdc.decimals, 6);

  // Verify Base Sepolia USDC
  const baseSepoliaUsdc = allAssets.find(
    (a) =>
      a.network === "base" &&
      a.chainId === "84532" &&
      a.asset.symbol === "USDC",
  );
  assert.ok(baseSepoliaUsdc);
  assert.equal(
    baseSepoliaUsdc.contractAddress,
    "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
  );
  assert.equal(baseSepoliaUsdc.decimals, 6);

  // Verify Solana Mainnet & Devnet USDC
  const solanaMainnetUsdc = allAssets.find(
    (a) =>
      a.network === "solana" &&
      a.chainId === "solana-mainnet" &&
      a.asset.symbol === "USDC",
  );
  assert.ok(solanaMainnetUsdc);
  assert.equal(
    solanaMainnetUsdc.contractAddress,
    "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  );
  assert.equal(solanaMainnetUsdc.decimals, 6);

  const solanaDevnetUsdc = allAssets.find(
    (a) =>
      a.network === "solana" &&
      a.chainId === "solana-devnet" &&
      a.asset.symbol === "USDC",
  );
  assert.ok(solanaDevnetUsdc);
  assert.equal(
    solanaDevnetUsdc.contractAddress,
    "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
  );
  assert.equal(solanaDevnetUsdc.decimals, 6);

  // Filter checks
  const baseOnly = await listSupportedAssets(appDb, { network: "base" });
  assert.ok(baseOnly.every((a) => a.network === "base"));

  const mainnetOnly = await listSupportedAssets(appDb, { chainId: "8453" });
  assert.ok(mainnetOnly.every((a) => a.chainId === "8453"));

  // 2. Database role separation and least-privilege enforcement
  // App role can SELECT from flow.assets
  const selectRes = await pool.query(
    "SELECT count(*)::int as count FROM flow.assets",
  );
  assert.ok(selectRes.rows[0].count >= 5);

  // App role CANNOT INSERT into flow.assets (permission denied: 42501)
  await assert.rejects(
    async () => {
      await pool.query(
        "INSERT INTO flow.assets (symbol, name, kind) VALUES ('SPAM', 'Spam Token', 'FUNGIBLE_TOKEN')",
      );
    },
    (err: unknown) => (err as { code?: string }).code === "42501",
  );

  // App role CANNOT INSERT into flow.network_assets (permission denied: 42501)
  await assert.rejects(
    async () => {
      await pool.query(
        "INSERT INTO flow.network_assets (asset_id, network, chain_id, token_standard, decimals) VALUES ($1, 'near', 'near-mainnet', 'NEP141', 18)",
        ["10000000-0000-0000-0000-000000000001"],
      );
    },
    (err: unknown) => (err as { code?: string }).code === "42501",
  );

  // App role CANNOT INSERT into flow.wallet_balances (permission denied: 42501)
  await assert.rejects(
    async () => {
      await pool.query(
        "INSERT INTO flow.wallet_balances (wallet_id, network_asset_id, atomic_balance) VALUES ($1, $2, 100)",
        [randomUUID(), "20000000-0000-0000-0000-000000000001"],
      );
    },
    (err: unknown) => (err as { code?: string }).code === "42501",
  );

  // 4. Tenant isolation and account portfolio projection
  const accountA = await createTestAccount(pool, "PERSONAL", "m3-tenant-a");
  const accountB = await createTestAccount(pool, "PERSONAL", "m3-tenant-b");

  // Worker inserts a wallet for Account A
  const walletAId = randomUUID();
  await workerPool.query(
    `INSERT INTO flow.wallets (
      id, account_id, provider, environment, provider_wallet_id, near_account_id,
      encrypted_credential, key_id, key_digest, status, policy_state
    ) VALUES (
      $1::uuid, $2::uuid, 'OUTLAYER', 'testnet',
      $3, 'mock-near-acc', 'mock-envelope', 'v1', 'mock-digest',
      'PROVISIONING'::flow.wallet_status, 'none'
    )`,
    [walletAId, accountA.accountId, `prov-${walletAId}`],
  );

  // Register address for NEAR Testnet so consistency check passes
  await workerPool.query(
    `INSERT INTO flow.wallet_addresses (
      id, wallet_id, network, chain_id, address, public_key
    ) VALUES (
      gen_random_uuid(), $1::uuid, 'near', 'near-testnet', 'eccb81cc1bf04b5ce09d31882ee283e1c87a8d6223dfd49067863bc360121c86', 'ed25519:eccb81cc1bf04b5ce09d31882ee283e1c87a8d6223dfd49067863bc360121c86'
    )`,
    [walletAId],
  );

  const nearTestnetAssetId = "20000000-0000-0000-0000-000000000002";

  // Negative balance constraint (CHECK atomic_balance >= 0) on valid wallet
  await assert.rejects(
    async () => {
      await workerPool.query(
        `INSERT INTO flow.wallet_balances (wallet_id, network_asset_id, atomic_balance)
         VALUES ($1::uuid, $2::uuid, -100)`,
        [walletAId, nearTestnetAssetId],
      );
    },
    (err: unknown) => (err as { code?: string }).code === "23514", // check_violation
  );

  // Worker records a balance for Account A (5 NEAR = 5 * 10^24)
  await upsertWalletBalance(db, {
    walletId: walletAId,
    networkAssetId: nearTestnetAssetId,
    atomicBalance: 5_000_000_000_000_000_000_000_000n,
    blockHeight: 1234567n,
    syncStatus: "SYNCED",
    finality: "FINALIZED",
  });

  // Active sessions for tenants
  const sessionA = await createTestSession(pool, accountA.authUserId);
  const sessionB = await createTestSession(pool, accountB.authUserId);

  // User A querying Account A: SUCCEEDS
  const projA = await getAccountBalances(appDb, accountA.accountId, {
    sessionToken: sessionA,
  });
  assert.equal(projA.accountId, accountA.accountId);
  assert.ok(projA.wallet);
  assert.equal(projA.wallet.status, "PROVISIONING");
  assert.equal(projA.wallet.eligibleForDeposits, false);
  assert.equal(projA.balances.length, 1);
  assert.equal(
    projA.balances[0]!.atomicBalance,
    5_000_000_000_000_000_000_000_000n,
  );
  assert.equal(projA.balances[0]!.displayBalance, "5");
  assert.equal(projA.balances[0]!.isZeroConfirmed, false);
  assert.equal(projA.balances[0]!.syncStatus, "SYNCED");

  // User B querying Account A: FAILS with ACCOUNT_NOT_FOUND (tenant barrier)
  await assert.rejects(
    async () => {
      await getAccountBalances(appDb, accountA.accountId, {
        sessionToken: sessionB,
      });
    },
    (err: unknown) =>
      err instanceof FlowError && err.code === "ACCOUNT_NOT_FOUND",
  );

  // User A querying Account B: FAILS with ACCOUNT_NOT_FOUND
  await assert.rejects(
    async () => {
      await getAccountBalances(appDb, accountB.accountId, {
        sessionToken: sessionA,
      });
    },
    (err: unknown) =>
      err instanceof FlowError && err.code === "ACCOUNT_NOT_FOUND",
  );

  // Unauthenticated query (empty session token): FAILS with ACCOUNT_NOT_FOUND
  await assert.rejects(
    async () => {
      await getAccountBalances(appDb, accountA.accountId, {
        sessionToken: "",
      });
    },
    (err: unknown) =>
      err instanceof FlowError && err.code === "ACCOUNT_NOT_FOUND",
  );

  // Confirmed zero balance vs NOT_SYNCED balance
  await upsertWalletBalance(db, {
    walletId: walletAId,
    networkAssetId: nearTestnetAssetId,
    atomicBalance: 0n,
    blockHeight: 1234568n,
    syncStatus: "SYNCED",
  });

  const projAZero = await getAccountBalances(appDb, accountA.accountId, {
    sessionToken: sessionA,
  });
  assert.equal(projAZero.balances[0]!.atomicBalance, 0n);
  assert.equal(projAZero.balances[0]!.displayBalance, "0");
  assert.equal(projAZero.balances[0]!.isZeroConfirmed, true);

  await upsertWalletBalance(db, {
    walletId: walletAId,
    networkAssetId: nearTestnetAssetId,
    atomicBalance: 0n,
    blockHeight: null,
    syncStatus: "NOT_SYNCED",
  });

  const projANotSynced = await getAccountBalances(appDb, accountA.accountId, {
    sessionToken: sessionA,
  });
  assert.equal(projANotSynced.balances[0]!.isZeroConfirmed, false);
  assert.equal(projANotSynced.balances[0]!.syncStatus, "NOT_SYNCED");
});

test("m3 phase 2: database row-level security and adversarial cross-tenant access enforcement", async () => {
  // 1. Setup two personal accounts: Account Alpha (User Alpha) and Account Beta (User Beta)
  const accountAlpha = await createTestAccount(
    pool,
    "PERSONAL",
    "m3-rls-alpha",
  );
  const accountBeta = await createTestAccount(pool, "PERSONAL", "m3-rls-beta");

  // Setup one business account: Account Biz, with User Alpha as an ACTIVE member
  const accountBiz = await createTestAccount(pool, "BUSINESS", "m3-rls-biz");
  await pool.query(
    `INSERT INTO flow.account_memberships (id, account_id, user_id, role, status)
     VALUES (gen_random_uuid(), $1, $2, 'MEMBER', 'ACTIVE')`,
    [accountBiz.accountId, accountAlpha.userId],
  );

  // Active verified sessions
  const sessionAlpha = await createTestSession(pool, accountAlpha.authUserId);
  const sessionBeta = await createTestSession(pool, accountBeta.authUserId);

  // Worker inserts a wallet for Alpha, Beta, and Biz
  const walletAlphaId = randomUUID();
  const walletBetaId = randomUUID();
  const walletBizId = randomUUID();

  await workerPool.query(
    `INSERT INTO flow.wallets (
      id, account_id, provider, environment, provider_wallet_id, near_account_id,
      encrypted_credential, key_id, key_digest, status, policy_state
    ) VALUES (
      $1::uuid, $2::uuid, 'OUTLAYER', 'testnet',
      $3, 'mock-alpha-near', 'mock-env-a', 'v1', 'mock-digest-a',
      'PROVISIONING'::flow.wallet_status, 'none'
    )`,
    [walletAlphaId, accountAlpha.accountId, `prov-${walletAlphaId}`],
  );

  await workerPool.query(
    `INSERT INTO flow.wallets (
      id, account_id, provider, environment, provider_wallet_id, near_account_id,
      encrypted_credential, key_id, key_digest, status, policy_state
    ) VALUES (
      $1::uuid, $2::uuid, 'OUTLAYER', 'testnet',
      $3, 'mock-beta-near', 'mock-env-b', 'v1', 'mock-digest-b',
      'PROVISIONING'::flow.wallet_status, 'none'
    )`,
    [walletBetaId, accountBeta.accountId, `prov-${walletBetaId}`],
  );

  await workerPool.query(
    `INSERT INTO flow.wallets (
      id, account_id, provider, environment, provider_wallet_id, near_account_id,
      encrypted_credential, key_id, key_digest, status, policy_state
    ) VALUES (
      $1::uuid, $2::uuid, 'OUTLAYER', 'testnet',
      $3, 'mock-biz-near', 'mock-env-biz', 'v1', 'mock-digest-biz',
      'PROVISIONING'::flow.wallet_status, 'none'
    )`,
    [walletBizId, accountBiz.accountId, `prov-${walletBizId}`],
  );

  // Register Base Sepolia addresses for all three wallets
  await workerPool.query(
    `INSERT INTO flow.wallet_addresses (
      id, wallet_id, network, chain_id, address, public_key
    ) VALUES (
      gen_random_uuid(), $1::uuid, 'base', '84532', '0xaa6bA2Ae7F20748B46A3DB221a418137ec54A5a2', 'pk-a'
    )`,
    [walletAlphaId],
  );

  await workerPool.query(
    `INSERT INTO flow.wallet_addresses (
      id, wallet_id, network, chain_id, address, public_key
    ) VALUES (
      gen_random_uuid(), $1::uuid, 'base', '84532', '0xbb6bA2Ae7F20748B46A3DB221a418137ec54A5a2', 'pk-b'
    )`,
    [walletBetaId],
  );

  await workerPool.query(
    `INSERT INTO flow.wallet_addresses (
      id, wallet_id, network, chain_id, address, public_key
    ) VALUES (
      gen_random_uuid(), $1::uuid, 'base', '84532', '0xcc6bA2Ae7F20748B46A3DB221a418137ec54A5a2', 'pk-biz'
    )`,
    [walletBizId],
  );

  // Worker records balances on Base Sepolia: Alpha=10 ETH, Beta=20 ETH, Biz=5 ETH
  const baseSepoliaEthAssetId = "20000000-0000-0000-0000-000000000004";
  await upsertWalletBalance(db, {
    walletId: walletAlphaId,
    networkAssetId: baseSepoliaEthAssetId,
    atomicBalance: 10_000_000_000_000_000_000n,
    blockHeight: 200001n,
    syncStatus: "SYNCED",
    finality: "CONFIRMED",
  });

  await upsertWalletBalance(db, {
    walletId: walletBetaId,
    networkAssetId: baseSepoliaEthAssetId,
    atomicBalance: 20_000_000_000_000_000_000n,
    blockHeight: 200002n,
    syncStatus: "SYNCED",
    finality: "CONFIRMED",
  });

  await upsertWalletBalance(db, {
    walletId: walletBizId,
    networkAssetId: baseSepoliaEthAssetId,
    atomicBalance: 5_000_000_000_000_000_000n,
    blockHeight: 200003n,
    syncStatus: "SYNCED",
    finality: "CONFIRMED",
  });

  // Adversarial Test 1: Direct SQL query by app_role without context -> returns 0 rows
  const noContextRes = await pool.query(
    "SELECT * FROM flow.wallet_balances WHERE wallet_id = $1",
    [walletBetaId],
  );
  assert.equal(
    noContextRes.rows.length,
    0,
    "Unscoped query must return 0 rows under RLS",
  );

  const allNoContext = await pool.query("SELECT * FROM flow.wallet_balances");
  assert.equal(
    allNoContext.rows.length,
    0,
    "Unscoped table scan must return 0 rows under RLS",
  );

  const appClient = await pool.connect();
  try {
    // Adversarial Test 2: GUC Spoofing Attack - Attacker sets caller-controlled flow.current_user_id & flow.current_account_id
    // WITHOUT a valid session token. MUST return 0 rows (proves user_id GUC alone is not trusted).
    await appClient.query("BEGIN");
    await appClient.query(
      "SELECT set_config('flow.current_account_id', $1, true), set_config('flow.current_user_id', $2, true)",
      [accountBeta.accountId, accountBeta.userId],
    );
    const gucSpoofRes = await appClient.query(
      "SELECT * FROM flow.wallet_balances",
    );
    assert.equal(
      gucSpoofRes.rows.length,
      0,
      "GUC spoofing (user_id and account_id without session token) must return 0 rows",
    );
    await appClient.query("COMMIT");

    // Adversarial Test 3: Fabricated / Unknown session token
    await appClient.query("BEGIN");
    await appClient.query(
      "SELECT set_config('flow.current_account_id', $1, true), set_config('flow.current_session_token', $2, true)",
      [accountBeta.accountId, "fabricated-token-attacker-000000000000"],
    );
    const fakeTokenRes = await appClient.query(
      "SELECT * FROM flow.wallet_balances",
    );
    assert.equal(
      fakeTokenRes.rows.length,
      0,
      "Fabricated session token must return 0 rows",
    );
    await appClient.query("COMMIT");

    // Adversarial Test 4: Attacker with valid session tries to access another tenant's account
    // 4a: User Alpha attempts to query Account Beta using Alpha's valid session token
    await appClient.query("BEGIN");
    await appClient.query(
      "SELECT set_config('flow.current_account_id', $1, true), set_config('flow.current_session_token', $2, true)",
      [accountBeta.accountId, sessionAlpha],
    );
    const crossTenantRes = await appClient.query(
      "SELECT * FROM flow.wallet_balances",
    );
    assert.equal(
      crossTenantRes.rows.length,
      0,
      "User Alpha cannot read Account Beta balances with valid session token",
    );
    await appClient.query("COMMIT");

    // 4b: User Beta attempts to query Account Alpha using Beta's valid session token
    await appClient.query("BEGIN");
    await appClient.query(
      "SELECT set_config('flow.current_account_id', $1, true), set_config('flow.current_session_token', $2, true)",
      [accountAlpha.accountId, sessionBeta],
    );
    const crossTenantResB = await appClient.query(
      "SELECT * FROM flow.wallet_balances",
    );
    assert.equal(
      crossTenantResB.rows.length,
      0,
      "User Beta cannot read Account Alpha balances with valid session token",
    );
    await appClient.query("COMMIT");

    // Adversarial Test 5: Cross-tenant joins
    await appClient.query("BEGIN");
    await appClient.query(
      "SELECT set_config('flow.current_account_id', $1, true), set_config('flow.current_session_token', $2, true)",
      [accountAlpha.accountId, sessionAlpha],
    );
    const joinRes = await appClient.query(
      `SELECT wb.* FROM flow.wallet_balances wb
       JOIN flow.wallets w ON w.id = wb.wallet_id
       WHERE w.account_id = $1::uuid`,
      [accountBeta.accountId],
    );
    assert.equal(
      joinRes.rows.length,
      0,
      "Cross-tenant join attempt must return 0 rows under RLS",
    );
    await appClient.query("COMMIT");

    // Adversarial Test 6: Subquery / View attempt for another tenant's wallet
    await appClient.query("BEGIN");
    await appClient.query(
      "SELECT set_config('flow.current_account_id', $1, true), set_config('flow.current_session_token', $2, true)",
      [accountAlpha.accountId, sessionAlpha],
    );
    const subqueryRes = await appClient.query(
      `SELECT * FROM (SELECT * FROM flow.wallet_balances) v WHERE v.wallet_id = $1::uuid`,
      [walletBetaId],
    );
    assert.equal(
      subqueryRes.rows.length,
      0,
      "Subquery / view scan for another tenant's wallet must return 0 rows",
    );
    await appClient.query("COMMIT");

    // Legitimate Test 7: Personal Owner with verified session reads Account Alpha
    await appClient.query("BEGIN");
    await appClient.query(
      "SELECT set_config('flow.current_account_id', $1, true), set_config('flow.current_session_token', $2, true)",
      [accountAlpha.accountId, sessionAlpha],
    );
    const alphaBalances = await appClient.query(
      `SELECT * FROM flow.wallet_balances WHERE wallet_id = $1::uuid`,
      [walletAlphaId],
    );
    assert.equal(
      alphaBalances.rows.length,
      1,
      "Legitimate personal owner query must return their own balance",
    );
    assert.equal(
      BigInt(alphaBalances.rows[0].atomic_balance),
      10_000_000_000_000_000_000n,
    );
    await appClient.query("COMMIT");

    // Legitimate Test 8: Authorized Business Member reads Account Biz
    await appClient.query("BEGIN");
    await appClient.query(
      "SELECT set_config('flow.current_account_id', $1, true), set_config('flow.current_session_token', $2, true)",
      [accountBiz.accountId, sessionAlpha],
    );
    const bizBalances = await appClient.query(
      `SELECT * FROM flow.wallet_balances WHERE wallet_id = $1::uuid`,
      [walletBizId],
    );
    assert.equal(
      bizBalances.rows.length,
      1,
      "Legitimate active business member query must return business balance",
    );
    assert.equal(
      BigInt(bizBalances.rows[0].atomic_balance),
      5_000_000_000_000_000_000n,
    );
    await appClient.query("COMMIT");

    // Adversarial Test 9: Membership Removal / Downgrade
    // Remove User Alpha from Account Biz (status = 'REMOVED')
    await pool.query(
      "UPDATE flow.account_memberships SET status = 'REMOVED' WHERE account_id = $1::uuid AND user_id = $2::uuid",
      [accountBiz.accountId, accountAlpha.userId],
    );
    await appClient.query("BEGIN");
    await appClient.query(
      "SELECT set_config('flow.current_account_id', $1, true), set_config('flow.current_session_token', $2, true)",
      [accountBiz.accountId, sessionAlpha],
    );
    const removedMemberRes = await appClient.query(
      `SELECT * FROM flow.wallet_balances WHERE wallet_id = $1::uuid`,
      [walletBizId],
    );
    assert.equal(
      removedMemberRes.rows.length,
      0,
      "Removed/downgraded business member must return 0 rows immediately",
    );
    await appClient.query("COMMIT");

    // Adversarial Test 10: Expired Session
    // Expire User Alpha's session token using caller's session context
    const expClient = await pool.connect();
    try {
      await expClient.query("BEGIN");
      await expClient.query(
        "SELECT set_config('flow.current_session_token', $1, true)",
        [sessionAlpha],
      );
      await expClient.query(
        "UPDATE flow.auth_sessions SET expires_at = NOW() - interval '10 seconds' WHERE token = $1",
        [sessionAlpha],
      );
      await expClient.query("COMMIT");
    } finally {
      expClient.release();
    }
    await appClient.query("BEGIN");
    await appClient.query(
      "SELECT set_config('flow.current_account_id', $1, true), set_config('flow.current_session_token', $2, true)",
      [accountAlpha.accountId, sessionAlpha],
    );
    const expiredRes = await appClient.query(
      `SELECT * FROM flow.wallet_balances WHERE wallet_id = $1::uuid`,
      [walletAlphaId],
    );
    assert.equal(
      expiredRes.rows.length,
      0,
      "Expired session must return 0 rows",
    );
    await appClient.query("COMMIT");

    // Adversarial Test 11: Inactive User Account
    // Create an account for a deactivated user (active = false)
    const inactiveAuthUserId = `test-user-inactive-${randomUUID().slice(0, 8)}`;
    await pool.query(
      `INSERT INTO flow.auth_users (id, name, email, email_verified, updated_at)
       VALUES ($1, 'Inactive User', $2, true, now())`,
      [inactiveAuthUserId, `${inactiveAuthUserId}@example.test`],
    );
    const inactiveUserResult = await pool.query<{ id: string }>(
      `INSERT INTO flow.users (id, auth_user_id, active)
       VALUES (gen_random_uuid(), $1, false)
       RETURNING id`,
      [inactiveAuthUserId],
    );
    const inactiveUserId = inactiveUserResult.rows[0]!.id;
    const inactiveAccountResult = await pool.query<{ id: string }>(
      `INSERT INTO flow.accounts (id, kind, name, personal_owner_id)
       VALUES (gen_random_uuid(), 'PERSONAL', 'Inactive Personal Account', $1)
       RETURNING id`,
      [inactiveUserId],
    );
    const inactiveAccountId = inactiveAccountResult.rows[0]!.id;
    const inactiveWalletId = randomUUID();
    await workerPool.query(
      `INSERT INTO flow.wallets (
        id, account_id, provider, environment, provider_wallet_id, near_account_id,
        encrypted_credential, key_id, key_digest, status, policy_state
      ) VALUES (
        $1::uuid, $2::uuid, 'OUTLAYER', 'testnet',
        $3, 'mock-near-inactive', 'mock-env-i', 'v1', 'mock-digest-i',
        'PROVISIONING'::flow.wallet_status, 'none'
      )`,
      [inactiveWalletId, inactiveAccountId, `prov-${inactiveWalletId}`],
    );
    await workerPool.query(
      `INSERT INTO flow.wallet_addresses (id, wallet_id, network, chain_id, address, public_key)
       VALUES (gen_random_uuid(), $1::uuid, 'base', '84532', 'mock-addr-inactive', 'mock-pk-i')`,
      [inactiveWalletId],
    );
    await workerPool.query(
      `INSERT INTO flow.wallet_balances (wallet_id, network_asset_id, atomic_balance)
       VALUES ($1::uuid, $2::uuid, 7000)`,
      [inactiveWalletId, baseSepoliaEthAssetId],
    );
    const sessionInactive = await createTestSession(pool, inactiveAuthUserId);

    await appClient.query("BEGIN");
    await appClient.query(
      "SELECT set_config('flow.current_account_id', $1, true), set_config('flow.current_session_token', $2, true)",
      [inactiveAccountId, sessionInactive],
    );
    const inactiveUserRes = await appClient.query(
      `SELECT * FROM flow.wallet_balances WHERE wallet_id = $1::uuid`,
      [inactiveWalletId],
    );
    assert.equal(
      inactiveUserRes.rows.length,
      0,
      "Inactive user must return 0 rows",
    );
    await appClient.query("COMMIT");

    // Test 12: Pooled Connection and Transaction-Local Context Cleanup
    // Since expired sessions cannot be resurrected by app_role under strict RLS,
    // create a fresh session for testing transaction-local context cleanup.
    const freshSessionAlpha = await createTestSession(
      pool,
      accountAlpha.authUserId,
    );

    // Inside transaction: valid context yields 1 row.
    await appClient.query("BEGIN");
    await appClient.query(
      "SELECT set_config('flow.current_account_id', $1, true), set_config('flow.current_session_token', $2, true)",
      [accountAlpha.accountId, freshSessionAlpha],
    );
    const inTxRes = await appClient.query(
      `SELECT * FROM flow.wallet_balances WHERE wallet_id = $1::uuid`,
      [walletAlphaId],
    );
    assert.equal(
      inTxRes.rows.length,
      1,
      "In-transaction query with valid context returns 1 row",
    );
    await appClient.query("COMMIT");

    // Immediately after commit on same connection: without setting session, must return 0 rows
    const afterCommitRes = await appClient.query(
      `SELECT * FROM flow.wallet_balances WHERE wallet_id = $1::uuid`,
      [walletAlphaId],
    );
    assert.equal(
      afterCommitRes.rows.length,
      0,
      "After COMMIT, session context must be cleared; pooled connection query returns 0 rows",
    );
  } catch (err) {
    await appClient.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    appClient.release();
  }
});

test("m3 phase 2: wallet-to-network consistency trigger prevents cross-environment and unregistered address balances", async () => {
  const accountTest = await createTestAccount(
    pool,
    "PERSONAL",
    "m3-consistency-test",
  );
  const accountProd = await createTestAccount(
    pool,
    "PERSONAL",
    "m3-consistency-prod",
  );

  const walletTestId = randomUUID();
  const walletProdId = randomUUID();

  // Insert a testnet wallet
  await workerPool.query(
    `INSERT INTO flow.wallets (
      id, account_id, provider, environment, provider_wallet_id, near_account_id,
      encrypted_credential, key_id, key_digest, status, policy_state
    ) VALUES (
      $1::uuid, $2::uuid, 'OUTLAYER', 'testnet',
      $3, 'mock-near-test', 'mock-env-t', 'v1', 'mock-digest-t',
      'PROVISIONING'::flow.wallet_status, 'none'
    )`,
    [walletTestId, accountTest.accountId, `prov-${walletTestId}`],
  );

  // Insert a mainnet wallet
  await workerPool.query(
    `INSERT INTO flow.wallets (
      id, account_id, provider, environment, provider_wallet_id, near_account_id,
      encrypted_credential, key_id, key_digest, status, policy_state
    ) VALUES (
      $1::uuid, $2::uuid, 'OUTLAYER', 'mainnet',
      $3, 'mock-near-prod', 'mock-env-p', 'v1', 'mock-digest-p',
      'PROVISIONING'::flow.wallet_status, 'none'
    )`,
    [walletProdId, accountProd.accountId, `prov-${walletProdId}`],
  );

  // Register NEAR Testnet address for testnet wallet
  await workerPool.query(
    `INSERT INTO flow.wallet_addresses (
      id, wallet_id, network, chain_id, address, public_key
    ) VALUES (
      gen_random_uuid(), $1::uuid, 'near', 'near-testnet', 'mock-near-testnet-addr', 'mock-pk-t'
    )`,
    [walletTestId],
  );

  // Register NEAR Mainnet address for mainnet wallet
  await workerPool.query(
    `INSERT INTO flow.wallet_addresses (
      id, wallet_id, network, chain_id, address, public_key
    ) VALUES (
      gen_random_uuid(), $1::uuid, 'near', 'near-mainnet', 'mock-near-mainnet-addr', 'mock-pk-m'
    )`,
    [walletProdId],
  );

  const nearMainnetAssetId = "20000000-0000-0000-0000-000000000001";
  const nearTestnetAssetId = "20000000-0000-0000-0000-000000000002";
  const solanaDevnetAssetId = "20000000-0000-0000-0000-000000000006";

  // Test A: Testnet wallet inserting Mainnet asset -> TRIGGER BLOCKS WITH 23514
  await assert.rejects(
    async () => {
      await workerPool.query(
        `INSERT INTO flow.wallet_balances (wallet_id, network_asset_id, atomic_balance)
         VALUES ($1::uuid, $2::uuid, 100)`,
        [walletTestId, nearMainnetAssetId],
      );
    },
    (err: unknown) =>
      (err as { code?: string }).code === "23514" &&
      (err as { message?: string }).message?.includes(
        "cannot record balances for mainnet chain",
      ),
  );

  // Test B: Mainnet wallet inserting Testnet asset -> TRIGGER BLOCKS WITH 23514
  await assert.rejects(
    async () => {
      await workerPool.query(
        `INSERT INTO flow.wallet_balances (wallet_id, network_asset_id, atomic_balance)
         VALUES ($1::uuid, $2::uuid, 100)`,
        [walletProdId, nearTestnetAssetId],
      );
    },
    (err: unknown) =>
      (err as { code?: string }).code === "23514" &&
      (err as { message?: string }).message?.includes(
        "cannot record balances for testnet chain",
      ),
  );

  // Test C: Testnet wallet inserting asset for network without registered address (Solana Devnet) -> TRIGGER BLOCKS WITH 23514
  await assert.rejects(
    async () => {
      await workerPool.query(
        `INSERT INTO flow.wallet_balances (wallet_id, network_asset_id, atomic_balance)
         VALUES ($1::uuid, $2::uuid, 100)`,
        [walletTestId, solanaDevnetAssetId],
      );
    },
    (err: unknown) =>
      (err as { code?: string }).code === "23514" &&
      (err as { message?: string }).message?.includes(
        "has no registered address for network",
      ),
  );

  // Test D: Valid consistency: Testnet wallet with registered NEAR Testnet address -> SUCCEEDS
  await workerPool.query(
    `INSERT INTO flow.wallet_balances (wallet_id, network_asset_id, atomic_balance)
     VALUES ($1::uuid, $2::uuid, 500)`,
    [walletTestId, nearTestnetAssetId],
  );

  const verifySuccess = await workerPool.query(
    "SELECT atomic_balance FROM flow.wallet_balances WHERE wallet_id = $1::uuid",
    [walletTestId],
  );
  assert.equal(verifySuccess.rows.length, 1);
  assert.equal(BigInt(verifySuccess.rows[0].atomic_balance), 500n);
});

test("m3 phase 2.1: wallet address correlation and database mapping with authentic M2 OutLayer identity", async () => {
  const account = await createTestAccount(
    pool,
    "PERSONAL",
    "m3-phase21-address-correlation",
  );

  const walletId = randomUUID();

  // 1. Insert OutLayer testnet wallet
  await workerPool.query(
    `INSERT INTO flow.wallets (
      id, account_id, provider, environment, provider_wallet_id, near_account_id,
      encrypted_credential, key_id, key_digest, status, policy_state
    ) VALUES (
      $1::uuid, $2::uuid, 'OUTLAYER', 'testnet',
      'prov-testnet-wallet-01', 'mock-near-test', 'mock-env-t', 'v1', 'mock-digest-t',
      'PROVISIONING'::flow.wallet_status, 'none'
    )`,
    [walletId, account.accountId],
  );

  // 2. Insert authentic M2 OutLayer registered addresses
  const AUTHENTIC_ADDRESSES = {
    near: "eccb81cc1bf04b5ce09d31882ee283e1c87a8d6223dfd49067863bc360121c86",
    base: "0xaa6bA2Ae7F20748B46A3DB221a418137ec54A5a2",
    solana: "DsesgAr8EguoiioX2kddzdYGHJHZos9ZRLh1VbDr3j1n",
  };

  await workerPool.query(
    `INSERT INTO flow.wallet_addresses (id, wallet_id, network, chain_id, address, public_key)
     VALUES
      (gen_random_uuid(), $1::uuid, 'near', 'near-testnet', $2, 'ed25519:testnet-pk'),
      (gen_random_uuid(), $1::uuid, 'base', '84532', $3, 'secp256k1:base-pk'),
      (gen_random_uuid(), $1::uuid, 'solana', 'solana-devnet', $4, 'ed25519:solana-pk')`,
    [
      walletId,
      AUTHENTIC_ADDRESSES.near,
      AUTHENTIC_ADDRESSES.base,
      AUTHENTIC_ADDRESSES.solana,
    ],
  );

  // 3. Query and verify registered addresses in database
  const res = await workerPool.query(
    `SELECT network, chain_id, address FROM flow.wallet_addresses WHERE wallet_id = $1::uuid ORDER BY network`,
    [walletId],
  );
  assert.equal(res.rows.length, 3);
  assert.equal(
    res.rows.find((r) => r.network === "near")?.address,
    AUTHENTIC_ADDRESSES.near,
  );
  assert.equal(
    res.rows.find((r) => r.network === "base")?.address,
    AUTHENTIC_ADDRESSES.base,
  );
  assert.equal(
    res.rows.find((r) => r.network === "solana")?.address,
    AUTHENTIC_ADDRESSES.solana,
  );

  // 4. Verify wallet balances can be recorded for all 3 supported testnet networks with matching addresses
  const nearTestnetAssetId = "20000000-0000-0000-0000-000000000002";
  const baseSepoliaEthAssetId = "20000000-0000-0000-0000-000000000004";
  const solanaDevnetAssetId = "20000000-0000-0000-0000-000000000006";

  await workerPool.query(
    `INSERT INTO flow.wallet_balances (wallet_id, network_asset_id, atomic_balance, sync_status, finality)
     VALUES
      ($1::uuid, $2::uuid, 0, 'SYNCED', 'FINALIZED'),
      ($1::uuid, $3::uuid, 0, 'SYNCED', 'CONFIRMED'),
      ($1::uuid, $4::uuid, 0, 'SYNCED', 'FINALIZED')`,
    [walletId, nearTestnetAssetId, baseSepoliaEthAssetId, solanaDevnetAssetId],
  );

  const balRes = await workerPool.query(
    `SELECT b.atomic_balance, b.sync_status, na.network, na.chain_id
     FROM flow.wallet_balances b
     JOIN flow.network_assets na ON na.id = b.network_asset_id
     WHERE b.wallet_id = $1::uuid
     ORDER BY na.network`,
    [walletId],
  );
  assert.equal(balRes.rows.length, 3);
  for (const row of balRes.rows) {
    assert.equal(row.sync_status, "SYNCED");
    assert.equal(BigInt(row.atomic_balance), 0n);
  }
});

test("m3 phase 3: security gate — auth_sessions row-level security and bearer token protection", async () => {
  // 1. Create two isolated users with active sessions
  const victim = await createTestAccount(pool, "PERSONAL", "m3-p3-victim");
  const attacker = await createTestAccount(pool, "PERSONAL", "m3-p3-attacker");

  const victimToken = await createTestSession(pool, victim.authUserId, 86400);
  await createTestSession(pool, attacker.authUserId, 86400);

  // 2. Direct SQL adversarial test: Unscoped bulk SELECT of bearer tokens by app_role returns 0 rows
  const bulkTokensRes = await pool.query(
    "SELECT token FROM flow.auth_sessions",
  );
  assert.equal(
    bulkTokensRes.rows.length,
    0,
    "Unscoped SELECT token FROM flow.auth_sessions by app_role must return 0 rows under RLS",
  );

  const bulkAllRes = await pool.query("SELECT * FROM flow.auth_sessions");
  assert.equal(
    bulkAllRes.rows.length,
    0,
    "Unscoped SELECT * FROM flow.auth_sessions by app_role must return 0 rows under RLS",
  );

  // 3. Direct SQL adversarial test: Targeted query for victim's token by user_id returns 0 rows
  const targetedTokenRes = await pool.query(
    "SELECT token FROM flow.auth_sessions WHERE user_id = $1",
    [victim.authUserId],
  );
  assert.equal(
    targetedTokenRes.rows.length,
    0,
    "Targeted query for another tenant's bearer token by user_id must return 0 rows",
  );

  // 4. Direct SQL adversarial test: UPDATE ... RETURNING token returns 0 rows
  const attackerUpdateRes = await pool.query(
    "UPDATE flow.auth_sessions SET updated_at = now() WHERE user_id = $1 RETURNING token",
    [victim.authUserId],
  );
  assert.equal(
    attackerUpdateRes.rows.length,
    0,
    "UPDATE ... RETURNING token for another user must be blocked by RLS word boundary check",
  );

  // 5. Direct SQL adversarial test: Forged GUC session token cannot bypass auth_sessions RLS
  const appClient = await pool.connect();
  try {
    await appClient.query("BEGIN");
    await appClient.query(
      "SELECT set_config('flow.current_session_token', 'completely-forged-token-value', true)",
    );
    const forgedSelectRes = await appClient.query(
      "SELECT token FROM flow.auth_sessions",
    );
    assert.equal(
      forgedSelectRes.rows.length,
      0,
      "Forged session token GUC value must return 0 rows from auth_sessions",
    );
    await appClient.query("COMMIT");
  } catch (err) {
    await appClient.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    appClient.release();
  }

  // 6. Direct SQL adversarial test: Forged GUC session token cannot read victim's balances
  const balanceAppClient = await pool.connect();
  try {
    await balanceAppClient.query("BEGIN");
    await balanceAppClient.query(
      "SELECT set_config('flow.current_session_token', 'forged-token', true)",
    );
    await balanceAppClient.query(
      "SELECT set_config('flow.current_account_id', $1, true)",
      [victim.accountId],
    );
    const leakedBalances = await balanceAppClient.query(
      "SELECT * FROM flow.wallet_balances",
    );
    assert.equal(
      leakedBalances.rows.length,
      0,
      "Forged token context must return 0 balance observations for victim account",
    );
    await balanceAppClient.query("COMMIT");
  } catch (err) {
    await balanceAppClient.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    balanceAppClient.release();
  }

  // 7. Legitimate session access: Legitimate holder with valid session token CAN query their balances
  // First provision a balance record for victim
  const victimWalletId = randomUUID();
  await workerPool.query(
    `INSERT INTO flow.wallets (
      id, account_id, provider, environment, provider_wallet_id, near_account_id,
      encrypted_credential, key_id, key_digest, status, policy_state
    ) VALUES (
      $1::uuid, $2::uuid, 'OUTLAYER', 'testnet',
      $3, 'victim-near', 'enc-v', 'v1', 'dig-v',
      'PROVISIONING'::flow.wallet_status, 'none'
    )`,
    [victimWalletId, victim.accountId, `prov-${victimWalletId}`],
  );

  await workerPool.query(
    `INSERT INTO flow.wallet_addresses (id, wallet_id, network, chain_id, address, public_key)
     VALUES (gen_random_uuid(), $1::uuid, 'near', 'near-testnet', 'victim-near-addr', 'mock-pk-victim')`,
    [victimWalletId],
  );

  const nearTestnetAssetId = "20000000-0000-0000-0000-000000000002";
  await workerPool.query(
    `INSERT INTO flow.wallet_balances (wallet_id, network_asset_id, atomic_balance, sync_status, finality)
     VALUES ($1::uuid, $2::uuid, 1000000000000000000000000, 'SYNCED', 'FINALIZED')`,
    [victimWalletId, nearTestnetAssetId],
  );

  const legitClient = await pool.connect();
  try {
    await legitClient.query("BEGIN");
    await legitClient.query(
      "SELECT set_config('flow.current_session_token', $1, true)",
      [victimToken],
    );
    await legitClient.query(
      "SELECT set_config('flow.current_account_id', $1, true)",
      [victim.accountId],
    );
    const legitBalances = await legitClient.query(
      `SELECT wb.atomic_balance, a.symbol
       FROM flow.wallet_balances wb
       JOIN flow.network_assets na ON na.id = wb.network_asset_id
       JOIN flow.assets a ON a.id = na.asset_id
       WHERE wb.wallet_id = $1::uuid`,
      [victimWalletId],
    );
    assert.equal(legitBalances.rows.length, 1);
    assert.equal(
      BigInt(legitBalances.rows[0].atomic_balance),
      1000000000000000000000000n,
    );
    assert.equal(legitBalances.rows[0].symbol, "NEAR");
    await legitClient.query("COMMIT");
  } catch (err) {
    await legitClient.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    legitClient.release();
  }
});

test("m3 phase 3: authenticated portfolio data layer — multi-chain aggregation and RLS isolation", async () => {
  const { serializePortfolio } = await import("../src/domain/portfolio.ts");

  // 1. Setup Owner user with personal account and provisioned testnet wallet
  const owner = await createTestAccount(pool, "PERSONAL", "m3-p3-owner");
  const stranger = await createTestAccount(pool, "PERSONAL", "m3-p3-stranger");

  const ownerSessionToken = await createTestSession(
    pool,
    owner.authUserId,
    86400,
  );
  const strangerSessionToken = await createTestSession(
    pool,
    stranger.authUserId,
    86400,
  );

  const ownerWalletId = randomUUID();
  await workerPool.query(
    `INSERT INTO flow.wallets (
      id, account_id, provider, environment, provider_wallet_id, near_account_id,
      encrypted_credential, key_id, key_digest, status, policy_state
    ) VALUES (
      $1::uuid, $2::uuid, 'OUTLAYER', 'testnet',
      $3, 'owner-near-test', 'enc-cred', 'v1', 'dig-cred',
      'PROVISIONING'::flow.wallet_status, 'none'
    )`,
    [ownerWalletId, owner.accountId, `prov-${ownerWalletId}`],
  );

  // Register addresses for NEAR, Base Sepolia, Solana Devnet
  await workerPool.query(
    `INSERT INTO flow.wallet_addresses (id, wallet_id, network, chain_id, address, public_key)
     VALUES
      (gen_random_uuid(), $1::uuid, 'near', 'near-testnet', 'eccb81cc1bf04b5ce09d31882ee283e1c87a8d6223dfd49067863bc360121c86', 'mock-pk-near'),
      (gen_random_uuid(), $1::uuid, 'base', '84532', '0xaa6bA2Ae7F20748B46A3DB221a418137ec54A5a2', 'mock-pk-base'),
      (gen_random_uuid(), $1::uuid, 'solana', 'devnet', 'DsesgAr8EguoiioX2kddzdYGHJHZos9ZRLh1VbDr3j1n', 'mock-pk-sol')`,
    [ownerWalletId],
  );

  const nearTestnetAssetId = "20000000-0000-0000-0000-000000000002";
  const baseSepoliaEthAssetId = "20000000-0000-0000-0000-000000000004";
  const baseSepoliaUsdcAssetId = "20000000-0000-0000-0000-000000000009";

  await workerPool.query(
    `INSERT INTO flow.wallet_balances (wallet_id, network_asset_id, atomic_balance, block_height, sync_status, finality, last_synced_at)
     VALUES
      ($1::uuid, $2::uuid, 0, 185000100, 'SYNCED', 'FINALIZED', NOW()),
      ($1::uuid, $3::uuid, 0, 20450123, 'SYNCED', 'FINALIZED', NOW()),
      ($1::uuid, $4::uuid, 0, 20450123, 'SYNCED', 'CONFIRMED', NOW())`,
    [
      ownerWalletId,
      nearTestnetAssetId,
      baseSepoliaEthAssetId,
      baseSepoliaUsdcAssetId,
    ],
  );

  // Test 1: Under RLS, accessing balances with owner session retrieves the owner's 3 balances
  const ownerProjection = await getAccountBalances(appDb, owner.accountId, {
    sessionToken: ownerSessionToken,
  });
  assert.equal(ownerProjection.accountId, owner.accountId);
  assert.ok(ownerProjection.wallet);
  assert.equal(ownerProjection.wallet.status, "PROVISIONING");
  assert.equal(ownerProjection.wallet.addresses.length, 3);
  assert.equal(ownerProjection.balances.length, 3);

  // Test 2: Serialized portfolio conforms to safe decimal representation and testnet safety
  const serialized = serializePortfolio(ownerProjection);
  assert.equal(serialized.wallet?.status, "PROVISIONING");
  assert.equal(serialized.wallet?.executionDisabled, true);
  assert.equal(serialized.wallet?.depositEligible, false);
  assert.equal(serialized.wallet?.transferEligible, false);
  assert.ok(serialized.wallet?.disclaimer.includes("PROVISIONING"));
  assert.equal(serialized.balances.length, 3);
  const nearBal = serialized.balances.find(
    (b) => b.networkAsset.asset.symbol === "NEAR",
  );
  assert.ok(nearBal);
  assert.equal(nearBal.atomicBalance, "0");
  assert.equal(nearBal.displayBalance, "0");
  assert.equal(nearBal.isZeroConfirmed, true);

  // Test 3: Under RLS and membership verification, stranger attempting to view owner's balances is denied
  await assert.rejects(
    async () =>
      getAccountBalances(appDb, owner.accountId, {
        sessionToken: strangerSessionToken,
      }),
    (err: unknown) => (err as FlowError).code === "ACCOUNT_NOT_FOUND",
    "Stranger accessing owner account must be denied with ACCOUNT_NOT_FOUND",
  );

  // Test 4: Access without valid session token throws ACCOUNT_NOT_FOUND
  await assert.rejects(
    async () =>
      getAccountBalances(appDb, owner.accountId, { sessionToken: "" }),
    (err: unknown) => (err as FlowError).code === "ACCOUNT_NOT_FOUND",
  );
});

test("m3 phase 3.1: adversarial security tests — session boundary hardening, exploit regressions, and durable refresh concurrency", async () => {
  // Setup: Create victim and attacker accounts
  const victim = await createTestAccount(pool, "PERSONAL", "m3-p31-victim");
  const attacker = await createTestAccount(pool, "PERSONAL", "m3-p31-attacker");

  await createTestSession(pool, victim.authUserId, 86400);
  const attackerToken = await createTestSession(
    pool,
    attacker.authUserId,
    86400,
  );

  // Provision wallet and balance for victim
  const victimWalletId = randomUUID();
  await workerPool.query(
    `INSERT INTO flow.wallets (
      id, account_id, provider, environment, provider_wallet_id, near_account_id,
      encrypted_credential, key_id, key_digest, status, policy_state
    ) VALUES (
      $1::uuid, $2::uuid, 'OUTLAYER', 'testnet',
      $3, 'victim-p31-near', 'enc-p31', 'v1', 'dig-p31',
      'PROVISIONING'::flow.wallet_status, 'none'
    )`,
    [victimWalletId, victim.accountId, `prov-${victimWalletId}`],
  );

  await workerPool.query(
    `INSERT INTO flow.wallet_addresses (id, wallet_id, network, chain_id, address, public_key)
     VALUES (gen_random_uuid(), $1::uuid, 'near', 'near-testnet', 'victim-p31-near-addr', 'mock-pk-p31')`,
    [victimWalletId],
  );

  const nearAssetId = "20000000-0000-0000-0000-000000000002";
  await workerPool.query(
    `INSERT INTO flow.wallet_balances (wallet_id, network_asset_id, atomic_balance, sync_status, finality)
     VALUES ($1::uuid, $2::uuid, 5000000000000000000000000, 'SYNCED', 'FINALIZED')`,
    [victimWalletId, nearAssetId],
  );

  // =========================================================================
  // Exploit 1: Direct SQL Attack — Attacker connects as app_role and attempts
  // to insert a session for victim without an issuance ticket
  // =========================================================================
  await assert.rejects(
    async () => {
      await pool.query(
        `INSERT INTO flow.auth_sessions (id, user_id, token, expires_at, created_at, updated_at)
         VALUES (gen_random_uuid(), $1, 'forged-attacker-token', NOW() + INTERVAL '1 hour', NOW(), NOW())
         RETURNING token`,
        [victim.authUserId],
      );
    },
    (err: unknown) => {
      const e = err as { code?: string; message?: string };
      assert.equal(e.code, "42501");
      assert.match(
        e.message ?? "",
        /(Direct session insertion unauthorized|violates row-level security policy|Authentication issuance ticket)/,
      );
      return true;
    },
    "Direct session insertion by app_role without active ticket must be rejected with 42501",
  );

  // =========================================================================
  // Exploit 2: Forged GUC Active Ticket ID — Attacker sets flow.active_auth_ticket_id
  // to an unissued UUID and attempts INSERT
  // =========================================================================
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `SELECT set_config('flow.active_auth_ticket_id', gen_random_uuid()::text, true)`,
    );
    await assert.rejects(
      async () => {
        await client.query(
          `INSERT INTO flow.auth_sessions (id, user_id, token, expires_at, created_at, updated_at)
           VALUES (gen_random_uuid(), $1, 'forged-token-2', NOW() + INTERVAL '1 hour', NOW(), NOW())
           RETURNING token`,
          [victim.authUserId],
        );
      },
      (err: unknown) => {
        const e = err as { code?: string; message?: string };
        assert.equal(e.code, "42501");
        assert.match(
          e.message ?? "",
          /(Authentication issuance ticket invalid|violates row-level security policy|Direct session insertion unauthorized)/,
        );
        return true;
      },
      "Forged ticket ID GUC must be rejected with 42501",
    );
    await client.query("ROLLBACK");
  } finally {
    client.release();
  }

  // =========================================================================
  // Exploit 3: Direct Insertion into flow.auth_issuance_tickets
  // =========================================================================
  await assert.rejects(
    async () => {
      await pool.query(
        `INSERT INTO flow.auth_issuance_tickets (ticket_id, user_id, flow_type)
         VALUES (gen_random_uuid(), $1, 'email-otp')`,
        [victim.authUserId],
      );
    },
    (err: unknown) => {
      const e = err as { code?: string; message?: string };
      assert.equal(e.code, "42501");
      assert.match(
        e.message ?? "",
        /permission denied for table auth_issuance_tickets/,
      );
      return true;
    },
    "Direct write to auth_issuance_tickets by app_role must be rejected by PostgreSQL permissions",
  );

  // =========================================================================
  // Exploit 4: Privileged Ticket Issuance Functions Misuse
  // =========================================================================
  await assert.rejects(
    async () => {
      await pool.query(
        `SELECT flow.issue_email_auth_ticket('fake-slot', 'fake-digest')`,
      );
    },
    (err: unknown) => {
      const e = err as { code?: string; message?: string };
      assert.equal(e.code, "42501");
      assert.match(
        e.message ?? "",
        /(Authentication intent invalid, expired, or non-matching|Ticket issuance unauthorized|permission denied for function)/,
      );
      return true;
    },
    "issue_email_auth_ticket with invalid intent must be rejected with 42501",
  );

  await assert.rejects(
    async () => {
      await pool.query(
        `SELECT flow.issue_google_auth_ticket('fake-sub', $1, 999999)`,
        [victim.authUserId],
      );
    },
    (err: unknown) => {
      const e = err as { code?: string; message?: string };
      assert.equal(e.code, "42501");
      assert.match(
        e.message ?? "",
        /(Google subject binding not found for user|Ticket issuance unauthorized|permission denied for function)/,
      );
      return true;
    },
    "issue_google_auth_ticket with invalid subject binding must be rejected with 42501",
  );

  // =========================================================================
  // Exploit 5: Session Tampering via UPDATE (Anti-Tampering Trigger)
  // =========================================================================
  // Sub-test 5.1: Attacker attempts to change user_id of their own session to victim
  const tamperClient1 = await pool.connect();
  try {
    await tamperClient1.query("BEGIN");
    await tamperClient1.query(
      `SELECT set_config('flow.current_session_token', $1, true)`,
      [attackerToken],
    );
    await assert.rejects(
      async () => {
        await tamperClient1.query(
          `UPDATE flow.auth_sessions SET user_id = $1 WHERE token = $2`,
          [victim.authUserId, attackerToken],
        );
      },
      (err: unknown) => {
        const e = err as { code?: string; message?: string };
        assert.equal(e.code, "42501");
        assert.match(e.message ?? "", /Cannot modify session user_id/);
        return true;
      },
      "Attempting to modify session user_id must be rejected with 42501 by trigger",
    );
    await tamperClient1.query("ROLLBACK");
  } finally {
    tamperClient1.release();
  }

  // Sub-test 5.2: Attacker attempts to change token of their own session
  const tamperClient2 = await pool.connect();
  try {
    await tamperClient2.query("BEGIN");
    await tamperClient2.query(
      `SELECT set_config('flow.current_session_token', $1, true)`,
      [attackerToken],
    );
    await assert.rejects(
      async () => {
        await tamperClient2.query(
          `UPDATE flow.auth_sessions SET token = 'hacked-token' WHERE token = $1`,
          [attackerToken],
        );
      },
      (err: unknown) => {
        const e = err as { code?: string; message?: string };
        assert.equal(e.code, "42501");
        assert.match(e.message ?? "", /Cannot modify session token/);
        return true;
      },
      "Attempting to modify session token must be rejected with 42501 by trigger",
    );
    await tamperClient2.query("ROLLBACK");
  } finally {
    tamperClient2.release();
  }

  // Sub-test 5.3: Attacker attempts to update victim's session
  const tamperClient3 = await pool.connect();
  try {
    await tamperClient3.query("BEGIN");
    await tamperClient3.query(
      `SELECT set_config('flow.current_session_token', $1, true)`,
      [attackerToken],
    );
    const otherUpdate = await tamperClient3.query(
      `UPDATE flow.auth_sessions SET updated_at = NOW() WHERE user_id = $1`,
      [victim.authUserId],
    );
    assert.equal(
      otherUpdate.rowCount,
      0,
      "Attempting to update another user's session must update 0 rows under RLS",
    );
    await tamperClient3.query("ROLLBACK");
  } finally {
    tamperClient3.release();
  }

  // =========================================================================
  // Exploit 6: Unauthorized Session Deletion
  // =========================================================================
  const deleteClient = await pool.connect();
  try {
    await deleteClient.query("BEGIN");
    await deleteClient.query(
      `SELECT set_config('flow.current_session_token', $1, true)`,
      [attackerToken],
    );
    const deleteRes = await deleteClient.query(
      `DELETE FROM flow.auth_sessions WHERE user_id = $1`,
      [victim.authUserId],
    );
    assert.equal(
      deleteRes.rowCount,
      0,
      "Attempting to delete victim's session must delete 0 rows under RLS",
    );
    await deleteClient.query("ROLLBACK");
  } finally {
    deleteClient.release();
  }

  // =========================================================================
  // Exploit 7: Verify elimination of current_query() regex inspection
  // =========================================================================
  const funcRes = await pool.query(
    `SELECT proname FROM pg_proc WHERE proname = 'auth_sessions_can_select'`,
  );
  assert.equal(
    funcRes.rows.length,
    0,
    "flow.auth_sessions_can_select must be dropped and eliminated completely",
  );

  // =========================================================================
  // Feature & Security: Durable Refresh Cooldown & Leasing Concurrency
  // =========================================================================
  // Verify app_role does NOT have DELETE on portfolio_refresh_leases (least privilege)
  await assert.rejects(
    async () => {
      await pool.query(
        `DELETE FROM flow.portfolio_refresh_leases WHERE account_id = $1::uuid`,
        [victim.accountId],
      );
    },
    (err: unknown) => {
      const e = err as { code?: string };
      assert.equal(e.code, "42501");
      return true;
    },
    "app_role must not have DELETE on portfolio_refresh_leases",
  );

  // Clean refresh lease for victim account using workerPool
  await workerPool.query(
    `DELETE FROM flow.portfolio_refresh_leases WHERE account_id = $1::uuid`,
    [victim.accountId],
  );

  // Test 1: Worker 1 acquires refresh lease atomically
  const worker1Holder = `worker-node-1-${randomUUID().slice(0, 8)}`;
  const leaseAcquisitionQuery = `
    INSERT INTO flow.portfolio_refresh_leases (
      account_id, last_refreshed_at, lease_expires_at, lease_holder, fencing_token, updated_at
    ) VALUES (
      $1::uuid, NULL, CURRENT_TIMESTAMP + interval '10 seconds', $2, 1, CURRENT_TIMESTAMP
    )
    ON CONFLICT (account_id) DO UPDATE
    SET lease_expires_at = CURRENT_TIMESTAMP + interval '10 seconds',
        lease_holder = EXCLUDED.lease_holder,
        fencing_token = flow.portfolio_refresh_leases.fencing_token + 1,
        updated_at = CURRENT_TIMESTAMP
    WHERE (flow.portfolio_refresh_leases.last_refreshed_at IS NULL
           OR flow.portfolio_refresh_leases.last_refreshed_at <= CURRENT_TIMESTAMP - interval '15 seconds')
      AND (flow.portfolio_refresh_leases.lease_expires_at IS NULL
           OR flow.portfolio_refresh_leases.lease_expires_at <= CURRENT_TIMESTAMP)
    RETURNING fencing_token;
  `;

  const w1Res = await workerPool.query<{ fencing_token: string }>(
    leaseAcquisitionQuery,
    [victim.accountId, worker1Holder],
  );
  assert.equal(w1Res.rows.length, 1);
  assert.equal(w1Res.rows[0]!.fencing_token, "1");

  // Test 2: Concurrent Worker 2 attempts to acquire lease while Worker 1 is in-flight -> 0 rows (fan-out blocked)
  const worker2Holder = `worker-node-2-${randomUUID().slice(0, 8)}`;
  const w2Res = await workerPool.query<{ fencing_token: string }>(
    leaseAcquisitionQuery,
    [victim.accountId, worker2Holder],
  );
  assert.equal(
    w2Res.rows.length,
    0,
    "Concurrent worker must be denied lease while in-flight lease is active",
  );

  // Test 3: Worker 1 finishes successfully and commits refresh cooldown
  await workerPool.query(
    `UPDATE flow.portfolio_refresh_leases
     SET last_refreshed_at = CURRENT_TIMESTAMP,
         lease_expires_at = NULL,
         lease_holder = NULL,
         updated_at = CURRENT_TIMESTAMP
     WHERE account_id = $1::uuid AND fencing_token = $2`,
    [victim.accountId, 1],
  );

  // Test 4: Subsequent request during 15s cooldown -> 0 rows (rate limited)
  const cooldownRes = await workerPool.query<{ fencing_token: string }>(
    leaseAcquisitionQuery,
    [victim.accountId, worker2Holder],
  );
  assert.equal(
    cooldownRes.rows.length,
    0,
    "Subsequent refresh during 15-second cooldown must be rejected",
  );

  // Test 5: Expire the cooldown artificially and acquire lease 2 (fencing token increments)
  await workerPool.query(
    `UPDATE flow.portfolio_refresh_leases
     SET last_refreshed_at = CURRENT_TIMESTAMP - interval '16 seconds'
     WHERE account_id = $1::uuid`,
    [victim.accountId],
  );
  const w2SuccessRes = await workerPool.query<{ fencing_token: string }>(
    leaseAcquisitionQuery,
    [victim.accountId, worker2Holder],
  );
  assert.equal(w2SuccessRes.rows.length, 1);
  assert.equal(
    w2SuccessRes.rows[0]!.fencing_token,
    "2",
    "Fencing token must increment on subsequent lease acquisition",
  );

  // Test 6: Fail-closed release on RPC failure: lease cleared without false freshness
  await workerPool.query(
    `UPDATE flow.portfolio_refresh_leases
     SET lease_expires_at = NULL,
         lease_holder = NULL,
         updated_at = CURRENT_TIMESTAMP
     WHERE account_id = $1::uuid AND fencing_token = $2`,
    [victim.accountId, 2],
  );
  const leaseState = await workerPool.query<{
    lease_expires_at: Date | null;
    lease_holder: string | null;
  }>(
    `SELECT lease_expires_at, lease_holder FROM flow.portfolio_refresh_leases WHERE account_id = $1::uuid`,
    [victim.accountId],
  );
  assert.equal(leaseState.rows.length, 1);
  assert.equal(leaseState.rows[0]!.lease_expires_at, null);
  assert.equal(leaseState.rows[0]!.lease_holder, null);

  // Test 7: Verify stale cache integrity — wallet balance record was not overwritten or fabricated
  const balanceCheck = await workerPool.query<{ atomic_balance: string }>(
    `SELECT atomic_balance FROM flow.wallet_balances WHERE wallet_id = $1::uuid AND network_asset_id = $2::uuid`,
    [victimWalletId, nearAssetId],
  );
  assert.equal(balanceCheck.rows.length, 1);
  assert.equal(
    balanceCheck.rows[0]!.atomic_balance,
    "5000000000000000000000000",
    "Existing balance observation must remain intact on refresh failure",
  );
});

test("m3 phase 3.2: authentication ticket and refresh lease privilege audit — adversarial trust boundary enforcement", async () => {
  // 1. Setup victim and attacker isolated personal accounts with sessions
  const victim = await createTestAccount(pool, "PERSONAL", "m3-p32-victim");
  const attacker = await createTestAccount(pool, "PERSONAL", "m3-p32-attacker");

  const victimToken = await createTestSession(pool, victim.authUserId, 86400);
  const attackerToken = await createTestSession(
    pool,
    attacker.authUserId,
    86400,
  );

  // -------------------------------------------------------------------------
  // Part 1: Authentication Ticket Privilege Audit & Defenses
  // -------------------------------------------------------------------------

  // Exploit 1: Attacker connects as app_role and attempts to call issue_email_auth_ticket directly
  await assert.rejects(
    async () => {
      await pool.query(
        `SELECT flow.issue_email_auth_ticket('fake-slot', 'fake-digest')`,
      );
    },
    (err: unknown) => {
      const e = err as { code?: string; message?: string };
      assert.equal(e.code, "42501");
      assert.match(
        e.message ?? "",
        /permission denied for function issue_email_auth_ticket|Ticket issuance unauthorized/,
      );
      return true;
    },
    "app_role must be forbidden from calling issue_email_auth_ticket",
  );

  // Exploit 2: Attacker connects as app_role and attempts to call issue_google_auth_ticket directly
  await assert.rejects(
    async () => {
      await pool.query(
        `SELECT flow.issue_google_auth_ticket('fake-sub', $1, 0)`,
        [victim.authUserId],
      );
    },
    (err: unknown) => {
      const e = err as { code?: string; message?: string };
      assert.equal(e.code, "42501");
      assert.match(
        e.message ?? "",
        /permission denied for function issue_google_auth_ticket|Ticket issuance unauthorized/,
      );
      return true;
    },
    "app_role must be forbidden from calling issue_google_auth_ticket",
  );

  // Exploit 3: Attacker creates a forged intent in flow.auth_intents and attempts ticket issuance
  // Even if an intent exists in flow.auth_intents, app_role cannot issue a ticket with it
  const forgedSlot = `forged-${randomUUID()}`;
  await pool.query(
    `INSERT INTO flow.auth_intents (slot, email, digest, issued_at, expires_at, purpose)
     VALUES ($1, 'victim-p32@example.test', 'forged-digest-p32', NOW(), NOW() + INTERVAL '10 minutes', 'sign-in-email')`,
    [forgedSlot],
  );
  await assert.rejects(
    async () => {
      await pool.query(
        `SELECT flow.issue_email_auth_ticket($1, 'forged-digest-p32')`,
        [forgedSlot],
      );
    },
    (err: unknown) => {
      const e = err as { code?: string };
      assert.equal(e.code, "42501");
      return true;
    },
    "Forged intent cannot be converted to ticket by app_role",
  );
  await pool.query(`DELETE FROM flow.auth_intents WHERE slot = $1`, [
    forgedSlot,
  ]);

  // Exploit 4: Worker role CAN legitimately issue ticket for valid intent, and intent is atomically consumed
  const legitimateSlot = `legit-${randomUUID()}`;
  const legitimateDigest = `digest-${randomUUID()}`;
  const victimEmail = `${victim.authUserId}@example.test`;
  await pool.query(
    `INSERT INTO flow.auth_intents (slot, email, digest, issued_at, expires_at, purpose)
     VALUES ($1, $2, $3, NOW(), NOW() + INTERVAL '10 minutes', 'sign-in-email')`,
    [legitimateSlot, victimEmail, legitimateDigest],
  );

  const ticketRows = await workerPool.query<{
    issue_email_auth_ticket: string;
  }>(`SELECT flow.issue_email_auth_ticket($1, $2)`, [
    legitimateSlot,
    legitimateDigest,
  ]);
  assert.equal(ticketRows.rows.length, 1);
  const issuedTicketId = ticketRows.rows[0]!.issue_email_auth_ticket;
  assert.ok(issuedTicketId);

  // Verify the intent was atomically deleted (replay prevention)
  const intentCheck = await pool.query(
    `SELECT * FROM flow.auth_intents WHERE slot = $1`,
    [legitimateSlot],
  );
  assert.equal(
    intentCheck.rows.length,
    0,
    "Intent must be atomically consumed upon ticket issuance",
  );

  // Replay attempt by worker role must fail because intent is gone
  await assert.rejects(
    async () => {
      await workerPool.query(`SELECT flow.issue_email_auth_ticket($1, $2)`, [
        legitimateSlot,
        legitimateDigest,
      ]);
    },
    (err: unknown) => {
      const e = err as { code?: string; message?: string };
      assert.equal(e.code, "42501");
      assert.match(
        e.message ?? "",
        /Authentication intent invalid, expired, or non-matching/,
      );
      return true;
    },
    "Replay of consumed intent must fail closed",
  );

  // -------------------------------------------------------------------------
  // Part 2: Refresh Lease Privilege Audit & Guarded Function Defenses
  // -------------------------------------------------------------------------

  // Exploit 5: Attacker directly updates portfolio_refresh_leases (attempts to reset cooldown)
  await assert.rejects(
    async () => {
      await pool.query(
        `UPDATE flow.portfolio_refresh_leases SET last_refreshed_at = '2000-01-01' WHERE account_id = $1::uuid`,
        [victim.accountId],
      );
    },
    (err: unknown) => {
      const e = err as { code?: string };
      assert.equal(e.code, "42501");
      return true;
    },
    "Direct UPDATE on portfolio_refresh_leases by app_role must be rejected with 42501",
  );

  // Exploit 6: Attacker directly inserts into portfolio_refresh_leases
  await assert.rejects(
    async () => {
      await pool.query(
        `INSERT INTO flow.portfolio_refresh_leases (account_id, fencing_token)
         VALUES ($1::uuid, 999)`,
        [victim.accountId],
      );
    },
    (err: unknown) => {
      const e = err as { code?: string };
      assert.equal(e.code, "42501");
      return true;
    },
    "Direct INSERT into portfolio_refresh_leases by app_role must be rejected with 42501",
  );

  // Exploit 7: Attacker directly deletes from portfolio_refresh_leases
  await assert.rejects(
    async () => {
      await pool.query(
        `DELETE FROM flow.portfolio_refresh_leases WHERE account_id = $1::uuid`,
        [victim.accountId],
      );
    },
    (err: unknown) => {
      const e = err as { code?: string };
      assert.equal(e.code, "42501");
      return true;
    },
    "Direct DELETE on portfolio_refresh_leases by app_role must be rejected with 42501",
  );

  // Exploit 8: Cross-tenant lease acquisition attack via guarded function
  // Attacker (session set to attackerToken) calls acquire_portfolio_refresh_lease for victim.accountId
  const attackerClient = await pool.connect();
  try {
    await attackerClient.query("BEGIN");
    await attackerClient.query(
      `SELECT set_config('flow.current_session_token', $1, true)`,
      [attackerToken],
    );
    await assert.rejects(
      async () => {
        await attackerClient.query(
          `SELECT * FROM flow.acquire_portfolio_refresh_lease($1::uuid, 'attacker-node')`,
          [victim.accountId],
        );
      },
      (err: unknown) => {
        const e = err as { code?: string; message?: string };
        assert.equal(e.code, "42501");
        assert.match(e.message ?? "", /Account access unauthorized/);
        return true;
      },
      "Cross-tenant acquire_portfolio_refresh_lease must be rejected with 42501",
    );
    await attackerClient.query("ROLLBACK");
  } catch (err) {
    await attackerClient.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    attackerClient.release();
  }

  // Exploit 9: Cross-tenant lease release attack via guarded function
  // Attacker attempts to release victim's lease
  const attackerReleaseClient = await pool.connect();
  try {
    await attackerReleaseClient.query("BEGIN");
    await attackerReleaseClient.query(
      `SELECT set_config('flow.current_session_token', $1, true)`,
      [attackerToken],
    );
    await assert.rejects(
      async () => {
        await attackerReleaseClient.query(
          `SELECT flow.release_portfolio_refresh_lease($1::uuid, 1::bigint, '00000000-0000-0000-0000-000000000000'::uuid, true)`,
          [victim.accountId],
        );
      },
      (err: unknown) => {
        const e = err as { code?: string; message?: string };
        assert.equal(e.code, "42501");
        assert.match(
          e.message ?? "",
          /(Account access unauthorized|permission denied for function)/,
        );
        return true;
      },
      "Cross-tenant release_portfolio_refresh_lease must be rejected with 42501",
    );
    await attackerReleaseClient.query("ROLLBACK");
  } catch (err) {
    await attackerReleaseClient.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    attackerReleaseClient.release();
  }

  // Exploit 10: Row-Level Security on portfolio_refresh_leases
  // Attacker cannot view victim's lease record via SELECT
  let victimLeaseToken = "";
  let victimFencingToken = "";
  const victimLeaseClient = await pool.connect();
  try {
    await victimLeaseClient.query("BEGIN");
    await victimLeaseClient.query(
      `SELECT set_config('flow.current_session_token', $1, true)`,
      [victimToken],
    );
    // Legitimate lease acquisition by victim
    const legitAcquire = await victimLeaseClient.query<{
      acquired: boolean;
      fencing_token: string;
      lease_token: string;
    }>(
      `SELECT acquired, fencing_token, lease_token FROM flow.acquire_portfolio_refresh_lease($1::uuid, 'victim-node')`,
      [victim.accountId],
    );
    assert.equal(legitAcquire.rows[0]!.acquired, true);
    victimFencingToken = legitAcquire.rows[0]!.fencing_token;
    victimLeaseToken = legitAcquire.rows[0]!.lease_token;
    await victimLeaseClient.query("COMMIT");
  } finally {
    victimLeaseClient.release();
  }

  const rlsReadClient = await pool.connect();
  try {
    await rlsReadClient.query("BEGIN");
    await rlsReadClient.query(
      `SELECT set_config('flow.current_session_token', $1, true)`,
      [attackerToken],
    );
    const leakedLeases = await rlsReadClient.query(
      `SELECT * FROM flow.portfolio_refresh_leases WHERE account_id = $1::uuid`,
      [victim.accountId],
    );
    assert.equal(
      leakedLeases.rows.length,
      0,
      "Attacker must not be able to select victim's refresh lease under RLS",
    );
    await rlsReadClient.query("COMMIT");
  } finally {
    rlsReadClient.release();
  }

  // Exploit 11: Cooldown enforcement via guarded function
  // Worker completes refresh with success=true using valid lease_token
  const released = await workerPool.query<{
    release_portfolio_refresh_lease: boolean;
  }>(
    `SELECT flow.release_portfolio_refresh_lease($1::uuid, $2::bigint, $3::uuid, true)`,
    [victim.accountId, victimFencingToken, victimLeaseToken],
  );
  assert.equal(released.rows[0]!.release_portfolio_refresh_lease, true);

  const victimCooldownClient = await pool.connect();
  try {
    await victimCooldownClient.query("BEGIN");
    await victimCooldownClient.query(
      `SELECT set_config('flow.current_session_token', $1, true)`,
      [victimToken],
    );
    // Immediate re-acquisition must be rejected with reason COOLDOWN
    const cooldownAttempt = await victimCooldownClient.query<{
      acquired: boolean;
      reason: string;
      remaining_seconds: number;
    }>(
      `SELECT acquired, reason, remaining_seconds FROM flow.acquire_portfolio_refresh_lease($1::uuid, 'victim-node-2')`,
      [victim.accountId],
    );
    assert.equal(cooldownAttempt.rows[0]!.acquired, false);
    assert.equal(cooldownAttempt.rows[0]!.reason, "COOLDOWN");
    assert.ok(
      cooldownAttempt.rows[0]!.remaining_seconds > 0 &&
        cooldownAttempt.rows[0]!.remaining_seconds <= 15,
    );
    await victimCooldownClient.query("COMMIT");
  } finally {
    victimCooldownClient.release();
  }

  // Exploit 12: Failed RPC reconciliation cannot mark stale balances as fresh
  // Fast forward cooldown using workerPool, acquire lease with fencing_token=2, then release with success=false
  await workerPool.query(
    `UPDATE flow.portfolio_refresh_leases
     SET last_refreshed_at = '2020-01-01 00:00:00'
     WHERE account_id = $1::uuid`,
    [victim.accountId],
  );

  let failFencingToken = "";
  let failLeaseToken = "";
  const failClient = await pool.connect();
  try {
    await failClient.query("BEGIN");
    await failClient.query(
      `SELECT set_config('flow.current_session_token', $1, true)`,
      [victimToken],
    );
    const acquire2 = await failClient.query<{
      acquired: boolean;
      fencing_token: string;
      lease_token: string;
    }>(
      `SELECT acquired, fencing_token, lease_token FROM flow.acquire_portfolio_refresh_lease($1::uuid, 'victim-node-fail')`,
      [victim.accountId],
    );
    assert.equal(acquire2.rows[0]!.acquired, true);
    assert.equal(acquire2.rows[0]!.fencing_token, "2");
    failFencingToken = acquire2.rows[0]!.fencing_token;
    failLeaseToken = acquire2.rows[0]!.lease_token;
    await failClient.query("COMMIT");
  } finally {
    failClient.release();
  }

  // Release with success = false (RPC failure simulation) via workerPool
  const failRelease = await workerPool.query<{
    release_portfolio_refresh_lease: boolean;
  }>(
    `SELECT flow.release_portfolio_refresh_lease($1::uuid, $2::bigint, $3::uuid, false)`,
    [victim.accountId, failFencingToken, failLeaseToken],
  );
  assert.equal(failRelease.rows[0]!.release_portfolio_refresh_lease, true);

  // Verify that last_refreshed_at remained the old timestamp '2020-01-01', NOT CURRENT_TIMESTAMP
  const staleCheck = await workerPool.query<{ last_refreshed_at: Date }>(
    `SELECT last_refreshed_at FROM flow.portfolio_refresh_leases WHERE account_id = $1::uuid`,
    [victim.accountId],
  );
  assert.equal(
    new Date(staleCheck.rows[0]!.last_refreshed_at).getFullYear(),
    2020,
    "Failed refresh must not mark last_refreshed_at as fresh",
  );
});

test("m3 phase 3.3: final ticket possession and refresh-lease integrity corrections", async () => {
  const victim = await createTestAccount(pool, "PERSONAL", "p33-victim");
  const attacker = await createTestAccount(pool, "PERSONAL", "p33-attacker");

  const victimToken = await createTestSession(pool, victim.authUserId);
  const attackerToken = await createTestSession(pool, attacker.authUserId);

  // --------------------------------------------------------------------------
  // Part 1: Authentication Ticket Possession & Zero-Fallback Enforcement
  // --------------------------------------------------------------------------

  // 1. Prepare an unconsumed ticket for victim via worker
  const slot = `intent-p33-${randomUUID()}`;
  const digest = randomUUID();
  await pool.query(
    `INSERT INTO flow.auth_intents (slot, digest, email, purpose, issued_at, expires_at)
     VALUES ($1, $2, $3, 'sign-in-email', (now() AT TIME ZONE 'UTC'), (now() AT TIME ZONE 'UTC') + interval '5 minutes')`,
    [slot, digest, victim.email],
  );

  const [ticketRow] = (
    await workerPool.query<{ issue_email_auth_ticket: string }>(
      `SELECT flow.issue_email_auth_ticket($1, $2)`,
      [slot, digest],
    )
  ).rows;
  const victimTicketId = ticketRow!.issue_email_auth_ticket;
  assert.ok(victimTicketId);

  // Attack 1: Attacker as app_role attempts INSERT into flow.auth_sessions for victim WITHOUT ticket ID
  // Must fail with 42501 (Authentication issuance ticket required) — NO FALLBACK
  const attackerClient = await pool.connect();
  try {
    await assert.rejects(
      attackerClient.query(
        `INSERT INTO flow.auth_sessions (id, token, user_id, expires_at, created_at, updated_at)
         VALUES ($1, $2, $3, now() + interval '1 hour', now(), now())`,
        [randomUUID(), randomUUID(), victim.authUserId],
      ),
      (err: unknown) => {
        const e = err as { code?: string; message?: string };
        assert.equal(e.code, "42501");
        assert.ok(
          e.message?.includes("Authentication issuance ticket required"),
          `Expected 'Authentication issuance ticket required', got: ${e.message}`,
        );
        return true;
      },
      "Attacker without ticket must fail with 'Authentication issuance ticket required'",
    );

    // Attack 2: Empty ticket ID string
    await assert.rejects(
      (async () => {
        try {
          await attackerClient.query("BEGIN");
          await attackerClient.query(
            `SELECT set_config('flow.active_auth_ticket_id', '', true)`,
          );
          await attackerClient.query(
            `INSERT INTO flow.auth_sessions (id, token, user_id, expires_at, created_at, updated_at)
             VALUES ($1, $2, $3, now() + interval '1 hour', now(), now())`,
            [randomUUID(), randomUUID(), victim.authUserId],
          );
          await attackerClient.query("COMMIT");
        } finally {
          await attackerClient.query("ROLLBACK").catch(() => {});
        }
      })(),
      (err: unknown) => {
        const e = err as { code?: string; message?: string };
        assert.equal(e.code, "42501");
        assert.ok(
          e.message?.includes("Authentication issuance ticket required"),
        );
        return true;
      },
    );

    // Attack 3: Malformed ticket ID (invalid UUID)
    await assert.rejects(
      (async () => {
        try {
          await attackerClient.query("BEGIN");
          await attackerClient.query(
            `SELECT set_config('flow.active_auth_ticket_id', 'not-a-valid-uuid', true)`,
          );
          await attackerClient.query(
            `INSERT INTO flow.auth_sessions (id, token, user_id, expires_at, created_at, updated_at)
             VALUES ($1, $2, $3, now() + interval '1 hour', now(), now())`,
            [randomUUID(), randomUUID(), victim.authUserId],
          );
          await attackerClient.query("COMMIT");
        } finally {
          await attackerClient.query("ROLLBACK").catch(() => {});
        }
      })(),
      (err: unknown) => {
        const e = err as { code?: string; message?: string };
        assert.equal(e.code, "42501");
        assert.ok(
          e.message?.includes("Authentication issuance ticket invalid"),
        );
        return true;
      },
    );

    // Attack 4: Guessed / non-existent random UUID ticket ID
    await assert.rejects(
      (async () => {
        try {
          await attackerClient.query("BEGIN");
          await attackerClient.query(
            `SELECT set_config('flow.active_auth_ticket_id', $1, true)`,
            [randomUUID()],
          );
          await attackerClient.query(
            `INSERT INTO flow.auth_sessions (id, token, user_id, expires_at, created_at, updated_at)
             VALUES ($1, $2, $3, now() + interval '1 hour', now(), now())`,
            [randomUUID(), randomUUID(), victim.authUserId],
          );
          await attackerClient.query("COMMIT");
        } finally {
          await attackerClient.query("ROLLBACK").catch(() => {});
        }
      })(),
      (err: unknown) => {
        const e = err as { code?: string; message?: string };
        assert.equal(e.code, "42501");
        assert.ok(
          e.message?.includes("Authentication issuance ticket invalid"),
        );
        return true;
      },
    );

    // Attack 5: Another user's ticket (attacker gets ticket for attacker, tries to use it for victim)
    const attackerSlot = `intent-p33-att-${randomUUID()}`;
    const attackerDigest = randomUUID();
    await pool.query(
      `INSERT INTO flow.auth_intents (slot, digest, email, purpose, issued_at, expires_at)
       VALUES ($1, $2, $3, 'sign-in-email', (now() AT TIME ZONE 'UTC'), (now() AT TIME ZONE 'UTC') + interval '5 minutes')`,
      [attackerSlot, attackerDigest, attacker.email],
    );
    const [attTicketRow] = (
      await workerPool.query<{ issue_email_auth_ticket: string }>(
        `SELECT flow.issue_email_auth_ticket($1, $2)`,
        [attackerSlot, attackerDigest],
      )
    ).rows;
    const attackerTicketId = attTicketRow!.issue_email_auth_ticket;

    await assert.rejects(
      (async () => {
        try {
          await attackerClient.query("BEGIN");
          await attackerClient.query(
            `SELECT set_config('flow.active_auth_ticket_id', $1, true)`,
            [attackerTicketId],
          );
          await attackerClient.query(
            `INSERT INTO flow.auth_sessions (id, token, user_id, expires_at, created_at, updated_at)
             VALUES ($1, $2, $3, now() + interval '1 hour', now(), now())`,
            [randomUUID(), randomUUID(), victim.authUserId],
          );
          await attackerClient.query("COMMIT");
        } finally {
          await attackerClient.query("ROLLBACK").catch(() => {});
        }
      })(),
      (err: unknown) => {
        const e = err as { code?: string; message?: string };
        assert.equal(e.code, "42501");
        assert.ok(
          e.message?.includes(
            "Authentication issuance ticket invalid, expired, or user mismatch",
          ),
        );
        return true;
      },
    );

    // Attack 6: Direct SELECT on flow.auth_issuance_tickets by app_role
    await assert.rejects(
      attackerClient.query(`SELECT * FROM flow.auth_issuance_tickets`),
      (err: unknown) => {
        const e = err as { code?: string };
        assert.equal(e.code, "42501");
        return true;
      },
    );

    // Attack 7: Direct EXECUTE of ticket issuance functions by app_role
    await assert.rejects(
      attackerClient.query(
        `SELECT flow.issue_email_auth_ticket('slot', 'digest')`,
      ),
      (err: unknown) => {
        const e = err as { code?: string };
        assert.equal(e.code, "42501");
        return true;
      },
    );
    await assert.rejects(
      attackerClient.query(
        `SELECT flow.issue_google_auth_ticket('sub', 'uid', 1)`,
      ),
      (err: unknown) => {
        const e = err as { code?: string };
        assert.equal(e.code, "42501");
        return true;
      },
    );
  } finally {
    attackerClient.release();
  }

  // Legitimate Ticket Possession: Session created with exact matching ticket in same transaction
  const legitSessionToken = randomUUID();
  const legitClient = await pool.connect();
  try {
    await legitClient.query("BEGIN");
    await legitClient.query(
      `SELECT set_config('flow.active_auth_ticket_id', $1, true)`,
      [victimTicketId],
    );
    const inserted = await legitClient.query(
      `INSERT INTO flow.auth_sessions (id, token, user_id, expires_at, created_at, updated_at)
       VALUES ($1, $2, $3, now() + interval '1 hour', now(), now())
       RETURNING id, token`,
      [randomUUID(), legitSessionToken, victim.authUserId],
    );
    assert.equal(inserted.rows.length, 1);
    await legitClient.query("COMMIT");
  } finally {
    legitClient.release();
  }

  // Attack 8: Ticket Replay — attempting to reuse the consumed ticket must fail
  const replayClient = await pool.connect();
  try {
    await assert.rejects(
      (async () => {
        try {
          await replayClient.query("BEGIN");
          await replayClient.query(
            `SELECT set_config('flow.active_auth_ticket_id', $1, true)`,
            [victimTicketId],
          );
          await replayClient.query(
            `INSERT INTO flow.auth_sessions (id, token, user_id, expires_at, created_at, updated_at)
             VALUES ($1, $2, $3, now() + interval '1 hour', now(), now())`,
            [randomUUID(), randomUUID(), victim.authUserId],
          );
          await replayClient.query("COMMIT");
        } finally {
          await replayClient.query("ROLLBACK").catch(() => {});
        }
      })(),
      (err: unknown) => {
        const e = err as { code?: string; message?: string };
        assert.equal(e.code, "42501");
        assert.ok(
          e.message?.includes(
            "Authentication issuance ticket invalid, expired, or user mismatch",
          ),
        );
        return true;
      },
    );
  } finally {
    replayClient.release();
  }

  // Attack 9: Expired ticket (> 30 seconds old)
  const expiredTicketId = randomUUID();
  await workerPool.query(
    `INSERT INTO flow.auth_issuance_tickets (ticket_id, user_id, flow_type, created_at)
     VALUES ($1, $2, 'email-otp', now() - interval '35 seconds')`,
    [expiredTicketId, victim.authUserId],
  );

  const expiredClient = await pool.connect();
  try {
    await assert.rejects(
      (async () => {
        try {
          await expiredClient.query("BEGIN");
          await expiredClient.query(
            `SELECT set_config('flow.active_auth_ticket_id', $1, true)`,
            [expiredTicketId],
          );
          await expiredClient.query(
            `INSERT INTO flow.auth_sessions (id, token, user_id, expires_at, created_at, updated_at)
             VALUES ($1, $2, $3, now() + interval '1 hour', now(), now())`,
            [randomUUID(), randomUUID(), victim.authUserId],
          );
          await expiredClient.query("COMMIT");
        } finally {
          await expiredClient.query("ROLLBACK").catch(() => {});
        }
      })(),
      (err: unknown) => {
        const e = err as { code?: string; message?: string };
        assert.equal(e.code, "42501");
        assert.ok(
          e.message?.includes(
            "Authentication issuance ticket invalid, expired, or user mismatch",
          ),
        );
        return true;
      },
    );
  } finally {
    expiredClient.release();
  }

  // --------------------------------------------------------------------------
  // Part 2: Refresh Lease Integrity & Unforgeable Capabilities
  // --------------------------------------------------------------------------

  // Attack 10: Caller passes 4 arguments to acquire_portfolio_refresh_lease (attempting custom cooldown/duration)
  const leaseAttackerClient = await pool.connect();
  try {
    await leaseAttackerClient.query("BEGIN");
    await leaseAttackerClient.query(
      `SELECT set_config('flow.current_session_token', $1, true)`,
      [victimToken],
    );
    await assert.rejects(
      leaseAttackerClient.query(
        `SELECT flow.acquire_portfolio_refresh_lease($1::uuid, 'holder', 0, 0)`,
        [victim.accountId],
      ),
      (err: unknown) => {
        const e = err as { code?: string };
        assert.equal(e.code, "42883"); // undefined_function
        return true;
      },
      "Overload with custom cooldown/duration must not exist",
    );
    await leaseAttackerClient.query("ROLLBACK");
  } catch (err) {
    await leaseAttackerClient.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    leaseAttackerClient.release();
  }

  // Attack 11: Cross-tenant acquire_portfolio_refresh_lease
  const crossTenantClient = await pool.connect();
  try {
    await crossTenantClient.query("BEGIN");
    await crossTenantClient.query(
      `SELECT set_config('flow.current_session_token', $1, true)`,
      [attackerToken],
    );
    await assert.rejects(
      crossTenantClient.query(
        `SELECT flow.acquire_portfolio_refresh_lease($1::uuid, 'attacker-node')`,
        [victim.accountId],
      ),
      (err: unknown) => {
        const e = err as { code?: string; message?: string };
        assert.equal(e.code, "42501");
        assert.ok(e.message?.includes("Account access unauthorized"));
        return true;
      },
    );
    await crossTenantClient.query("ROLLBACK");
  } catch (err) {
    await crossTenantClient.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    crossTenantClient.release();
  }

  // Legitimate Lease Acquisition: Server-enforced constants (15s cooldown / 10s duration)
  let p33FencingToken = "";
  let p33LeaseToken = "";
  const leaseClient = await pool.connect();
  try {
    await leaseClient.query("BEGIN");
    await leaseClient.query(
      `SELECT set_config('flow.current_session_token', $1, true)`,
      [victimToken],
    );
    const acquireRes = await leaseClient.query<{
      acquired: boolean;
      reason: string;
      fencing_token: string;
      lease_token: string;
      remaining_seconds: number;
    }>(
      `SELECT acquired, reason, fencing_token, lease_token, remaining_seconds
       FROM flow.acquire_portfolio_refresh_lease($1::uuid, 'p33-holder')`,
      [victim.accountId],
    );
    assert.equal(acquireRes.rows[0]!.acquired, true);
    assert.equal(acquireRes.rows[0]!.reason, "ACQUIRED");
    assert.ok(acquireRes.rows[0]!.lease_token);
    p33FencingToken = acquireRes.rows[0]!.fencing_token;
    p33LeaseToken = acquireRes.rows[0]!.lease_token;
    await leaseClient.query("COMMIT");
  } finally {
    leaseClient.release();
  }

  // Cooldown & In-Flight enforcement
  const secondLeaseClient = await pool.connect();
  try {
    await secondLeaseClient.query("BEGIN");
    await secondLeaseClient.query(
      `SELECT set_config('flow.current_session_token', $1, true)`,
      [victimToken],
    );
    const inFlightRes = await secondLeaseClient.query<{
      acquired: boolean;
      reason: string;
      remaining_seconds: number;
    }>(
      `SELECT acquired, reason, remaining_seconds
       FROM flow.acquire_portfolio_refresh_lease($1::uuid, 'second-holder')`,
      [victim.accountId],
    );
    assert.equal(inFlightRes.rows[0]!.acquired, false);
    assert.equal(inFlightRes.rows[0]!.reason, "IN_FLIGHT");
    await secondLeaseClient.query("COMMIT");
  } finally {
    secondLeaseClient.release();
  }

  // Attack 12: app_role cannot SELECT on flow.portfolio_refresh_lease_secrets
  const secretInspectClient = await pool.connect();
  try {
    await assert.rejects(
      secretInspectClient.query(
        `SELECT * FROM flow.portfolio_refresh_lease_secrets`,
      ),
      (err: unknown) => {
        const e = err as { code?: string };
        assert.equal(e.code, "42501");
        return true;
      },
    );
  } finally {
    secretInspectClient.release();
  }

  // Attack 13: app_role cannot call flow.release_portfolio_refresh_lease
  const releaseAttackerClient = await pool.connect();
  try {
    await assert.rejects(
      releaseAttackerClient.query(
        `SELECT flow.release_portfolio_refresh_lease($1::uuid, $2::bigint, $3::uuid, true)`,
        [victim.accountId, p33FencingToken, p33LeaseToken],
      ),
      (err: unknown) => {
        const e = err as { code?: string };
        assert.equal(e.code, "42501");
        return true;
      },
    );
  } finally {
    releaseAttackerClient.release();
  }

  // Attack 14: Worker release without lease_token (NULL)
  await assert.rejects(
    workerPool.query(
      `SELECT flow.release_portfolio_refresh_lease($1::uuid, $2::bigint, NULL, true)`,
      [victim.accountId, p33FencingToken],
    ),
    (err: unknown) => {
      const e = err as { code?: string; message?: string };
      assert.equal(e.code, "42501");
      assert.ok(e.message?.includes("Lease token required for release"));
      return true;
    },
  );

  // Attack 15: Worker release with wrong/guessed lease_token
  await assert.rejects(
    workerPool.query(
      `SELECT flow.release_portfolio_refresh_lease($1::uuid, $2::bigint, $3::uuid, true)`,
      [victim.accountId, p33FencingToken, randomUUID()],
    ),
    (err: unknown) => {
      const e = err as { code?: string; message?: string };
      assert.equal(e.code, "42501");
      assert.ok(
        e.message?.includes(
          "Invalid, expired, or non-matching lease capability",
        ),
      );
      return true;
    },
  );

  // Attack 16: Worker release with wrong fencing_token
  await assert.rejects(
    workerPool.query(
      `SELECT flow.release_portfolio_refresh_lease($1::uuid, 999999::bigint, $2::uuid, true)`,
      [victim.accountId, p33LeaseToken],
    ),
    (err: unknown) => {
      const e = err as { code?: string; message?: string };
      assert.equal(e.code, "42501");
      assert.ok(
        e.message?.includes(
          "Invalid, expired, or non-matching lease capability",
        ),
      );
      return true;
    },
  );

  // Legitimate fail-closed release: Worker releases with success=false (RPC failure)
  const failReleaseRes = await workerPool.query<{
    release_portfolio_refresh_lease: boolean;
  }>(
    `SELECT flow.release_portfolio_refresh_lease($1::uuid, $2::bigint, $3::uuid, false)`,
    [victim.accountId, p33FencingToken, p33LeaseToken],
  );
  assert.equal(failReleaseRes.rows[0]!.release_portfolio_refresh_lease, true);

  // Verify that last_refreshed_at was NOT set (preserves previous observation)
  const failCheck = await workerPool.query<{
    last_refreshed_at: Date | null;
    lease_holder: string | null;
  }>(
    `SELECT last_refreshed_at, lease_holder FROM flow.portfolio_refresh_leases WHERE account_id = $1::uuid`,
    [victim.accountId],
  );
  assert.equal(failCheck.rows[0]!.last_refreshed_at, null);
  assert.equal(failCheck.rows[0]!.lease_holder, null);

  // Verify secret was cleaned up
  const secretCheck = await workerPool.query(
    `SELECT * FROM flow.portfolio_refresh_lease_secrets WHERE account_id = $1::uuid`,
    [victim.accountId],
  );
  assert.equal(secretCheck.rows.length, 0);

  // Re-acquire and legitimately release with success=true
  let p33FencingToken2 = "";
  let p33LeaseToken2 = "";
  const acquireClient2 = await pool.connect();
  try {
    await acquireClient2.query("BEGIN");
    await acquireClient2.query(
      `SELECT set_config('flow.current_session_token', $1, true)`,
      [victimToken],
    );
    const acquireRes2 = await acquireClient2.query<{
      acquired: boolean;
      fencing_token: string;
      lease_token: string;
    }>(
      `SELECT acquired, fencing_token, lease_token
       FROM flow.acquire_portfolio_refresh_lease($1::uuid, 'p33-holder-2')`,
      [victim.accountId],
    );
    assert.equal(acquireRes2.rows[0]!.acquired, true);
    p33FencingToken2 = acquireRes2.rows[0]!.fencing_token;
    p33LeaseToken2 = acquireRes2.rows[0]!.lease_token;
    await acquireClient2.query("COMMIT");
  } finally {
    acquireClient2.release();
  }

  const successReleaseRes = await workerPool.query<{
    release_portfolio_refresh_lease: boolean;
  }>(
    `SELECT flow.release_portfolio_refresh_lease($1::uuid, $2::bigint, $3::uuid, true)`,
    [victim.accountId, p33FencingToken2, p33LeaseToken2],
  );
  assert.equal(
    successReleaseRes.rows[0]!.release_portfolio_refresh_lease,
    true,
  );

  const successCheck = await workerPool.query<{
    last_refreshed_at: Date | null;
    lease_holder: string | null;
  }>(
    `SELECT last_refreshed_at, lease_holder FROM flow.portfolio_refresh_leases WHERE account_id = $1::uuid`,
    [victim.accountId],
  );
  assert.ok(successCheck.rows[0]!.last_refreshed_at !== null);
  assert.equal(successCheck.rows[0]!.lease_holder, null);

  // Immediate re-acquire must now be in COOLDOWN
  const cooldownClient2 = await pool.connect();
  try {
    await cooldownClient2.query("BEGIN");
    await cooldownClient2.query(
      `SELECT set_config('flow.current_session_token', $1, true)`,
      [victimToken],
    );
    const cooldownRes = await cooldownClient2.query<{
      acquired: boolean;
      reason: string;
      remaining_seconds: number;
    }>(
      `SELECT acquired, reason, remaining_seconds
       FROM flow.acquire_portfolio_refresh_lease($1::uuid, 'p33-holder-3')`,
      [victim.accountId],
    );
    assert.equal(cooldownRes.rows[0]!.acquired, false);
    assert.equal(cooldownRes.rows[0]!.reason, "COOLDOWN");
    assert.ok(
      cooldownRes.rows[0]!.remaining_seconds > 0 &&
        cooldownRes.rows[0]!.remaining_seconds <= 15,
    );
    await cooldownClient2.query("COMMIT");
  } finally {
    cooldownClient2.release();
  }

  // --------------------------------------------------------------------------
  // Part 2.1: Lease Expiration Recovery & Stale Worker Rejection
  // --------------------------------------------------------------------------
  // Fast-forward cooldown so lease is eligible again
  await workerPool.query(
    `UPDATE flow.portfolio_refresh_leases
     SET last_refreshed_at = '2020-01-01 00:00:00',
         lease_expires_at = NULL,
         lease_holder = NULL
     WHERE account_id = $1::uuid`,
    [victim.accountId],
  );

  // Holder A acquires lease
  let holderAFencing = "";
  let holderALeaseToken = "";
  const acquireAClient = await pool.connect();
  try {
    await acquireAClient.query("BEGIN");
    await acquireAClient.query(
      `SELECT set_config('flow.current_session_token', $1, true)`,
      [victimToken],
    );
    const resA = await acquireAClient.query<{
      acquired: boolean;
      fencing_token: string;
      lease_token: string;
    }>(
      `SELECT acquired, fencing_token, lease_token
       FROM flow.acquire_portfolio_refresh_lease($1::uuid, 'holder-a')`,
      [victim.accountId],
    );
    assert.equal(resA.rows[0]!.acquired, true);
    holderAFencing = resA.rows[0]!.fencing_token;
    holderALeaseToken = resA.rows[0]!.lease_token;
    await acquireAClient.query("COMMIT");
  } finally {
    acquireAClient.release();
  }

  // Simulate worker crash / lease expiry without release (lease_expires_at passes)
  await workerPool.query(
    `UPDATE flow.portfolio_refresh_leases
     SET lease_expires_at = now() - interval '1 second'
     WHERE account_id = $1::uuid`,
    [victim.accountId],
  );

  // Holder B acquires lease after expiry -> must succeed with incremented fencing token
  let holderBFencing = "";
  let holderBLeaseToken = "";
  const acquireBClient = await pool.connect();
  try {
    await acquireBClient.query("BEGIN");
    await acquireBClient.query(
      `SELECT set_config('flow.current_session_token', $1, true)`,
      [victimToken],
    );
    const resB = await acquireBClient.query<{
      acquired: boolean;
      fencing_token: string;
      lease_token: string;
    }>(
      `SELECT acquired, fencing_token, lease_token
       FROM flow.acquire_portfolio_refresh_lease($1::uuid, 'holder-b')`,
      [victim.accountId],
    );
    assert.equal(resB.rows[0]!.acquired, true);
    assert.ok(BigInt(resB.rows[0]!.fencing_token) > BigInt(holderAFencing));
    holderBFencing = resB.rows[0]!.fencing_token;
    holderBLeaseToken = resB.rows[0]!.lease_token;
    assert.notEqual(holderBLeaseToken, holderALeaseToken);
    await acquireBClient.query("COMMIT");
  } finally {
    acquireBClient.release();
  }

  // Stale worker A tries to release its expired lease -> must fail with 42501
  await assert.rejects(
    workerPool.query(
      `SELECT flow.release_portfolio_refresh_lease($1::uuid, $2::bigint, $3::uuid, true)`,
      [victim.accountId, holderAFencing, holderALeaseToken],
    ),
    (err: unknown) => {
      const e = err as { code?: string; message?: string };
      assert.equal(e.code, "42501");
      assert.ok(
        e.message?.includes(
          "Invalid, expired, or non-matching lease capability",
        ),
      );
      return true;
    },
  );

  // Active worker B releases lease successfully
  const releaseB = await workerPool.query<{
    release_portfolio_refresh_lease: boolean;
  }>(
    `SELECT flow.release_portfolio_refresh_lease($1::uuid, $2::bigint, $3::uuid, true)`,
    [victim.accountId, holderBFencing, holderBLeaseToken],
  );
  assert.equal(releaseB.rows[0]!.release_portfolio_refresh_lease, true);

  // --------------------------------------------------------------------------
  // Part 3: Additional Privilege Audit & Role Boundaries
  // --------------------------------------------------------------------------

  const privilegeClient = await pool.connect();
  try {
    // Attack 17: app_role cannot SET ROLE to worker_role or migrator_role
    await assert.rejects(
      privilegeClient.query(`SET ROLE flow_test_worker`),
      (err: unknown) => {
        const e = err as { code?: string };
        assert.equal(e.code, "42501");
        return true;
      },
    );
    await assert.rejects(
      privilegeClient.query(`SET ROLE flow_test_migrator`),
      (err: unknown) => {
        const e = err as { code?: string };
        assert.equal(e.code, "42501");
        return true;
      },
    );

    // Verify app_role does NOT have inherited membership in worker or migrator roles
    const memberCheck = await privilegeClient.query<{
      is_worker: boolean;
      is_migrator: boolean;
    }>(
      `SELECT pg_has_role(SESSION_USER, 'flow_test_worker', 'MEMBER') AS is_worker,
              pg_has_role(SESSION_USER, 'flow_test_migrator', 'MEMBER') AS is_migrator`,
    );
    assert.equal(memberCheck.rows[0]!.is_worker, false);
    assert.equal(memberCheck.rows[0]!.is_migrator, false);
  } finally {
    privilegeClient.release();
  }

  // Verify that PUBLIC does NOT have EXECUTE on any of the SECURITY DEFINER functions
  const publicFuncs = [
    "flow.acquire_portfolio_refresh_lease(uuid, text)",
    "flow.release_portfolio_refresh_lease(uuid, bigint, uuid, boolean)",
    "flow.issue_email_auth_ticket(text, text)",
    "flow.issue_google_auth_ticket(text, text, bigint)",
    "flow.can_access_account(uuid)",
  ];

  for (const func of publicFuncs) {
    const pubCheck = await workerPool.query<{ has_exec: boolean }>(
      `SELECT has_function_privilege('public', $1, 'EXECUTE') AS has_exec`,
      [func],
    );
    assert.equal(
      pubCheck.rows[0]!.has_exec,
      false,
      `PUBLIC must NOT have EXECUTE on ${func}`,
    );
  }

  // Verify search_path = flow, pg_temp and prosecdef = true on all functions
  const secDefFuncs = [
    "acquire_portfolio_refresh_lease",
    "release_portfolio_refresh_lease",
    "issue_email_auth_ticket",
    "issue_google_auth_ticket",
    "can_access_account",
  ];

  for (const fnName of secDefFuncs) {
    const secCheck = await workerPool.query<{
      prosecdef: boolean;
      proconfig: string[] | null;
    }>(
      `SELECT prosecdef, proconfig
       FROM pg_proc p
       JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'flow' AND p.proname = $1
       LIMIT 1`,
      [fnName],
    );
    assert.equal(
      secCheck.rows[0]!.prosecdef,
      true,
      `${fnName} must be SECURITY DEFINER`,
    );
    assert.ok(
      secCheck.rows[0]!.proconfig?.includes("search_path=flow, pg_temp"),
      `${fnName} must have search_path=flow, pg_temp`,
    );
  }
});

test("M3 Phase 4: flow.wallet_activities row-level security, adversarial isolation, consistency triggers, and idempotent deduplication", async () => {
  const adminClient = await pool.connect();
  const workerClient = await workerPool.connect();
  const appClient = await pool.connect();

  try {
    // 1. Setup Tenant A (Victim) and Tenant B (Attacker)
    const victim = await createTestAccount(
      adminClient,
      "PERSONAL",
      "m3p4-victim",
    );
    const victimSessionToken = await createTestSession(
      adminClient,
      victim.authUserId,
    );

    const attacker = await createTestAccount(
      adminClient,
      "PERSONAL",
      "m3p4-attacker",
    );
    const attackerSessionToken = await createTestSession(
      adminClient,
      attacker.authUserId,
    );

    // Create testnet wallets and addresses for both tenants
    const victimWalletId = randomUUID();
    const attackerWalletId = randomUUID();
    const victimBaseAddr = "0xaa6bA2Ae7F20748B46A3DB221a418137ec54A5a2";
    const attackerBaseAddr = "0xbbbbA2Ae7F20748B46A3DB221a418137ec54A5b2";

    await workerClient.query(
      `INSERT INTO flow.wallets (id, account_id, provider, provider_wallet_id, near_account_id, encrypted_credential, key_id, key_digest, status, environment)
       VALUES ($1, $2, 'outlayer', $3, $4, 'v1:dummy', 'v1', 'digest1', 'ACTIVE', 'testnet'),
              ($5, $6, 'outlayer', $7, $8, 'v1:dummy', 'v1', 'digest2', 'ACTIVE', 'testnet')`,
      [
        victimWalletId,
        victim.accountId,
        `prov-${victimWalletId}`,
        `victim-${victimWalletId.slice(0, 8)}.testnet`,
        attackerWalletId,
        attacker.accountId,
        `prov-${attackerWalletId}`,
        `attacker-${attackerWalletId.slice(0, 8)}.testnet`,
      ],
    );

    await workerClient.query(
      `INSERT INTO flow.wallet_addresses (id, wallet_id, network, chain_id, address, public_key)
       VALUES ($1, $2, 'base', '84532', $3, 'secp256k1:03victim'),
              ($4, $5, 'base', '84532', $6, 'secp256k1:03attacker')`,
      [
        randomUUID(),
        victimWalletId,
        victimBaseAddr,
        randomUUID(),
        attackerWalletId,
        attackerBaseAddr,
      ],
    );

    // 2. Consistency Trigger Verification:
    // Test A: Wallet-account ownership mismatch must fail
    await assert.rejects(
      workerClient.query(
        `INSERT INTO flow.wallet_activities (
           account_id, wallet_id, network, chain_id, ecosystem,
           activity_type, direction, tx_hash, event_index,
           from_address, to_address, asset_symbol, atomic_amount, decimals,
           finality, reorg_status
         ) VALUES (
           $1, $2, 'base', '84532', 'evm',
           'ON_CHAIN_TRANSFER', 'INCOMING', '0xtx1', 0,
           '0xexternal', $3, 'ETH', 1000000000000000000, 18,
           'CONFIRMED', 'CANONICAL'
         )`,
        [attacker.accountId, victimWalletId, victimBaseAddr], // attacker account + victim wallet
      ),
      (err: unknown) => {
        const e = err as { code?: string; message?: string };
        assert.equal(e.code, "42501");
        assert.ok(e.message?.includes("Account mismatch"));
        return true;
      },
    );

    // Test B: Network environment mismatch (testnet wallet with mainnet chain) must fail
    await assert.rejects(
      workerClient.query(
        `INSERT INTO flow.wallet_activities (
           account_id, wallet_id, network, chain_id, ecosystem,
           activity_type, direction, tx_hash, event_index,
           from_address, to_address, asset_symbol, atomic_amount, decimals,
           finality, reorg_status
         ) VALUES (
           $1, $2, 'base', '8453', 'evm', -- 8453 is Base Mainnet!
           'ON_CHAIN_TRANSFER', 'INCOMING', '0xtx2', 0,
           '0xexternal', $3, 'ETH', 1000000000000000000, 18,
           'CONFIRMED', 'CANONICAL'
         )`,
        [victim.accountId, victimWalletId, victimBaseAddr],
      ),
      (err: unknown) => {
        const e = err as { code?: string; message?: string };
        assert.equal(e.code, "23514");
        assert.ok(e.message?.includes("Environment mismatch"));
        return true;
      },
    );

    // Test C: Unregistered address mismatch must fail
    await assert.rejects(
      workerClient.query(
        `INSERT INTO flow.wallet_activities (
           account_id, wallet_id, network, chain_id, ecosystem,
           activity_type, direction, tx_hash, event_index,
           from_address, to_address, asset_symbol, atomic_amount, decimals,
           finality, reorg_status
         ) VALUES (
           $1, $2, 'base', '84532', 'evm',
           'ON_CHAIN_TRANSFER', 'INCOMING', '0xtx3', 0,
           '0xexternal1', '0xexternal2', 'ETH', 1000000000000000000, 18, -- neither matches victimBaseAddr!
           'CONFIRMED', 'CANONICAL'
         )`,
        [victim.accountId, victimWalletId],
      ),
      (err: unknown) => {
        const e = err as { code?: string; message?: string };
        assert.equal(e.code, "23514");
        assert.ok(e.message?.includes("Address mismatch"));
        return true;
      },
    );

    // 3. Insert valid activities for Victim and Attacker
    const victimTxHash =
      "0xvictim_tx_1111111111111111111111111111111111111111111111111111111111111111";
    const attackerTxHash =
      "0xattacker_tx_2222222222222222222222222222222222222222222222222222222222222222";

    await workerClient.query(
      `INSERT INTO flow.wallet_activities (
         account_id, wallet_id, network, chain_id, ecosystem,
         activity_type, direction, tx_hash, event_index,
         from_address, to_address, asset_symbol, atomic_amount, decimals,
         block_height, block_hash, finality, reorg_status, metadata
       ) VALUES
       ($1, $2, 'base', '84532', 'evm', 'ON_CHAIN_TRANSFER', 'INCOMING', $3, 0, '0xsender', $4, 'USDC', 100000000, 6, 100, '0xblock100', 'CONFIRMED', 'CANONICAL', '{"tag":"victim"}'),
       ($5, $6, 'base', '84532', 'evm', 'ON_CHAIN_TRANSFER', 'INCOMING', $7, 0, '0xsender', $8, 'USDC', 50000000, 6, 101, '0xblock101', 'CONFIRMED', 'CANONICAL', '{"tag":"attacker"}')`,
      [
        victim.accountId,
        victimWalletId,
        victimTxHash,
        victimBaseAddr,
        attacker.accountId,
        attackerWalletId,
        attackerTxHash,
        attackerBaseAddr,
      ],
    );

    // 4. Adversarial RLS Isolation:
    // Attacker sets session to their own valid session token
    await appClient.query("BEGIN");
    await appClient.query(
      `SELECT set_config('flow.current_session_token', $1, true)`,
      [attackerSessionToken],
    );

    // Attacker queries their own activities: sees exactly 1 (attackerTxHash)
    const myActs = await appClient.query(
      `SELECT tx_hash, account_id FROM flow.wallet_activities`,
    );
    assert.equal(myActs.rows.length, 1);
    assert.equal(myActs.rows[0]!.tx_hash, attackerTxHash);
    assert.equal(myActs.rows[0]!.account_id, attacker.accountId);

    // Attacker tries to query victim's account directly: 0 rows returned
    const victimActs = await appClient.query(
      `SELECT * FROM flow.wallet_activities WHERE account_id = $1::uuid`,
      [victim.accountId],
    );
    assert.equal(victimActs.rows.length, 0);

    // Attacker tries arbitrary session token spoofing: 0 rows returned
    await appClient.query(
      `SELECT set_config('flow.current_session_token', 'forged_fake_token', true)`,
    );
    const spoofedActs = await appClient.query(
      `SELECT * FROM flow.wallet_activities`,
    );
    assert.equal(spoofedActs.rows.length, 0);

    // Attacker tries custom GUC manipulation: 0 rows returned
    await appClient.query(
      `SELECT set_config('flow.current_account_id', $1, true)`,
      [victim.accountId],
    );
    const gucSpoofed = await appClient.query(
      `SELECT * FROM flow.wallet_activities`,
    );
    assert.equal(gucSpoofed.rows.length, 0);

    // Attacker tries to insert, update, or delete: rejected at table privilege level
    await assert.rejects(
      appClient.query(`DELETE FROM flow.wallet_activities WHERE tx_hash = $1`, [
        victimTxHash,
      ]),
      (err: unknown) => {
        const e = err as { code?: string };
        assert.equal(e.code, "42501");
        return true;
      },
    );

    await appClient.query("ROLLBACK");

    // Legitimate Tenant (Victim) queries their own activities: sees exactly 1 (victimTxHash)
    await appClient.query("BEGIN");
    await appClient.query(
      `SELECT set_config('flow.current_session_token', $1, true)`,
      [victimSessionToken],
    );
    const victimRead = await appClient.query(
      `SELECT tx_hash, account_id FROM flow.wallet_activities`,
    );
    assert.equal(victimRead.rows.length, 1);
    assert.equal(victimRead.rows[0]!.tx_hash, victimTxHash);
    assert.equal(victimRead.rows[0]!.account_id, victim.accountId);
    await appClient.query("ROLLBACK");

    // 5. Idempotent Upsert & Deduplication:
    // Upserting the same (network, tx_hash, event_index) updates finality without duplicating
    const upsertRes = await workerClient.query(
      `INSERT INTO flow.wallet_activities (
         account_id, wallet_id, network, chain_id, ecosystem,
         activity_type, direction, tx_hash, event_index,
         from_address, to_address, asset_symbol, atomic_amount, decimals,
         block_height, block_hash, finality, reorg_status, metadata
       ) VALUES (
         $1, $2, 'base', '84532', 'evm', 'ON_CHAIN_TRANSFER', 'INCOMING', $3, 0,
         '0xsender', $4, 'USDC', 100000000, 6, 100, '0xblock100', 'FINALIZED', 'CANONICAL', '{"updated":true}'
       )
       ON CONFLICT (network, tx_hash, event_index)
       DO UPDATE SET
         finality = EXCLUDED.finality,
         metadata = flow.wallet_activities.metadata || EXCLUDED.metadata,
         updated_at = now()
       RETURNING id, finality, metadata`,
      [victim.accountId, victimWalletId, victimTxHash, victimBaseAddr],
    );

    assert.equal(upsertRes.rows.length, 1);
    assert.equal(upsertRes.rows[0]!.finality, "FINALIZED");
    assert.equal(
      (upsertRes.rows[0]!.metadata as Record<string, unknown>).updated,
      true,
    );

    // Total rows for victim remains 1
    const totalCount = await workerClient.query<{ count: string }>(
      `SELECT count(*)::text as count FROM flow.wallet_activities WHERE account_id = $1::uuid`,
      [victim.accountId],
    );
    assert.equal(totalCount.rows[0]!.count, "1");

    // 6. Reorg Handling: Conflicting block hash updates reorg_status to REORG_DETECTED
    await workerClient.query(
      `INSERT INTO flow.wallet_activities (
         account_id, wallet_id, network, chain_id, ecosystem,
         activity_type, direction, tx_hash, event_index,
         from_address, to_address, asset_symbol, atomic_amount, decimals,
         block_height, block_hash, finality, reorg_status
       ) VALUES (
         $1, $2, 'base', '84532', 'evm', 'ON_CHAIN_TRANSFER', 'INCOMING', $3, 0,
         '0xsender', $4, 'USDC', 100000000, 6, 100, '0xreorged_block_hash', 'CONFIRMED', 'CANONICAL'
       )
       ON CONFLICT (network, tx_hash, event_index)
       DO UPDATE SET
         reorg_status = CASE
           WHEN flow.wallet_activities.block_hash IS NOT NULL
             AND EXCLUDED.block_hash IS NOT NULL
             AND flow.wallet_activities.block_hash <> EXCLUDED.block_hash
           THEN 'REORGED'
           ELSE flow.wallet_activities.reorg_status
         END`,
      [victim.accountId, victimWalletId, victimTxHash, victimBaseAddr],
    );

    const reorgCheck = await workerClient.query<{ reorg_status: string }>(
      `SELECT reorg_status FROM flow.wallet_activities WHERE tx_hash = $1`,
      [victimTxHash],
    );
    assert.equal(reorgCheck.rows[0]!.reorg_status, "REORGED");
  } finally {
    adminClient.release();
    workerClient.release();
    appClient.release();
  }
});

test("M5 Phase 1: flow.payment_requests row-level security, adversarial tenant isolation, consistency constraints, and safe public projection", async () => {
  const adminClient = await pool.connect();
  const workerClient = await workerPool.connect();
  const appClient = await pool.connect();

  try {
    // 1. Setup Tenant A (Victim) and Tenant B (Attacker)
    const victim = await createTestAccount(
      adminClient,
      "PERSONAL",
      "m5p1-victim",
    );
    const victimSessionToken = await createTestSession(
      adminClient,
      victim.authUserId,
    );

    const attacker = await createTestAccount(
      adminClient,
      "PERSONAL",
      "m5p1-attacker",
    );
    const attackerSessionToken = await createTestSession(
      adminClient,
      attacker.authUserId,
    );

    // 2. Consistency Triggers & Check Constraints Enforcement:
    // (a) Empty title must fail
    await assert.rejects(
      workerClient.query(
        `INSERT INTO flow.payment_requests (account_id, public_id, title, destination_network, destination_asset_id, destination_asset_symbol, destination_decimals)
         VALUES ($1, 'pr_empty_title_1234567890', '   ', 'base-sepolia', 'base-sepolia:USDC', 'USDC', 6)`,
        [victim.accountId],
      ),
      (err: unknown) => {
        const e = err as { code?: string; message?: string };
        assert.ok(
          e.code === "23514" || e.message?.includes("Title cannot be empty"),
        );
        return true;
      },
    );

    // (b) Invalid public_id format must fail check constraint
    await assert.rejects(
      workerClient.query(
        `INSERT INTO flow.payment_requests (account_id, public_id, title, destination_network, destination_asset_id, destination_asset_symbol, destination_decimals)
         VALUES ($1, 'invalid_no_pr_prefix', 'Valid Title', 'base-sepolia', 'base-sepolia:USDC', 'USDC', 6)`,
        [victim.accountId],
      ),
      (err: unknown) => {
        const e = err as { code?: string };
        assert.equal(e.code, "23514");
        return true;
      },
    );

    // (c) Amount mode FIXED with NULL amount must fail check constraint
    await assert.rejects(
      workerClient.query(
        `INSERT INTO flow.payment_requests (account_id, public_id, title, destination_network, destination_asset_id, destination_asset_symbol, destination_decimals, amount_mode, requested_atomic_amount)
         VALUES ($1, 'pr_fixed_null_amount_123456', 'Valid Title', 'base-sepolia', 'base-sepolia:USDC', 'USDC', 6, 'FIXED', NULL)`,
        [victim.accountId],
      ),
      (err: unknown) => {
        const e = err as { code?: string };
        assert.equal(e.code, "23514");
        return true;
      },
    );

    // (d) Amount mode OPTIONAL with positive amount must fail check constraint
    await assert.rejects(
      workerClient.query(
        `INSERT INTO flow.payment_requests (account_id, public_id, title, destination_network, destination_asset_id, destination_asset_symbol, destination_decimals, amount_mode, requested_atomic_amount)
         VALUES ($1, 'pr_opt_with_amount_12345678', 'Valid Title', 'base-sepolia', 'base-sepolia:USDC', 'USDC', 6, 'OPTIONAL', 10000000)`,
        [victim.accountId],
      ),
      (err: unknown) => {
        const e = err as { code?: string };
        assert.equal(e.code, "23514");
        return true;
      },
    );

    // (e) Past expiry on creation must fail trigger
    await assert.rejects(
      workerClient.query(
        `INSERT INTO flow.payment_requests (account_id, public_id, title, destination_network, destination_asset_id, destination_asset_symbol, destination_decimals, expires_at)
         VALUES ($1, 'pr_past_expiry_123456789012', 'Valid Title', 'base-sepolia', 'base-sepolia:USDC', 'USDC', 6, now() - interval '1 hour')`,
        [victim.accountId],
      ),
      (err: unknown) => {
        const e = err as { code?: string; message?: string };
        assert.ok(
          e.code === "23514" ||
            e.message?.includes("Expiry cannot be in the past"),
        );
        return true;
      },
    );

    // 3. Create Valid Payment Requests for Victim and Attacker
    const victimPublicId = "pr_victim_active_request_1234567890";
    const attackerPublicId = "pr_attacker_active_request_12345678";

    await workerClient.query(
      `INSERT INTO flow.payment_requests (
         account_id, public_id, title, description,
         destination_network, destination_asset_id, destination_asset_symbol, destination_decimals,
         amount_mode, requested_atomic_amount, expires_at
       ) VALUES
       ($1, $2, 'Victim Invoice #1', 'Phase 1 Consulting', 'base-sepolia', 'base-sepolia:USDC', 'USDC', 6, 'FIXED', 25000000, now() + interval '7 days'),
       ($3, $4, 'Attacker Invoice #2', 'Attacker services', 'solana-devnet', 'solana-devnet:USDC', 'USDC', 6, 'OPTIONAL', NULL, now() + interval '7 days')`,
      [victim.accountId, victimPublicId, attacker.accountId, attackerPublicId],
    );

    // 4. Adversarial RLS Isolation:
    // Attacker sets session to their own valid session token
    await appClient.query("BEGIN");
    await appClient.query(
      `SELECT set_config('flow.current_session_token', $1, true)`,
      [attackerSessionToken],
    );

    // Attacker queries payment requests: sees ONLY their own (attackerPublicId)
    const attackerQuery = await appClient.query<{
      public_id: string;
      account_id: string;
    }>(`SELECT public_id, account_id FROM flow.payment_requests`);
    assert.equal(attackerQuery.rows.length, 1);
    assert.equal(attackerQuery.rows[0]!.public_id, attackerPublicId);
    assert.equal(attackerQuery.rows[0]!.account_id, attacker.accountId);

    // Attacker attempts to SELECT victim's payment request directly: 0 rows returned
    const crossSelect = await appClient.query(
      `SELECT * FROM flow.payment_requests WHERE account_id = $1::uuid`,
      [victim.accountId],
    );
    assert.equal(crossSelect.rows.length, 0);

    // Attacker attempts to UPDATE victim's payment request: 0 rows affected
    const crossUpdate = await appClient.query(
      `UPDATE flow.payment_requests SET title = 'Hacked' WHERE public_id = $1`,
      [victimPublicId],
    );
    assert.equal(crossUpdate.rowCount, 0);

    // Attacker attempts to DELETE victim's payment request: 0 rows affected
    const crossDelete = await appClient.query(
      `DELETE FROM flow.payment_requests WHERE public_id = $1`,
      [victimPublicId],
    );
    assert.equal(crossDelete.rowCount, 0);

    // Attacker attempts session token forgery: 0 rows returned
    await appClient.query(
      `SELECT set_config('flow.current_session_token', 'forged_fake_token', true)`,
    );
    const forgedSelect = await appClient.query(
      `SELECT * FROM flow.payment_requests`,
    );
    assert.equal(forgedSelect.rows.length, 0);

    // Attacker attempts custom GUC manipulation: 0 rows returned
    await appClient.query(
      `SELECT set_config('flow.current_account_id', $1, true)`,
      [victim.accountId],
    );
    const gucSelect = await appClient.query(
      `SELECT * FROM flow.payment_requests`,
    );
    assert.equal(gucSelect.rows.length, 0);

    await appClient.query("ROLLBACK");

    // 5. Legitimate Tenant (Victim) access:
    await appClient.query("BEGIN");
    await appClient.query(
      `SELECT set_config('flow.current_session_token', $1, true)`,
      [victimSessionToken],
    );
    const victimQuery = await appClient.query<{
      public_id: string;
      title: string;
    }>(`SELECT public_id, title FROM flow.payment_requests`);
    assert.equal(victimQuery.rows.length, 1);
    assert.equal(victimQuery.rows[0]!.public_id, victimPublicId);
    assert.equal(victimQuery.rows[0]!.title, "Victim Invoice #1");
    await appClient.query("ROLLBACK");

    // 6. Public Guest Checkout Security Definer Function:
    // (a) Active request returns safe projection
    const publicRow = await appClient.query<{
      public_id: string;
      title: string;
      status: string;
      recipient_name: string;
      requested_atomic_amount: string;
    }>(`SELECT * FROM flow.get_public_payment_request($1)`, [victimPublicId]);
    assert.equal(publicRow.rows.length, 1);
    assert.equal(publicRow.rows[0]!.public_id, victimPublicId);
    assert.equal(publicRow.rows[0]!.title, "Victim Invoice #1");
    assert.equal(publicRow.rows[0]!.status, "ACTIVE");
    assert.equal(publicRow.rows[0]!.requested_atomic_amount, "25000000");

    // (b) Non-existent / invalid token returns 0 rows
    const nonExistent = await appClient.query(
      `SELECT * FROM flow.get_public_payment_request('pr_non_existent_token_12345678')`,
    );
    assert.equal(nonExistent.rows.length, 0);

    // (c) Expired request returns status EXPIRED
    const expiredPublicId = "pr_victim_expired_request_12345678";
    await workerClient.query(
      `INSERT INTO flow.payment_requests (
         account_id, public_id, title, destination_network, destination_asset_id, destination_asset_symbol, destination_decimals, amount_mode, requested_atomic_amount, expires_at
       ) VALUES ($1, $2, 'Expired Invoice', 'base-sepolia', 'base-sepolia:USDC', 'USDC', 6, 'FIXED', 10000000, now() + interval '1 second')`,
      [victim.accountId, expiredPublicId],
    );
    // Fast-forward expires_at to the past
    await workerClient.query(
      `UPDATE flow.payment_requests SET expires_at = now() - interval '1 second' WHERE public_id = $1`,
      [expiredPublicId],
    );
    const expiredRow = await appClient.query<{ status: string }>(
      `SELECT status FROM flow.get_public_payment_request($1)`,
      [expiredPublicId],
    );
    assert.equal(expiredRow.rows.length, 1);
    assert.equal(expiredRow.rows[0]!.status, "EXPIRED");
  } finally {
    adminClient.release();
    workerClient.release();
    appClient.release();
  }
});

test("database integration: M5 Phase 2 payment_attempts schema, constraints, security definer and tenant RLS isolation", async () => {
  const adminClient = await pool.connect();
  const workerClient = await workerPool.connect();
  const appClient = await pool.connect();

  try {
    // 1. Setup victim and attacker tenants
    const victim = await createTestAccount(
      adminClient,
      "PERSONAL",
      "m5p2-victim",
    );
    const victimSessionToken = await createTestSession(
      adminClient,
      victim.authUserId,
    );

    const attacker = await createTestAccount(
      adminClient,
      "PERSONAL",
      "m5p2-attacker",
    );
    const attackerSessionToken = await createTestSession(
      adminClient,
      attacker.authUserId,
    );

    // 2. Create victim payment requests
    const victimActivePr = "pr_m5p2_victim_active_123456789";
    const victimExpiredPr = "pr_m5p2_victim_expired_12345678";
    const victimDisabledPr = "pr_m5p2_victim_disabled_1234567";

    await workerClient.query(
      `INSERT INTO flow.payment_requests (
         account_id, public_id, title, destination_network, destination_asset_id, destination_asset_symbol, destination_decimals, amount_mode, requested_atomic_amount, status
       ) VALUES ($1, $2, 'Active Request', 'base-mainnet', 'base-mainnet:USDC', 'USDC', 6, 'FIXED', 10000000, 'ACTIVE')`,
      [victim.accountId, victimActivePr],
    );

    await workerClient.query(
      `INSERT INTO flow.payment_requests (
         account_id, public_id, title, destination_network, destination_asset_id, destination_asset_symbol, destination_decimals, amount_mode, requested_atomic_amount, status, expires_at
       ) VALUES ($1, $2, 'Expired Request', 'base-mainnet', 'base-mainnet:USDC', 'USDC', 6, 'FIXED', 10000000, 'ACTIVE', now() + interval '1 second')`,
      [victim.accountId, victimExpiredPr],
    );
    await workerClient.query(
      `UPDATE flow.payment_requests SET expires_at = now() - interval '1 hour' WHERE public_id = $1`,
      [victimExpiredPr],
    );

    await workerClient.query(
      `INSERT INTO flow.payment_requests (
         account_id, public_id, title, destination_network, destination_asset_id, destination_asset_symbol, destination_decimals, amount_mode, requested_atomic_amount, status
       ) VALUES ($1, $2, 'Disabled Request', 'base-mainnet', 'base-mainnet:USDC', 'USDC', 6, 'FIXED', 10000000, 'DISABLED')`,
      [victim.accountId, victimDisabledPr],
    );

    // 3. Test flow.record_public_payment_attempt Security Definer function
    const validAttemptId = "pa_m5p2_valid_attempt_123456789";

    // (a) Success on active request
    const recorded = await appClient.query<{
      id: string;
      attempt_public_id: string;
      route_status: string;
      status: string;
      verification_tier: string;
      is_provider_verified: boolean;
    }>(
      `SELECT * FROM flow.record_public_payment_attempt(
         $1, $2, 'WALLET', NULL, 'solana-mainnet', 'solana-mainnet:SOL', 'SOL', 9,
         'CROSS_CHAIN_1CLICK', 'SUPPORTED_AND_QUOTABLE', 'EXACT_OUTPUT',
         116868899::decimal, 10000000::decimal, 22, '{"refundFee":"115314"}'::jsonb,
         'corr-12345', 'sig-test', now() + interval '1 minute'
       )`,
      [victimActivePr, validAttemptId],
    );
    assert.equal(recorded.rows.length, 1);
    assert.equal(recorded.rows[0]!.attempt_public_id, validAttemptId);
    assert.equal(recorded.rows[0]!.route_status, "SUPPORTED_AND_QUOTABLE");
    assert.equal(recorded.rows[0]!.status, "QUOTE_OBSERVED");
    assert.equal(recorded.rows[0]!.verification_tier, "UNVERIFIED_OBSERVATION");
    assert.equal(recorded.rows[0]!.is_provider_verified, false);

    // (b) Fails on non-existent payment request
    await assert.rejects(
      appClient.query(
        `SELECT * FROM flow.record_public_payment_attempt(
           'pr_non_existent_12345678901234', 'pa_attempt_fail_1234567890123', 'WALLET', NULL,
           'solana-mainnet', 'solana-mainnet:SOL', 'SOL', 9,
           'CROSS_CHAIN_1CLICK', 'SUPPORTED_AND_QUOTABLE', 'EXACT_OUTPUT',
           100::decimal, 100::decimal, 10, '{}'::jsonb, NULL, NULL, now() + interval '1 minute'
         )`,
      ),
      { message: /PAYMENT_REQUEST_NOT_FOUND/ },
    );

    // (c) Fails on disabled payment request
    await assert.rejects(
      appClient.query(
        `SELECT * FROM flow.record_public_payment_attempt(
           $1, 'pa_attempt_fail_disabled_123', 'WALLET', NULL,
           'solana-mainnet', 'solana-mainnet:SOL', 'SOL', 9,
           'CROSS_CHAIN_1CLICK', 'SUPPORTED_AND_QUOTABLE', 'EXACT_OUTPUT',
           100::decimal, 100::decimal, 10, '{}'::jsonb, NULL, NULL, now() + interval '1 minute'
         )`,
        [victimDisabledPr],
      ),
      { message: /PAYMENT_REQUEST_INACTIVE/ },
    );

    // (d) Fails on expired payment request
    await assert.rejects(
      appClient.query(
        `SELECT * FROM flow.record_public_payment_attempt(
           $1, 'pa_attempt_fail_expired_1234', 'WALLET', NULL,
           'solana-mainnet', 'solana-mainnet:SOL', 'SOL', 9,
           'CROSS_CHAIN_1CLICK', 'SUPPORTED_AND_QUOTABLE', 'EXACT_OUTPUT',
           100::decimal, 100::decimal, 10, '{}'::jsonb, NULL, NULL, now() + interval '1 minute'
         )`,
        [victimExpiredPr],
      ),
      { message: /PAYMENT_REQUEST_EXPIRED/ },
    );

    // 4. Test Constraints on flow.payment_attempts table
    // (a) Invalid payer_mode
    await assert.rejects(
      workerClient.query(
        `INSERT INTO flow.payment_attempts (
           payment_request_id, attempt_public_id, payer_mode, source_network, source_asset_id,
           source_asset_symbol, source_decimals, route_type, route_status
         ) VALUES (
           (SELECT id FROM flow.payment_requests WHERE public_id = $1),
           'pa_invalid_mode_12345678901234', 'INVALID_MODE', 'solana-mainnet', 'solana-mainnet:SOL',
           'SOL', 9, 'CROSS_CHAIN_1CLICK', 'SUPPORTED_AND_QUOTABLE'
         )`,
        [victimActivePr],
      ),
      { code: "23514" }, // check constraint violation
    );

    // (b) Invalid attempt_public_id format
    await assert.rejects(
      workerClient.query(
        `INSERT INTO flow.payment_attempts (
           payment_request_id, attempt_public_id, payer_mode, source_network, source_asset_id,
           source_asset_symbol, source_decimals, route_type, route_status
         ) VALUES (
           (SELECT id FROM flow.payment_requests WHERE public_id = $1),
           'invalid_prefix_pa_12345678901', 'WALLET', 'solana-mainnet', 'solana-mainnet:SOL',
           'SOL', 9, 'CROSS_CHAIN_1CLICK', 'SUPPORTED_AND_QUOTABLE'
         )`,
        [victimActivePr],
      ),
      { code: "23514" },
    );

    // 5. Test Multi-Tenant RLS Isolation on flow.payment_attempts
    // Victim can select attempts for their own payment request
    await appClient.query("BEGIN");
    await appClient.query(
      `SELECT set_config('flow.current_session_token', $1, true)`,
      [victimSessionToken],
    );
    const victimAttempts = await appClient.query<{ attempt_public_id: string }>(
      `SELECT attempt_public_id FROM flow.payment_attempts`,
    );
    assert.equal(victimAttempts.rows.length, 1);
    assert.equal(victimAttempts.rows[0]!.attempt_public_id, validAttemptId);
    await appClient.query("ROLLBACK");

    // Attacker CANNOT see victim's payment attempts (RLS filters out)
    await appClient.query("BEGIN");
    await appClient.query(
      `SELECT set_config('flow.current_session_token', $1, true)`,
      [attackerSessionToken],
    );
    const attackerAttempts = await appClient.query(
      `SELECT * FROM flow.payment_attempts`,
    );
    assert.equal(attackerAttempts.rows.length, 0);

    // Attacker cannot select even by direct attempt_public_id
    const crossAttemptSelect = await appClient.query(
      `SELECT * FROM flow.payment_attempts WHERE attempt_public_id = $1`,
      [validAttemptId],
    );
    assert.equal(crossAttemptSelect.rows.length, 0);
    await appClient.query("ROLLBACK");

    // Unauthenticated query sees 0 rows
    const unauthAttempts = await appClient.query(
      `SELECT * FROM flow.payment_attempts`,
    );
    assert.equal(unauthAttempts.rows.length, 0);
  } finally {
    adminClient.release();
    workerClient.release();
    appClient.release();
  }
});

test("database integration: M5 Phase 3 quote integrity, unprivileged caller boundaries, and settlement idempotency", async () => {
  const adminClient = await pool.connect();
  const workerClient = await workerPool.connect();
  const appClient = await pool.connect();

  try {
    const owner = await createTestAccount(
      adminClient,
      "PERSONAL",
      "m5p3-db-owner",
    );
    const invoicePublicId = "pr_m5p3_integrity_test_invoice";

    await workerClient.query(
      `INSERT INTO flow.payment_requests (
         account_id, public_id, title, destination_network, destination_asset_id, destination_asset_symbol, destination_decimals, amount_mode, requested_atomic_amount, status
       ) VALUES ($1, $2, 'Integrity Test Invoice', 'base-mainnet', 'base-mainnet:USDC', 'USDC', 6, 'FIXED', 10000000, 'ACTIVE')`,
      [owner.accountId, invoicePublicId],
    );

    // 1. Record an unverified quote observation via record_public_payment_attempt
    const attemptPublicId1 = "pa_0123456789abcdef0123456789abcdef";
    const corrId1 = "corr-integrity-1";

    const rec = await appClient.query<{
      status: string;
      verification_tier: string;
      is_provider_verified: boolean;
    }>(
      `SELECT * FROM flow.record_public_payment_attempt(
         $1, $2, 'WALLET', NULL, 'solana-mainnet', 'solana-mainnet:SOL', 'SOL', 9,
         'CROSS_CHAIN_1CLICK', 'SUPPORTED_AND_QUOTABLE', 'EXACT_OUTPUT',
         116000000::decimal, 10000000::decimal, 22, '{"refundFee":"10000"}'::jsonb,
         $3, 'signature-forged-test', now() + interval '1 minute'
       )`,
      [invoicePublicId, attemptPublicId1, corrId1],
    );

    assert.equal(rec.rows[0]!.status, "QUOTE_OBSERVED");
    assert.equal(rec.rows[0]!.verification_tier, "UNVERIFIED_OBSERVATION");
    assert.equal(rec.rows[0]!.is_provider_verified, false);

    // 2. Adversarial Test: App-role caller cannot execute worker_verify_payment_attempt
    await assert.rejects(
      appClient.query(
        `SELECT * FROM flow.worker_verify_payment_attempt($1, $2)`,
        [attemptPublicId1, corrId1],
      ),
      { code: "42501" }, // permission denied for function worker_verify_payment_attempt
    );

    // 3. Adversarial Test: App role cannot manufacture SETTLED status or bypass constraint
    await assert.rejects(
      appClient.query(
        `UPDATE flow.payment_attempts SET status = 'SETTLED', is_provider_verified = true WHERE attempt_public_id = $1`,
        [attemptPublicId1],
      ),
      // Either 0 rows affected by RLS or check constraint
    );

    // Verify row remains unverified
    const checkRow = await workerClient.query<{
      status: string;
      verification_tier: string;
      is_provider_verified: boolean;
    }>(
      `SELECT status, verification_tier, is_provider_verified FROM flow.payment_attempts WHERE attempt_public_id = $1`,
      [attemptPublicId1],
    );
    assert.equal(checkRow.rows[0]!.status, "QUOTE_OBSERVED");
    assert.equal(checkRow.rows[0]!.verification_tier, "UNVERIFIED_OBSERVATION");
    assert.equal(checkRow.rows[0]!.is_provider_verified, false);

    // 4. Privileged worker verification succeeds
    const verified = await workerClient.query<{
      status: string;
      verification_tier: string;
      is_provider_verified: boolean;
    }>(`SELECT * FROM flow.worker_verify_payment_attempt($1, $2)`, [
      attemptPublicId1,
      corrId1,
    ]);
    assert.equal(verified.rows.length, 1);
    assert.equal(verified.rows[0]!.verification_tier, "PROVIDER_VERIFIED");
    assert.equal(verified.rows[0]!.is_provider_verified, true);

    // 5. Test Settlement Idempotency (Partial Unique Index)
    // Worker transitions attempt 1 to SETTLING
    await workerClient.query(
      `UPDATE flow.payment_attempts SET status = 'SETTLING' WHERE attempt_public_id = $1`,
      [attemptPublicId1],
    );

    // Create attempt 2 for the SAME payment request
    const attemptPublicId2 = "pa_fedcba9876543210fedcba9876543210";
    await workerClient.query(
      `INSERT INTO flow.payment_attempts (
         payment_request_id, attempt_public_id, payer_mode, source_network, source_asset_id,
         source_asset_symbol, source_decimals, route_type, route_status, status, verification_tier, is_provider_verified
       ) VALUES (
         (SELECT id FROM flow.payment_requests WHERE public_id = $1),
         $2, 'WALLET', 'solana-mainnet', 'solana-mainnet:SOL', 'SOL', 9,
         'CROSS_CHAIN_1CLICK', 'SUPPORTED_AND_QUOTABLE', 'QUOTE_OBSERVED', 'PROVIDER_VERIFIED', true
       )`,
      [invoicePublicId, attemptPublicId2],
    );

    // Attempting to set attempt 2 to SETTLED while attempt 1 is SETTLING MUST FAIL with unique constraint violation
    await assert.rejects(
      workerClient.query(
        `UPDATE flow.payment_attempts SET status = 'SETTLED' WHERE attempt_public_id = $1`,
        [attemptPublicId2],
      ),
      { code: "23505" }, // unique_violation on uq_payment_request_settled_attempt
    );
  } finally {
    adminClient.release();
    workerClient.release();
    appClient.release();
  }
});

test("database integration: M5 Phase 4 financial ledger double-entry, RLS isolation, and settlement lifecycle", async () => {
  const adminClient = await pool.connect();
  const workerClient = await workerPool.connect();
  const appClient = await pool.connect();

  try {
    // 1. Provision Test Tenant Account and legitimate session token
    const owner = await createTestAccount(
      adminClient,
      "PERSONAL",
      "m5p4-db-owner",
    );
    const tenantAccountId = owner.accountId;
    const sessionToken = await createTestSession(adminClient, owner.authUserId);

    // 2. Double-Entry Invariant Test: Unbalanced journal must fail
    const custodyAcctId = randomUUID();
    const merchantAcctId = randomUUID();

    await workerClient.query(
      `INSERT INTO flow.ledger_accounts (id, account_id, account_type, account_code, asset_id, network, decimals, balance_atomic)
       VALUES ($1, NULL, 'ASSET', 'ASSET_CUSTODY_IN_FLIGHT', 'usdc', 'base-mainnet', 6, 0)`,
      [custodyAcctId],
    );

    await workerClient.query(
      `INSERT INTO flow.ledger_accounts (id, account_id, account_type, account_code, asset_id, network, decimals, balance_atomic)
       VALUES ($1, $2, 'LIABILITY', 'LIABILITY_MERCHANT_PAYABLE', 'usdc', 'base-mainnet', 6, 0)`,
      [merchantAcctId, tenantAccountId],
    );

    const unbalancedEntries = JSON.stringify([
      {
        ledger_account_id: custodyAcctId,
        entry_direction: "DEBIT",
        amount_atomic: "10000000",
      },
      {
        ledger_account_id: merchantAcctId,
        entry_direction: "CREDIT",
        amount_atomic: "9000000",
      },
    ]);

    await assert.rejects(
      workerClient.query(
        `SELECT * FROM flow.post_balanced_ledger_journal('lj_test_unbalanced_01', 'PAYMENT_SETTLEMENT', 'ref_1', 'test unbalanced', $1::jsonb)`,
        [unbalancedEntries],
      ),
      /UNBALANCED_JOURNAL_ENTRY/,
    );

    // 3. Balanced Journal Posting Test
    const balancedEntries = JSON.stringify([
      {
        ledger_account_id: custodyAcctId,
        entry_direction: "DEBIT",
        amount_atomic: "10000000",
      },
      {
        ledger_account_id: merchantAcctId,
        entry_direction: "CREDIT",
        amount_atomic: "10000000",
      },
    ]);

    const postResult = await workerClient.query<{
      journal_id: string;
      journal_public_id: string;
      entry_count: number;
      total_atomic: string;
    }>(
      `SELECT * FROM flow.post_balanced_ledger_journal('lj_test_balanced_0001', 'PAYMENT_SETTLEMENT', 'ref_2', 'test balanced', $1::jsonb)`,
      [balancedEntries],
    );

    assert.equal(postResult.rows.length, 1);
    assert.equal(postResult.rows[0]!.entry_count, 2);
    assert.equal(postResult.rows[0]!.total_atomic, "10000000");

    // Verify balances updated correctly
    const custodyBal = await workerClient.query<{ balance_atomic: string }>(
      `SELECT balance_atomic FROM flow.ledger_accounts WHERE id = $1`,
      [custodyAcctId],
    );
    assert.equal(custodyBal.rows[0]!.balance_atomic, "10000000");

    const merchantBal = await workerClient.query<{ balance_atomic: string }>(
      `SELECT balance_atomic FROM flow.ledger_accounts WHERE id = $1`,
      [merchantAcctId],
    );
    assert.equal(merchantBal.rows[0]!.balance_atomic, "10000000");

    // 4. Row-Level Security: App client can only see their own tenant accounts
    await appClient.query(
      `SELECT set_config('flow.current_session_token', $1, false)`,
      [sessionToken],
    );

    const tenantVisibleAccounts = await appClient.query<{ id: string }>(
      `SELECT id FROM flow.ledger_accounts`,
    );
    assert.equal(tenantVisibleAccounts.rows.length, 1);
    assert.equal(tenantVisibleAccounts.rows[0]!.id, merchantAcctId);

    // System account is invisible to tenant
    const systemSearch = await appClient.query(
      `SELECT * FROM flow.ledger_accounts WHERE id = $1`,
      [custodyAcctId],
    );
    assert.equal(systemSearch.rows.length, 0);

    // 5. Payment Attempt Commit and Full Settlement Lifecycle
    const prPublicId = `pr_${randomUUID().replace(/-/g, "").slice(0, 24)}`;
    const attemptPublicId = `pa_${randomUUID().replace(/-/g, "").slice(0, 32)}`;

    await workerClient.query(
      `INSERT INTO flow.payment_requests (
        account_id, public_id, title, destination_network, destination_asset_id,
        destination_asset_symbol, destination_decimals, amount_mode, requested_atomic_amount, status
      ) VALUES (
        $1, $2, 'M5P4 Invoice', 'base-mainnet', 'base-mainnet:USDC', 'USDC', 6, 'FIXED', 25000000, 'ACTIVE'
      )`,
      [tenantAccountId, prPublicId],
    );

    await workerClient.query(
      `INSERT INTO flow.payment_attempts (
        payment_request_id, attempt_public_id, payer_mode, source_network, source_asset_id,
        source_asset_symbol, source_decimals, route_type, route_status, quoted_source_atomic_amount,
        quoted_destination_atomic_amount, status, quote_expires_at, verification_tier, is_provider_verified
      ) VALUES (
        (SELECT id FROM flow.payment_requests WHERE public_id = $1),
        $2, 'WALLET', 'ethereum-mainnet', 'ethereum-mainnet:USDC', 'USDC', 6,
        'CROSS_CHAIN_1CLICK', 'SUPPORTED_AND_QUOTABLE', 25000000, 25000000,
        'QUOTE_OBSERVED', CURRENT_TIMESTAMP + INTERVAL '10 minutes', 'PROVIDER_VERIFIED', true
      )`,
      [prPublicId, attemptPublicId],
    );

    // Commit payment attempt via stored procedure (callable by app role)
    const commitResult = await appClient.query<{
      status: string;
      deposit_address: string;
    }>(
      `SELECT * FROM flow.commit_payment_attempt($1, '0x1234567890123456789012345678901234567890', NULL, CURRENT_TIMESTAMP + INTERVAL '15 minutes', '{"qr": "eth"}'::jsonb)`,
      [attemptPublicId],
    );

    assert.equal(commitResult.rows.length, 1);
    assert.equal(commitResult.rows[0]!.status, "DEPOSIT_COMMITTED");
    assert.equal(
      commitResult.rows[0]!.deposit_address,
      "0x1234567890123456789012345678901234567890",
    );

    // Settle payment attempt via worker
    const settleResult = await workerClient.query<{
      status: string;
      journal_id: string;
      journal_public_id: string;
    }>(
      `SELECT * FROM flow.worker_settle_payment_attempt($1, '0xsource_tx_hash_1', '0xdest_tx_hash_1')`,
      [attemptPublicId],
    );

    assert.equal(settleResult.rows.length, 1);
    assert.equal(settleResult.rows[0]!.status, "SETTLED");
    assert.ok(settleResult.rows[0]!.journal_id);

    // Verify invoice status marked COMPLETED
    const updatedPr = await workerClient.query<{ status: string }>(
      `SELECT status::text FROM flow.payment_requests WHERE public_id = $1`,
      [prPublicId],
    );
    assert.equal(updatedPr.rows[0]!.status, "COMPLETED");
  } finally {
    adminClient.release();
    workerClient.release();
    appClient.release();
  }
});

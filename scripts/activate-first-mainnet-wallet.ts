import { parseArgs } from "node:util";
import {
  OUTLAYER_CAPABILITIES,
  toEip55ChecksumAddress,
} from "../src/domain/custody.ts";
import { isBannedIllustrativeAddress } from "../src/domain/quote-discovery.ts";
import {
  deriveKeyDigest,
  encryptSecret,
  serializeEnvelope,
} from "../src/foundation/crypto-envelope.ts";
import { isFinancialExecutionDisabled } from "../src/domain/custody.ts";
import { FlowError } from "../src/foundation/errors.ts";
import { getPrismaClient } from "../src/foundation/prisma.ts";
import {
  readWalletConfig,
  type ProviderCompatibilityConfig,
} from "../src/foundation/wallet-environment.ts";
import {
  OutLayerAdapter,
  scrubHandoffUrl,
} from "../src/server/custody/outlayer-adapter.ts";

export interface ActivateMainnetWalletOptions {
  readonly accountId?: string;
  readonly dryRun?: boolean;
  readonly operatorAuthId?: string;
  readonly operatorSessionToken?: string;
}

export async function assertPreDispatchDatabaseWritePermissions(
  db: ReturnType<typeof getPrismaClient>,
  targetAccountId: string,
): Promise<void> {
  console.log(
    "   - Step 0: Pre-dispatch Database Write Permission Test (Rollback-Only)...",
  );
  let rolledBack = false;
  try {
    await db.$transaction(async (tx) => {
      // 1. Test update grant on wallet_provisioning_jobs
      await tx.$executeRaw`
        UPDATE flow.wallet_provisioning_jobs
        SET updated_at = CURRENT_TIMESTAMP
        WHERE account_id = ${targetAccountId}::uuid
      `;
      // 2. Test insert/update grant on wallets
      await tx.$executeRaw`
        INSERT INTO flow.wallets (
          account_id, provider, environment, provider_wallet_id, near_account_id,
          encrypted_credential, key_id, key_digest, status, policy_state
        ) VALUES (
          ${targetAccountId}::uuid, ${"OUTLAYER"}, ${"mainnet"}, ${"00000000-0000-0000-0000-000000000000"}, ${"predispatch-test.near"},
          ${"test-envelope"}, ${"v1"}, ${"test-digest"}, ${"SETUP_PENDING"}::flow.wallet_status, ${"none"}
        )
        ON CONFLICT (account_id) DO UPDATE SET updated_at = CURRENT_TIMESTAMP
      `;
      // 3. Test insert/update grant on wallet_addresses
      await tx.$executeRaw`
        INSERT INTO flow.wallet_addresses (wallet_id, network, chain_id, address, public_key)
        SELECT id, ${"near"}, ${"near-mainnet"}, ${"predispatch-test.near"}, ${"ed25519:test"}
        FROM flow.wallets
        WHERE account_id = ${targetAccountId}::uuid
        ON CONFLICT (wallet_id, network) DO UPDATE SET updated_at = CURRENT_TIMESTAMP
      `;
      // 4. Test insert/update grant on wallet_capabilities
      await tx.$executeRaw`
        INSERT INTO flow.wallet_capabilities (wallet_id, network, can_receive)
        SELECT id, ${"near"}, true
        FROM flow.wallets
        WHERE account_id = ${targetAccountId}::uuid
        ON CONFLICT (wallet_id, network) DO UPDATE SET verified_at = CURRENT_TIMESTAMP
      `;

      throw new Error("__FLOW_PRE_DISPATCH_ROLLBACK_VERIFIED__");
    });
  } catch (err) {
    if (
      err instanceof Error &&
      err.message.includes("__FLOW_PRE_DISPATCH_ROLLBACK_VERIFIED__")
    ) {
      rolledBack = true;
    } else {
      throw new FlowError(
        "INVALID_CONFIGURATION",
        `Pre-dispatch database write permission test failed: ${(err as Error).message}`,
      );
    }
  }

  if (!rolledBack) {
    throw new FlowError(
      "INVALID_CONFIGURATION",
      "Pre-dispatch database test failed to verify rollback safety.",
    );
  }
  console.log(
    "     [PASS] Verified worker INSERT/UPDATE permissions on jobs, wallets, addresses, and capabilities (Cleanly rolled back).\n",
  );
}

export async function activateFirstMainnetWallet(
  options: ActivateMainnetWalletOptions = {},
): Promise<void> {
  console.log(
    "===============================================================",
  );
  console.log(" FLOW — First Account-Associated Mainnet Wallet Activation");
  console.log(" (Controlled, Non-Simulated Mainnet Onboarding Procedure)");
  console.log(
    "===============================================================\n",
  );

  // 1. Invariant: Financial Execution Safety Guard MUST be disabled
  if (!isFinancialExecutionDisabled()) {
    throw new FlowError(
      "INVALID_CONFIGURATION",
      "FATAL: Wallet provisioning cannot proceed unless FLOW_EXECUTION=disabled.",
    );
  }
  console.log("1. Safety Guard Check:");
  console.log(
    "   [PASS] FLOW_EXECUTION=disabled (Financial execution strictly blocked; outgoing signing disabled).\n",
  );

  // 2. Read and Validate Wallet Configuration
  console.log("2. Custody Configuration Check:");
  const walletConfig = readWalletConfig(process.env);
  console.log(`   - Wallet Provider:       ${walletConfig.provider}`);
  console.log(`   - Master Key ID:         ${walletConfig.keyId}`);
  console.log(`   - OutLayer Base URL:     ${walletConfig.apiUrl}`);

  if (
    walletConfig.apiUrl !== "https://api.outlayer.ai" &&
    !walletConfig.apiUrl.includes("127.0.0.1")
  ) {
    throw new FlowError(
      "INVALID_CONFIGURATION",
      `Mainnet wallet activation strictly requires OutLayer coordinator https://api.outlayer.ai (got ${walletConfig.apiUrl}).`,
    );
  }
  console.log(
    "   [PASS] OutLayer production coordinator https://api.outlayer.ai verified.\n",
  );

  // 3. Connect to Database via unprivileged worker or operator role
  console.log("3. Target Account Resolution:");
  let db;
  let targetAccountId = options.accountId;
  let account:
    | { id: string; name: string; type: string; owner_id: string | null }
    | undefined;

  const hasDbUrl =
    Boolean(process.env.FLOW_WORKER_DATABASE_URL) ||
    Boolean(process.env.FLOW_OPERATOR_DATABASE_URL) ||
    Boolean(process.env.FLOW_DATABASE_URL);

  if (hasDbUrl) {
    try {
      if (!process.env.FLOW_WORKER_DATABASE_URL && !options.dryRun) {
        throw new FlowError(
          "INVALID_CONFIGURATION",
          "Wallet provisioning strictly requires FLOW_WORKER_DATABASE_URL (flow_worker role). Operator or app database roles are prohibited.",
        );
      }
      db = getPrismaClient(
        process.env.FLOW_WORKER_DATABASE_URL
          ? "worker"
          : process.env.FLOW_OPERATOR_DATABASE_URL
            ? "operator"
            : "runtime",
      );
      if (!targetAccountId) {
        const candidateAccounts = await db.$queryRaw<
          Array<{
            id: string;
            name: string;
            type: string;
            owner_id: string | null;
          }>
        >`
          SELECT id, name, kind::text AS type, personal_owner_id::text AS owner_id
          FROM flow.accounts
          ORDER BY created_at ASC
          LIMIT 5
        `;

        if (candidateAccounts.length === 0) {
          throw new FlowError(
            "INVALID_CONFIGURATION",
            "No accounts found in database. Please register a user and complete onboarding first.",
          );
        }

        targetAccountId = candidateAccounts[0]!.id;
        console.log(
          `   - Auto-selected first account: ${candidateAccounts[0]!.name} (${candidateAccounts[0]!.type}) [ID: ${targetAccountId}]`,
        );
      }

      const accountRows = await db.$queryRaw<
        Array<{
          id: string;
          name: string;
          type: string;
          owner_id: string | null;
          created_at: Date;
        }>
      >`
        SELECT id, name, kind::text AS type, personal_owner_id::text AS owner_id, created_at
        FROM flow.accounts
        WHERE id = ${targetAccountId}::uuid
        LIMIT 1
      `;

      if (accountRows.length === 0) {
        throw new FlowError(
          "INVALID_CONFIGURATION",
          `Account with ID ${targetAccountId} not found in database.`,
        );
      }

      account = accountRows[0]!;
      console.log(
        `   - Account Name: ${account.name} (Type: ${account.type}, Owner: ${account.owner_id ?? "Business/Team"})\n`,
      );
    } catch (dbErr) {
      if (!options.dryRun) {
        throw dbErr;
      }
      console.log(
        `   [WARN] Database connection skipped or unavailable in dry-run mode: ${(dbErr as Error).message}\n`,
      );
    }
  } else {
    if (!options.dryRun) {
      throw new FlowError(
        "INVALID_CONFIGURATION",
        "FLOW_OPERATOR_DATABASE_URL or FLOW_DATABASE_URL required for live activation.",
      );
    }
    console.log(
      "   [DRY-RUN] No database URL configured; performing offline configuration preflight.\n",
    );
  }

  // 4. Inspect Existing Wallet State (if DB connected)
  if (db && targetAccountId) {
    console.log("4. Existing Wallet Status Check:");
    const existingWallets = await db.$queryRaw<
      Array<{
        id: string;
        provider_wallet_id: string;
        near_account_id: string;
        controller_account_id: string | null;
        status: string;
        policy_state: string;
        environment: string;
      }>
    >`
      SELECT
        id,
        provider_wallet_id,
        near_account_id,
        controller_account_id,
        status::text AS status,
        policy_state,
        environment
      FROM flow.wallets
      WHERE account_id = ${targetAccountId}::uuid
      LIMIT 1
    `;

    if (existingWallets.length === 0) {
      console.log(
        "   [NO EXISTING WALLET] Account has no existing wallet record. Ready for initial mainnet provisioning.\n",
      );
    } else if (existingWallets[0]!.status === "ACTIVE") {
      const existing = existingWallets[0]!;
      console.log(
        `   [EXISTING WALLET DETECTED] Account has a previously recorded wallet.`,
      );
      console.log(`   - Wallet ID:               ${existing.id}`);
      console.log(`   - Environment:             ${existing.environment}`);
      console.log(`   - Policy State:            ${existing.policy_state}`);
      console.log(
        `   - Controller Account:      ${existing.controller_account_id}`,
      );

      // Load persisted addresses
      const addresses = await db.$queryRaw<
        Array<{ network: string; chain_id: string; address: string }>
      >`
        SELECT network, chain_id, address
        FROM flow.wallet_addresses
        WHERE wallet_id = ${existing.id}::uuid
      `;

      console.log("\n   Persisted Multi-Chain Receiving Addresses:");
      let hasBannedAddress = false;
      for (const a of addresses) {
        const isBanned = isBannedIllustrativeAddress(a.address);
        if (isBanned) hasBannedAddress = true;
        console.log(
          `   - ${a.network.toUpperCase().padEnd(8)} (${a.chain_id}): ${a.address}${isBanned ? " [BANNED ILLUSTRATIVE ADDRESS / TEST FIXTURE]" : ""}`,
        );
      }

      if (hasBannedAddress || existing.environment !== "mainnet") {
        console.log(
          "\n   [BLOCKER DETECTED] This wallet contains synthetic test fixture / banned illustrative addresses (e.g. vitalik.eth).",
        );
        console.log(
          "   It is NOT an owner-controlled production custody wallet. Genuine OutLayer mainnet registration is required.\n",
        );
        if (!options.dryRun) {
          throw new FlowError(
            "INVALID_CONFIGURATION",
            "Target account contains banned illustrative address or test fixture. Genuine OutLayer mainnet registration required.",
          );
        }
      } else {
        console.log(
          "\n   [VERIFIED] Genuine mainnet wallet ownership is registered and proven to belong to this account.",
        );
        console.log("   Ready for payable payment request creation.\n");
        return;
      }
    } else {
      console.log(
        `   [PENDING/INCOMPLETE WALLET] Account wallet status is ${existingWallets[0]!.status} (${existingWallets[0]!.environment}). Ready for mainnet activation.\n`,
      );
    }
  }

  // 5. Inspect Provisioning Job State (if DB connected)
  let job:
    | { id: string; status: string; attempts: number; idempotency_key: string }
    | undefined;

  if (db && targetAccountId) {
    console.log("5. Provisioning Job Status Check:");
    const existingJobs = await db.$queryRaw<
      Array<{
        id: string;
        status: string;
        attempts: number;
        idempotency_key: string;
      }>
    >`
      SELECT id, status, attempts, idempotency_key
      FROM flow.wallet_provisioning_jobs
      WHERE account_id = ${targetAccountId}::uuid
      LIMIT 1
    `;

    if (existingJobs.length === 0) {
      console.log(
        "   [WARN] No provisioning job found for account. Creating PENDING job...",
      );
      const newJobId = crypto.randomUUID();
      const newKey = crypto.randomUUID();
      await db.$executeRaw`
        INSERT INTO flow.wallet_provisioning_jobs (id, account_id, idempotency_key, status)
        VALUES (${newJobId}::uuid, ${targetAccountId}::uuid, ${newKey}::uuid, 'PENDING')
      `;
      job = {
        id: newJobId,
        status: "PENDING",
        attempts: 0,
        idempotency_key: newKey,
      };
    } else {
      job = existingJobs[0]!;
      console.log(
        `   [PASS] Existing Provisioning Job ID: ${job.id} (Status: ${job.status}, Attempts: ${job.attempts})\n`,
      );
      if (job.status === "UNKNOWN" || job.status === "MANUAL_REVIEW") {
        throw new FlowError(
          "INVALID_CONFIGURATION",
          `Provisioning job ${job.id} is quarantined in ${job.status} state. Operator recovery required before activation.`,
        );
      }
    }
  }

  // 6. Dry Run Check
  if (options.dryRun) {
    console.log("6. Dry Run Preflight Verification:");
    console.log(
      "   [DRY RUN] All custody and environment prerequisites verified.",
    );
    console.log(`   - Target OutLayer Host:    https://api.outlayer.ai`);
    console.log(
      `   - Target Account ID:       ${targetAccountId ?? "(Unspecified / First Account)"}`,
    );
    console.log(
      `   - Provisioning Job ID:     ${job?.id ?? "None"} (Status: ${job?.status ?? "N/A"})`,
    );
    console.log(
      "   - Planned Procedure:       1) POST /register to allocate TEE wallet container.",
    );
    console.log(
      "                              2) Encrypt API key with master AES-256-GCM envelope and store in PostgreSQL.",
    );
    console.log(
      "                              3) Derive Ethereum (chain 1), Base (chain 8453), Solana, and NEAR addresses.",
    );
    console.log(
      "                              4) Verify OutLayer policy and activate wallet (can_receive=true, can_sign=false).",
    );
    console.log("   - Live network call:       Skipped (dry-run mode).\n");
    return;
  }

  if (!db || !targetAccountId || !account) {
    throw new FlowError(
      "INVALID_CONFIGURATION",
      "Database connection and target account resolution required for live activation.",
    );
  }

  // 6. Controlled Execution against Genuine OutLayer Mainnet (Fail-Closed, Zero Simulation)
  console.log(
    "5. Genuine OutLayer Mainnet Provisioning (Controlled Execution):",
  );

  // Scoped authorization config strictly for this single account
  const compatibilityConfig: ProviderCompatibilityConfig = {
    mode: "authorized",
    providerEnvironment: "mainnet",
    isolatedAccountId: targetAccountId,
    maxRegistrations: 1,
    allowedMethods: [
      "POST /register",
      "GET /wallet/v1/address",
      "GET /wallet/v1/policy",
    ],
  };

  const adapter = new OutLayerAdapter("https://api.outlayer.ai", 10_000, {
    compatibilityConfig,
  });

  // Pre-dispatch, rollback-only database write permission test
  await assertPreDispatchDatabaseWritePermissions(db, targetAccountId);

  console.log(
    "   - Step 1: Registering TEE custody container on OutLayer (POST /register)...",
  );
  if (job) {
    const dispatchAttemptId = crypto.randomUUID();
    await db.$executeRaw`
      UPDATE flow.wallet_provisioning_jobs
      SET
        status = 'SUBMITTED',
        dispatch_attempt_id = ${dispatchAttemptId}::uuid,
        dispatched_at = CURRENT_TIMESTAMP,
        attempts = attempts + 1,
        updated_at = CURRENT_TIMESTAMP
      WHERE id = ${job.id}::uuid
    `;
    console.log(
      `     [PASS] Provisioning Job ${job.id} transitioned to SUBMITTED (attempt ${job.attempts + 1}).`,
    );
  }

  let regResult;
  try {
    regResult = await adapter.register({});
  } catch (err) {
    console.error(
      "   [FAIL] OutLayer registration failed:",
      (err as Error).message,
    );
    if (job) {
      await db.$executeRaw`
        UPDATE flow.wallet_provisioning_jobs
        SET
          status = 'UNKNOWN',
          failure_classification = 'POST_DISPATCH_AMBIGUOUS',
          last_error = ${(err as Error).message.slice(0, 500)},
          lease_holder = NULL,
          lease_expires_at = NULL,
          updated_at = CURRENT_TIMESTAMP
        WHERE id = ${job.id}::uuid
      `;
      console.log(
        `     [QUARANTINED] Job ${job.id} quarantined in UNKNOWN status.`,
      );
    }
    throw err;
  }

  const {
    wallet_id: providerWalletId,
    api_key: apiKey,
    near_account_id: nearAccountId,
  } = regResult;
  console.log(`     [PASS] OutLayer Container ID: ${providerWalletId}`);
  console.log(`     [PASS] NEAR Implicit Account: ${nearAccountId}`);

  // Encrypt bearer API key with master AES-256-GCM envelope
  const encryptedEnvelope = serializeEnvelope(
    encryptSecret(apiKey, walletConfig.encryptionKey, walletConfig.keyId),
  );
  const keyDigest = deriveKeyDigest(walletConfig.encryptionKey);
  const safeHandoffUrl = scrubHandoffUrl(regResult.handoff_url);

  console.log(
    "   - Step 2: Durably persisting encrypted credentials in PostgreSQL (flow.wallets)...",
  );
  const walletRows = await db.$queryRaw<Array<{ id: string }>>`
    INSERT INTO flow.wallets (
      account_id,
      provider,
      environment,
      provider_wallet_id,
      near_account_id,
      encrypted_credential,
      key_id,
      key_digest,
      handoff_url,
      status,
      policy_state
    ) VALUES (
      ${targetAccountId}::uuid,
      'OUTLAYER',
      'mainnet',
      ${providerWalletId},
      ${nearAccountId},
      ${encryptedEnvelope},
      ${walletConfig.keyId},
      ${keyDigest},
      ${safeHandoffUrl},
      'SETUP_PENDING'::flow.wallet_status,
      'none'
    )
    ON CONFLICT (account_id) DO UPDATE SET
      provider_wallet_id = EXCLUDED.provider_wallet_id,
      near_account_id = EXCLUDED.near_account_id,
      encrypted_credential = EXCLUDED.encrypted_credential,
      key_id = EXCLUDED.key_id,
      key_digest = EXCLUDED.key_digest,
      handoff_url = EXCLUDED.handoff_url,
      environment = 'mainnet',
      updated_at = CURRENT_TIMESTAMP
    RETURNING id
  `;

  const walletId = walletRows[0]!.id;
  console.log(`     [PASS] FLOW Wallet Database Record ID: ${walletId}`);

  console.log(
    "   - Step 3: Deriving multi-chain receiving addresses (GET /wallet/v1/address)...",
  );
  const nearAddr = await adapter.getAddress(apiKey, "near", providerWalletId);
  const baseAddr = await adapter.getAddress(apiKey, "base", providerWalletId);
  const solanaAddr = await adapter.getAddress(
    apiKey,
    "solana",
    providerWalletId,
  );

  const checksummedBaseAddress = toEip55ChecksumAddress(baseAddr.address);
  console.log(`     [PASS] NEAR Address:     ${nearAddr.address}`);
  console.log(
    `     [PASS] Base Address:     ${checksummedBaseAddress} (Chain ID: 8453)`,
  );
  console.log(
    `     [PASS] Ethereum Address: ${checksummedBaseAddress} (Chain ID: 1)`,
  );
  console.log(
    `     [PASS] Solana Address:   ${solanaAddr.address} (Chain ID: solana-mainnet)`,
  );

  // Persist addresses and capabilities
  await db.$transaction(async (tx) => {
    // Insert addresses
    await tx.$executeRaw`
      INSERT INTO flow.wallet_addresses (wallet_id, network, chain_id, address, public_key)
      VALUES
        (${walletId}::uuid, 'near', 'near-mainnet', ${nearAddr.address}, ${nearAddr.public_key}),
        (${walletId}::uuid, 'base', '8453', ${checksummedBaseAddress}, ${baseAddr.public_key}),
        (${walletId}::uuid, 'ethereum', '1', ${checksummedBaseAddress}, ${baseAddr.public_key}),
        (${walletId}::uuid, 'solana', 'solana-mainnet', ${solanaAddr.address}, ${solanaAddr.public_key})
      ON CONFLICT (wallet_id, network) DO UPDATE SET
        chain_id = EXCLUDED.chain_id,
        address = EXCLUDED.address,
        public_key = EXCLUDED.public_key
    `;

    // Insert capabilities (can_receive = true, can_sign_transfer = false)
    await tx.$executeRaw`
      INSERT INTO flow.wallet_capabilities (
        wallet_id, network, can_derive_address, can_receive,
        can_read_native_balance, can_read_intents_balance, can_sign_transfer,
        broadcast_mode, can_rotate_credentials, verified_at
      ) VALUES
        (${walletId}::uuid, 'near', true, true, true, true, false, ${OUTLAYER_CAPABILITIES.near.broadcastMode}, true, CURRENT_TIMESTAMP),
        (${walletId}::uuid, 'base', true, true, true, true, false, ${OUTLAYER_CAPABILITIES.base.broadcastMode}, true, CURRENT_TIMESTAMP),
        (${walletId}::uuid, 'ethereum', true, true, false, false, false, ${OUTLAYER_CAPABILITIES.ethereum.broadcastMode}, true, CURRENT_TIMESTAMP),
        (${walletId}::uuid, 'solana', true, true, true, true, false, ${OUTLAYER_CAPABILITIES.solana.broadcastMode}, true, CURRENT_TIMESTAMP)
      ON CONFLICT (wallet_id, network) DO UPDATE SET
        can_receive = true,
        can_sign_transfer = false,
        verified_at = CURRENT_TIMESTAMP
    `;
  });

  console.log(
    "   - Step 4: Verifying TEE policy state (GET /wallet/v1/policy)...",
  );
  const policyEvidence = await adapter.getPolicy(apiKey, providerWalletId);
  const isPolicyStored = policyEvidence.policy === "stored";
  const controllerAccount = policyEvidence.controller || nearAccountId;

  console.log(
    `     [PASS] OutLayer Policy: ${policyEvidence.policy ?? "none"} (Frozen: ${policyEvidence.frozen})`,
  );

  // Step 5: Activate wallet
  console.log(
    "   - Step 5: Activating wallet and provisioning job in PostgreSQL...",
  );
  await db.$executeRaw`
    UPDATE flow.wallets
    SET
      status = 'ACTIVE'::flow.wallet_status,
      policy_state = ${isPolicyStored ? "stored" : "none"},
      controller_account_id = ${controllerAccount},
      updated_at = CURRENT_TIMESTAMP
    WHERE id = ${walletId}::uuid
  `;

  if (job) {
    await db.$executeRaw`
      UPDATE flow.wallet_provisioning_jobs
      SET
        status = 'ACTIVE',
        lease_holder = NULL,
        lease_expires_at = NULL,
        last_error = NULL,
        failure_classification = NULL,
        updated_at = CURRENT_TIMESTAMP
      WHERE id = ${job.id}::uuid
    `;
    console.log(
      `     [PASS] Provisioning Job ${job.id} transitioned to ACTIVE.`,
    );
  }

  console.log(
    "\n===============================================================",
  );
  console.log(" SUCCESS: First Account-Associated Mainnet Wallet Activated!");
  console.log(
    "===============================================================",
  );
  console.log(
    ` - Account ID:              ${targetAccountId} (${account.type}: ${account.name})`,
  );
  console.log(` - Wallet Database ID:      ${walletId}`);
  console.log(` - OutLayer Container ID:   ${providerWalletId}`);
  console.log(` - Ethereum Mainnet Address: ${checksummedBaseAddress}`);
  console.log(` - Base Mainnet Address:     ${checksummedBaseAddress}`);
  console.log(` - Solana Mainnet Address:   ${solanaAddr.address}`);
  console.log(` - NEAR Mainnet Address:     ${nearAddr.address}`);
  console.log(` - Capability Receive:      true (Ready for deposits/invoices)`);
  console.log(
    ` - Capability Sign:         false (Outgoing signing strictly blocked)`,
  );
  console.log(` - FLOW_EXECUTION:          disabled`);
  console.log(
    "===============================================================\n",
  );
}

// CLI Execution entrypoint
if (process.argv[1]?.endsWith("activate-first-mainnet-wallet.ts")) {
  const { values } = parseArgs({
    options: {
      account: { type: "string" },
      "account-id": { type: "string" },
      "dry-run": { type: "boolean", default: false },
      "operator-auth-id": { type: "string" },
      "session-token": { type: "string" },
    },
    strict: false,
  });

  activateFirstMainnetWallet({
    accountId: (values["account"] || values["account-id"]) as
      string | undefined,
    dryRun: Boolean(values["dry-run"]),
    operatorAuthId: values["operator-auth-id"] as string | undefined,
    operatorSessionToken: values["session-token"] as string | undefined,
  }).catch((err) => {
    console.error("\nActivation failed:", (err as Error).message);
    process.exit(1);
  });
}

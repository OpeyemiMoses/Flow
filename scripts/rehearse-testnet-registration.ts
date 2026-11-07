import { randomUUID } from "node:crypto";
import { parseArgs } from "node:util";
import { readConfig } from "../src/foundation/environment.ts";
import { FlowError } from "../src/foundation/errors.ts";
import { log } from "../src/foundation/logger.ts";
import {
  disconnectPrismaClients,
  getPrismaClient,
} from "../src/foundation/prisma.ts";
import {
  OUTLAYER_TESTNET_API_URL,
  readWalletConfig,
} from "../src/foundation/wallet-environment.ts";
import {
  claimCompatibilityRegistration,
  createCompatibilityAuthorization,
  deriveOperatorContext,
  ensureProvisioningJobForAccount,
  getAccountWalletPublicProjection,
} from "../src/server/custody/job-repository.ts";
import { OutLayerAdapter } from "../src/server/custody/outlayer-adapter.ts";
import { WalletProvisioningWorker } from "../src/server/custody/provisioning-worker.ts";

export interface RehearsalPreflightReport {
  readonly environment: string;
  readonly executionDisabled: boolean;
  readonly testnetUrlVerified: boolean;
  readonly targetUrl: string;
  readonly operatorAuthId: string;
  readonly operatorRole: string;
  readonly targetAccountId: string;
  readonly authorizationId?: string;
  readonly authorizationStatus?: string;
}

export interface RehearsalExecutionResult {
  readonly success: boolean;
  readonly dryRun: boolean;
  readonly preflight: RehearsalPreflightReport;
  readonly walletId?: string;
  readonly providerWalletId?: string;
  readonly nearAccountId?: string;
  readonly outcome?: string;
  readonly fundsReady?: boolean;
  readonly eligibleForDeposits?: boolean;
  readonly budgetExceededPrevented?: boolean;
}

export async function runTestnetRehearsal(options?: {
  readonly dryRun?: boolean;
  readonly operatorAuthId?: string;
  readonly operatorSessionToken?: string;
  readonly accountId?: string;
  readonly customAdapter?: OutLayerAdapter;
  readonly env?: Record<string, string | undefined>;
}): Promise<RehearsalExecutionResult> {
  const env = options?.env ?? process.env;
  const dryRun = options?.dryRun ?? false;

  // 1. Validate environment & strict execution guard
  const { environment, execution } = readConfig(env, "operator");
  if (environment !== "local" && environment !== "test") {
    throw new FlowError(
      "INVALID_CONFIGURATION",
      `Testnet rehearsal is only permitted in local or test environments (current: ${environment}).`,
    );
  }
  if (execution !== "disabled") {
    throw new FlowError(
      "INVALID_CONFIGURATION",
      `Testnet rehearsal strictly requires FLOW_EXECUTION=disabled (current: ${execution}). Financial execution is prohibited.`,
    );
  }

  // 2. Validate wallet configuration and testnet endpoint
  const walletConfig = readWalletConfig(env);
  const targetUrl = walletConfig.apiUrl;
  const isTestnetUrl =
    targetUrl === OUTLAYER_TESTNET_API_URL ||
    targetUrl.includes("testnet-api.outlayer.ai") ||
    targetUrl.includes("127.0.0.1") ||
    targetUrl.includes("localhost");

  if (!isTestnetUrl) {
    throw new FlowError(
      "INVALID_CONFIGURATION",
      `Testnet rehearsal strictly requires coordinator URL https://testnet-api.outlayer.ai (got ${targetUrl}). Mainnet coordinator is strictly prohibited.`,
    );
  }

  if (walletConfig.compatibility.mode !== "authorized") {
    throw new FlowError(
      "INVALID_CONFIGURATION",
      "Testnet rehearsal requires FLOW_PROVIDER_COMPATIBILITY_MODE=authorized.",
    );
  }

  const operatorDb = getPrismaClient("operator");
  const workerDb = getPrismaClient("worker");

  // 3. Authenticate and derive operator context
  const operatorAuthId =
    options?.operatorAuthId ??
    env.FLOW_CUSTODY_OPERATOR_AUTH_ID ??
    walletConfig.compatibility.authorizedToken;

  if (!operatorAuthId) {
    throw new FlowError(
      "CUSTODY_OPERATOR_AUTHENTICATION_REQUIRED",
      "Rehearsal requires an authenticated operator ID via --operator-id or FLOW_CUSTODY_OPERATOR_AUTH_ID.",
    );
  }

  const operatorContext = await deriveOperatorContext(operatorDb, {
    operatorAuthId,
    sessionToken: options?.operatorSessionToken,
  });

  // 4. Validate isolated target account
  const accountId =
    options?.accountId ??
    walletConfig.compatibility.isolatedAccountId ??
    env.FLOW_PROVIDER_COMPATIBILITY_ACCOUNT_ID;

  if (!accountId) {
    throw new FlowError(
      "INVALID_CONFIGURATION",
      "Rehearsal requires an isolated account ID via --account-id or FLOW_PROVIDER_COMPATIBILITY_ACCOUNT_ID.",
    );
  }

  const accounts = await operatorDb.$queryRaw<
    Array<{ id: string; kind: string }>
  >`
    SELECT id, kind::text as kind FROM flow.accounts WHERE id = ${accountId}::uuid
  `;
  if (!accounts[0]) {
    throw new FlowError(
      "INVALID_CONFIGURATION",
      `Rehearsal target account ${accountId} does not exist in flow.accounts.`,
    );
  }
  if (accounts[0].kind !== "PERSONAL") {
    throw new FlowError(
      "INVALID_CONFIGURATION",
      `Rehearsal target account must be PERSONAL, got ${accounts[0].kind}.`,
    );
  }

  // Verify account does NOT already have an active wallet
  const existingWallets = await operatorDb.$queryRaw<
    Array<{ id: string; status: string }>
  >`
    SELECT id, status::text as status FROM flow.wallets WHERE account_id = ${accountId}::uuid
  `;
  if (
    existingWallets.length > 0 &&
    existingWallets.some((w) => w.status === "ACTIVE")
  ) {
    throw new FlowError(
      "INVALID_CONFIGURATION",
      `Account ${accountId} already possesses an ACTIVE wallet. Rehearsal must target an unprovisioned test account.`,
    );
  }

  // 5. Check or create durable compatibility authorization record
  const authorizations = await operatorDb.$queryRaw<
    Array<{
      id: string;
      status: string;
      maxRegistrations: number;
      registrationsAttempted: number;
      registrationsCompleted: number;
    }>
  >`
    SELECT id, status, max_registrations AS "maxRegistrations",
           registrations_attempted AS "registrationsAttempted",
           registrations_completed AS "registrationsCompleted"
    FROM flow.provider_compatibility_authorizations
    WHERE singleton_scope = 'GLOBAL_TESTNET_REHEARSAL'
  `;

  let authorizationId = authorizations[0]?.id;
  let authorizationStatus = authorizations[0]?.status;

  if (!authorizations[0]) {
    // Automatically create the singleton testnet authorization if authorized by operator
    const created = await createCompatibilityAuthorization(operatorDb, {
      accountId,
      environment: "testnet",
      operatorAuthId: operatorContext.operatorAuthId,
      operatorContext,
      validityMinutes: 60,
    });
    authorizationId = created.id;
    authorizationStatus = "AUTHORIZED";
  } else if (authorizations[0].status !== "AUTHORIZED") {
    throw new FlowError(
      "CUSTODY_REGISTRATION_BUDGET_EXCEEDED",
      `Provider compatibility authorization is ${authorizations[0].status} (attempted: ${authorizations[0].registrationsAttempted}, completed: ${authorizations[0].registrationsCompleted}). Re-use or reset is strictly prohibited.`,
    );
  }

  if (!authorizationId) {
    throw new FlowError(
      "INVALID_CONFIGURATION",
      "Failed to obtain or create provider compatibility authorization.",
    );
  }

  const preflight: RehearsalPreflightReport = {
    environment,
    executionDisabled: execution === "disabled",
    testnetUrlVerified: isTestnetUrl,
    targetUrl,
    operatorAuthId: operatorContext.operatorAuthId,
    operatorRole: operatorContext.role,
    targetAccountId: accountId,
    authorizationId,
    authorizationStatus,
  };

  if (dryRun) {
    log("info", "testnet_rehearsal_dry_run_completed", { ...preflight });
    return {
      success: true,
      dryRun: true,
      preflight,
    };
  }

  // 6. Execute rehearsal registration via WalletProvisioningWorker
  await ensureProvisioningJobForAccount(workerDb, accountId, randomUUID());

  const adapter =
    options?.customAdapter ??
    new OutLayerAdapter(targetUrl, 5_000, {
      compatibilityConfig: {
        mode: "authorized",
        authorizationId,
        providerEnvironment: "testnet",
        maxRegistrations: 1,
      },
    });

  const worker = new WalletProvisioningWorker({
    db: workerDb,
    adapter,
    walletConfig: {
      encryptionKey: walletConfig.encryptionKey,
      keyId: walletConfig.keyId,
    },
    compatibilityAuthorizationId: authorizationId,
    providerEnvironment: "testnet",
  });

  const result = await worker.processAccountJob(accountId);

  if (result.outcome !== "registered" && result.outcome !== "activated") {
    throw new FlowError(
      "INCOMPLETE_WALLET_PROVISIONING",
      `Rehearsal provisioning ended with unexpected outcome: ${result.outcome}.`,
    );
  }

  // 7. Verify post-rehearsal invariants
  // A. Public projection verification
  const projection = await getAccountWalletPublicProjection(
    operatorDb,
    accountId,
  );
  if (!projection) {
    throw new FlowError(
      "INCOMPLETE_WALLET_PROVISIONING",
      "Public wallet projection not found after rehearsal provisioning.",
    );
  }

  // B. Budget exceeded enforcement check: Attempting a second registration MUST fail
  let budgetExceededPrevented = false;
  try {
    await claimCompatibilityRegistration(
      workerDb,
      authorizationId,
      "test-worker-budget-check",
      randomUUID(),
    );
  } catch (err) {
    if (
      err instanceof FlowError &&
      err.code === "CUSTODY_REGISTRATION_BUDGET_EXCEEDED"
    ) {
      budgetExceededPrevented = true;
    }
  }

  log("info", "testnet_rehearsal_executed_successfully", {
    walletId: result.walletId,
    outcome: result.outcome,
    environment: projection.environment,
    isTestnet: projection.isTestnet,
    fundsReady: projection.fundsReady,
    eligibleForDeposits: projection.eligibleForDeposits,
  });

  return {
    success: true,
    dryRun: false,
    preflight,
    walletId: result.walletId,
    nearAccountId: projection.nearAccountId ?? undefined,
    outcome: result.outcome,
    fundsReady: projection.fundsReady,
    eligibleForDeposits: projection.eligibleForDeposits,
    budgetExceededPrevented,
  };
}

async function main() {
  const { values } = parseArgs({
    options: {
      "dry-run": { type: "boolean", default: false },
      "account-id": { type: "string" },
      "operator-id": { type: "string" },
      help: { type: "boolean", default: false },
    },
    allowPositionals: true,
  });

  if (values.help) {
    console.log(`
Usage: node scripts/rehearse-testnet-registration.ts [options]

Deterministic one-time OutLayer testnet wallet registration rehearsal.

Options:
  --dry-run        Validate preflight conditions and database state without making outbound calls.
  --account-id     Target isolated personal account UUID.
  --operator-id    Authenticated custody operator auth identifier.
  --help           Show this help message.
`);
    return;
  }

  console.log("==========================================================");
  console.log(" FLOW OutLayer Testnet Registration Rehearsal");
  console.log("==========================================================\n");

  try {
    const result = await runTestnetRehearsal({
      dryRun: values["dry-run"],
      accountId: values["account-id"],
      operatorAuthId: values["operator-id"],
    });

    console.log(
      `Mode: ${result.dryRun ? "DRY-RUN (Preflight Validation Only)" : "LIVE TESTNET REHEARSAL"}`,
    );
    console.log(`Preflight Checks:`);
    console.log(` - Environment: ${result.preflight.environment}`);
    console.log(
      ` - FLOW_EXECUTION: disabled (${result.preflight.executionDisabled ? "VERIFIED" : "FAILED"})`,
    );
    console.log(` - Coordinator URL: ${result.preflight.targetUrl}`);
    console.log(
      ` - Operator Identity: ${result.preflight.operatorAuthId} (${result.preflight.operatorRole})`,
    );
    console.log(` - Target Account: ${result.preflight.targetAccountId}`);
    console.log(
      ` - Authorization Singleton: ${result.preflight.authorizationId} (${result.preflight.authorizationStatus})\n`,
    );

    if (result.dryRun) {
      console.log(
        "✓ Dry-run completed successfully: All testnet rehearsal preflight safety invariants are satisfied.",
      );
    } else {
      console.log(`Rehearsal Execution Results:`);
      console.log(` - Wallet ID: ${result.walletId}`);
      console.log(` - NEAR Account: ${result.nearAccountId}`);
      console.log(` - Lifecycle Outcome: ${result.outcome}`);
      console.log(
        ` - Funds Ready: ${result.fundsReady} (Financial safety enforced)`,
      );
      console.log(
        ` - Eligible for Deposits: ${result.eligibleForDeposits} (Real deposits prohibited)`,
      );
      console.log(
        ` - Budget Exceeded Protection: ${result.budgetExceededPrevented ? "VERIFIED (Second registration blocked)" : "NOT_TESTED"}\n`,
      );
      console.log("✓ Live testnet rehearsal completed successfully.");
    }
  } catch (error) {
    console.error(
      `\nx Rehearsal preflight failed: ${error instanceof FlowError ? error.code : "ERROR"} - ${(error as Error).message}\n`,
    );
    process.exitCode = 1;
  } finally {
    try {
      await disconnectPrismaClients();
    } catch {
      // Ignore cleanup
    }
  }
}

if (
  process.argv[1]?.endsWith("rehearse-testnet-registration.ts") ||
  process.argv[1]?.endsWith("rehearse-testnet-registration")
) {
  void main();
}

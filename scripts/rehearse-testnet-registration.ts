import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
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
  type AuthenticatedOperatorContext,
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
  readonly operatorAuthenticated: boolean;
  readonly targetAccountId: string;
  readonly targetAccountClean: boolean;
  readonly authorizationId?: string;
  readonly authorizationStatus?: string;
  readonly authorizationValid?: boolean;
  readonly prerequisitesSatisfied: boolean;
  readonly missingPrerequisites: readonly string[];
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

export interface RunTestnetRehearsalOptions {
  readonly dryRun?: boolean;
  readonly accountId?: string;
  readonly operatorAuthId?: string;
  readonly operatorSessionToken?: string;
  readonly operatorSessionTokenFile?: string;
  readonly trustedExecutionKey?: string;
  readonly customAdapter?: OutLayerAdapter;
  readonly offlineTestMode?: boolean;
  readonly env?: Record<string, string | undefined>;
}

export function resolveOperatorProof(
  env: Record<string, string | undefined>,
  options?: {
    readonly operatorSessionToken?: string;
    readonly operatorSessionTokenFile?: string;
    readonly trustedExecutionKey?: string;
  },
): {
  sessionToken?: string;
  trustedExecutionKey?: string;
} {
  // 1. Explicit option passed programmatically or via CLI
  if (
    options?.operatorSessionToken &&
    options.operatorSessionToken.trim().length > 0
  ) {
    return { sessionToken: options.operatorSessionToken.trim() };
  }

  // 2. Read from secure session token file (recommended to avoid process argument exposure)
  const tokenFilePath =
    options?.operatorSessionTokenFile ?? env.FLOW_CUSTODY_OPERATOR_SESSION_FILE;
  if (tokenFilePath && tokenFilePath.trim().length > 0) {
    if (!existsSync(tokenFilePath.trim())) {
      throw new FlowError(
        "INVALID_CONFIGURATION",
        `Operator session token file does not exist: ${tokenFilePath.trim()}`,
      );
    }
    try {
      const content = readFileSync(tokenFilePath.trim(), "utf8").trim();
      if (content.length > 0) {
        return { sessionToken: content };
      }
    } catch {
      throw new FlowError(
        "CUSTODY_OPERATOR_AUTHENTICATION_REQUIRED",
        `Failed to read operator session token from file: ${tokenFilePath.trim()}`,
      );
    }
  }

  // 3. Read from environment variable
  if (
    env.FLOW_CUSTODY_OPERATOR_SESSION_TOKEN &&
    env.FLOW_CUSTODY_OPERATOR_SESSION_TOKEN.trim().length > 0
  ) {
    return { sessionToken: env.FLOW_CUSTODY_OPERATOR_SESSION_TOKEN.trim() };
  }

  // 4. Trusted execution key from options or environment
  const executionKey =
    options?.trustedExecutionKey ?? env.FLOW_OPERATOR_TRUSTED_EXECUTION_KEY;
  if (executionKey && executionKey.trim().length > 0) {
    return { trustedExecutionKey: executionKey.trim() };
  }

  return {};
}

export interface CreateRehearsalAuthorizationOptions {
  readonly accountId?: string;
  readonly operatorAuthId?: string;
  readonly operatorSessionToken?: string;
  readonly operatorSessionTokenFile?: string;
  readonly trustedExecutionKey?: string;
  readonly validityMinutes?: number;
  readonly env?: Record<string, string | undefined>;
}

/**
 * Checks whether an existing wallet provisioning job is in its pristine initial
 * state as created during normal onboarding (never leased, dispatched, or attempted).
 */
export function isJobPristineInitial(job: {
  status: string;
  fencingToken: string | bigint | number;
  leaseExpiresAt: Date | null;
  dispatchedAt: Date | null;
  attempts: number;
  failureClassification: string | null;
}): boolean {
  const tokenIsZero =
    job.fencingToken === "0" ||
    job.fencingToken === 0n ||
    job.fencingToken === 0;
  return (
    job.status === "PENDING" &&
    tokenIsZero &&
    job.dispatchedAt === null &&
    job.attempts === 0 &&
    job.failureClassification === null &&
    (job.leaseExpiresAt === null || job.leaseExpiresAt < new Date())
  );
}

/**
 * Creates the single-use compatibility authorization record explicitly.
 * This is an operator-initiated write action separated cleanly from rehearsal execution.
 */
export async function createRehearsalAuthorization(
  options?: CreateRehearsalAuthorizationOptions,
): Promise<{
  readonly id: string;
  readonly expiresAt: Date;
  readonly accountId: string;
  readonly operatorAuthId: string;
}> {
  const env = options?.env ?? process.env;

  // 1. Environment & execution guard
  const { environment, execution } = readConfig(env, "operator");
  if (environment !== "local" && environment !== "test") {
    throw new FlowError(
      "INVALID_CONFIGURATION",
      `Creating testnet authorization is only permitted in local or test environments (current: ${environment}).`,
    );
  }
  if (execution !== "disabled") {
    throw new FlowError(
      "INVALID_CONFIGURATION",
      `Creating testnet authorization strictly requires FLOW_EXECUTION=disabled (current: ${execution}).`,
    );
  }

  const operatorDb = getPrismaClient("operator");

  // 2. Resolve target account ID
  const accountId =
    options?.accountId ?? env.FLOW_PROVIDER_COMPATIBILITY_ACCOUNT_ID;
  if (!accountId) {
    throw new FlowError(
      "INVALID_CONFIGURATION",
      "Account ID is required to create compatibility authorization via --account-id or FLOW_PROVIDER_COMPATIBILITY_ACCOUNT_ID.",
    );
  }

  // 3. Validate target account: must be PERSONAL, no wallets, no jobs
  const accounts = await operatorDb.$queryRaw<
    Array<{ id: string; kind: string }>
  >`
    SELECT id, kind::text as kind FROM flow.accounts WHERE id = ${accountId}::uuid
  `;
  if (!accounts[0]) {
    throw new FlowError(
      "INVALID_CONFIGURATION",
      `Target account ${accountId} does not exist in flow.accounts.`,
    );
  }
  if (accounts[0].kind !== "PERSONAL") {
    throw new FlowError(
      "INVALID_CONFIGURATION",
      `Target account must be PERSONAL, got ${accounts[0].kind}.`,
    );
  }

  const existingWallets = await operatorDb.$queryRaw<
    Array<{ id: string; status: string }>
  >`
    SELECT id, status::text as status FROM flow.wallets WHERE account_id = ${accountId}::uuid
  `;
  if (existingWallets.length > 0) {
    throw new FlowError(
      "INVALID_CONFIGURATION",
      `Account ${accountId} already possesses a wallet record in flow.wallets (status: ${existingWallets[0]!.status}). Rehearsal must target an unprovisioned test account.`,
    );
  }

  const existingJobs = await operatorDb.$queryRaw<
    Array<{
      id: string;
      status: string;
      fencingToken: string;
      leaseExpiresAt: Date | null;
      dispatchedAt: Date | null;
      attempts: number;
      failureClassification: string | null;
    }>
  >`
    SELECT id, status::text as status, fencing_token::text AS "fencingToken",
           lease_expires_at AS "leaseExpiresAt", dispatched_at AS "dispatchedAt",
           attempts, failure_classification AS "failureClassification"
    FROM flow.wallet_provisioning_jobs
    WHERE account_id = ${accountId}::uuid
  `;
  if (existingJobs.length === 1) {
    const job = existingJobs[0]!;
    if (!isJobPristineInitial(job)) {
      throw new FlowError(
        "INVALID_CONFIGURATION",
        `Account ${accountId} possesses a provisioning job in non-initial state (status: ${job.status}, fencingToken: ${job.fencingToken}, attempts: ${job.attempts}). Rehearsal requires a clean, unstarted test account.`,
      );
    }
  } else if (existingJobs.length > 1) {
    throw new FlowError(
      "INVALID_CONFIGURATION",
      `Account ${accountId} possesses multiple provisioning jobs. Rehearsal requires a clean, unstarted test account.`,
    );
  }

  // 4. Resolve operator authentication
  const operatorAuthId =
    options?.operatorAuthId ?? env.FLOW_CUSTODY_OPERATOR_AUTH_ID;
  if (!operatorAuthId) {
    throw new FlowError(
      "CUSTODY_OPERATOR_AUTHENTICATION_REQUIRED",
      "Operator authentication required via --operator-id or FLOW_CUSTODY_OPERATOR_AUTH_ID.",
    );
  }

  const proof = resolveOperatorProof(env, options);
  if (!proof.sessionToken && !proof.trustedExecutionKey) {
    throw new FlowError(
      "CUSTODY_OPERATOR_AUTHENTICATION_REQUIRED",
      "Operator authentication proof required: provide valid session token via FLOW_CUSTODY_OPERATOR_SESSION_TOKEN, --session-token-file, or FLOW_CUSTODY_OPERATOR_SESSION_FILE.",
    );
  }

  const operatorContext = await deriveOperatorContext(operatorDb, {
    operatorAuthId,
    sessionToken: proof.sessionToken,
    trustedExecutionProof: proof.trustedExecutionKey
      ? { executionKey: proof.trustedExecutionKey }
      : undefined,
  });

  // 5. Check existing singleton authorization
  const existingAuthorizations = await operatorDb.$queryRaw<
    Array<{
      id: string;
      status: string;
      accountId: string;
      expiresAt: Date;
    }>
  >`
    SELECT id, status, account_id AS "accountId", expires_at AS "expiresAt"
    FROM flow.provider_compatibility_authorizations
    WHERE singleton_scope = 'GLOBAL_TESTNET_REHEARSAL'
  `;

  if (existingAuthorizations[0]) {
    const existing = existingAuthorizations[0];
    if (existing.status !== "AUTHORIZED") {
      throw new FlowError(
        "CUSTODY_REGISTRATION_BUDGET_EXCEEDED",
        `Provider compatibility authorization is already ${existing.status}. Quota reset or re-creation is strictly prohibited.`,
      );
    }
    if (existing.accountId !== accountId) {
      throw new FlowError(
        "CUSTODY_OPERATOR_AUTHORIZATION_ERROR",
        `An active compatibility authorization already exists for another account (${existing.accountId}).`,
      );
    }
    return {
      id: existing.id,
      expiresAt: existing.expiresAt,
      accountId: existing.accountId,
      operatorAuthId: operatorContext.operatorAuthId,
    };
  }

  // 6. Create the single-use compatibility authorization record
  const created = await createCompatibilityAuthorization(operatorDb, {
    accountId,
    environment: "testnet",
    operatorAuthId: operatorContext.operatorAuthId,
    operatorContext,
    validityMinutes: options?.validityMinutes ?? 60,
  });

  log("info", "testnet_rehearsal_authorization_created", {
    authorizationId: created.id,
    accountId,
    operatorAuthId: operatorContext.operatorAuthId,
    environment: "testnet",
  });

  return {
    id: created.id,
    expiresAt: created.expiresAt,
    accountId,
    operatorAuthId: operatorContext.operatorAuthId,
  };
}

/**
 * Runs the deterministic OutLayer testnet registration rehearsal.
 * In --dry-run mode, inspects prerequisites with ZERO writes and ZERO external mutation calls.
 * In live mode, requires existing authorization and clean unprovisioned account.
 */
export async function runTestnetRehearsal(
  options?: RunTestnetRehearsalOptions,
): Promise<RehearsalExecutionResult> {
  const env = options?.env ?? process.env;
  const dryRun = options?.dryRun ?? false;
  const missingPrerequisites: string[] = [];

  // 1. Environment & strict execution guard
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

  // 2. Validate wallet configuration and testnet endpoint (Requirement 7)
  const walletConfig = readWalletConfig(env);
  const targetUrl = walletConfig.apiUrl;
  const isOfflineTestMode =
    Boolean(options?.offlineTestMode) ||
    Boolean(options?.customAdapter) ||
    env.FLOW_OFFLINE_TEST_MODE === "1" ||
    (env.FLOW_ENV === "test" && Boolean(options?.customAdapter));

  const isExactCanonicalTestnet = targetUrl === OUTLAYER_TESTNET_API_URL;
  const isLoopback =
    targetUrl.startsWith("http://127.0.0.1:") ||
    targetUrl.startsWith("http://localhost:") ||
    targetUrl === "http://127.0.0.1" ||
    targetUrl === "http://localhost";

  let testnetUrlVerified = false;
  if (isExactCanonicalTestnet) {
    testnetUrlVerified = true;
  } else if (isOfflineTestMode && isLoopback) {
    testnetUrlVerified = true;
  } else {
    throw new FlowError(
      "INVALID_CONFIGURATION",
      `Testnet rehearsal strictly requires coordinator URL https://testnet-api.outlayer.ai (got ${targetUrl}). Substring matching, arbitrary hosts, and unapproved loopback are strictly prohibited.`,
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

  // 3. Authenticate and derive operator context (Requirements 4, 5, 6)
  const operatorAuthId =
    options?.operatorAuthId ??
    env.FLOW_CUSTODY_OPERATOR_AUTH_ID ??
    walletConfig.compatibility.authorizedToken;

  if (!operatorAuthId) {
    if (dryRun) {
      missingPrerequisites.push("OPERATOR_IDENTITY_REQUIRED");
    } else {
      throw new FlowError(
        "CUSTODY_OPERATOR_AUTHENTICATION_REQUIRED",
        "Rehearsal requires an authenticated operator ID via --operator-id or FLOW_CUSTODY_OPERATOR_AUTH_ID.",
      );
    }
  }

  const proof = resolveOperatorProof(env, options);
  let operatorContext: AuthenticatedOperatorContext | undefined;
  let operatorAuthenticated = false;
  let operatorRole = "UNAUTHENTICATED";

  if (operatorAuthId) {
    if (!proof.sessionToken && !proof.trustedExecutionKey) {
      if (dryRun) {
        missingPrerequisites.push("OPERATOR_AUTHENTICATION_PROOF_REQUIRED");
      } else {
        throw new FlowError(
          "CUSTODY_OPERATOR_AUTHENTICATION_REQUIRED",
          "Operator authentication proof required: provide valid session token via FLOW_CUSTODY_OPERATOR_SESSION_TOKEN, --session-token-file, or FLOW_CUSTODY_OPERATOR_SESSION_FILE.",
        );
      }
    } else {
      try {
        operatorContext = await deriveOperatorContext(operatorDb, {
          operatorAuthId,
          sessionToken: proof.sessionToken,
          trustedExecutionProof: proof.trustedExecutionKey
            ? { executionKey: proof.trustedExecutionKey }
            : undefined,
        });
        operatorAuthenticated = true;
        operatorRole = operatorContext.role;
      } catch (err) {
        if (dryRun) {
          missingPrerequisites.push(
            err instanceof FlowError
              ? err.code
              : "OPERATOR_AUTHENTICATION_FAILED",
          );
        } else {
          throw err;
        }
      }
    }
  }

  // 4. Validate isolated target account (Requirement 9)
  const accountId =
    options?.accountId ??
    walletConfig.compatibility.isolatedAccountId ??
    env.FLOW_PROVIDER_COMPATIBILITY_ACCOUNT_ID;

  let targetAccountClean = false;

  if (!accountId) {
    if (dryRun) {
      missingPrerequisites.push("TARGET_ACCOUNT_ID_REQUIRED");
    } else {
      throw new FlowError(
        "INVALID_CONFIGURATION",
        "Rehearsal requires an isolated account ID via --account-id or FLOW_PROVIDER_COMPATIBILITY_ACCOUNT_ID.",
      );
    }
  } else {
    const accounts = await operatorDb.$queryRaw<
      Array<{ id: string; kind: string }>
    >`
      SELECT id, kind::text as kind FROM flow.accounts WHERE id = ${accountId}::uuid
    `;
    if (!accounts[0]) {
      if (dryRun) {
        missingPrerequisites.push("TARGET_ACCOUNT_NOT_FOUND");
      } else {
        throw new FlowError(
          "INVALID_CONFIGURATION",
          `Rehearsal target account ${accountId} does not exist in flow.accounts.`,
        );
      }
    } else if (accounts[0].kind !== "PERSONAL") {
      if (dryRun) {
        missingPrerequisites.push("TARGET_ACCOUNT_NOT_PERSONAL");
      } else {
        throw new FlowError(
          "INVALID_CONFIGURATION",
          `Rehearsal target account must be PERSONAL, got ${accounts[0].kind}.`,
        );
      }
    } else {
      // Requirement 9: Reject ANY existing wallet (not only ACTIVE)
      const existingWallets = await operatorDb.$queryRaw<
        Array<{ id: string; status: string }>
      >`
        SELECT id, status::text as status FROM flow.wallets WHERE account_id = ${accountId}::uuid
      `;
      if (existingWallets.length > 0) {
        if (dryRun) {
          missingPrerequisites.push("ACCOUNT_HAS_EXISTING_WALLET");
        } else {
          throw new FlowError(
            "INVALID_CONFIGURATION",
            `Account ${accountId} already possesses a wallet record in flow.wallets (status: ${existingWallets[0]!.status}). Rehearsal must target a clean, unprovisioned test account.`,
          );
        }
      }

      // Check existing provisioning jobs: must be either absent or pristine initial PENDING
      const existingJobs = await operatorDb.$queryRaw<
        Array<{
          id: string;
          status: string;
          fencingToken: string;
          leaseExpiresAt: Date | null;
          dispatchedAt: Date | null;
          attempts: number;
          failureClassification: string | null;
        }>
      >`
        SELECT id, status::text as status, fencing_token::text AS "fencingToken",
               lease_expires_at AS "leaseExpiresAt", dispatched_at AS "dispatchedAt",
               attempts, failure_classification AS "failureClassification"
        FROM flow.wallet_provisioning_jobs
        WHERE account_id = ${accountId}::uuid
      `;

      let jobClean = false;
      if (existingJobs.length === 0) {
        jobClean = true;
      } else if (existingJobs.length === 1) {
        const job = existingJobs[0]!;
        if (isJobPristineInitial(job)) {
          jobClean = true;
        } else {
          if (dryRun) {
            missingPrerequisites.push("ACCOUNT_HAS_IN_FLIGHT_OR_TERMINAL_JOB");
          } else {
            throw new FlowError(
              "INVALID_CONFIGURATION",
              `Account ${accountId} possesses a provisioning job in non-initial state (status: ${job.status}, fencingToken: ${job.fencingToken}, attempts: ${job.attempts}). Rehearsal requires a clean, unstarted test account.`,
            );
          }
        }
      } else {
        if (dryRun) {
          missingPrerequisites.push("ACCOUNT_HAS_IN_FLIGHT_OR_TERMINAL_JOB");
        } else {
          throw new FlowError(
            "INVALID_CONFIGURATION",
            `Account ${accountId} possesses multiple provisioning jobs. Rehearsal requires a clean, unstarted test account.`,
          );
        }
      }

      if (existingWallets.length === 0 && jobClean) {
        targetAccountClean = true;
      }
    }
  }

  // 5. Inspect existing durable compatibility authorization (Requirements 1, 2, 3, 8, 10)
  // NO AUTO-CREATION: authorization MUST be created separately by operator beforehand.
  const authorizations = await operatorDb.$queryRaw<
    Array<{
      id: string;
      status: string;
      accountId: string;
      environment: string;
      allowedMethods: string[];
      authorizedByOperatorId: string;
      maxRegistrations: number;
      registrationsAttempted: number;
      registrationsCompleted: number;
      expiresAt: Date;
    }>
  >`
    SELECT id, status, account_id AS "accountId", environment,
           allowed_methods AS "allowedMethods",
           authorized_by_operator_id AS "authorizedByOperatorId",
           max_registrations AS "maxRegistrations",
           registrations_attempted AS "registrationsAttempted",
           registrations_completed AS "registrationsCompleted",
           expires_at AS "expiresAt"
    FROM flow.provider_compatibility_authorizations
    WHERE singleton_scope = 'GLOBAL_TESTNET_REHEARSAL'
  `;

  const auth = authorizations[0];
  const authorizationId: string | undefined = auth?.id;
  const authorizationStatus: string | undefined = auth?.status;
  let authorizationValid = false;

  if (!auth) {
    if (dryRun) {
      missingPrerequisites.push("COMPATIBILITY_AUTHORIZATION_MISSING");
    } else {
      throw new FlowError(
        "CUSTODY_OPERATOR_AUTHORIZATION_ERROR",
        "Provider compatibility authorization not found. An authorized operator must create it separately before running live rehearsal.",
      );
    }
  } else {
    // Check all properties (Requirement 8 & 10)
    let authValid = true;

    // Available budget check (must be checked first - if budget is consumed, no further rehearsal is authorized)
    if (auth.status !== "AUTHORIZED") {
      authValid = false;
      if (dryRun) {
        missingPrerequisites.push(`AUTHORIZATION_STATUS_${auth.status}`);
      } else {
        throw new FlowError(
          "CUSTODY_REGISTRATION_BUDGET_EXCEEDED",
          `Provider compatibility authorization status is '${auth.status}' (completed: ${auth.registrationsCompleted}, attempted: ${auth.registrationsAttempted}). Re-use or reset is strictly prohibited.`,
        );
      }
    }

    if (
      auth.maxRegistrations !== 1 ||
      auth.registrationsAttempted > 0 ||
      auth.registrationsCompleted > 0
    ) {
      authValid = false;
      if (dryRun) {
        missingPrerequisites.push("AUTHORIZATION_BUDGET_EXHAUSTED");
      } else {
        throw new FlowError(
          "CUSTODY_REGISTRATION_BUDGET_EXCEEDED",
          `Provider compatibility authorization budget exhausted (max: ${auth.maxRegistrations}, attempted: ${auth.registrationsAttempted}, completed: ${auth.registrationsCompleted}).`,
        );
      }
    }

    // Account match check
    if (accountId && auth.accountId !== accountId) {
      authValid = false;
      if (dryRun) {
        missingPrerequisites.push("AUTHORIZATION_ACCOUNT_MISMATCH");
      } else {
        throw new FlowError(
          "CUSTODY_OPERATOR_AUTHORIZATION_ERROR",
          `Compatibility authorization target account (${auth.accountId}) does not match rehearsal account (${accountId}).`,
        );
      }
    }

    // Environment check
    if (auth.environment !== "testnet") {
      authValid = false;
      if (dryRun) {
        missingPrerequisites.push("AUTHORIZATION_ENVIRONMENT_MISMATCH");
      } else {
        throw new FlowError(
          "CUSTODY_OPERATOR_AUTHORIZATION_ERROR",
          `Compatibility authorization environment is '${auth.environment}', expected 'testnet'.`,
        );
      }
    }

    // Expiry check
    if (new Date(auth.expiresAt).getTime() <= Date.now()) {
      authValid = false;
      if (dryRun) {
        missingPrerequisites.push("AUTHORIZATION_EXPIRED");
      } else {
        throw new FlowError(
          "CUSTODY_OPERATOR_AUTHORIZATION_ERROR",
          `Compatibility authorization expired at ${auth.expiresAt.toISOString()}.`,
        );
      }
    }

    // Permitted methods check
    const requiredMethods = [
      "POST /register",
      "GET /wallet/v1/address",
      "GET /wallet/v1/policy",
    ];
    const missingMethods = requiredMethods.filter(
      (m) => !auth.allowedMethods.includes(m),
    );
    if (missingMethods.length > 0) {
      authValid = false;
      if (dryRun) {
        missingPrerequisites.push("AUTHORIZATION_PERMITTED_METHODS_INCOMPLETE");
      } else {
        throw new FlowError(
          "CUSTODY_OPERATOR_AUTHORIZATION_ERROR",
          `Compatibility authorization missing required methods: ${missingMethods.join(", ")}.`,
        );
      }
    }

    // Operator identity check
    const authorizingOperator = await operatorDb.$queryRaw<
      Array<{ id: string }>
    >`
      SELECT id FROM flow.auth_users WHERE id = ${auth.authorizedByOperatorId}
    `;
    if (!authorizingOperator[0]) {
      authValid = false;
      if (dryRun) {
        missingPrerequisites.push("AUTHORIZATION_OPERATOR_UNKNOWN");
      } else {
        throw new FlowError(
          "CUSTODY_OPERATOR_AUTHORIZATION_ERROR",
          `Authorizing operator ${auth.authorizedByOperatorId} does not exist in flow.auth_users.`,
        );
      }
    }

    authorizationValid = authValid;
  }

  const preflight: RehearsalPreflightReport = {
    environment,
    executionDisabled: execution === "disabled",
    testnetUrlVerified,
    targetUrl,
    operatorAuthId: operatorAuthId ?? "UNKNOWN",
    operatorRole,
    operatorAuthenticated,
    targetAccountId: accountId ?? "UNKNOWN",
    targetAccountClean,
    authorizationId,
    authorizationStatus,
    authorizationValid,
    prerequisitesSatisfied: missingPrerequisites.length === 0,
    missingPrerequisites,
  };

  // 6. Dry run early return: ZERO WRITES WHATSOEVER (Requirements 1 & 2)
  if (dryRun) {
    log("info", "testnet_rehearsal_dry_run_completed", { ...preflight });
    return {
      success: true,
      dryRun: true,
      preflight,
    };
  }

  // 7. Live execution pre-condition check
  if (missingPrerequisites.length > 0) {
    throw new FlowError(
      "INVALID_CONFIGURATION",
      `Testnet rehearsal prerequisites not satisfied: ${missingPrerequisites.join(", ")}.`,
    );
  }

  if (!authorizationId) {
    throw new FlowError(
      "CUSTODY_OPERATOR_AUTHORIZATION_ERROR",
      "Missing authorization ID for rehearsal dispatch.",
    );
  }

  // 8. Execute rehearsal registration via WalletProvisioningWorker
  await ensureProvisioningJobForAccount(workerDb, accountId!, randomUUID());

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

  const result = await worker.processAccountJob(accountId!);

  if (result.outcome !== "registered" && result.outcome !== "activated") {
    throw new FlowError(
      "INCOMPLETE_WALLET_PROVISIONING",
      `Rehearsal provisioning ended with unexpected outcome: ${result.outcome}.`,
    );
  }

  // 9. Verify post-rehearsal invariants
  const projection = await getAccountWalletPublicProjection(
    operatorDb,
    accountId!,
  );
  if (!projection) {
    throw new FlowError(
      "INCOMPLETE_WALLET_PROVISIONING",
      "Public wallet projection not found after rehearsal provisioning.",
    );
  }

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

export const SAFE_ERROR_DIAGNOSTICS: Record<string, string> = {
  INVALID_CONFIGURATION:
    "Configuration or target account preconditions were not met. Check environment, account readiness, and inputs.",
  CUSTODY_OPERATOR_AUTHENTICATION_REQUIRED:
    "A valid custody operator identity and session token are required.",
  CUSTODY_OPERATOR_AUTHORIZATION_ERROR:
    "Operator session is expired, untrusted, or lacks authorized custody privileges.",
  CUSTODY_REGISTRATION_BUDGET_EXCEEDED:
    "Single-use compatibility registration budget has already been exhausted.",
  PROVIDER_COMPATIBILITY_UNAUTHORIZED:
    "Action not authorized by active singleton provider compatibility authorization.",
  PROVIDER_UNAVAILABLE:
    "Upstream provider network request failed or service was unreachable.",
  INCOMPLETE_WALLET_PROVISIONING:
    "Wallet provisioning did not reach the expected outcome.",
  DATABASE_UNAVAILABLE: "Database operation failed or database is unreachable.",
};

export function formatSanitizedCliError(error: unknown): {
  code: string;
  diagnostic: string;
} {
  if (error instanceof FlowError) {
    const code = error.code;
    const diagnostic =
      SAFE_ERROR_DIAGNOSTICS[code] ??
      "A custody or validation error occurred. Check secure audit logs.";
    return { code, diagnostic };
  }
  return {
    code: "UNEXPECTED_ERROR",
    diagnostic:
      "An unexpected operational error occurred. Check secure audit logs for sanitized diagnostic details.",
  };
}

async function main() {
  const { values } = parseArgs({
    options: {
      "dry-run": { type: "boolean", default: false },
      "create-authorization": { type: "boolean", default: false },
      "account-id": { type: "string" },
      "operator-id": { type: "string" },
      "session-token": { type: "string" },
      "session-token-file": { type: "string" },
      help: { type: "boolean", default: false },
    },
    allowPositionals: true,
  });

  if (values.help) {
    console.log(`
Usage: node scripts/rehearse-testnet-registration.ts [options]

Deterministic one-time OutLayer testnet wallet registration rehearsal.

Options:
  --dry-run                 Inspect prerequisites and database readiness with ZERO writes or outbound mutation calls.
  --create-authorization    Create the single-use compatibility authorization record (explicit operator action).
  --account-id              Target clean isolated personal account UUID.
  --operator-id             Authenticated custody operator auth identifier.
  --session-token-file      Path to file containing operator session token (recommended for security).
  --session-token           Operator session token (discouraged in shared shells; prefer file or env).
  --help                    Show this help message.
`);
    return;
  }

  console.log("==========================================================");
  console.log(" FLOW OutLayer Testnet Registration Rehearsal");
  console.log("==========================================================\n");

  try {
    if (values["create-authorization"]) {
      console.log("Action: CREATE COMPATIBILITY AUTHORIZATION");
      const auth = await createRehearsalAuthorization({
        accountId: values["account-id"],
        operatorAuthId: values["operator-id"],
        operatorSessionToken: values["session-token"],
        operatorSessionTokenFile: values["session-token-file"],
      });
      console.log(
        `\n✓ Single-use compatibility authorization created successfully:`,
      );
      console.log(` - Authorization ID: ${auth.id}`);
      console.log(` - Target Account: ${auth.accountId}`);
      console.log(` - Authorized By: ${auth.operatorAuthId}`);
      console.log(` - Valid Until: ${auth.expiresAt.toISOString()}\n`);
      return;
    }

    const result = await runTestnetRehearsal({
      dryRun: values["dry-run"],
      accountId: values["account-id"],
      operatorAuthId: values["operator-id"],
      operatorSessionToken: values["session-token"],
      operatorSessionTokenFile: values["session-token-file"],
    });

    console.log(
      `Mode: ${result.dryRun ? "DRY-RUN (Preflight Validation Only - Read Only)" : "LIVE TESTNET REHEARSAL"}`,
    );
    console.log(`Preflight Checks:`);
    console.log(` - Environment: ${result.preflight.environment}`);
    console.log(
      ` - FLOW_EXECUTION: disabled (${result.preflight.executionDisabled ? "VERIFIED" : "FAILED"})`,
    );
    console.log(
      ` - Coordinator URL: ${result.preflight.targetUrl} (${result.preflight.testnetUrlVerified ? "EXACT_CANONICAL" : "INVALID"})`,
    );
    console.log(
      ` - Operator Identity: ${result.preflight.operatorAuthId} (${result.preflight.operatorRole}, Authenticated: ${result.preflight.operatorAuthenticated})`,
    );
    console.log(
      ` - Target Account: ${result.preflight.targetAccountId} (Clean/Unprovisioned: ${result.preflight.targetAccountClean})`,
    );
    console.log(
      ` - Authorization Singleton: ${result.preflight.authorizationId ?? "NONE"} (Status: ${result.preflight.authorizationStatus ?? "MISSING"}, Valid: ${result.preflight.authorizationValid ?? false})\n`,
    );

    if (result.dryRun) {
      if (result.preflight.prerequisitesSatisfied) {
        console.log(
          "✓ Dry-run completed successfully: All testnet rehearsal preflight safety invariants are satisfied. ZERO database writes performed.",
        );
      } else {
        console.log(
          `⚠ Dry-run completed with missing prerequisites (${result.preflight.missingPrerequisites.length}):`,
        );
        for (const missing of result.preflight.missingPrerequisites) {
          console.log(`  - ${missing}`);
        }
        console.log(
          "\nZERO database writes performed. Complete the missing prerequisites before running live rehearsal.",
        );
        process.exitCode = 2;
      }
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
    const { code, diagnostic } = formatSanitizedCliError(error);
    console.error(`\nx Rehearsal failed: [${code}] ${diagnostic}\n`);
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

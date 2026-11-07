import { randomUUID } from "node:crypto";
import { parseArgs } from "node:util";
import { readConfig } from "../src/foundation/environment.ts";
import { FlowError } from "../src/foundation/errors.ts";
import {
  disconnectPrismaClients,
  getPrismaClient,
} from "../src/foundation/prisma.ts";
import {
  deriveOperatorContext,
  ensureProvisioningJobForAccount,
} from "../src/server/custody/job-repository.ts";
import {
  formatSanitizedCliError,
  isJobPristineInitial,
  resolveOperatorProof,
} from "./rehearse-testnet-registration.ts";

export interface PrepareTestnetAccountOptions {
  readonly operatorAuthId?: string;
  readonly operatorSessionToken?: string;
  readonly operatorSessionTokenFile?: string;
  readonly email?: string;
  readonly name?: string;
  readonly env?: Record<string, string | undefined>;
}

export interface PreparedTestnetAccountResult {
  readonly accountId: string;
  readonly authUserId: string;
  readonly email: string;
  readonly name: string;
  readonly kind: "PERSONAL";
  readonly jobStatus: "PENDING";
  readonly walletCount: number;
  readonly operatorAuthId: string;
  readonly operatorRole: string;
  readonly isNew: boolean;
}

/**
 * Prepares exactly one isolated personal test account in an authorized,
 * reproducible manner without deleting production data, weakening tenant
 * isolation, or bypassing security controls.
 */
export async function prepareIsolatedTestnetAccount(
  options?: PrepareTestnetAccountOptions,
): Promise<PreparedTestnetAccountResult> {
  const env = options?.env ?? process.env;

  // 1. Environment & execution guard
  const { environment, execution } = readConfig(env, "operator");
  if (environment !== "local" && environment !== "test") {
    throw new FlowError(
      "INVALID_CONFIGURATION",
      `Preparing testnet account is only permitted in local or test environments (current: ${environment}).`,
    );
  }
  if (execution !== "disabled") {
    throw new FlowError(
      "INVALID_CONFIGURATION",
      `Preparing testnet account strictly requires FLOW_EXECUTION=disabled (current: ${execution}).`,
    );
  }

  // 2. Authenticate custody operator
  const operatorDb = getPrismaClient("operator");
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

  if (
    operatorContext.role !== "SECURITY_OFFICER" &&
    operatorContext.role !== "CUSTODY_OPERATOR"
  ) {
    throw new FlowError(
      "CUSTODY_OPERATOR_AUTHORIZATION_ERROR",
      `Operator role ${operatorContext.role} lacks authorization to prepare rehearsal accounts.`,
    );
  }

  // 3. Prepare personal test account via application role
  const appDb = getPrismaClient("runtime");
  const email = (
    options?.email ?? "testnet-rehearsal-user@flow.internal"
  ).toLowerCase();
  const name = options?.name ?? "Testnet Rehearsal User";

  const prepResult = await appDb.$transaction(async (tx) => {
    const existingAuth = await tx.authUser.findUnique({
      where: { email },
    });

    if (existingAuth) {
      const flowUser = await tx.flowUser.findUnique({
        where: { authUserId: existingAuth.id },
      });

      if (flowUser) {
        const personalAccount = await tx.flowAccount.findFirst({
          where: {
            personalOwnerId: flowUser.id,
            kind: "PERSONAL",
          },
        });

        if (personalAccount) {
          return {
            accountId: personalAccount.id,
            authUserId: existingAuth.id,
            email: existingAuth.email,
            name: personalAccount.name,
            isNew: false,
          };
        }
      }
    }

    const authUserId = randomUUID();
    await tx.authUser.create({
      data: {
        id: authUserId,
        name,
        email,
        emailVerified: true,
        updatedAt: new Date(),
      },
    });

    const flowUser = await tx.flowUser.create({
      data: {
        authUserId,
        active: true,
      },
    });

    const account = await tx.flowAccount.create({
      data: {
        kind: "PERSONAL",
        name,
        personalOwnerId: flowUser.id,
      },
    });

    await ensureProvisioningJobForAccount(tx, account.id, randomUUID());

    await tx.securityAuditEvent.createMany({
      data: [
        {
          kind: "personal-created",
          actorAuthId: operatorContext.operatorAuthId,
          accountId: account.id,
          requestId: randomUUID(),
        },
      ],
    });

    return {
      accountId: account.id,
      authUserId,
      email,
      name,
      isNew: true,
    };
  });

  // 4. Operator-role verification: verify no wallet exists and job is in pristine initial state
  const existingWallets = await operatorDb.$queryRaw<
    Array<{ id: string; status: string }>
  >`
    SELECT id, status::text as status FROM flow.wallets WHERE account_id = ${prepResult.accountId}::uuid
  `;
  if (existingWallets.length > 0) {
    throw new FlowError(
      "INVALID_CONFIGURATION",
      `Target account ${prepResult.accountId} already possesses a wallet record in flow.wallets (status: ${existingWallets[0]!.status}).`,
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
    WHERE account_id = ${prepResult.accountId}::uuid
  `;

  if (existingJobs.length === 0) {
    throw new FlowError(
      "INVALID_CONFIGURATION",
      `Target account ${prepResult.accountId} does not possess an initial provisioning job.`,
    );
  }

  const job = existingJobs[0]!;
  if (!isJobPristineInitial(job)) {
    throw new FlowError(
      "INVALID_CONFIGURATION",
      `Target account ${prepResult.accountId} possesses a non-initial provisioning job (status: ${job.status}, fencingToken: ${job.fencingToken}).`,
    );
  }

  return {
    accountId: prepResult.accountId,
    authUserId: prepResult.authUserId,
    email: prepResult.email,
    name: prepResult.name,
    kind: "PERSONAL",
    jobStatus: "PENDING",
    walletCount: 0,
    operatorAuthId: operatorContext.operatorAuthId,
    operatorRole: operatorContext.role,
    isNew: prepResult.isNew,
  };
}

async function main() {
  const { values } = parseArgs({
    options: {
      "operator-id": { type: "string" },
      "session-token": { type: "string" },
      "session-token-file": { type: "string" },
      email: { type: "string" },
      name: { type: "string" },
      help: { type: "boolean", default: false },
    },
    allowPositionals: true,
  });

  if (values.help) {
    console.log(`
Usage: node scripts/prepare-testnet-account.ts [options]

Authorized preparation of exactly one isolated personal test account for testnet rehearsal.

Options:
  --operator-id             Authenticated custody operator auth identifier.
  --session-token-file      Path to file containing operator session token.
  --session-token           Operator session token (prefer session-token-file).
  --email                   Custom email address for the test account.
  --name                    Display name for the test account.
  --help                    Show this help message.
`);
    return;
  }

  console.log("==========================================================");
  console.log(" FLOW Testnet Rehearsal Account Preparation");
  console.log("==========================================================\n");

  try {
    const result = await prepareIsolatedTestnetAccount({
      operatorAuthId: values["operator-id"],
      operatorSessionToken: values["session-token"],
      operatorSessionTokenFile: values["session-token-file"],
      email: values.email,
      name: values.name,
    });

    console.log("✓ Isolated personal test account ready for rehearsal:");
    console.log(` - Account ID: ${result.accountId}`);
    console.log(` - Auth User ID: ${result.authUserId}`);
    console.log(` - Account Kind: ${result.kind}`);
    console.log(` - Email: ${result.email}`);
    console.log(
      ` - Provisioning Job Status: ${result.jobStatus} (Pristine unstarted initial job)`,
    );
    console.log(` - Wallets Count: ${result.walletCount}`);
    console.log(
      ` - Operator: ${result.operatorAuthId} (${result.operatorRole})`,
    );
    console.log(
      ` - Status: ${result.isNew ? "NEWLY_CREATED" : "EXISTING_CLEAN"}\n`,
    );

    console.log("Next Steps:");
    console.log(
      ` 1. Set FLOW_PROVIDER_COMPATIBILITY_ACCOUNT_ID=${result.accountId}`,
    );
    console.log(
      ` 2. Run dry-run rehearsal: npm run rehearse:testnet -- --dry-run --account-id ${result.accountId}\n`,
    );
  } catch (error) {
    const { code, diagnostic } = formatSanitizedCliError(error);
    console.error(`\nx Account preparation failed: [${code}] ${diagnostic}\n`);
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
  process.argv[1]?.endsWith("prepare-testnet-account.ts") ||
  process.argv[1]?.endsWith("prepare-testnet-account")
) {
  void main();
}

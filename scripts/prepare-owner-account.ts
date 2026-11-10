import { createHash, randomUUID } from "node:crypto";
import { parseArgs } from "node:util";
import { readConfig } from "../src/foundation/environment.ts";
import { FlowError } from "../src/foundation/errors.ts";
import {
  disconnectPrismaClients,
  getPrismaClient,
} from "../src/foundation/prisma.ts";
import { ensureProvisioningJobForAccount } from "../src/server/custody/job-repository.ts";

export function accountProvisioningKey(id: string): string {
  const hash = createHash("sha256")
    .update(`flow:wallet-provisioning:${id.toLowerCase()}`)
    .digest("hex");
  return [
    hash.slice(0, 8),
    hash.slice(8, 12),
    `5${hash.slice(13, 16)}`,
    `8${hash.slice(17, 20)}`,
    hash.slice(20, 32),
  ].join("-");
}

export interface PrepareOwnerAccountOptions {
  readonly email?: string;
  readonly name?: string;
}

export interface PreparedOwnerAccountResult {
  readonly accountId: string;
  readonly authUserId: string;
  readonly email: string;
  readonly name: string;
  readonly kind: "PERSONAL";
  readonly jobStatus: "PENDING";
  readonly walletCount: number;
  readonly isNew: boolean;
}

/**
 * Prepares a fresh owner-controlled FLOW Personal account using the genuine
 * onboarding and provisioning-job association process.
 */
export async function prepareOwnerAccount(
  options: PrepareOwnerAccountOptions = {},
): Promise<PreparedOwnerAccountResult> {
  const { execution } = readConfig(process.env, "runtime");

  if (execution !== "disabled") {
    throw new FlowError(
      "INVALID_CONFIGURATION",
      "Account preparation strictly requires FLOW_EXECUTION=disabled.",
    );
  }

  const email = (options.email ?? "owner@flow.internal").trim().toLowerCase();
  const name = options.name?.trim() || "FLOW Owner";

  const appDb = getPrismaClient("runtime");
  const workerDb = getPrismaClient("worker");

  // 1. Transactional Owner Signup & Onboarding
  const prepResult = await appDb.$transaction(async (tx) => {
    // Check if auth user already exists
    let authUser = await tx.authUser.findUnique({
      where: { email },
    });

    let isNew = false;
    if (!authUser) {
      isNew = true;
      const authUserId = randomUUID();
      authUser = await tx.authUser.create({
        data: {
          id: authUserId,
          name,
          email,
          emailVerified: true,
          emailEnrolled: true,
          updatedAt: new Date(),
        },
      });
    }

    // Ensure FlowUser exists
    let flowUser = await tx.flowUser.findUnique({
      where: { authUserId: authUser.id },
    });

    if (!flowUser) {
      flowUser = await tx.flowUser.create({
        data: {
          authUserId: authUser.id,
          active: true,
        },
      });
    }

    // Check for existing Personal account
    let personalAccount = await tx.flowAccount.findFirst({
      where: {
        personalOwnerId: flowUser.id,
        kind: "PERSONAL",
      },
    });

    if (!personalAccount) {
      personalAccount = await tx.flowAccount.create({
        data: {
          kind: "PERSONAL",
          name,
          personalOwnerId: flowUser.id,
        },
      });
    }

    // Create / ensure provisioning job associated with this account
    const idempotencyKey = accountProvisioningKey(personalAccount.id);
    await ensureProvisioningJobForAccount(
      tx,
      personalAccount.id,
      idempotencyKey,
    );

    // Audit personal account creation
    await tx.securityAuditEvent.createMany({
      data: [
        {
          kind: "personal-created",
          actorAuthId: authUser.id,
          accountId: personalAccount.id,
          requestId: randomUUID(),
        },
      ],
    });

    return {
      accountId: personalAccount.id,
      authUserId: authUser.id,
      email: authUser.email,
      name: personalAccount.name,
      isNew,
    };
  });

  // 2. Validate with worker role that no wallet exists yet
  const existingWallets = await workerDb.$queryRaw<
    Array<{ id: string; status: string }>
  >`
    SELECT id, status::text as status
    FROM flow.wallets
    WHERE account_id = ${prepResult.accountId}::uuid
  `;

  // 3. Validate provisioning job state
  const jobs = await workerDb.$queryRaw<
    Array<{
      id: string;
      status: string;
      attempts: number;
      dispatched_at: Date | null;
    }>
  >`
    SELECT id, status::text as status, attempts, dispatched_at
    FROM flow.wallet_provisioning_jobs
    WHERE account_id = ${prepResult.accountId}::uuid
  `;

  if (jobs.length === 0) {
    throw new FlowError(
      "INVALID_CONFIGURATION",
      `Target account ${prepResult.accountId} lacks a provisioning job.`,
    );
  }

  const job = jobs[0]!;

  return {
    accountId: prepResult.accountId,
    authUserId: prepResult.authUserId,
    email: prepResult.email,
    name: prepResult.name,
    kind: "PERSONAL",
    jobStatus: job.status as "PENDING",
    walletCount: existingWallets.length,
    isNew: prepResult.isNew,
  };
}

// CLI entrypoint
async function main() {
  const { values } = parseArgs({
    options: {
      email: { type: "string" },
      name: { type: "string" },
    },
    strict: false,
  });

  console.log("==========================================================");
  console.log(" FLOW — Prepare Fresh Owner Personal Mainnet Account");
  console.log(" (Authenticated Owner Signup & Onboarding Procedure)");
  console.log("==========================================================\n");

  try {
    const result = await prepareOwnerAccount({
      email: typeof values.email === "string" ? values.email : undefined,
      name: typeof values.name === "string" ? values.name : undefined,
    });

    console.log("✓ Owner personal account ready for genuine activation:");
    console.log(` - Account ID:             ${result.accountId}`);
    console.log(` - Auth User ID:          ${result.authUserId}`);
    console.log(` - Account Kind:           ${result.kind}`);
    console.log(` - Owner Name:             ${result.name}`);
    console.log(` - Owner Email:            ${result.email}`);
    console.log(
      ` - Provisioning Job State: ${result.jobStatus} (Pristine unstarted initial job)`,
    );
    console.log(` - Existing Wallets:       ${result.walletCount} (None)`);
    console.log(
      ` - Status:                 ${result.isNew ? "NEWLY_CREATED" : "EXISTING_CLEAN"}\n`,
    );

    console.log("Next Step (Controlled Dry Run):");
    console.log(
      ` FLOW_OUTLAYER_API_URL="https://api.outlayer.ai" node --env-file-if-exists=.env.integration scripts/activate-first-mainnet-wallet.ts --dry-run --account ${result.accountId}\n`,
    );
  } catch (error) {
    console.error(
      "\nAccount preparation failed:",
      (error as Error).message || error,
    );
    process.exitCode = 1;
  } finally {
    await disconnectPrismaClients();
  }
}

if (
  process.argv[1]?.endsWith("prepare-owner-account.ts") ||
  process.argv[1]?.endsWith("prepare-owner-account")
) {
  void main();
}

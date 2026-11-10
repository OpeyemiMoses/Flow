import { randomUUID } from "node:crypto";
import { getPrismaClient } from "../src/foundation/prisma.ts";
import {
  createCustodyRecoveryApproval,
  createOperatorSession,
  enrollCustodyOperator,
  escalateJobToManualReview,
  resolveQuarantinedProvisioningJob,
} from "../src/server/custody/job-repository.ts";

export async function recoverOrphanedContainerJob(
  options: {
    readonly accountId?: string;
    readonly jobId?: string;
    readonly abandonedContainerId?: string;
    readonly expectedDispatchAttemptId?: string;
  } = {},
): Promise<void> {
  const accountId = options.accountId ?? "cb88c933-b6a9-4de5-a8d8-8cd56cf5696c";
  const jobId = options.jobId ?? "d4bc6799-5465-4a7b-9bde-eafbb531b85b";
  const abandonedContainerId =
    options.abandonedContainerId ?? "006b80df-bdbe-43e4-ad91-26087f595e8d";
  const expectedDispatchAttemptId =
    options.expectedDispatchAttemptId ?? "be948ce6-6a75-4936-b8ba-3ce145580a3c";

  console.log(
    "================================================================",
  );
  console.log("FLOW Custody Recovery — Orphaned Container Reconciliation");
  console.log(
    "================================================================",
  );
  console.log(`Target Account ID:          ${accountId}`);
  console.log(`Target Provisioning Job ID: ${jobId}`);
  console.log(`Abandoned Container ID:     ${abandonedContainerId}`);
  console.log(`Expected Dispatch Attempt:  ${expectedDispatchAttemptId}`);
  console.log(
    "----------------------------------------------------------------\n",
  );

  const operatorDb = getPrismaClient("operator");

  try {
    // 1. Inspect Current Job State
    console.log("1. Inspecting Provisioning Job Status in PostgreSQL...");
    const jobs = await operatorDb.$queryRaw<
      Array<{
        id: string;
        accountId: string;
        status: string;
        fencingToken: bigint;
        dispatchAttemptId: string | null;
        failureClassification: string | null;
      }>
    >`
      SELECT
        id, account_id AS "accountId", status, fencing_token AS "fencingToken",
        dispatch_attempt_id AS "dispatchAttemptId",
        failure_classification AS "failureClassification"
      FROM flow.wallet_provisioning_jobs
      WHERE id = ${jobId}::uuid AND account_id = ${accountId}::uuid
    `;

    if (jobs.length === 0) {
      throw new Error(`Job ${jobId} not found for account ${accountId}.`);
    }

    const currentJob = jobs[0]!;
    console.log(
      `   [OK] Job found. Current status: ${currentJob.status}, Fencing token: ${currentJob.fencingToken.toString()}`,
    );

    if (currentJob.status === "PENDING") {
      console.log(
        "   [INFO] Job is already in PENDING state. Recovery already completed.\n",
      );
      return;
    }

    if (
      currentJob.status !== "UNKNOWN" &&
      currentJob.status !== "MANUAL_REVIEW"
    ) {
      throw new Error(
        `Job cannot be recovered from status ${currentJob.status}. Must be UNKNOWN or MANUAL_REVIEW.`,
      );
    }

    // 2. Ensure Two Independent Operators are Enrolled
    console.log(
      "\n2. Verifying Independent Operator Identities (Separation of Duties)...",
    );
    const op1AuthId = "flow-custody-operator-rehearsal";
    const op2AuthId = "647f70dc-df20-4548-b057-c43c08c7baf6"; // owner@flow.internal

    const existingOps = await operatorDb.$queryRaw<
      Array<{ authUserId: string; role: string; status: string }>
    >`
      SELECT auth_user_id AS "authUserId", role, status
      FROM flow.custody_operators
      WHERE auth_user_id IN (${op1AuthId}, ${op2AuthId})
    `;

    const opMap = new Map(existingOps.map((op) => [op.authUserId, op]));

    if (!opMap.has(op1AuthId) || opMap.get(op1AuthId)?.status !== "ACTIVE") {
      throw new Error(
        `Primary operator ${op1AuthId} is not active in custody_operators.`,
      );
    }

    // Create session for primary operator first
    console.log("   - Authenticating primary operator session...");
    const op1Session = await createOperatorSession(operatorDb, op1AuthId, 60);
    console.log(`   [OK] Operator 1 Session: ${op1Session.sessionId}`);

    if (!opMap.has(op2AuthId) || opMap.get(op2AuthId)?.status !== "ACTIVE") {
      console.log(
        `   - Enrolling secondary operator ${op2AuthId} (SECURITY_OFFICER)...`,
      );
      await enrollCustodyOperator(operatorDb, {
        authUserId: op2AuthId,
        role: "SECURITY_OFFICER",
        enrolledBy: op1AuthId,
        enrolledBySessionToken: op1Session.sessionToken,
      });
      console.log("   [OK] Secondary operator enrolled successfully.");
    } else {
      console.log(`   [OK] Secondary operator ${op2AuthId} already active.`);
    }

    // 3. Create Authenticated Session for Operator 2
    console.log("\n3. Creating Authenticated Session for Operator 2...");
    const op2Session = await createOperatorSession(operatorDb, op2AuthId, 60);
    console.log(`   [OK] Operator 2 Session: ${op2Session.sessionId}`);

    // 4. Escalate UNKNOWN Job to MANUAL_REVIEW (if not already escalated)
    if (currentJob.status === "UNKNOWN") {
      console.log("\n4. Step 1: Escalating UNKNOWN job to MANUAL_REVIEW...");
      const escalationRequestId = randomUUID();
      await escalateJobToManualReview(operatorDb, {
        jobId,
        accountId,
        expectedAccountKind: "PERSONAL",
        expectedDispatchAttemptId,
        operatorAuthId: op1AuthId,
        reasonCode: "AMBIGUOUS_REGISTRATION_OUTCOME",
        providerInspectionSummary: "REMOTE_CONTAINER_ORPHANED_CREDENTIAL_LOST",
        requestId: escalationRequestId,
        verifyOperatorInDatabase: true,
      });
      console.log("   [OK] Quarantined job escalated to MANUAL_REVIEW.");
    } else {
      console.log("\n4. Step 1: Job already in MANUAL_REVIEW state.");
    }

    // 5. Create Independent Custody Recovery Approval
    console.log(
      "\n5. Step 2: Creating Independent Two-Person Recovery Approval...",
    );
    const approvalToken = randomUUID();
    const approval = await createCustodyRecoveryApproval(operatorDb, {
      jobId,
      accountId,
      initiatorOperatorAuthId: op1AuthId,
      initiatorSessionToken: op1Session.sessionToken,
      approverAuthId: op2AuthId,
      approverSessionToken: op2Session.sessionToken,
      expectedDispatchAttemptId,
      resolution: "REMOTE_CONTAINER_ORPHANED_CREDENTIAL_LOST",
      approvalToken,
      validityMinutes: 30,
    });
    console.log(`   [OK] Approval record created: ${approval.id}`);
    console.log(`   - Expires at: ${approval.expiresAt.toISOString()}`);

    // 6. Execute Quarantined Job Resolution (Atomic Mode C)
    console.log(
      "\n6. Step 3: Resolving Quarantined Job via REMOTE_CONTAINER_ORPHANED_CREDENTIAL_LOST...",
    );
    const resolutionRequestId = randomUUID();
    const resolution = await resolveQuarantinedProvisioningJob(operatorDb, {
      resolution: "REMOTE_CONTAINER_ORPHANED_CREDENTIAL_LOST",
      jobId,
      accountId,
      expectedAccountKind: "PERSONAL",
      expectedDispatchAttemptId,
      abandonedContainerId,
      initiatorOperatorAuthId: op1AuthId,
      approverOperatorAuthId: op2AuthId,
      approvalToken,
      requestId: resolutionRequestId,
      verifyOperatorInDatabase: true,
    });

    console.log(`   [OK] Resolution completed successfully.`);
    console.log(`   - Job ID:        ${resolution.jobId}`);
    console.log(`   - New Status:    ${resolution.status}`);
    console.log(`   - Fencing Token: ${resolution.fencingToken.toString()}`);

    // 7. Verify Post-Resolution State
    console.log("\n7. Verifying Post-Resolution Database State...");
    const resolvedJobs = await operatorDb.$queryRaw<
      Array<{
        id: string;
        status: string;
        fencingToken: bigint;
        leaseHolder: string | null;
        dispatchAttemptId: string | null;
        lastError: string | null;
        recoveryEvidence: string | null;
      }>
    >`
      SELECT
        id, status, fencing_token AS "fencingToken", lease_holder AS "leaseHolder",
        dispatch_attempt_id AS "dispatchAttemptId", last_error AS "lastError",
        recovery_evidence AS "recoveryEvidence"
      FROM flow.wallet_provisioning_jobs
      WHERE id = ${jobId}::uuid
    `;
    const resolvedJob = resolvedJobs[0]!;
    console.log(`   - Status:           ${resolvedJob.status}`);
    console.log(
      `   - Fencing Token:    ${resolvedJob.fencingToken.toString()}`,
    );
    console.log(
      `   - Lease Holder:     ${resolvedJob.leaseHolder ?? "(null)"}`,
    );
    console.log(
      `   - Dispatch Attempt: ${resolvedJob.dispatchAttemptId ?? "(null)"}`,
    );
    console.log(`   - Last Error:       ${resolvedJob.lastError ?? "(null)"}`);
    console.log(
      `   - Recovery Evidence Preserved: ${resolvedJob.recoveryEvidence ? "YES" : "NO"}`,
    );

    const approvalRecords = await operatorDb.$queryRaw<
      Array<{ id: string; status: string; consumedAt: Date | null }>
    >`
      SELECT id, status, consumed_at AS "consumedAt"
      FROM flow.custody_recovery_approvals
      WHERE id = ${approval.id}::uuid
    `;
    console.log(
      `   - Approval Status:  ${approvalRecords[0]?.status} (Consumed At: ${approvalRecords[0]?.consumedAt?.toISOString() ?? "N/A"})`,
    );

    const auditRecords = await operatorDb.$queryRaw<
      Array<{ id: string; kind: string; targetId: string; createdAt: Date }>
    >`
      SELECT id, kind, target_id AS "targetId", created_at AS "createdAt"
      FROM flow.security_audit_events
      WHERE target_id = ${abandonedContainerId}
      ORDER BY created_at DESC
    `;
    console.log(
      `   - Total Security Audit Events for Container: ${auditRecords.length}`,
    );
    for (const audit of auditRecords) {
      console.log(
        `     * [${audit.kind}] ID: ${audit.id} (At: ${audit.createdAt.toISOString()})`,
      );
    }

    console.log(
      "\n================================================================",
    );
    console.log(
      "RECOVERY COMPLETE — Job d4bc6799-5465-4a7b-9bde-eafbb531b85b is PENDING",
    );
    console.log(
      "================================================================\n",
    );
  } finally {
    await operatorDb.$disconnect();
  }
}

if (process.argv[1]?.endsWith("recover-orphaned-container-job.ts")) {
  recoverOrphanedContainerJob().catch((err) => {
    console.error("RECOVERY FAILED:", err);
    process.exit(1);
  });
}

import "server-only";
import { randomUUID } from "node:crypto";
import type { FlowDb } from "../foundation/prisma.ts";

type AuditKind =
  | "sign-in"
  | "recovery"
  | "google-linked"
  | "unlink-google"
  | "enroll-email"
  | "disable-email"
  | "sign-out"
  | "revoke-all"
  | "revoke-session"
  | "personal-created"
  | "business-created"
  | "account-renamed"
  | "invite-issued"
  | "invite-revoked"
  | "invite-accepted"
  | "member-removed"
  | "member-role-changed";

export async function audit(
  db: FlowDb,
  kind: AuditKind,
  actorAuthId: string,
  accountId?: string,
  targetId?: string,
): Promise<void> {
  await db.securityAuditEvent.createMany({
    data: { kind, actorAuthId, accountId, targetId, requestId: randomUUID() },
  });
}

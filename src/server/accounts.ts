import "server-only";
import { z } from "zod";
import { runtime, transaction, type FlowDb } from "../foundation/prisma.ts";
import { audit } from "./audit.ts";
import { digest } from "./auth/provider.ts";
import { forwardCookies, requireSession } from "./auth/session.ts";
import { ensureProvisioningJobForAccount } from "./custody/job-repository.ts";
import {
  ApiFailure,
  canonicalHost,
  input,
  privateHeaders,
  reply,
} from "./http.ts";

export const emptyBody = z.strictObject({});
const nameBody = z.strictObject({ name: z.string().trim().min(1).max(80) });
const uuid = z.uuid();

export function accountProvisioningKey(id: string): string {
  const hash = digest(`flow:wallet-provisioning:${id.toLowerCase()}`);
  return [
    hash.slice(0, 8),
    hash.slice(8, 12),
    `5${hash.slice(13, 16)}`,
    `8${hash.slice(17, 20)}`,
    hash.slice(20, 32),
  ].join("-");
}

export function accountId(value: unknown): string {
  const parsed = uuid.safeParse(value);
  if (!parsed.success) throw new ApiFailure(404, "NOT_FOUND");
  return parsed.data.toLowerCase();
}

export async function principal(
  db: FlowDb,
  headers: Headers,
  lock = false,
  refresh = false,
) {
  const session = await requireSession(db, headers, lock, refresh);
  const user = await db.flowUser.findUnique({
    where: { authUserId: session.userId },
    select: {
      id: true,
      active: true,
      authUser: {
        select: { email: true, emailVerified: true, mailboxPaused: true },
      },
    },
  });
  if (!user) throw new ApiFailure(409, "ONBOARDING_REQUIRED");
  if (!user.active) throw new ApiFailure(403, "ACCOUNT_UNAVAILABLE");
  return {
    session,
    userId: user.id,
    email: user.authUser.email,
    verifiedEmail: user.authUser.emailVerified && !user.authUser.mailboxPaused,
  };
}

export type Principal = Awaited<ReturnType<typeof principal>>;

function scope(userId: string) {
  return {
    OR: [
      { personalOwnerId: userId },
      {
        business: { members: { some: { userId, status: "ACTIVE" as const } } },
      },
    ],
  };
}

function summarySelect(userId: string) {
  return {
    id: true,
    name: true,
    kind: true,
    wallet: {
      select: {
        status: true,
        policyState: true,
        controllerAccountId: true,
      },
    },
    business: {
      select: {
        members: {
          where: { userId, status: "ACTIVE" as const },
          select: { role: true },
        },
      },
    },
  } as const;
}

function mapWalletSummaryStatus(
  status?:
    | "SETUP_PENDING"
    | "PROVISIONING"
    | "ACTIVE"
    | "SETUP_FAILED"
    | "FROZEN"
    | "RECOVERY_PENDING"
    | null,
) {
  switch (status) {
    case "PROVISIONING":
      return "provisioning" as const;
    case "ACTIVE":
      return "active" as const;
    case "SETUP_FAILED":
      return "setup_failed" as const;
    case "FROZEN":
      return "frozen" as const;
    case "RECOVERY_PENDING":
      return "recovery_pending" as const;
    case "SETUP_PENDING":
    default:
      return "setup_pending" as const;
  }
}

function summary(row: {
  id: string;
  name: string;
  kind: "PERSONAL" | "BUSINESS";
  wallet?: {
    status:
      | "SETUP_PENDING"
      | "PROVISIONING"
      | "ACTIVE"
      | "SETUP_FAILED"
      | "FROZEN"
      | "RECOVERY_PENDING";
    policyState: string;
    controllerAccountId: string | null;
  } | null;
  business: { members: { role: "OWNER" | "ADMIN" | "MEMBER" }[] } | null;
}) {
  const role =
    row.kind === "PERSONAL" ? "OWNER" : row.business?.members[0]?.role;
  if (!role) throw new ApiFailure(404, "NOT_FOUND");
  const walletStatus = mapWalletSummaryStatus(row.wallet?.status);
  const provisioningComplete =
    row.wallet?.status === "ACTIVE" &&
    row.wallet?.policyState === "stored" &&
    Boolean(row.wallet?.controllerAccountId);
  return {
    id: row.id,
    name: row.name,
    kind: row.kind,
    role,
    walletStatus,
    provisioningComplete,
    fundsReady: false as const,
  };
}

export async function accessibleAccounts(db: FlowDb, actor: Principal) {
  const rows = await db.flowAccount.findMany({
    where: scope(actor.userId),
    select: summarySelect(actor.userId),
    orderBy: [{ kind: "asc" }, { createdAt: "asc" }],
    take: 100,
  });
  return rows.map(summary);
}

export async function access(db: FlowDb, actor: Principal, id: string) {
  const row = await db.flowAccount.findFirst({
    where: { id, ...scope(actor.userId) },
    select: summarySelect(actor.userId),
  });
  if (!row) throw new ApiFailure(404, "NOT_FOUND");
  return summary(row);
}

export async function lockAccount(db: FlowDb, id: string) {
  await db.$queryRaw`SELECT id FROM flow.accounts WHERE id = ${id}::uuid FOR UPDATE`;
}

export async function lockedAccess(db: FlowDb, actor: Principal, id: string) {
  await access(db, actor, id);
  await lockAccount(db, id);
  return access(db, actor, id);
}

export async function onboard(request: Request): Promise<Response> {
  await input(request, emptyBody);
  const account = await transaction(async (tx) => {
    const session = await requireSession(tx, request.headers, true);
    const existing = await tx.flowUser.findUnique({
      where: { authUserId: session.userId },
    });
    if (existing && !existing.active)
      throw new ApiFailure(403, "ACCOUNT_UNAVAILABLE");
    const user =
      existing ??
      (await tx.flowUser.create({ data: { authUserId: session.userId } }));
    const personal = await tx.flowAccount.findUnique({
      where: { personalOwnerId: user.id },
      select: summarySelect(user.id),
    });
    if (personal) {
      await ensureProvisioningJobForAccount(
        tx,
        personal.id,
        accountProvisioningKey(personal.id),
      );
      return summary(personal);
    }
    const auth = await tx.authUser.findUniqueOrThrow({
      where: { id: session.userId },
      select: { name: true },
    });
    const created = await tx.flowAccount.create({
      data: {
        kind: "PERSONAL",
        name: auth.name.trim() || "Personal",
        personalOwnerId: user.id,
      },
    });
    await ensureProvisioningJobForAccount(
      tx,
      created.id,
      accountProvisioningKey(created.id),
    );
    await audit(tx, "personal-created", session.userId, created.id);
    return summary({ ...created, wallet: null, business: null });
  });
  return reply(200, { account });
}

export async function me(request: Request): Promise<Response> {
  const { db, auth } = runtime();
  canonicalHost(request.headers, auth);
  const actor = await principal(db, request.headers, false, true);
  const headers = privateHeaders();
  forwardCookies(headers, actor.session.headers, auth.cookies.session);
  return reply(
    200,
    {
      user: { id: actor.userId, email: actor.email },
      accounts: await accessibleAccounts(db, actor),
    },
    headers,
  );
}

export async function readAccounts(
  request: Request,
  id?: string,
): Promise<Response> {
  const { db, auth } = runtime();
  canonicalHost(request.headers, auth);
  const actor = await principal(db, request.headers);
  return id
    ? reply(200, { account: await access(db, actor, id) })
    : reply(200, { accounts: await accessibleAccounts(db, actor) });
}

export async function createBusiness(request: Request): Promise<Response> {
  const { name } = await input(request, nameBody);
  const key = uuid.safeParse(request.headers.get("idempotency-key"));
  if (!key.success) throw new ApiFailure(422, "IDEMPOTENCY_KEY_REQUIRED");
  const fingerprint = digest(name);
  const account = await transaction(async (tx) => {
    const actor = await principal(tx, request.headers, true);
    const lookup = { actorId_key: { actorId: actor.userId, key: key.data } };
    const existing = await tx.businessCreation.findUnique({ where: lookup });
    if (existing) {
      if (existing.fingerprint !== fingerprint)
        throw new ApiFailure(409, "IDEMPOTENCY_CONFLICT");
      await ensureProvisioningJobForAccount(
        tx,
        existing.accountId,
        accountProvisioningKey(existing.accountId),
      );
      return access(tx, actor, existing.accountId);
    }
    const created = await tx.flowAccount.create({
      data: { kind: "BUSINESS", name },
    });
    await tx.businessProfile.create({ data: { accountId: created.id } });
    await tx.accountMembership.create({
      data: { accountId: created.id, userId: actor.userId, role: "OWNER" },
    });
    await tx.businessCreation.create({
      data: {
        actorId: actor.userId,
        key: key.data,
        fingerprint,
        accountId: created.id,
      },
    });
    await ensureProvisioningJobForAccount(
      tx,
      created.id,
      accountProvisioningKey(created.id),
    );
    await audit(tx, "business-created", actor.session.userId, created.id);
    return access(tx, actor, created.id);
  });
  return reply(201, { account });
}

export async function renameAccount(
  request: Request,
  id: string,
): Promise<Response> {
  const { name } = await input(request, nameBody);
  const updated = await transaction(async (tx) => {
    const actor = await principal(tx, request.headers, true);
    const account = await lockedAccess(tx, actor, id);
    if (account.role !== "OWNER") throw new ApiFailure(403, "FORBIDDEN");
    await tx.flowAccount.update({ where: { id: account.id }, data: { name } });
    await audit(tx, "account-renamed", actor.session.userId, account.id);
    return { ...account, name };
  });
  return reply(200, { account: updated });
}

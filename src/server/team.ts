import "server-only";
import { randomBytes } from "node:crypto";
import { after } from "next/server";
import { z } from "zod";
import { runtime, transaction, type FlowDb } from "../foundation/prisma.ts";
import {
  access,
  emptyBody,
  lockAccount,
  lockedAccess,
  principal,
  type Principal,
} from "./accounts.ts";
import { audit } from "./audit.ts";
import { requireProof } from "./auth/flows.ts";
import { withinBudget } from "./auth/limits.ts";
import { sendMail } from "./auth/mail.ts";
import { digest, emailAddress } from "./auth/provider.ts";
import { ApiFailure, canonicalHost, input, reply } from "./http.ts";

const assignableRole = z.enum(["ADMIN", "MEMBER"]);
const inviteBody = z.strictObject({
  email: emailAddress,
  role: assignableRole,
});
const roleBody = z.strictObject({ role: assignableRole });
const tokenBody = z.strictObject({ token: z.string().regex(/^[a-f0-9]{64}$/) });

type Summary = Awaited<ReturnType<typeof access>>;
function canGrant(role: string | undefined, offered: string): boolean {
  return (
    (role === "OWNER" && (offered === "ADMIN" || offered === "MEMBER")) ||
    (role === "ADMIN" && offered === "MEMBER")
  );
}

function requireTeam(account: Summary): void {
  if (account.kind !== "BUSINESS") throw new ApiFailure(404, "NOT_FOUND");
  if (!canGrant(account.role, "MEMBER")) throw new ApiFailure(403, "FORBIDDEN");
}

const inviteSelect = {
  id: true,
  email: true,
  role: true,
  status: true,
  expiresAt: true,
} as const;

export async function team(db: FlowDb, actor: Principal, id: string) {
  const account = await access(db, actor, id);
  requireTeam(account);
  const [members, invitations] = await Promise.all([
    db.accountMembership.findMany({
      where: { accountId: id, status: "ACTIVE" },
      select: {
        id: true,
        role: true,
        user: { select: { authUser: { select: { email: true } } } },
      },
      orderBy: [{ role: "asc" }, { createdAt: "asc" }],
      take: 100,
    }),
    db.accountInvite.findMany({
      where: {
        accountId: id,
        status: "PENDING",
        expiresAt: { gt: new Date() },
      },
      select: inviteSelect,
      orderBy: { createdAt: "desc" },
      take: 100,
    }),
  ]);
  return {
    account,
    members: members.map(({ id, role, user }) => ({
      id,
      role,
      email: user.authUser.email,
    })),
    invitations: invitations.map((invite) => ({
      ...invite,
      expiresAt: invite.expiresAt.toISOString(),
    })),
  };
}

export async function readTeam(
  request: Request,
  id: string,
): Promise<Response> {
  const { db, auth } = runtime();
  canonicalHost(request.headers, auth);
  const actor = await principal(db, request.headers);
  return reply(200, await team(db, actor, id));
}

export async function invite(request: Request, id: string): Promise<Response> {
  const { email, role } = await input(request, inviteBody);
  const { db, auth } = runtime();
  const actor = await principal(db, request.headers);
  const visible = await access(db, actor, id);
  requireTeam(visible);
  if (!canGrant(visible.role, role)) throw new ApiFailure(403, "FORBIDDEN");
  const secret = randomBytes(32).toString("hex");
  const invitation = await transaction(async (tx) => {
    const current = await principal(tx, request.headers, true);
    const account = await lockedAccess(tx, current, id);
    requireTeam(account);
    if (!canGrant(account.role, role)) throw new ApiFailure(403, "FORBIDDEN");
    await requireProof(tx, request, current.session, "team-change", id);
    if (
      !(await withinBudget(`invite:actor:${current.userId}`, 12, 3600, tx)) ||
      !(await withinBudget(`invite:account:${id}`, 30, 3600, tx))
    ) {
      throw new ApiFailure(429, "TRY_LATER");
    }
    const alreadyMember = await tx.accountMembership.findFirst({
      where: { accountId: id, status: "ACTIVE", user: { authUser: { email } } },
      select: { id: true },
    });
    if (alreadyMember) throw new ApiFailure(409, "ALREADY_MEMBER");
    // An admin cannot rotate an owner's outstanding invitation for an admin role.
    const old = await tx.accountInvite.findFirst({
      where: { accountId: id, email, status: "PENDING" },
    });
    if (old && !canGrant(account.role, old.role))
      throw new ApiFailure(403, "FORBIDDEN");
    if (old)
      await tx.accountInvite.update({
        where: { id: old.id, accountId: id },
        data: { status: "REVOKED" },
      });
    const created = await tx.accountInvite.create({
      data: {
        accountId: id,
        inviterId: current.userId,
        email,
        role,
        digest: digest(secret),
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1_000),
      },
      select: inviteSelect,
    });
    await audit(tx, "invite-issued", current.session.userId, id, created.id);
    return created;
  });
  const url = new URL("/invites/accept", auth.origin);
  url.hash = `token=${secret}`;
  after(async () => {
    await sendMail(
      auth,
      email,
      "Your FLOW business invitation",
      `Sign in to FLOW with the invited email, then open this link to accept the invitation. It expires in 24 hours.\n\n${url.href}`,
    );
  });
  return reply(201, { invitation });
}

export async function revokeInvite(
  request: Request,
  id: string,
  inviteId: string,
): Promise<Response> {
  await input(request, emptyBody);
  await transaction(async (tx) => {
    const actor = await principal(tx, request.headers, true);
    const account = await lockedAccess(tx, actor, id);
    requireTeam(account);
    const existing = await tx.accountInvite.findFirst({
      where: { id: inviteId, accountId: id, status: "PENDING" },
    });
    if (!existing) throw new ApiFailure(404, "NOT_FOUND");
    if (!canGrant(account.role, existing.role))
      throw new ApiFailure(403, "FORBIDDEN");
    await requireProof(tx, request, actor.session, "team-change", id);
    await tx.accountInvite.update({
      where: { id: inviteId, accountId: id },
      data: { status: "REVOKED" },
    });
    await audit(tx, "invite-revoked", actor.session.userId, id, inviteId);
  });
  return reply(204);
}

export async function changeMember(
  request: Request,
  id: string,
  memberId: string,
  remove: boolean,
): Promise<Response> {
  const data = remove
    ? await input(request, emptyBody)
    : await input(request, roleBody);
  await transaction(async (tx) => {
    const actor = await principal(tx, request.headers, true);
    const account = await lockedAccess(tx, actor, id);
    requireTeam(account);
    const member = await tx.accountMembership.findFirst({
      where: { id: memberId, accountId: id, status: "ACTIVE" },
    });
    if (!member) throw new ApiFailure(404, "NOT_FOUND");
    if (
      !canGrant(account.role, member.role) ||
      (!remove && account.role !== "OWNER")
    ) {
      throw new ApiFailure(403, "FORBIDDEN");
    }
    await requireProof(tx, request, actor.session, "team-change", id);
    const update = remove
      ? { status: "REMOVED" as const }
      : roleBody.parse(data);
    await tx.accountMembership.update({
      where: { id: memberId, accountId: id },
      data: update,
    });
    await audit(
      tx,
      remove ? "member-removed" : "member-role-changed",
      actor.session.userId,
      id,
      memberId,
    );
  });
  return reply(204);
}

export async function acceptInvite(request: Request): Promise<Response> {
  const { token } = await input(request, tokenBody);
  const hashed = digest(token);
  const account = await transaction(async (tx) => {
    const actor = await principal(tx, request.headers, true);
    if (!actor.verifiedEmail) throw new ApiFailure(404, "INVITE_UNAVAILABLE");
    const pending = await tx.accountInvite.findUnique({
      where: { digest: hashed },
    });
    if (
      !pending ||
      pending.email !== actor.email ||
      pending.status !== "PENDING"
    ) {
      throw new ApiFailure(404, "INVITE_UNAVAILABLE");
    }
    await lockAccount(tx, pending.accountId);
    const current = await tx.accountInvite.findFirst({
      where: {
        digest: hashed,
        accountId: pending.accountId,
        email: actor.email,
        status: "PENDING",
        expiresAt: { gt: new Date() },
      },
    });
    if (!current) throw new ApiFailure(404, "INVITE_UNAVAILABLE");
    const inviter = await tx.accountMembership.findFirst({
      where: {
        accountId: current.accountId,
        userId: current.inviterId,
        status: "ACTIVE",
        user: { active: true },
      },
      select: { role: true },
    });
    if (!canGrant(inviter?.role, current.role))
      throw new ApiFailure(404, "INVITE_UNAVAILABLE");
    const member = { accountId: current.accountId, userId: actor.userId };
    const existing = await tx.accountMembership.findUnique({
      where: { accountId_userId: member },
    });
    if (existing?.status === "ACTIVE")
      throw new ApiFailure(409, "ALREADY_MEMBER");
    await tx.accountMembership.upsert({
      where: { accountId_userId: member },
      update: { role: current.role, status: "ACTIVE" },
      create: { ...member, role: current.role },
    });
    await tx.accountInvite.update({
      where: { id: current.id, accountId: current.accountId },
      data: { status: "ACCEPTED" },
    });
    await audit(
      tx,
      "invite-accepted",
      actor.session.userId,
      current.accountId,
      current.id,
    );
    return access(tx, actor, current.accountId);
  });
  return reply(200, { account });
}

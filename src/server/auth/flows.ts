import "server-only";
import { randomBytes } from "node:crypto";
import { after } from "next/server";
import { z } from "zod";
import { runtime, transaction, type FlowDb } from "../../foundation/prisma.ts";
import { audit } from "../audit.ts";
import {
  api,
  ApiFailure,
  canonicalHost,
  input,
  privateHeaders,
  reply,
} from "../http.ts";
import { clientBudget, withinBudget } from "./limits.ts";
import { sendMail } from "./mail.ts";
import {
  digest,
  emailAddress,
  keyedDigest,
  lockAuthUser,
  otpAttempts,
  otpSeconds,
  provider,
  sessionLimitMs,
} from "./provider.ts";
import {
  authHeaders,
  cookie,
  forwardCookies,
  readNonce,
  readSession,
  requireSession,
} from "./session.ts";

const empty = z.strictObject({});
const codeBody = z.strictObject({ code: z.string().regex(/^[0-9]{8}$/) });
const googleStart = z.strictObject({ recovery: z.boolean().optional() });
const emailStart = z.strictObject({
  email: emailAddress,
  recovery: z.boolean().optional(),
});
const securityPurpose = z.enum([
  "enroll-email",
  "link-google",
  "unlink-google",
  "disable-email",
  "revoke-all",
  "team-change",
]);
const securityStart = z
  .strictObject({
    purpose: securityPurpose,
    target: z.uuid().optional(),
  })
  .refine(({ purpose, target }) => (purpose === "team-change") === !!target);
type SecurityPurpose = z.infer<typeof securityPurpose>;

const nonce = () => randomBytes(32).toString("hex");
const expiry = () => new Date(Date.now() + otpSeconds * 1_000);
const providerRedirect = "/api/auth/complete";
const fixedSignInError = "/sign-in?issue=authentication";

function authRedirect(location: string, headers = privateHeaders()): Response {
  headers.set("location", location);
  return reply(303, undefined, headers);
}

function rejectedCode(error: unknown): boolean {
  if (!error || typeof error !== "object" || !("body" in error)) return false;
  const body = error.body;
  return (
    !!body &&
    typeof body === "object" &&
    "code" in body &&
    ["INVALID_OTP", "OTP_EXPIRED", "TOO_MANY_ATTEMPTS"].includes(
      String(body.code),
    )
  );
}

async function sendCode(
  request: Request,
  security: boolean,
): Promise<Response> {
  const { auth } = runtime();
  const login = security ? undefined : await input(request, emailStart);
  const action = security ? await input(request, securityStart) : undefined;
  const secret = nonce();
  const key = security ? auth.cookies.security : auth.cookies.email;
  const accepted = (value: string) => {
    const headers = privateHeaders();
    headers.append("set-cookie", cookie(auth, key, value, otpSeconds));
    return reply(202, undefined, headers);
  };
  const previous = readNonce(request.headers, key) ?? secret;
  const email =
    login?.email ??
    (await transaction(async (tx) => {
      const session = await requireSession(tx, request.headers);
      const user = await tx.authUser.findUniqueOrThrow({
        where: { id: session.userId },
      });
      if (user.mailboxPaused || !user.emailVerified)
        throw new ApiFailure(403, "MAILBOX_UNAVAILABLE");
      return user.email;
    }));
  const channel = security ? "security-code" : "email-code";
  const slot = keyedDigest(auth.otpKey, channel, email);
  if (
    !(await clientBudget(request, channel)) ||
    !(await withinBudget(`${channel}:global`, 240, 900)) ||
    !(await withinBudget(`${channel}:cooldown:${email}`, 1, 60)) ||
    !(await withinBudget(`${channel}:recipient:${email}`, 3, 900))
  )
    return accepted(previous);

  const mails: { email: string; code: string }[] = [];
  await transaction(async (tx) => {
    const session = security
      ? await requireSession(tx, request.headers, true)
      : undefined;
    const user = await tx.authUser.findUnique({ where: { email } });
    if (
      security &&
      (!user ||
        user.id !== session?.userId ||
        user.mailboxPaused ||
        !user.emailVerified)
    ) {
      throw new ApiFailure(403, "MAILBOX_UNAVAILABLE");
    }
    if (login && user && (!user.emailEnrolled || user.mailboxPaused)) return;
    if (login?.recovery && !user) return;
    const data = {
      digest: digest(secret),
      purpose:
        action?.purpose ??
        (login?.recovery ? "recover-email" : "sign-in-email"),
      email,
      userId: session?.userId ?? null,
      sessionId: session?.id ?? null,
      target: action?.target ?? null,
      issuedAt: new Date(),
      expiresAt: expiry(),
      verified: false,
      attempts: 0,
    };
    await tx.authIntent.upsert({
      where: { slot },
      create: { slot, ...data },
      update: data,
    });
    await provider(tx, auth, {
      captureOtp: (destination, code) =>
        mails.push({ email: destination, code }),
    }).api.sendVerificationOTP({
      body: { email, type: security ? "email-verification" : "sign-in" },
    });
  });

  for (const mail of mails) {
    const subject = security
      ? "Confirm a FLOW security change"
      : "Your FLOW sign-in code";
    after(async () => {
      await sendMail(
        auth,
        mail.email,
        subject,
        `Your FLOW code is ${mail.code}. It expires in five minutes. Enter it only in the FLOW window that requested it.`,
      );
    });
  }
  return accepted(mails.length ? secret : previous);
}

async function verifyCode(
  request: Request,
  security: boolean,
): Promise<Response> {
  const { code } = await input(request, codeBody);
  const { auth, db } = runtime();
  const key = security ? auth.cookies.security : auth.cookies.email;
  const secret = readNonce(request.headers, key);
  if (!secret || !(await clientBudget(request, "verify"))) {
    throw new ApiFailure(401, "INVALID_PROOF");
  }
  const headers = privateHeaders();

  if (security) {
    await transaction(async (tx) => {
      const session = await requireSession(tx, request.headers, true);
      const changed = await tx.authIntent.updateMany({
        where: {
          digest: digest(secret),
          expiresAt: { gt: new Date() },
          attempts: { lt: otpAttempts },
          verified: false,
          sessionId: session.id,
          purpose: { in: securityPurpose.options },
        },
        data: { attempts: { increment: 1 } },
      });
      if (!changed.count) throw new ApiFailure(401, "INVALID_PROOF");
      const intent = await tx.authIntent.findUniqueOrThrow({
        where: { digest: digest(secret) },
      });
      if (!intent.email) throw new ApiFailure(401, "INVALID_PROOF");
      const user = await tx.authUser.findUnique({
        where: { email: intent.email },
      });
      if (
        user?.id !== session.userId ||
        !user?.emailVerified ||
        user.mailboxPaused
      ) {
        throw new ApiFailure(401, "INVALID_PROOF");
      }
      try {
        await provider(tx, auth).api.verifyEmailOTP({
          body: { email: intent.email, otp: code },
        });
      } catch (error) {
        if (rejectedCode(error)) throw new ApiFailure(401, "INVALID_PROOF");
        throw error;
      }
      await tx.authIntent.update({
        where: { slot: intent.slot },
        data: { verified: true, expiresAt: expiry() },
      });
    });
    return reply(204, undefined, headers);
  }

  const changed = await db.authIntent.updateMany({
    where: {
      digest: digest(secret),
      expiresAt: { gt: new Date() },
      attempts: { lt: otpAttempts },
      verified: false,
      purpose: { in: ["sign-in-email", "recover-email"] },
    },
    data: { attempts: { increment: 1 } },
  });
  if (!changed.count) {
    throw new ApiFailure(401, "INVALID_PROOF");
  }
  const intent = await db.authIntent.findUniqueOrThrow({
    where: { digest: digest(secret) },
  });
  if (!intent.email) {
    throw new ApiFailure(401, "INVALID_PROOF");
  }
  const user = await db.authUser.findUnique({
    where: { email: intent.email },
  });
  if (user && (!user.emailEnrolled || user.mailboxPaused))
    throw new ApiFailure(401, "INVALID_PROOF");
  if (intent.purpose === "recover-email" && !user)
    throw new ApiFailure(401, "INVALID_PROOF");
  const previous = await readSession(db, request.headers);
  try {
    const result = await provider(db, auth, {
      emailLogin: intent.email,
      emailSlot: intent.slot,
      emailDigest: intent.digest,
    }).api.signInEmailOTP({
      body: { email: intent.email, otp: code },
      headers: authHeaders(request.headers),
      returnHeaders: true,
    });
    await db.$executeRaw`SELECT set_config('flow.current_session_token', ${result.response.token}, false)`;
    const created = await db.authSession.findUniqueOrThrow({
      where: { token: result.response.token },
    });
    if (intent.purpose === "recover-email") {
      await db.authSession.deleteMany({
        where: { userId: created.userId, id: { not: created.id } },
      });
    }
    if (previous && previous.id !== created.id)
      await db.authSession.deleteMany({ where: { id: previous.id } });
    await db.authIntent.deleteMany({ where: { slot: intent.slot } });
    await audit(
      db,
      intent.purpose === "recover-email" ? "recovery" : "sign-in",
      created.userId,
      undefined,
      created.id,
    );
    forwardCookies(headers, result.headers, auth.cookies.session);
    headers.append("set-cookie", cookie(auth, auth.cookies.email, "", 0));
    return reply(204, undefined, headers);
  } catch (error) {
    if (rejectedCode(error)) throw new ApiFailure(401, "INVALID_PROOF");
    throw error;
  }
}

export async function requireProof(
  tx: FlowDb,
  request: Request,
  session: { id: string; userId: string },
  purpose: SecurityPurpose,
  target?: string,
): Promise<void> {
  const { auth } = runtime();
  const secret = readNonce(request.headers, auth.cookies.security);
  if (!secret) throw new ApiFailure(403, "FRESH_PROOF_REQUIRED");
  const user = await tx.authUser.findUniqueOrThrow({
    where: { id: session.userId },
  });
  if (user.mailboxPaused) throw new ApiFailure(403, "MAILBOX_UNAVAILABLE");
  const consumed = await tx.authIntent.deleteMany({
    where: {
      digest: digest(secret),
      purpose,
      target: target ?? null,
      verified: true,
      userId: session.userId,
      sessionId: session.id,
      expiresAt: { gt: new Date() },
    },
  });
  if (!consumed.count) throw new ApiFailure(403, "FRESH_PROOF_REQUIRED");
}

async function beginGoogle(
  request: Request,
  linking: boolean,
): Promise<Response> {
  const data = await input(request, linking ? empty : googleStart);
  const recovery = "recovery" in data && data.recovery === true;
  const { auth } = runtime();
  if (!(await clientBudget(request, "google")))
    throw new ApiFailure(429, "TRY_LATER");
  const secret = nonce();
  const identityNonce = nonce();
  const headers = privateHeaders();
  const destination = await transaction(async (tx) => {
    const current = linking
      ? await requireSession(tx, request.headers, true)
      : undefined;
    if (current) await requireProof(tx, request, current, "link-google");
    const [start] = await tx.$queryRaw<{ order: bigint }[]>`
      SELECT nextval('flow.google_oauth_order') AS "order"
    `;
    if (!start) throw new ApiFailure(503, "UNAVAILABLE");
    const instance = provider(tx, auth);
    const body = {
      provider: "google" as const,
      callbackURL: new URL(providerRedirect, auth.origin).href,
      errorCallbackURL: new URL(fixedSignInError, auth.origin).href,
      disableRedirect: true,
    };
    const options = {
      body,
      headers: authHeaders(request.headers),
      returnHeaders: true as const,
    };
    const redirect = linking
      ? await instance.api.linkSocialAccount(options)
      : await instance.api.signInSocial(options);
    const url = new URL(redirect.response.url ?? "");
    const state = url.searchParams.get("state");
    if (
      url.origin !== "https://accounts.google.com" ||
      url.pathname !== "/o/oauth2/v2/auth" ||
      !state ||
      url.searchParams.get("code_challenge_method") !== "S256"
    ) {
      throw new ApiFailure(503, "UNAVAILABLE");
    }
    url.searchParams.set("nonce", identityNonce);
    await tx.authIntent.create({
      data: {
        slot: `google:${digest(secret)}`,
        digest: digest(secret),
        stateHash: digest(state),
        nonceHash: digest(identityNonce),
        purpose: linking
          ? "link-google-callback"
          : recovery
            ? "recover-google"
            : "sign-in-google",
        userId: current?.userId,
        sessionId: current?.id,
        googleStartOrder: start.order,
        issuedAt: new Date(),
        expiresAt: expiry(),
      },
    });
    forwardCookies(headers, redirect.headers, auth.cookies.state);
    headers.append(
      "set-cookie",
      cookie(auth, auth.cookies.oauth, secret, otpSeconds),
    );
    return url.href;
  });
  return reply(200, { url: destination }, headers);
}

async function finishGoogle(request: Request): Promise<Response> {
  const { auth, db } = runtime();
  canonicalHost(request.headers, auth);
  const query = new URL(request.url).searchParams;
  const state = query.get("state");
  const code = query.get("code");
  const secret = readNonce(request.headers, auth.cookies.oauth);
  const headers = privateHeaders();
  headers.append("set-cookie", cookie(auth, auth.cookies.oauth, "", 0));
  if (
    !secret ||
    !state ||
    !/^[\w-]{32}$/.test(state) ||
    !code ||
    code.length > 2048 ||
    query.getAll("state").length !== 1 ||
    query.getAll("code").length !== 1
  ) {
    return authRedirect(fixedSignInError, headers);
  }
  const intent = await db.authIntent.findUnique({
    where: { digest: digest(secret) },
  });
  if (
    !intent?.nonceHash ||
    !intent.stateHash ||
    intent.stateHash !== digest(state)
  )
    return authRedirect(fixedSignInError, headers);
  const claimed = await db.authIntent.deleteMany({
    where: {
      digest: intent.digest,
      stateHash: intent.stateHash,
      expiresAt: { gt: new Date() },
    },
  });
  const startOrder = intent.googleStartOrder;
  if (claimed.count !== 1 || startOrder === null)
    return authRedirect(fixedSignInError, headers);
  const link = intent.purpose === "link-google-callback";
  const binding = intent.nonceHash;
  try {
    const current = link
      ? await requireSession(db, request.headers, true)
      : await readSession(db, request.headers);
    if (
      link &&
      (!current ||
        current.id !== intent.sessionId ||
        current.userId !== intent.userId)
    ) {
      throw new ApiFailure(401, "INVALID_PROOF");
    }
    const callback = new URL("/api/auth/callback/google", auth.origin);
    callback.searchParams.set("state", state);
    callback.searchParams.set("code", code);
    const response = await provider(db, auth, {
      google: {
        nonceHash: binding,
        startOrder,
        linkUserId: link ? current?.userId : undefined,
      },
    }).handler(
      new Request(callback, { headers: authHeaders(request.headers) }),
    );
    if (
      response.status < 300 ||
      response.status >= 400 ||
      response.headers.get("location") !==
        new URL(providerRedirect, auth.origin).href
    ) {
      throw new ApiFailure(401, "INVALID_PROOF");
    }
    if (link && current) {
      await db.authSession.deleteMany({ where: { userId: current.userId } });
      await audit(db, "google-linked", current.userId);
    } else {
      const nextCookie = response.headers
        .getSetCookie()
        .find((value) => value.startsWith(`${auth.cookies.session}=`));
      const session = nextCookie
        ? await readSession(
            db,
            new Headers({ cookie: nextCookie.split(";")[0]! }),
          )
        : null;
      if (!session) throw new ApiFailure(401, "INVALID_PROOF");
      if (intent.purpose === "recover-google") {
        await db.authSession.deleteMany({
          where: { userId: session.userId, id: { not: session.id } },
        });
      }
      if (current && current.id !== session.id)
        await db.authSession.deleteMany({ where: { id: current.id } });
      await audit(
        db,
        intent.purpose === "recover-google" ? "recovery" : "sign-in",
        session.userId,
        undefined,
        session.id,
      );
    }
    forwardCookies(
      headers,
      response.headers,
      auth.cookies.state,
      ...(link ? [] : [auth.cookies.session]),
    );
    if (link)
      headers.append("set-cookie", cookie(auth, auth.cookies.session, "", 0));
    return authRedirect(
      link ? "/sign-in?notice=linked" : "/onboarding",
      headers,
    );
  } catch (error) {
    if (!(error instanceof ApiFailure)) throw error;
    return authRedirect(
      link ? "/security?issue=authentication" : fixedSignInError,
      headers,
    );
  }
}

async function changeSecurity(
  request: Request,
  purpose: Exclude<SecurityPurpose, "link-google" | "team-change">,
): Promise<Response> {
  await input(request, empty);
  const { auth } = runtime();
  await transaction(async (tx) => {
    const session = await requireSession(tx, request.headers, true);
    await tx.$executeRaw`SELECT set_config('flow.current_session_token', ${session.token}, true)`;
    await requireProof(tx, request, session, purpose);
    const user = await tx.authUser.findUniqueOrThrow({
      where: { id: session.userId },
    });
    if (purpose === "enroll-email") {
      await tx.authUser.update({
        where: { id: user.id },
        data: { emailEnrolled: true },
      });
    } else if (purpose === "disable-email") {
      const google = await tx.authIdentity.count({
        where: { userId: user.id, providerId: "google" },
      });
      if (!google) throw new ApiFailure(409, "LAST_LOGIN_METHOD");
      await tx.authUser.update({
        where: { id: user.id },
        data: { emailEnrolled: false },
      });
    } else if (purpose === "unlink-google") {
      if (!user.emailEnrolled || user.mailboxPaused)
        throw new ApiFailure(409, "LAST_LOGIN_METHOD");
      await tx.authIdentity.deleteMany({
        where: { userId: user.id, providerId: "google" },
      });
    }
    await tx.authSession.deleteMany({ where: { userId: user.id } });
    await audit(tx, purpose, user.id);
  });
  const headers = privateHeaders();
  headers.append("set-cookie", cookie(auth, auth.cookies.session, "", 0));
  headers.append("set-cookie", cookie(auth, auth.cookies.security, "", 0));
  return reply(204, undefined, headers);
}

async function signOut(request: Request): Promise<Response> {
  await input(request, empty);
  const { auth } = runtime();
  await transaction(async (tx) => {
    const session = await readSession(tx, request.headers);
    if (session) {
      await lockAuthUser(tx, session.userId);
      await tx.$executeRaw`SELECT set_config('flow.current_session_token', ${session.token}, true)`;
      const deleted = await tx.authSession.deleteMany({
        where: { id: session.id },
      });
      if (deleted.count)
        await audit(tx, "sign-out", session.userId, undefined, session.id);
    }
  });
  const headers = privateHeaders();
  for (const key of Object.values(auth.cookies))
    headers.append("set-cookie", cookie(auth, key, "", 0));
  return reply(204, undefined, headers);
}

export async function securitySnapshot(headers: Headers) {
  const { db } = runtime();
  const session = await requireSession(db, headers);
  return db.$transaction(async (tx) => {
    const user = await tx.authUser.findUniqueOrThrow({
      where: { id: session.userId },
      select: {
        email: true,
        emailEnrolled: true,
        mailboxPaused: true,
        identities: { select: { providerId: true } },
      },
    });
    await tx.$executeRaw`SELECT set_config('flow.current_session_token', ${session.token}, true)`;
    const sessions = await tx.authSession.findMany({
      where: {
        userId: session.userId,
        expiresAt: { gt: new Date() },
        createdAt: { gt: new Date(Date.now() - sessionLimitMs) },
      },
      orderBy: { createdAt: "desc" },
      select: { id: true, createdAt: true, expiresAt: true },
      take: 25,
    });
    return {
      email: user.email,
      emailEnrolled: user.emailEnrolled,
      mailboxPaused: user.mailboxPaused,
      googleLinked: user.identities.some(
        ({ providerId }) => providerId === "google",
      ),
      sessions: sessions.map((record) => ({
        id: record.id,
        createdAt: record.createdAt.toISOString(),
        expiresAt: record.expiresAt.toISOString(),
        current: record.id === session.id,
      })),
    };
  });
}

async function securityStatus(request: Request): Promise<Response> {
  canonicalHost(request.headers, runtime().auth);
  return reply(200, await securitySnapshot(request.headers));
}

async function revokeSession(request: Request): Promise<Response> {
  const { id } = await input(
    request,
    z.strictObject({ id: z.string().regex(/^[\w-]{1,80}$/) }),
  );
  const { auth } = runtime();
  const removedCurrent = await transaction(async (tx) => {
    const session = await requireSession(tx, request.headers, true);
    await tx.$executeRaw`SELECT set_config('flow.current_session_token', ${session.token}, true)`;
    const removed = await tx.authSession.deleteMany({
      where: { userId: session.userId, id },
    });
    if (removed.count)
      await audit(tx, "revoke-session", session.userId, undefined, id);
    return id === session.id;
  });
  const headers = privateHeaders();
  if (removedCurrent)
    headers.append("set-cookie", cookie(auth, auth.cookies.session, "", 0));
  return reply(204, undefined, headers);
}

export function authRoute(request: Request, path: string): Promise<Response> {
  return api(async () => {
    switch (`${request.method} ${path}`) {
      case "POST google/start":
        return beginGoogle(request, false);
      case "GET callback/google":
        return finishGoogle(request);
      case "POST email/start":
        return sendCode(request, false);
      case "POST email/verify":
        return verifyCode(request, false);
      case "POST sign-out":
        return signOut(request);
      default:
        return reply(404, { error: "NOT_FOUND" });
    }
  });
}

export function securityRoute(
  request: Request,
  path: string,
): Promise<Response> {
  return api(async () => {
    switch (`${request.method} ${path}`) {
      case "GET status":
        return securityStatus(request);
      case "POST code/start":
        return sendCode(request, true);
      case "POST code/verify":
        return verifyCode(request, true);
      case "POST google/link":
        return beginGoogle(request, true);
      case "POST google/unlink":
        return changeSecurity(request, "unlink-google");
      case "POST email/enroll":
        return changeSecurity(request, "enroll-email");
      case "POST email/disable":
        return changeSecurity(request, "disable-email");
      case "POST sessions/revoke-all":
        return changeSecurity(request, "revoke-all");
      case "POST sessions/revoke":
        return revokeSession(request);
      default:
        return reply(404, { error: "NOT_FOUND" });
    }
  });
}

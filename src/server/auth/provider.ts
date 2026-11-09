import "server-only";
import { createHash, createHmac } from "node:crypto";
import { prismaAdapter } from "@better-auth/prisma-adapter";
import { betterAuth } from "better-auth";
import { emailOTP } from "better-auth/plugins/email-otp";
import { createRemoteJWKSet, jwtVerify } from "jose";
import { z } from "zod";
import type { AuthConfig } from "../../foundation/auth-environment.ts";
import { getPrismaClient, type FlowDb } from "../../foundation/prisma.ts";
import { ApiFailure } from "../http.ts";

export const emailAddress = z
  .string()
  .trim()
  .toLowerCase()
  .max(254)
  .pipe(z.email());
export const sessionIdleSeconds = 12 * 60 * 60;
export const sessionLimitMs = 7 * 24 * 60 * 60 * 1_000;
export const otpSeconds = 300;
export const otpAttempts = 5;

const googleIssuer = ["https://accounts.google.com", "accounts.google.com"];
const googleKeys = createRemoteJWKSet(
  new URL("https://www.googleapis.com/oauth2/v3/certs"),
  {
    timeoutDuration: 3_500,
  },
);

export function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function keyedDigest(
  key: string,
  purpose: string,
  value: string,
): string {
  return createHmac("sha256", key)
    .update(purpose)
    .update("\0")
    .update(value)
    .digest("hex");
}

export async function lockAuthUser(db: FlowDb, id: string): Promise<void> {
  await db.$queryRaw`SELECT id FROM flow.auth_users WHERE id = ${id} FOR UPDATE`;
}

type AuthContext = {
  emailLogin?: string;
  emailSlot?: string;
  emailDigest?: string;
  google?: { nonceHash: string; startOrder: bigint; linkUserId?: string };
  captureOtp?: (email: string, code: string) => void;
};

type VerifiedGoogle = {
  subject: string;
  identity: { id: string; userId: string } | null;
  registeredUserId?: string;
};

const discardedCredentials = {
  accessToken: null,
  refreshToken: null,
  idToken: null,
  accessTokenExpiresAt: null,
  refreshTokenExpiresAt: null,
  scope: null,
  password: null,
};

export function provider(
  db: FlowDb,
  config: AuthConfig,
  context: AuthContext = {},
) {
  const google = context.google;
  let verifiedGoogle: VerifiedGoogle | undefined;

  // The caller holds the same auth-user lock as Google unlink and relink.
  async function requireCurrentGoogleBinding(userId: string) {
    const proof = verifiedGoogle;
    if (!google || google.linkUserId || !proof)
      throw new ApiFailure(401, "INVALID_PROOF");
    const active = await db.authIdentity.findUnique({
      where: {
        providerId_accountId: {
          providerId: "google",
          accountId: proof.subject,
        },
      },
      select: { id: true, userId: true, googleBindingOrder: true },
    });
    if (
      active?.userId !== userId ||
      (proof.identity
        ? active.id !== proof.identity.id ||
          userId !== proof.identity.userId ||
          active.googleBindingOrder >= google.startOrder
        : proof.registeredUserId !== userId)
    ) {
      throw new ApiFailure(401, "INVALID_PROOF");
    }
  }

  const sessionDb = new Proxy(db, {
    get(target, prop, receiver) {
      if (
        prop === "authSession" ||
        prop === "AuthSession" ||
        (typeof prop === "string" && prop.toLowerCase() === "authsession")
      ) {
        const authSession =
          (target as Record<string, unknown>).authSession ??
          (target as Record<string, unknown>).AuthSession;
        if (authSession && typeof authSession === "object") {
          return new Proxy(authSession as Record<string, unknown>, {
            get(sTarget, sProp) {
              if (sProp === "create") {
                return async (args: {
                  data?: { userId?: string; user_id?: string };
                }) => {
                  if (google && verifiedGoogle?.identity) {
                    const dbWithTx = target as {
                      $transaction?: <T>(
                        fn: (tx: FlowDb) => Promise<T>,
                      ) => Promise<T>;
                    };
                    if (typeof dbWithTx.$transaction === "function") {
                      const userId =
                        args?.data?.userId ??
                        args?.data?.user_id ??
                        verifiedGoogle!.identity!.userId;
                      const workerDb = getPrismaClient("worker");
                      const [ticket] = await workerDb.$queryRaw<
                        { id: string }[]
                      >`
                        SELECT flow.issue_google_auth_ticket(${verifiedGoogle!.subject}, ${userId}, ${google!.startOrder}) AS id
                      `;
                      return await dbWithTx.$transaction(async (tx) => {
                        await lockAuthUser(tx, userId);
                        if (google) await requireCurrentGoogleBinding(userId);
                        if (ticket?.id) {
                          await tx.$executeRaw`
                            SELECT set_config('flow.active_auth_ticket_id', ${ticket.id}, true)
                          `;
                        }
                        return await tx.authSession.create(
                          args as Parameters<typeof tx.authSession.create>[0],
                        );
                      });
                    }
                  }
                  const createDelegate = (
                    sTarget as { create?: (a: unknown) => Promise<unknown> }
                  ).create;
                  if (typeof createDelegate === "function") {
                    return await createDelegate(args);
                  }
                  return undefined;
                };
              }
              return Reflect.get(sTarget, sProp);
            },
          });
        }
      }
      return Reflect.get(target, prop, receiver);
    },
  });

  return betterAuth({
    appName: "FLOW",
    baseURL: config.origin,
    secret: config.secret,
    trustedOrigins: [config.origin],
    // The FLOW transaction is shared by its checks and the library's writes.
    database: prismaAdapter(sessionDb, {
      provider: "postgresql",
      transaction: false,
    }),
    logger: { disabled: true },
    rateLimit: { enabled: false },
    session: {
      modelName: "AuthSession",
      expiresIn: sessionIdleSeconds,
      updateAge: 60 * 60,
      cookieCache: { enabled: false },
    },
    verification: { modelName: "AuthVerification", storeIdentifier: "hashed" },
    user: {
      modelName: "AuthUser",
      additionalFields: {
        emailEnrolled: {
          type: "boolean",
          defaultValue: false,
          input: false,
          returned: false,
        },
        mailboxPaused: {
          type: "boolean",
          defaultValue: false,
          input: false,
          returned: false,
        },
      },
    },
    account: {
      modelName: "AuthIdentity",
      storeStateStrategy: "database",
      updateAccountOnSignIn: false,
      accountLinking: {
        enabled: true,
        disableImplicitLinking: true,
        allowDifferentEmails: false,
      },
    },
    advanced: {
      // FLOW supplies its own host-only cookie names and transport attributes.
      useSecureCookies: false,
      defaultCookieAttributes: { secure: config.secure },
      ipAddress: { disableIpTracking: true },
      cookies: {
        session_token: { name: config.cookies.session },
        state: { name: config.cookies.state },
      },
    },
    socialProviders: {
      google: {
        clientId: config.googleId,
        clientSecret: config.googleSecret,
        disableIdTokenSignIn: true,
        includeGrantedScopes: false,
        async getUserInfo(tokens) {
          if (!tokens.idToken || !google) return null;
          const proof = await jwtVerify(tokens.idToken, googleKeys, {
            issuer: googleIssuer,
            audience: config.googleId,
            algorithms: ["RS256"],
            maxTokenAge: "10 minutes",
            requiredClaims: ["sub", "iat", "exp", "nonce"],
          }).catch(() => null);
          if (!proof) return null;
          const claims = proof.payload;
          const subject = claims.sub;
          if (
            !subject ||
            subject.length > 255 ||
            (claims.azp !== undefined && claims.azp !== config.googleId) ||
            (Array.isArray(claims.aud) && claims.aud.length !== 1) ||
            typeof claims.nonce !== "string" ||
            digest(claims.nonce) !== google.nonceHash
          )
            return null;

          const email = emailAddress.safeParse(claims.email);
          const domain = email.success
            ? email.data.split("@").at(-1)
            : undefined;
          const authoritative =
            claims.email_verified === true &&
            !!domain &&
            (domain === "gmail.com" ||
              (typeof claims.hd === "string" &&
                claims.hd.toLowerCase() === domain));
          const name =
            typeof claims.name === "string"
              ? claims.name.trim().slice(0, 80)
              : "Personal";
          const data = {
            sub: subject,
            iss: claims.iss ?? "",
            aud: config.googleId,
            azp: typeof claims.azp === "string" ? claims.azp : config.googleId,
            exp: claims.exp ?? 0,
            iat: claims.iat ?? 0,
            email: email.success ? email.data : "",
            email_verified: authoritative,
            name,
            given_name: "",
            family_name: "",
            picture: "",
          };
          const identity = await db.authIdentity.findUnique({
            where: {
              providerId_accountId: {
                providerId: "google",
                accountId: subject,
              },
            },
            include: { user: true },
          });
          const linkUserId = google.linkUserId;
          if (linkUserId && identity && identity.userId !== linkUserId)
            return null;
          verifiedGoogle = {
            subject,
            identity: identity && { id: identity.id, userId: identity.userId },
          };
          if (
            identity &&
            !linkUserId &&
            (!authoritative || email.data !== identity.user.email)
          ) {
            await lockAuthUser(db, identity.userId);
            await requireCurrentGoogleBinding(identity.userId);
            await db.authUser.update({
              where: { id: identity.userId },
              data: { mailboxPaused: true, emailEnrolled: false },
            });
            await db.authSession.deleteMany({
              where: { userId: identity.userId },
            });
            return {
              user: {
                email: identity.user.email,
                emailVerified: true,
                name: identity.user.name,
              },
              data,
            };
          }
          if (!authoritative || !email.success) return null;
          return {
            user: {
              email: email.data,
              emailVerified: true,
              name,
            },
            data,
          };
        },
      },
    },
    databaseHooks: {
      user: {
        create: {
          async before(user) {
            if (context.emailLogin && user.email !== context.emailLogin) {
              throw new ApiFailure(401, "INVALID_PROOF");
            }
            return { data: { ...user, emailEnrolled: !!context.emailLogin } };
          },
        },
      },
      session: {
        create: {
          async before(session) {
            if (google && verifiedGoogle?.identity) {
              const dbWithTx = db as {
                $transaction?: <T>(
                  fn: (tx: FlowDb) => Promise<T>,
                ) => Promise<T>;
              };
              if (typeof dbWithTx.$transaction === "function") {
                return;
              }
            }
            await lockAuthUser(db, session.userId);
            if (google) await requireCurrentGoogleBinding(session.userId);
            if (context.emailLogin) {
              const user = await db.authUser.findUnique({
                where: { id: session.userId },
              });
              if (
                !user?.emailEnrolled ||
                user.mailboxPaused ||
                user.email !== context.emailLogin
              ) {
                throw new ApiFailure(401, "INVALID_PROOF");
              }
              if (context.emailSlot && context.emailDigest) {
                const workerDb = getPrismaClient("worker");
                const [ticket] = await workerDb.$queryRaw<{ id: string }[]>`
                  SELECT flow.issue_email_auth_ticket(${context.emailSlot}, ${context.emailDigest}) AS id
                `;
                if (ticket?.id) {
                  await db.$executeRaw`
                    SELECT set_config('flow.active_auth_ticket_id', ${ticket.id}, true)
                  `;
                }
              }
            } else if (google && verifiedGoogle) {
              const workerDb = getPrismaClient("worker");
              const [ticket] = await workerDb.$queryRaw<{ id: string }[]>`
                SELECT flow.issue_google_auth_ticket(${verifiedGoogle.subject}, ${session.userId}, ${google.startOrder}) AS id
              `;
              if (ticket?.id) {
                await db.$executeRaw`
                  SELECT set_config('flow.active_auth_ticket_id', ${ticket.id}, true)
                `;
              }
            }
          },
        },
      },
      account: {
        create: {
          async before(account) {
            const proof = verifiedGoogle;
            if (
              !google ||
              proof?.subject !== account.accountId ||
              account.providerId !== "google" ||
              (google.linkUserId && google.linkUserId !== account.userId)
            ) {
              throw new ApiFailure(401, "INVALID_PROOF");
            }
            const inserted = await db.$executeRaw`
              INSERT INTO flow.google_subject_bindings (subject, user_id)
              VALUES (${account.accountId}, ${account.userId}) ON CONFLICT (subject) DO NOTHING
            `;
            const binding = await db.googleSubjectBinding.findUnique({
              where: { subject: account.accountId },
            });
            if (binding?.userId !== account.userId)
              throw new ApiFailure(401, "INVALID_PROOF");
            if (!google.linkUserId) {
              // Only a first registration in this transaction can create its own binding.
              if (proof.identity || inserted !== 1)
                throw new ApiFailure(401, "INVALID_PROOF");
              proof.registeredUserId = account.userId;
            }
            return { data: { ...account, ...discardedCredentials } };
          },
        },
        update: {
          async before(account) {
            return { data: { ...account, ...discardedCredentials } };
          },
        },
      },
    },
    plugins: [
      emailOTP({
        otpLength: 8,
        expiresIn: otpSeconds,
        allowedAttempts: otpAttempts,
        storeOTP: {
          hash: async (otp) => keyedDigest(config.otpKey, "email-otp", otp),
        },
        async sendVerificationOTP({ email, otp }) {
          if (!context.captureOtp) throw new ApiFailure(503, "UNAVAILABLE");
          context.captureOtp(email, otp);
        },
      }),
    ],
  });
}

import "server-only";
import type { AuthConfig } from "../../foundation/auth-environment.ts";
import { runtime, type FlowDb } from "../../foundation/prisma.ts";
import { ApiFailure } from "../http.ts";
import { lockAuthUser, provider, sessionLimitMs } from "./provider.ts";

export function authHeaders(source: Headers): Headers {
  const headers = new Headers();
  for (const name of ["cookie", "origin", "host", "sec-fetch-site"] as const) {
    const value = source.get(name);
    if (value) headers.set(name, value);
  }
  return headers;
}

export function forwardCookies(
  target: Headers,
  source: Headers,
  ...allowed: string[]
): void {
  for (const cookie of source.getSetCookie()) {
    const name = cookie.slice(0, cookie.indexOf("="));
    if (allowed.includes(name)) target.append("set-cookie", cookie);
  }
}

export function cookie(
  config: AuthConfig,
  name: string,
  value: string,
  seconds: number,
): string {
  return `${name}=${value}; Path=/; Max-Age=${seconds}; HttpOnly; SameSite=Lax${config.secure ? "; Secure" : ""}`;
}

export function extractCookieSessionToken(
  headers: Headers,
  cookieName: string,
): string | null {
  const cookieHeader = headers.get("cookie");
  if (!cookieHeader) return null;
  const parts = cookieHeader.split(";").map((part) => part.trim());
  const prefix = `${cookieName}=`;
  const match = parts.find((part) => part.startsWith(prefix));
  if (!match) return null;
  const raw = match.slice(prefix.length);
  const decoded = decodeURIComponent(raw);
  const token = decoded.split(".")[0];
  return token && token.length > 0 ? token : null;
}

export function readNonce(headers: Headers, name: string): string | undefined {
  const matches = headers
    .get("cookie")
    ?.split(";")
    .map((part) => part.trim())
    .filter((part) => part.startsWith(`${name}=`));
  const value =
    matches?.length === 1 ? matches[0]?.slice(name.length + 1) : undefined;
  return value && /^[a-f0-9]{64}$/.test(value) ? value : undefined;
}

export async function readSession(
  db: FlowDb,
  headers: Headers,
  refresh = false,
) {
  const { auth } = runtime();
  const rawHeaders = authHeaders(headers);
  const candidateToken =
    extractCookieSessionToken(headers, auth.cookies.session) ??
    headers
      .get("authorization")
      ?.replace(/^Bearer\s+/i, "")
      .trim() ??
    null;

  const resolveWithContext = async (tx: FlowDb) => {
    if (candidateToken) {
      await tx.$executeRaw`SELECT set_config('flow.current_session_token', ${candidateToken}, true)`;
    }
    const result = await provider(tx, auth).api.getSession({
      headers: rawHeaders,
      query: { disableRefresh: !refresh },
      returnHeaders: true,
    });
    const session = result.response?.session;
    if (
      !session ||
      Date.now() >= new Date(session.createdAt).getTime() + sessionLimitMs
    )
      return null;
    return {
      id: session.id,
      userId: session.userId,
      token: (session as { token?: string }).token ?? candidateToken,
      headers: result.headers,
    };
  };

  const dbWithTx = db as {
    $transaction?: <T>(fn: (tx: FlowDb) => Promise<T>) => Promise<T>;
  };
  if (typeof dbWithTx.$transaction === "function") {
    return dbWithTx.$transaction(resolveWithContext);
  }
  return resolveWithContext(db);
}

export async function requireSession(
  db: FlowDb,
  headers: Headers,
  lock = false,
  refresh = false,
) {
  const session = await readSession(db, headers, refresh);
  if (!session) throw new ApiFailure(401, "AUTH_REQUIRED");
  if (lock) {
    await lockAuthUser(db, session.userId);
    await db.$executeRaw`SELECT set_config('flow.current_session_token', ${session.token}, true)`;
    const current = await db.authSession.findUnique({
      where: { id: session.id },
    });
    if (!current || current.expiresAt.getTime() <= Date.now())
      throw new ApiFailure(401, "AUTH_REQUIRED");
  }
  return session;
}

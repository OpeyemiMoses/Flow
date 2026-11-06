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
  const result = await provider(db, auth).api.getSession({
    headers: authHeaders(headers),
    query: { disableRefresh: !refresh },
    returnHeaders: true,
  });
  const session = result.response?.session;
  if (
    !session ||
    Date.now() >= new Date(session.createdAt).getTime() + sessionLimitMs
  )
    return null;
  return { id: session.id, userId: session.userId, headers: result.headers };
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
    const current = await db.authSession.findUnique({
      where: { id: session.id },
    });
    if (!current || current.expiresAt.getTime() <= Date.now())
      throw new ApiFailure(401, "AUTH_REQUIRED");
  }
  return session;
}

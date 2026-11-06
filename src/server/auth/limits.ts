import "server-only";
import { isIP } from "node:net";
import { runtime, type FlowDb } from "../../foundation/prisma.ts";
import { keyedDigest } from "./provider.ts";

export async function withinBudget(
  bucket: string,
  limit: number,
  seconds: number,
  db: FlowDb = runtime().db,
): Promise<boolean> {
  const { auth } = runtime();
  const key = keyedDigest(auth.otpKey, "rate-limit", bucket);
  const now = new Date();
  const expiry = new Date(now.getTime() + seconds * 1_000);
  const changed = await db.$queryRaw<{ count: number }[]>`
    INSERT INTO flow.auth_throttles (key, count, expires_at) VALUES (${key}, 1, ${expiry})
    ON CONFLICT (key) DO UPDATE
      SET count = CASE WHEN auth_throttles.expires_at <= ${now}
        THEN 1 ELSE auth_throttles.count + 1 END,
        expires_at = CASE WHEN auth_throttles.expires_at <= ${now}
        THEN ${expiry} ELSE auth_throttles.expires_at END
      WHERE auth_throttles.expires_at <= ${now} OR auth_throttles.count < ${limit}
    RETURNING count
  `;
  return changed.length === 1;
}

export async function clientBudget(
  request: Request,
  operation: string,
): Promise<boolean> {
  const { auth } = runtime();
  const supplied = auth.clientIpHeader
    ? request.headers.get(auth.clientIpHeader)
    : null;
  const address = supplied && isIP(supplied) ? supplied : "unknown";
  return withinBudget(
    `${operation}:client:${address}`,
    address === "unknown" ? 180 : 30,
    900,
  );
}

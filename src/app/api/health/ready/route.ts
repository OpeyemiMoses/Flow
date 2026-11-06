import "server-only";
import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import {
  assertDatabaseReady,
  createDatabasePool,
} from "../../../../foundation/database.ts";
import { readConfig } from "../../../../foundation/environment.ts";
import { errorCode } from "../../../../foundation/errors.ts";
import { log } from "../../../../foundation/logger.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const headers = { "Cache-Control": "no-store" };
let pool: Pool | undefined;

export async function GET(): Promise<Response> {
  try {
    const { database } = readConfig(process.env, "runtime");
    pool ??= createDatabasePool(database);
    await assertDatabaseReady(pool, database);
    return Response.json({ status: "ready" }, { headers });
  } catch (error) {
    const requestId = randomUUID();
    log("error", "readiness_failed", { code: errorCode(error), requestId });
    return Response.json(
      { status: "unavailable", requestId },
      { status: 503, headers },
    );
  }
}

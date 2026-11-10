import pg from "pg";
import type { DatabaseTarget } from "./environment.ts";
import { FlowError } from "./errors.ts";
import { log } from "./logger.ts";

export function createDatabasePool(
  target: DatabaseTarget,
  purpose: "readiness" | "application" = "readiness",
): pg.Pool {
  const connectionUrl = new URL(target.url);
  // pg replaces explicit TLS options when the connection string has SSL parameters.
  connectionUrl.search = "";
  const pool = new pg.Pool({
    connectionString: connectionUrl.href,
    options: "-c timezone=UTC",
    ssl: target.tls ? { rejectUnauthorized: true } : false,
    application_name: `flow-${purpose}`,
    connectionTimeoutMillis: 1_500,
    query_timeout: 1_500,
    statement_timeout: 1_500,
    max: purpose === "readiness" ? 2 : 8,
  });
  pool.on("error", () => {
    log("error", "database_idle_connection_failed", {
      code: "DATABASE_UNAVAILABLE",
    });
  });
  return pool;
}

export async function assertDatabaseReady(
  pool: pg.Pool,
  target: DatabaseTarget,
): Promise<void> {
  const result = await pool
    .query<{ database_name: string; runtime_role: string; ready: boolean }>(
      `
      SELECT pg_catalog.current_database() AS database_name, current_user AS runtime_role,
        session_user = current_user
        AND NOT (app.rolsuper OR app.rolcreaterole OR app.rolcreatedb
                 OR app.rolreplication OR app.rolbypassrls)
        AND NOT pg_catalog.has_database_privilege(pg_catalog.current_database(), 'CREATE')
        AND NOT EXISTS (
          SELECT 1 FROM pg_catalog.pg_auth_members WHERE member = app.oid
        )
        AND EXISTS (
          SELECT 1 FROM pg_catalog.pg_namespace
          WHERE nspname = 'flow'
            AND pg_catalog.has_schema_privilege(oid, 'USAGE')
        )
        AND NOT EXISTS (
          SELECT 1 FROM pg_catalog.pg_namespace
          WHERE pg_catalog.has_schema_privilege(oid, 'CREATE')
        ) AS ready
      FROM pg_catalog.pg_roles AS app
      WHERE app.rolname = current_user
    `,
    )
    .catch(() => {
      throw new FlowError(
        "DATABASE_UNAVAILABLE",
        "PostgreSQL readiness query failed.",
      );
    });

  const row = result.rows[0];
  if (
    row?.database_name !== target.name ||
    row.runtime_role !== target.role ||
    !row.ready
  ) {
    throw new FlowError(
      "DATABASE_NOT_READY",
      "PostgreSQL target or runtime privileges are invalid.",
    );
  }
}

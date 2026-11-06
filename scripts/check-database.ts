import {
  assertDatabaseReady,
  createDatabasePool,
} from "../src/foundation/database.ts";
import { readConfig } from "../src/foundation/environment.ts";
import { errorCode } from "../src/foundation/errors.ts";
import { log } from "../src/foundation/logger.ts";

try {
  const { database, environment } = readConfig(process.env, "runtime");
  const pool = createDatabasePool(database);
  try {
    await assertDatabaseReady(pool, database);
    log("info", "database_ready", { environment });
  } finally {
    await pool.end();
  }
} catch (error) {
  log("error", "database_check_failed", { code: errorCode(error) });
  process.exitCode = 1;
}

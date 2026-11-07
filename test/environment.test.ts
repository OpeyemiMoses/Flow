import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { parseEnv } from "node:util";
import pg from "pg";
import { createDatabasePool } from "../src/foundation/database.ts";
import {
  assertWebEnvironment,
  assertWorkerEnvironment,
  readConfig,
} from "../src/foundation/environment.ts";

const testPassword = "fixture-only-password";

function localEnvironment(environment: "local" | "test") {
  return {
    FLOW_ENV: environment,
    FLOW_EXECUTION: "disabled",
    FLOW_DATABASE_URL: `postgresql://flow_${environment}_app:${testPassword}@127.0.0.1:55432/flow_${environment}`,
  };
}

function migrationEnvironment({
  FLOW_DATABASE_URL,
  ...selectors
}: ReturnType<typeof localEnvironment> | ReturnType<typeof remoteEnvironment>) {
  return {
    ...selectors,
    FLOW_MIGRATION_DATABASE_URL: FLOW_DATABASE_URL.replace(
      `flow_${selectors.FLOW_ENV}_app`,
      `flow_${selectors.FLOW_ENV}_migrator`,
    ).replace("sslmode=verify-full", "sslmode=require&sslaccept=strict"),
  };
}

function remoteEnvironment(environment: "staging" | "production") {
  return {
    FLOW_ENV: environment,
    FLOW_EXECUTION: "disabled",
    FLOW_DATABASE_URL: `postgresql://flow_${environment}_app:${testPassword}@db.flow.example:5432/flow_${environment}?sslmode=verify-full`,
  };
}

const invalid = { code: "INVALID_CONFIGURATION" };

for (const environment of ["local", "test"] as const) {
  test(`accepts isolated ${environment} runtime and migration targets`, () => {
    const source = localEnvironment(environment);
    const runtime = readConfig(source, "runtime");
    const migration = readConfig(migrationEnvironment(source), "migration");
    assert.equal(runtime.environment, environment);
    assert.equal(runtime.execution, "disabled");
    assert.equal(runtime.database.role, `flow_${environment}_app`);
    assert.equal(migration.database.role, `flow_${environment}_migrator`);
    assert.equal(runtime.database.tls, false);
  });
}

for (const environment of ["staging", "production"] as const) {
  test(`requires the ${environment} identity and verified TLS`, () => {
    const source = remoteEnvironment(environment);
    const migration = migrationEnvironment(source);

    assert.equal(readConfig(source, "runtime").database.tls, true);
    assert.equal(readConfig(migration, "migration").database.tls, true);
    assert.throws(
      () =>
        readConfig(
          {
            ...migration,
            FLOW_MIGRATION_DATABASE_URL:
              migration.FLOW_MIGRATION_DATABASE_URL.replace(
                "&sslaccept=strict",
                "",
              ),
          },
          "migration",
        ),
      invalid,
    );
  });
}

test("rejects unset or unknown environments and live execution", () => {
  const source = localEnvironment("local");
  assert.throws(() => readConfig({}, "runtime"), invalid);
  assert.throws(
    () => readConfig({ ...source, FLOW_ENV: "preview" }, "runtime"),
    invalid,
  );
  for (const environment of ["local", "test", "staging", "production"]) {
    assert.throws(
      () =>
        readConfig(
          { ...source, FLOW_ENV: environment, FLOW_EXECUTION: "live" },
          "runtime",
        ),
      /FLOW_EXECUTION/,
    );
  }
});

test("blocks cross-environment credentials and targets in both directions", () => {
  for (const [first, second] of [
    [localEnvironment("local"), localEnvironment("test")],
    [remoteEnvironment("staging"), remoteEnvironment("production")],
  ] as const) {
    assert.throws(
      () =>
        readConfig(
          { ...first, FLOW_DATABASE_URL: second.FLOW_DATABASE_URL },
          "runtime",
        ),
      invalid,
    );
    assert.throws(
      () =>
        readConfig(
          { ...second, FLOW_DATABASE_URL: first.FLOW_DATABASE_URL },
          "runtime",
        ),
      invalid,
    );
  }
});

test("rejects runtime and migration credentials used in each other's role", () => {
  const source = localEnvironment("test");
  const migration = migrationEnvironment(source);
  assert.throws(
    () =>
      readConfig(
        { ...source, FLOW_DATABASE_URL: migration.FLOW_MIGRATION_DATABASE_URL },
        "runtime",
      ),
    { ...invalid, message: /as flow_test_app/ },
  );
  assert.throws(
    () =>
      readConfig(
        { ...migration, FLOW_MIGRATION_DATABASE_URL: source.FLOW_DATABASE_URL },
        "migration",
      ),
    { ...invalid, message: /as flow_test_migrator/ },
  );
});

const bootstrapKeys = [
  "FLOW_POSTGRES_ADMIN_PASSWORD",
  "FLOW_LOCAL_APP_PASSWORD",
  "FLOW_LOCAL_MIGRATOR_PASSWORD",
  "FLOW_TEST_APP_PASSWORD",
  "FLOW_TEST_MIGRATOR_PASSWORD",
  "POSTGRES_PASSWORD",
  "POSTGRES_PASSWORD_FILE",
  "PGPASSWORD",
  "PGPASSFILE",
  "DATABASE_URL",
  "DIRECT_URL",
];

test("web configuration and builds reject foreign database credentials in every environment", () => {
  const error = {
    ...invalid,
    message:
      "Supply only the FLOW runtime database credential to this process.",
  };
  for (const runtime of [
    localEnvironment("local"),
    localEnvironment("test"),
    remoteEnvironment("staging"),
    remoteEnvironment("production"),
  ]) {
    for (const key of ["FLOW_MIGRATION_DATABASE_URL", ...bootstrapKeys]) {
      const contaminated = { ...runtime, [key]: testPassword };
      assert.throws(() => readConfig(contaminated, "runtime"), error, key);
      assert.throws(() => assertWebEnvironment(contaminated), error, key);
    }
  }
  assert.throws(
    () => assertWebEnvironment({ FLOW_MIGRATION_DATABASE_URL: "" }),
    error,
  );
});

test("migration rejects a runtime URL or any bootstrap or alternate credential", () => {
  const migration = migrationEnvironment(localEnvironment("test"));
  for (const key of ["FLOW_DATABASE_URL", ...bootstrapKeys]) {
    assert.throws(
      () => readConfig({ ...migration, [key]: testPassword }, "migration"),
      {
        ...invalid,
        message:
          "Supply only the FLOW migration database credential to this process.",
      },
      key,
    );
  }
});

test("the checked-in web dotenv template contains only runtime settings", () => {
  const template = parseEnv(
    readFileSync(new URL("../.env.example", import.meta.url), "utf8"),
  );
  assert.deepEqual(Object.keys(template).sort(), [
    "FLOW_APP_ORIGIN",
    "FLOW_AUTH_SECRET",
    "FLOW_DATABASE_URL",
    "FLOW_ENV",
    "FLOW_EXECUTION",
    "FLOW_GOOGLE_CLIENT_ID",
    "FLOW_GOOGLE_CLIENT_SECRET",
    "FLOW_MAIL_API_KEY",
    "FLOW_MAIL_FROM",
    "FLOW_OTP_KEY",
  ]);
  assert.equal(template.FLOW_ENV, "local");
  assert.equal(template.FLOW_EXECUTION, "disabled");
  assertWebEnvironment(template);
});

test("the checked-in integration dotenv template contains valid syntax and fail-closed defaults", () => {
  const template = parseEnv(
    readFileSync(
      new URL("../.env.integration.example", import.meta.url),
      "utf8",
    ),
  );
  assert.equal(template.FLOW_ENV, "local");
  assert.equal(template.FLOW_EXECUTION, "disabled");
  assert.equal(template.FLOW_PROVIDER_COMPATIBILITY_MODE, "disabled");
  assert.equal(template.FLOW_PROVIDER_COMPATIBILITY_ENVIRONMENT, "testnet");
  assert.equal(template.FLOW_PROVIDER_COMPATIBILITY_MAX_REGISTRATIONS, "1");
  assert.ok(template.FLOW_OUTLAYER_API_URL);
  assert.ok(template.FLOW_NEAR_RPC_URL);
  assert.ok(template.FLOW_BASE_RPC_URL);
  assert.ok(template.FLOW_SOLANA_RPC_URL);
});

test("assertWebEnvironment rejects custody encryption key in web runtime", () => {
  assert.throws(
    () =>
      assertWebEnvironment({
        FLOW_DATABASE_URL:
          "postgresql://flow_local_app:password@127.0.0.1:55432/flow_local",
        FLOW_WALLET_ENCRYPTION_KEY:
          "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      }),
    {
      code: "INVALID_CONFIGURATION",
      message: /Custody encryption keys are isolated to the wallet worker/,
    },
  );
});

test("assertWorkerEnvironment rejects migration database URL in worker runtime", () => {
  assert.throws(
    () =>
      assertWorkerEnvironment({
        FLOW_DATABASE_URL:
          "postgresql://flow_local_app:password@127.0.0.1:55432/flow_local",
        FLOW_MIGRATION_DATABASE_URL:
          "postgresql://flow_local_migrator:password@127.0.0.1:55432/flow_local",
      }),
    {
      code: "INVALID_CONFIGURATION",
      message: /Supply only the FLOW runtime database credential/,
    },
  );
});

test("the npm development command binds explicitly to IPv4 loopback", () => {
  const manifest = JSON.parse(
    readFileSync(new URL("../package.json", import.meta.url), "utf8"),
  );
  assert.match(manifest.scripts.dev, /^next dev\b/);
  assert.deepEqual(
    manifest.scripts.dev.match(/(?:^|\s)(?:--hostname|-H)\s+\S+/g),
    [" --hostname 127.0.0.1"],
  );
});

test("rejects remote local targets and connection string overrides", () => {
  const source = localEnvironment("local");
  for (const url of [
    source.FLOW_DATABASE_URL.replace("127.0.0.1", "db.flow.example"),
    `${source.FLOW_DATABASE_URL}?host=db.flow.example`,
    `${source.FLOW_DATABASE_URL}?dbname=flow_production`,
    source.FLOW_DATABASE_URL.replace(":55432", ""),
  ]) {
    assert.throws(
      () => readConfig({ ...source, FLOW_DATABASE_URL: url }, "runtime"),
      invalid,
    );
  }
});

test("rejects local hosts, weak TLS and duplicate remote parameters", () => {
  const source = remoteEnvironment("production");
  for (const url of [
    source.FLOW_DATABASE_URL.replace("db.flow.example", "127.0.0.1"),
    source.FLOW_DATABASE_URL.replace("verify-full", "require"),
    source.FLOW_DATABASE_URL.replace("?sslmode=verify-full", ""),
    `${source.FLOW_DATABASE_URL}&sslmode=disable`,
  ]) {
    assert.throws(
      () => readConfig({ ...source, FLOW_DATABASE_URL: url }, "runtime"),
      invalid,
    );
  }
});

test("verified TLS survives PostgreSQL driver connection string parsing", async () => {
  const { database } = readConfig(remoteEnvironment("production"), "runtime");
  const pool = createDatabasePool(database);
  try {
    const client = new pg.Client(pool.options);
    assert.deepEqual(client.ssl, { rejectUnauthorized: true });
  } finally {
    await pool.end();
  }
});

test("rejects public variables without copying their names or values into the error", () => {
  assert.throws(
    () =>
      readConfig(
        {
          ...localEnvironment("local"),
          NEXT_PUBLIC_FLOW_DATABASE_URL: testPassword,
        },
        "runtime",
      ),
    {
      code: "INVALID_CONFIGURATION",
      message: "Public environment variables are disabled for FLOW M0.",
    },
  );
});

test("rejects placeholder or malformed URLs without exposing their content", () => {
  const source = localEnvironment("test");
  assert.throws(
    () =>
      readConfig(
        {
          ...source,
          FLOW_DATABASE_URL: source.FLOW_DATABASE_URL.replace(
            testPassword,
            "replace-with-a-password",
          ),
        },
        "runtime",
      ),
    invalid,
  );
  assert.throws(
    () =>
      readConfig(
        { ...source, FLOW_DATABASE_URL: `not a URL ${testPassword}` },
        "runtime",
      ),
    {
      code: "INVALID_CONFIGURATION",
      message: "FLOW_DATABASE_URL must be an encoded PostgreSQL URL.",
    },
  );
});

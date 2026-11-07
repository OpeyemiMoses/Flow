import { isIP } from "node:net";
import { z } from "zod";
import { FlowError } from "./errors.ts";

const environmentSchema = z.object({
  FLOW_ENV: z.enum(["local", "test", "staging", "production"]),
  FLOW_EXECUTION: z.literal("disabled"),
});

type EnvironmentInput = Readonly<Record<string, string | undefined>>;
export type DatabasePurpose = "runtime" | "worker" | "operator" | "migration";

const databaseUrlKeys = {
  runtime: "FLOW_DATABASE_URL",
  worker: "FLOW_WORKER_DATABASE_URL",
  operator: "FLOW_OPERATOR_DATABASE_URL",
  migration: "FLOW_MIGRATION_DATABASE_URL",
} as const;

const otherDatabaseCredentialKeys = [
  "FLOW_POSTGRES_ADMIN_PASSWORD",
  "FLOW_LOCAL_APP_PASSWORD",
  "FLOW_LOCAL_WORKER_PASSWORD",
  "FLOW_LOCAL_OPERATOR_PASSWORD",
  "FLOW_LOCAL_MIGRATOR_PASSWORD",
  "FLOW_TEST_APP_PASSWORD",
  "FLOW_TEST_WORKER_PASSWORD",
  "FLOW_TEST_OPERATOR_PASSWORD",
  "FLOW_TEST_MIGRATOR_PASSWORD",
  "POSTGRES_PASSWORD",
  "POSTGRES_PASSWORD_FILE",
  "PGPASSWORD",
  "PGPASSFILE",
  "DATABASE_URL",
  "DIRECT_URL",
];

export type DatabaseTarget = Readonly<{
  url: string;
  name: string;
  role: string;
  tls: boolean;
}>;

function invalidConfig(message: string): never {
  throw new FlowError("INVALID_CONFIGURATION", message);
}

function assertCredentialScope(
  source: EnvironmentInput,
  purpose: DatabasePurpose,
): void {
  if (Object.keys(source).some((key) => key.startsWith("NEXT_PUBLIC_"))) {
    invalidConfig("Public environment variables are disabled for FLOW M0.");
  }
  const disallowedUrls =
    purpose === "migration"
      ? [
          "FLOW_DATABASE_URL",
          "FLOW_WORKER_DATABASE_URL",
          "FLOW_OPERATOR_DATABASE_URL",
        ]
      : ["FLOW_MIGRATION_DATABASE_URL"];
  if (
    disallowedUrls.some((k) => source[k] !== undefined) ||
    otherDatabaseCredentialKeys.some((key) => source[key] !== undefined)
  ) {
    invalidConfig(
      `Supply only the FLOW ${purpose} database credential to this process.`,
    );
  }
}

export function assertWebEnvironment(source: EnvironmentInput): void {
  assertCredentialScope(source, "runtime");
  if (source.FLOW_WALLET_ENCRYPTION_KEY !== undefined) {
    invalidConfig(
      "Supply only the FLOW web runtime credentials to this process. Custody encryption keys are isolated to the wallet worker.",
    );
  }
  if (source.FLOW_OPERATOR_DATABASE_URL !== undefined) {
    invalidConfig(
      "Supply only the FLOW web runtime credentials to this process. Privileged operator database credentials are strictly isolated.",
    );
  }
}

export function assertWorkerEnvironment(source: EnvironmentInput): void {
  if (source.FLOW_MIGRATION_DATABASE_URL !== undefined) {
    invalidConfig(
      "Migration credentials must remain strictly isolated and are prohibited in worker runtime.",
    );
  }
  if (source.FLOW_OPERATOR_DATABASE_URL !== undefined) {
    invalidConfig(
      "Operator credentials must remain strictly isolated and are prohibited in worker runtime.",
    );
  }
}

export function assertOperatorEnvironment(source: EnvironmentInput): void {
  if (source.FLOW_MIGRATION_DATABASE_URL !== undefined) {
    invalidConfig(
      "Migration credentials must remain strictly isolated and are prohibited in operator runtime.",
    );
  }
  if (source.FLOW_WALLET_ENCRYPTION_KEY !== undefined) {
    invalidConfig(
      "Wallet encryption key is strictly isolated to the wallet worker and is prohibited in operator runtime.",
    );
  }
}

function parseDatabaseUrl(value: string | undefined, variable: string): URL {
  if (!value || /\s/.test(value)) {
    return invalidConfig(`${variable} must be an encoded PostgreSQL URL.`);
  }

  try {
    return new URL(value);
  } catch {
    return invalidConfig(`${variable} must be an encoded PostgreSQL URL.`);
  }
}

function hasDatabasePassword(url: URL): boolean {
  try {
    const password = decodeURIComponent(url.password);
    return password.trim().length >= 16 && !password.startsWith("replace-");
  } catch {
    return false;
  }
}

function hasExpectedTls(
  url: URL,
  purpose: DatabasePurpose,
  tls: boolean,
): boolean {
  if (!tls) {
    return url.search === "";
  }

  if (purpose !== "migration") {
    return (
      url.searchParams.size === 1 &&
      url.searchParams.get("sslmode") === "verify-full"
    );
  }

  return (
    url.searchParams.size === 2 &&
    url.searchParams.get("sslmode") === "require" &&
    url.searchParams.get("sslaccept") === "strict"
  );
}

export function readConfig(source: EnvironmentInput, purpose: DatabasePurpose) {
  assertCredentialScope(source, purpose);

  const result = environmentSchema.safeParse(source);
  if (!result.success) {
    const fields = result.error.issues.map((issue) => issue.path.join("."));
    return invalidConfig(
      `Invalid FLOW configuration fields: ${fields.join(", ")}.`,
    );
  }

  const { FLOW_ENV: environment, FLOW_EXECUTION: execution } = result.data;
  const tls = environment === "staging" || environment === "production";
  const variable = databaseUrlKeys[purpose];
  const databaseName = `flow_${environment}`;
  const roleSuffix =
    purpose === "runtime"
      ? "app"
      : purpose === "worker"
        ? "worker"
        : purpose === "operator"
          ? "operator"
          : "migrator";
  const role = `${databaseName}_${roleSuffix}`;
  const url = parseDatabaseUrl(source[variable], variable);

  if (
    !["postgres:", "postgresql:"].includes(url.protocol) ||
    !url.hostname ||
    !url.port ||
    url.port === "0" ||
    url.hash ||
    url.pathname !== `/${databaseName}` ||
    url.username !== role ||
    !hasDatabasePassword(url)
  ) {
    return invalidConfig(
      `${variable} must target ${databaseName} as ${role} with a real password.`,
    );
  }

  const validHost = tls
    ? isIP(url.hostname) === 0 &&
      /^[a-z0-9.-]+\.[a-z]{2,}$/i.test(url.hostname) &&
      !url.hostname.toLowerCase().endsWith(".localhost")
    : url.hostname === "127.0.0.1" || url.hostname === "[::1]";
  if (!validHost || !hasExpectedTls(url, purpose, tls)) {
    return invalidConfig(
      `${variable} has an invalid host or TLS configuration for ${environment}.`,
    );
  }

  const database: DatabaseTarget = {
    url: url.href,
    name: databaseName,
    role,
    tls,
  };
  return { environment, execution, database };
}

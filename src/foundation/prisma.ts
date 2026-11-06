import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient, type Prisma } from "../generated/prisma/client.ts";
import { readAuthConfig } from "./auth-environment.ts";
import { createDatabasePool } from "./database.ts";
import { readConfig } from "./environment.ts";

type Runtime = { db: PrismaClient; auth: ReturnType<typeof readAuthConfig> };
const processCache = globalThis as typeof globalThis & {
  flowRuntime?: Runtime;
  flowPrismaClient?: PrismaClient;
};

export function getPrismaClient(): PrismaClient {
  if (!processCache.flowPrismaClient) {
    const config = readConfig(process.env, "runtime");
    const pool = createDatabasePool(config.database, "application");
    processCache.flowPrismaClient = new PrismaClient({
      adapter: new PrismaPg(pool, { schema: "flow" }),
    });
  }
  return processCache.flowPrismaClient;
}

export function runtime(): Runtime {
  if (!processCache.flowRuntime) {
    const config = readConfig(process.env, "runtime");
    const auth = readAuthConfig(process.env, config.environment);
    const db = getPrismaClient();
    processCache.flowRuntime = { db, auth };
  }
  return processCache.flowRuntime;
}

export type FlowDb = Prisma.TransactionClient;

export function transaction<T>(
  callback: (tx: FlowDb) => Promise<T>,
  isolationLevel: Prisma.TransactionIsolationLevel = "ReadCommitted",
): Promise<T> {
  return runtime().db.$transaction(callback, {
    isolationLevel,
    maxWait: 2_000,
    timeout: 12_000,
  });
}

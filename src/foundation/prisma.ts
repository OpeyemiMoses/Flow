import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient, type Prisma } from "../generated/prisma/client.ts";
import { readAuthConfig } from "./auth-environment.ts";
import { createDatabasePool } from "./database.ts";
import { readConfig, type DatabasePurpose } from "./environment.ts";

type Runtime = { db: PrismaClient; auth: ReturnType<typeof readAuthConfig> };
const processCache = globalThis as typeof globalThis & {
  flowRuntime?: Runtime;
  flowPrismaClients?: Partial<Record<DatabasePurpose, PrismaClient>>;
};

export function getPrismaClient(
  purpose: DatabasePurpose = "runtime",
): PrismaClient {
  if (!processCache.flowPrismaClients) {
    processCache.flowPrismaClients = {};
  }
  if (!processCache.flowPrismaClients[purpose]) {
    const config = readConfig(process.env, purpose);
    const pool = createDatabasePool(config.database, "application");
    processCache.flowPrismaClients[purpose] = new PrismaClient({
      adapter: new PrismaPg(pool, { schema: "flow" }),
    });
  }
  return processCache.flowPrismaClients[purpose]!;
}

export async function disconnectPrismaClients(): Promise<void> {
  if (processCache.flowPrismaClients) {
    for (const client of Object.values(processCache.flowPrismaClients)) {
      if (client) {
        await client.$disconnect().catch(() => {});
      }
    }
    processCache.flowPrismaClients = {};
  }
}

export function runtime(): Runtime {
  if (!processCache.flowRuntime) {
    const config = readConfig(process.env, "runtime");
    const auth = readAuthConfig(process.env, config.environment);
    const db = getPrismaClient("runtime");
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

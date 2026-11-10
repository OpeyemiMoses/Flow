import "server-only";
import { randomUUID } from "node:crypto";
import {
  REFRESH_COOLDOWN_MS,
  serializePortfolio,
} from "../domain/portfolio.ts";
import { getPrismaClient, runtime, type FlowDb } from "../foundation/prisma.ts";
import { readWalletConfig } from "../foundation/wallet-environment.ts";
import { access, accountProvisioningKey, principal } from "./accounts.ts";
import { getAccountBalances } from "./assets/asset-service.ts";
import {
  getDefaultRpcConfig,
  reconcileWalletBalances,
} from "./assets/connectors/multi-chain-reconciler.ts";
import {
  ensureProvisioningJobForAccount,
  getAccountWalletPublicProjection,
} from "./custody/job-repository.ts";
import { OutLayerAdapter } from "./custody/outlayer-adapter.ts";
import { WalletProvisioningWorker } from "./custody/provisioning-worker.ts";
import { ApiFailure, reply } from "./http.ts";

export type {
  SerializedAccountPortfolio,
  SerializedWalletBalanceRecord,
} from "../domain/portfolio.ts";
export {
  REFRESH_COOLDOWN_MS,
  serializePortfolio,
} from "../domain/portfolio.ts";

const BOUNDED_WAIT_MAX_MS = 3_000;
const BOUNDED_WAIT_STEP_MS = 300;

async function getPortfolioCooldownRemainingSeconds(
  db: FlowDb,
  accountId: string,
  sessionToken?: string,
): Promise<number | undefined> {
  const execute = async (tx: FlowDb) => {
    if (sessionToken) {
      await tx.$executeRaw`SELECT set_config('flow.current_session_token', ${sessionToken}, true)`;
    }
    const rows = await tx.$queryRaw<Array<{ last_refreshed_at: Date | null }>>`
      SELECT last_refreshed_at
      FROM flow.portfolio_refresh_leases
      WHERE account_id = ${accountId}::uuid
    `;
    const lastRefreshedAt = rows[0]?.last_refreshed_at;
    if (!lastRefreshedAt) return undefined;
    const elapsedMs = Math.max(
      0,
      Date.now() - new Date(lastRefreshedAt).getTime(),
    );
    if (elapsedMs < REFRESH_COOLDOWN_MS) {
      return Math.min(
        15,
        Math.max(1, Math.ceil((REFRESH_COOLDOWN_MS - elapsedMs) / 1000)),
      );
    }
    return undefined;
  };
  const dbWithTx = db as {
    $transaction?: <T>(fn: (tx: FlowDb) => Promise<T>) => Promise<T>;
  };
  return typeof dbWithTx.$transaction === "function"
    ? await dbWithTx.$transaction(execute)
    : await execute(db);
}

async function acquirePortfolioRefreshLease(
  db: FlowDb,
  accountId: string,
  leaseHolder: string,
  sessionToken?: string,
): Promise<
  | {
      readonly acquired: true;
      readonly fencingToken: bigint;
      readonly leaseToken: string;
    }
  | {
      readonly acquired: false;
      readonly reason: "COOLDOWN" | "IN_FLIGHT";
      readonly remainingSeconds?: number;
    }
> {
  const execute = async (tx: FlowDb) => {
    if (sessionToken) {
      await tx.$executeRaw`SELECT set_config('flow.current_session_token', ${sessionToken}, true)`;
    }
    const rows = await tx.$queryRaw<
      Array<{
        acquired: boolean;
        reason: string;
        fencing_token: bigint;
        lease_token: string | null;
        remaining_seconds: number;
      }>
    >`
      SELECT acquired, reason, fencing_token, lease_token, remaining_seconds
      FROM flow.acquire_portfolio_refresh_lease(
        ${accountId}::uuid,
        ${leaseHolder}
      )
    `;
    return rows[0];
  };

  const dbWithTx = db as {
    $transaction?: <T>(fn: (tx: FlowDb) => Promise<T>) => Promise<T>;
  };
  const row =
    typeof dbWithTx.$transaction === "function"
      ? await dbWithTx.$transaction(execute)
      : await execute(db);

  if (!row) {
    return { acquired: false, reason: "IN_FLIGHT" };
  }

  if (row.acquired && row.lease_token) {
    return {
      acquired: true,
      fencingToken: row.fencing_token,
      leaseToken: row.lease_token,
    };
  }

  if (row.reason === "COOLDOWN") {
    return {
      acquired: false,
      reason: "COOLDOWN",
      remainingSeconds: Math.min(15, Math.max(1, row.remaining_seconds)),
    };
  }

  return { acquired: false, reason: "IN_FLIGHT" };
}

async function releasePortfolioRefreshLease(
  db: FlowDb,
  accountId: string,
  fencingToken: bigint,
  leaseToken: string,
  success: boolean,
): Promise<void> {
  const execute = async (tx: FlowDb) => {
    await tx.$executeRaw`
      SELECT flow.release_portfolio_refresh_lease(
        ${accountId}::uuid,
        ${fencingToken},
        ${leaseToken}::uuid,
        ${success}
      )
    `;
  };
  const dbWithTx = db as {
    $transaction?: <T>(fn: (tx: FlowDb) => Promise<T>) => Promise<T>;
  };
  if (typeof dbWithTx.$transaction === "function") {
    await dbWithTx.$transaction(execute);
  } else {
    await execute(db);
  }
}

export async function readPortfolio(
  request: Request,
  accountId: string,
): Promise<Response> {
  const { db } = runtime();
  const actor = await principal(db, request.headers);
  await access(db, actor, accountId);

  if (!actor.session.token) {
    throw new ApiFailure(401, "AUTH_REQUIRED");
  }

  const projection = await getAccountBalances(db, accountId, {
    sessionToken: actor.session.token,
  });

  const serialized = serializePortfolio(projection);
  const remaining = await getPortfolioCooldownRemainingSeconds(
    db,
    accountId,
    actor.session.token,
  );
  if (remaining !== undefined) {
    return reply(200, {
      ...serialized,
      cooldownRemainingSeconds: remaining,
    });
  }

  return reply(200, serialized);
}

export async function refreshPortfolio(
  request: Request,
  accountId: string,
): Promise<Response> {
  const { db } = runtime();
  const actor = await principal(db, request.headers);
  await access(db, actor, accountId);

  if (!actor.session.token) {
    throw new ApiFailure(401, "AUTH_REQUIRED");
  }

  const leaseHolder = `lease-${randomUUID()}`;
  const leaseResult = await acquirePortfolioRefreshLease(
    db,
    accountId,
    leaseHolder,
    actor.session.token,
  );

  if (!leaseResult.acquired) {
    if (leaseResult.reason === "COOLDOWN") {
      throw new ApiFailure(429, "REFRESH_RATE_LIMITED");
    }

    // In-flight refresh: bounded wait for concurrent instance to finish
    let waitedMs = 0;
    while (waitedMs < BOUNDED_WAIT_MAX_MS) {
      await new Promise((resolve) => setTimeout(resolve, BOUNDED_WAIT_STEP_MS));
      waitedMs += BOUNDED_WAIT_STEP_MS;

      const check = await (async () => {
        const execute = async (tx: FlowDb) => {
          await tx.$executeRaw`SELECT set_config('flow.current_session_token', ${actor.session.token}, true)`;
          return tx.$queryRaw<
            Array<{
              last_refreshed_at: Date | null;
              lease_expires_at: Date | null;
            }>
          >`
            SELECT last_refreshed_at, lease_expires_at
            FROM flow.portfolio_refresh_leases
            WHERE account_id = ${accountId}::uuid
          `;
        };
        const dbWithTx = db as {
          $transaction?: <T>(fn: (tx: FlowDb) => Promise<T>) => Promise<T>;
        };
        return typeof dbWithTx.$transaction === "function"
          ? await dbWithTx.$transaction(execute)
          : await execute(db);
      })();
      const currentLease = check[0];
      if (
        !currentLease?.lease_expires_at ||
        new Date(currentLease.lease_expires_at).getTime() <= Date.now()
      ) {
        break;
      }
    }
  } else {
    let success = false;
    try {
      const workerDb = getPrismaClient("worker");
      const wallets = await workerDb.$queryRaw<
        Array<{ id: string; environment: string; status: string }>
      >`
        SELECT id, environment, status::text AS status
        FROM flow.wallets
        WHERE account_id = ${accountId}::uuid
        LIMIT 1
      `;
      const wallet = wallets[0];
      if (wallet && wallet.status === "ACTIVE") {
        const config = getDefaultRpcConfig(
          wallet.environment as "testnet" | "mainnet",
        );
        await reconcileWalletBalances(workerDb, wallet.id, config);
      }
      success = true;
    } finally {
      const workerDb = getPrismaClient("worker");
      await releasePortfolioRefreshLease(
        workerDb,
        accountId,
        leaseResult.fencingToken,
        leaseResult.leaseToken,
        success,
      );
    }
  }

  const projection = await getAccountBalances(db, accountId, {
    sessionToken: actor.session.token,
  });

  const serialized = serializePortfolio(projection);
  return reply(200, {
    ...serialized,
    cooldownRemainingSeconds: Math.ceil(REFRESH_COOLDOWN_MS / 1000),
  });
}

export async function provisionAccountWallet(
  request: Request,
  accountId: string,
): Promise<Response> {
  const { db } = runtime();
  const actor = await principal(db, request.headers);
  await access(db, actor, accountId);

  if (!actor.session.token) {
    throw new ApiFailure(401, "AUTH_REQUIRED");
  }

  const workerDb = getPrismaClient("worker");

  await ensureProvisioningJobForAccount(
    workerDb,
    accountId,
    accountProvisioningKey(accountId),
  );

  let walletConfig;
  try {
    walletConfig = readWalletConfig(process.env);
  } catch (err) {
    throw new ApiFailure(
      503,
      err instanceof Error ? err.message : "CUSTODY_CONFIGURATION_ERROR",
    );
  }

  const adapter = new OutLayerAdapter(
    process.env.FLOW_OUTLAYER_API_URL || walletConfig.apiUrl,
    5_000,
    { compatibilityConfig: walletConfig.compatibility },
  );

  const worker = new WalletProvisioningWorker({
    db: workerDb,
    adapter,
    walletConfig,
    workerId: `api-provision-${randomUUID().slice(0, 8)}`,
  });

  const result = await worker.processAccountJob(accountId);

  // If wallet is now ACTIVE, reconcile initial balances from RPC
  const wallets = await workerDb.$queryRaw<
    Array<{ id: string; environment: string; status: string }>
  >`
    SELECT id, environment, status::text AS status
    FROM flow.wallets
    WHERE account_id = ${accountId}::uuid
    LIMIT 1
  `;
  const activeWallet = wallets[0];
  if (activeWallet && activeWallet.status === "ACTIVE") {
    try {
      const rpcConfig = getDefaultRpcConfig(
        activeWallet.environment as "testnet" | "mainnet",
      );
      await reconcileWalletBalances(workerDb, activeWallet.id, rpcConfig);
    } catch {
      // Non-fatal if initial RPC balance check times out; wallet provisioning itself is complete
    }
  }

  const walletProjection = await getAccountWalletPublicProjection(
    workerDb,
    accountId,
  );
  const portfolioProjection = await getAccountBalances(db, accountId, {
    sessionToken: actor.session.token,
  });

  return reply(200, {
    outcome: result.outcome,
    walletStatus: walletProjection
      ? walletProjection.status.toLowerCase()
      : "setup_pending",
    wallet: walletProjection,
    portfolio: serializePortfolio(portfolioProjection),
  });
}

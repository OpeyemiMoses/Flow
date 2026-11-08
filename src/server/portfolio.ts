import "server-only";
import { randomUUID } from "node:crypto";
import {
  REFRESH_COOLDOWN_MS,
  serializePortfolio,
} from "../domain/portfolio.ts";
import { getPrismaClient, runtime, type FlowDb } from "../foundation/prisma.ts";
import { access, principal } from "./accounts.ts";
import { getAccountBalances } from "./assets/asset-service.ts";
import {
  getDefaultRpcConfig,
  reconcileWalletBalances,
} from "./assets/connectors/multi-chain-reconciler.ts";
import { ApiFailure, reply } from "./http.ts";

export type {
  SerializedAccountPortfolio,
  SerializedWalletBalanceRecord,
} from "../domain/portfolio.ts";
export {
  REFRESH_COOLDOWN_MS,
  serializePortfolio,
} from "../domain/portfolio.ts";

const LEASE_DURATION_SECONDS = 10;
const BOUNDED_WAIT_MAX_MS = 3_000;
const BOUNDED_WAIT_STEP_MS = 300;

async function getPortfolioCooldownRemainingSeconds(
  db: FlowDb,
  accountId: string,
): Promise<number | undefined> {
  const rows = await db.$queryRaw<Array<{ last_refreshed_at: Date | null }>>`
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
}

async function acquirePortfolioRefreshLease(
  db: FlowDb,
  accountId: string,
  leaseHolder: string,
): Promise<
  | { readonly acquired: true; readonly fencingToken: bigint }
  | {
      readonly acquired: false;
      readonly reason: "COOLDOWN" | "IN_FLIGHT";
      readonly remainingSeconds?: number;
    }
> {
  const cooldownSeconds = Math.ceil(REFRESH_COOLDOWN_MS / 1000);

  // Check cooldown first
  const current = await db.$queryRaw<
    Array<{ last_refreshed_at: Date | null; lease_expires_at: Date | null }>
  >`
    SELECT last_refreshed_at, lease_expires_at
    FROM flow.portfolio_refresh_leases
    WHERE account_id = ${accountId}::uuid
  `;
  if (current.length > 0 && current[0]?.last_refreshed_at) {
    const elapsedMs = Math.max(
      0,
      Date.now() - new Date(current[0].last_refreshed_at).getTime(),
    );
    if (elapsedMs < REFRESH_COOLDOWN_MS) {
      return {
        acquired: false,
        reason: "COOLDOWN",
        remainingSeconds: Math.min(
          15,
          Math.max(1, Math.ceil((REFRESH_COOLDOWN_MS - elapsedMs) / 1000)),
        ),
      };
    }
  }

  // Atomic lease acquisition with fencing token increment
  const acquiredRows = await db.$queryRaw<Array<{ fencing_token: bigint }>>`
    INSERT INTO flow.portfolio_refresh_leases (
      account_id, last_refreshed_at, lease_expires_at, lease_holder, fencing_token, updated_at
    ) VALUES (
      ${accountId}::uuid,
      NULL,
      CURRENT_TIMESTAMP + (${LEASE_DURATION_SECONDS} || ' seconds')::interval,
      ${leaseHolder},
      1,
      CURRENT_TIMESTAMP
    )
    ON CONFLICT (account_id) DO UPDATE
    SET lease_expires_at = CURRENT_TIMESTAMP + (${LEASE_DURATION_SECONDS} || ' seconds')::interval,
        lease_holder = EXCLUDED.lease_holder,
        fencing_token = flow.portfolio_refresh_leases.fencing_token + 1,
        updated_at = CURRENT_TIMESTAMP
    WHERE (flow.portfolio_refresh_leases.last_refreshed_at IS NULL
           OR flow.portfolio_refresh_leases.last_refreshed_at <= CURRENT_TIMESTAMP - (${cooldownSeconds} || ' seconds')::interval)
      AND (flow.portfolio_refresh_leases.lease_expires_at IS NULL
           OR flow.portfolio_refresh_leases.lease_expires_at <= CURRENT_TIMESTAMP)
    RETURNING fencing_token
  `;

  if (acquiredRows.length > 0 && acquiredRows[0]) {
    return { acquired: true, fencingToken: acquiredRows[0].fencing_token };
  }

  // Determine failure reason
  const latest = await db.$queryRaw<
    Array<{ last_refreshed_at: Date | null; lease_expires_at: Date | null }>
  >`
    SELECT last_refreshed_at, lease_expires_at
    FROM flow.portfolio_refresh_leases
    WHERE account_id = ${accountId}::uuid
  `;
  if (latest.length > 0 && latest[0]?.last_refreshed_at) {
    const elapsedMs = Math.max(
      0,
      Date.now() - new Date(latest[0].last_refreshed_at).getTime(),
    );
    if (elapsedMs < REFRESH_COOLDOWN_MS) {
      return {
        acquired: false,
        reason: "COOLDOWN",
        remainingSeconds: Math.min(
          15,
          Math.max(1, Math.ceil((REFRESH_COOLDOWN_MS - elapsedMs) / 1000)),
        ),
      };
    }
  }

  return { acquired: false, reason: "IN_FLIGHT" };
}

async function releasePortfolioRefreshLease(
  db: FlowDb,
  accountId: string,
  fencingToken: bigint,
  success: boolean,
): Promise<void> {
  if (success) {
    await db.$executeRaw`
      UPDATE flow.portfolio_refresh_leases
      SET last_refreshed_at = CURRENT_TIMESTAMP,
          lease_expires_at = NULL,
          lease_holder = NULL,
          updated_at = CURRENT_TIMESTAMP
      WHERE account_id = ${accountId}::uuid AND fencing_token = ${fencingToken}
    `;
  } else {
    // Fail-closed: release lease holder without updating last_refreshed_at to avoid false freshness
    await db.$executeRaw`
      UPDATE flow.portfolio_refresh_leases
      SET lease_expires_at = NULL,
          lease_holder = NULL,
          updated_at = CURRENT_TIMESTAMP
      WHERE account_id = ${accountId}::uuid AND fencing_token = ${fencingToken}
    `;
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
  const remaining = await getPortfolioCooldownRemainingSeconds(db, accountId);
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

      const check = await db.$queryRaw<
        Array<{
          last_refreshed_at: Date | null;
          lease_expires_at: Date | null;
        }>
      >`
        SELECT last_refreshed_at, lease_expires_at
        FROM flow.portfolio_refresh_leases
        WHERE account_id = ${accountId}::uuid
      `;
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
      const wallets = await db.$queryRaw<
        Array<{ id: string; environment: string }>
      >`
        SELECT id, environment FROM flow.wallets WHERE account_id = ${accountId}::uuid LIMIT 1
      `;
      const wallet = wallets[0];
      if (wallet) {
        const workerDb = getPrismaClient("worker");
        const config = getDefaultRpcConfig(
          wallet.environment as "testnet" | "mainnet",
        );
        await reconcileWalletBalances(workerDb, wallet.id, config);
      }
      success = true;
    } finally {
      await releasePortfolioRefreshLease(
        db,
        accountId,
        leaseResult.fencingToken,
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

import "server-only";
import {
  REFRESH_COOLDOWN_MS,
  serializePortfolio,
} from "../domain/portfolio.ts";
import { getPrismaClient, runtime } from "../foundation/prisma.ts";
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
export { REFRESH_COOLDOWN_MS, serializePortfolio } from "../domain/portfolio.ts";

const refreshState = new Map<
  string,
  { lastRefreshedAt: number; inFlight?: Promise<void> }
>();

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
  const state = refreshState.get(accountId);
  if (state && Date.now() - state.lastRefreshedAt < REFRESH_COOLDOWN_MS) {
    const remaining = Math.ceil(
      (REFRESH_COOLDOWN_MS - (Date.now() - state.lastRefreshedAt)) / 1000,
    );
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

  const state = refreshState.get(accountId);
  const now = Date.now();

  if (state && now - state.lastRefreshedAt < REFRESH_COOLDOWN_MS) {
    throw new ApiFailure(429, "REFRESH_RATE_LIMITED");
  }

  if (state?.inFlight) {
    await state.inFlight;
  } else {
    const inFlightPromise = (async () => {
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
      } finally {
        const entry = refreshState.get(accountId);
        if (entry) {
          entry.inFlight = undefined;
          entry.lastRefreshedAt = Date.now();
        }
      }
    })();

    refreshState.set(accountId, {
      lastRefreshedAt: now,
      inFlight: inFlightPromise,
    });

    await inFlightPromise;
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

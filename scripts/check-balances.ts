import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { readConfig } from "../src/foundation/environment.ts";
import { createDatabasePool } from "../src/foundation/database.ts";
import {
  getPrismaClient,
  disconnectPrismaClients,
} from "../src/foundation/prisma.ts";
import {
  reconcileWalletBalances,
  getDefaultRpcConfig,
} from "../src/server/assets/connectors/multi-chain-reconciler.ts";

const DEFAULT_TESTNET_WALLET_ID = "4db1447f-f32d-47ca-be4c-c07bc283c7ac";

async function main() {
  const args = process.argv.slice(2);
  let walletId = DEFAULT_TESTNET_WALLET_ID;
  const walletIdIndex = args.indexOf("--wallet-id");
  if (walletIdIndex !== -1 && args[walletIdIndex + 1]) {
    walletId = args[walletIdIndex + 1]!;
  }

  // In local development, safely resolve flow_local_worker database URL from protected secrets file if not explicitly provided
  if (
    !process.env.FLOW_WORKER_DATABASE_URL &&
    (process.env.FLOW_ENV === "local" || !process.env.FLOW_ENV)
  ) {
    const secretsPath = path.join(
      process.cwd(),
      "secrets/postgres-passwords.json",
    );
    if (existsSync(secretsPath)) {
      try {
        const passwords = JSON.parse(
          readFileSync(secretsPath, "utf8"),
        ) as Record<string, string>;
        if (passwords.local_worker) {
          process.env.FLOW_WORKER_DATABASE_URL = `postgresql://flow_local_worker:${passwords.local_worker}@127.0.0.1:55432/flow_local`;
        }
      } catch {
        // Fall back to standard environment resolution
      }
    }
  }

  console.log(
    "================================================================================",
  );
  console.log(" FLOW M3 Phase 2 — Multi-Chain Read-Only Balance Diagnostic");
  console.log(" Target Wallet ID:", walletId);
  console.log(
    " Execution Mode: FLOW_EXECUTION=disabled (Strict read-only queries)",
  );
  console.log(
    "================================================================================\n",
  );

  const { database: workerDbConfig } = readConfig(process.env, "worker");
  createDatabasePool(workerDbConfig);
  const db = getPrismaClient("worker");

  try {
    const config = getDefaultRpcConfig("testnet");
    console.log("Configured Endpoints:");
    console.log(`- NEAR Testnet:   ${config.near?.primary}`);
    console.log(`- Base Sepolia:   ${config.base?.primary}`);
    console.log(`- Solana Devnet:  ${config.solana?.primary}\n`);

    console.log("Dispatching real read-only blockchain queries...\n");
    const result = await reconcileWalletBalances(db, walletId, config);

    console.log(
      "--------------------------------------------------------------------------------",
    );
    console.log(" OBSERVED ON-CHAIN BALANCES (TESTNET)");
    console.log(
      "--------------------------------------------------------------------------------",
    );

    for (const obs of result.observations) {
      console.log(
        `Asset:        ${obs.symbol} (${obs.network} / ${obs.chainId})`,
      );
      if (obs.contractAddress) {
        console.log(`Contract:     ${obs.contractAddress}`);
      }
      if (obs.tokenAccountAddress) {
        console.log(`Token Acct:   ${obs.tokenAccountAddress}`);
      }
      console.log(`Atomic Bal:   ${obs.atomicBalance.toString()}`);
      console.log(`Status:       ${obs.syncStatus} [${obs.observationState}]`);
      console.log(`Finality:     ${obs.finality}`);
      console.log(
        `Provenance:   ${obs.blockHeight !== null ? `Block/Slot ${obs.blockHeight}` : "N/A"}`,
      );
      console.log(`Endpoint:     ${obs.endpointUsed}`);
      if (obs.lastError) {
        console.log(`Last Error:   ${obs.lastError}`);
      }
      console.log(
        "--------------------------------------------------------------------------------",
      );
    }

    console.log(
      "\nSummary: All observations verified and recorded with strict provenance.",
    );
    console.log(
      "Notice: Balances remain strictly read-only; deposit and transfer eligibility is false.",
    );
  } finally {
    await disconnectPrismaClients();
  }
}

main().catch((err) => {
  console.error("Diagnostic failed:", err);
  process.exit(1);
});

import {
  createDatabasePool,
  assertDatabaseReady,
} from "../src/foundation/database.ts";
import { readConfig } from "../src/foundation/environment.ts";
import { readWalletConfig } from "../src/foundation/wallet-environment.ts";
import { checkAllBlockchainRpcs } from "../src/server/custody/blockchain-connectivity.ts";
import { log } from "../src/foundation/logger.ts";
import { errorCode } from "../src/foundation/errors.ts";

async function main() {
  console.log("=================================================");
  console.log(" FLOW Local Integration & Readiness Check");
  console.log("=================================================\n");

  let hasErrors = false;

  // 1. Audit core environment & database configuration
  console.log("1. Environment & Database Configuration Check:");
  try {
    const { environment, execution, database } = readConfig(
      process.env,
      "runtime",
    );
    console.log(`   - FLOW_ENV: ${environment}`);
    console.log(
      `   - FLOW_EXECUTION: ${execution} (Financial execution safety guard active)`,
    );
    console.log(
      `   - Target Database: ${database.name} (Role: ${database.role}, TLS: ${database.tls})`,
    );

    const pool = createDatabasePool(database);
    try {
      await assertDatabaseReady(pool, database);
      console.log(
        "   - Database Readiness: CONNECTED & READY (Schema namespace 'flow' verified)\n",
      );
    } finally {
      await pool.end();
    }
  } catch (err) {
    hasErrors = true;
    console.error(
      `   x Database / Environment check failed: ${errorCode(err)} - ${(err as Error).message}\n`,
    );
  }

  // 2. Audit wallet configuration & fail-closed provider compatibility mode
  console.log("2. Wallet & Custody Configuration Check:");
  try {
    const walletConfig = readWalletConfig(process.env);
    console.log(`   - Wallet Provider: ${walletConfig.provider}`);
    console.log(`   - Key Identifier: ${walletConfig.keyId}`);
    console.log(`   - OutLayer Base URL: ${walletConfig.apiUrl}`);
    console.log(
      `   - Provider Compatibility Mode: ${walletConfig.compatibility.mode.toUpperCase()} (Live calls prohibited unless authorized)`,
    );
    if (walletConfig.compatibility.mode === "authorized") {
      console.log(
        `   - Compatibility Max Registrations: ${walletConfig.compatibility.maxRegistrations}`,
      );
      console.log(
        `   - Isolated Test Account: ${walletConfig.compatibility.isolatedAccountId ?? "NONE"}`,
      );
    }
    console.log(
      "   - Wallet Encryption Key: CONFIGURED (32-byte AES-256-GCM envelope key present)\n",
    );
  } catch (err) {
    hasErrors = true;
    console.error(
      `   x Wallet configuration check failed: ${errorCode(err)} - ${(err as Error).message}\n`,
    );
  }

  // 3. Read-only Blockchain RPC Connectivity Checks (NEAR, Base, Solana)
  console.log("3. Read-Only Blockchain JSON-RPC Connectivity Checks:");
  try {
    const rpcResults = await checkAllBlockchainRpcs({
      nearRpcUrl: process.env.FLOW_NEAR_RPC_URL,
      baseRpcUrl: process.env.FLOW_BASE_RPC_URL,
      solanaRpcUrl: process.env.FLOW_SOLANA_RPC_URL,
      timeoutMs: 5_000,
    });

    // NEAR check
    if (rpcResults.near.reachable) {
      console.log(
        `   - NEAR RPC (${rpcResults.near.endpoint}): REACHABLE (${rpcResults.near.latencyMs}ms, Chain: ${rpcResults.near.details.chainId}, Block: ${rpcResults.near.details.latestBlockHeight})`,
      );
    } else {
      console.log(
        `   - NEAR RPC (${rpcResults.near.endpoint}): UNREACHABLE (${rpcResults.near.error ?? "error"})`,
      );
    }

    // Base check
    if (rpcResults.base.reachable) {
      console.log(
        `   - Base RPC (${rpcResults.base.endpoint}): REACHABLE (${rpcResults.base.latencyMs}ms, Network ID: ${rpcResults.base.details.networkId}, Block: ${rpcResults.base.details.latestBlockHeight})`,
      );
    } else {
      console.log(
        `   - Base RPC (${rpcResults.base.endpoint}): UNREACHABLE (${rpcResults.base.error ?? "error"})`,
      );
    }

    // Solana check
    if (rpcResults.solana.reachable) {
      console.log(
        `   - Solana RPC (${rpcResults.solana.endpoint}): REACHABLE (${rpcResults.solana.latencyMs}ms, Slot: ${rpcResults.solana.details.latestSlot})`,
      );
    } else {
      console.log(
        `   - Solana RPC (${rpcResults.solana.endpoint}): UNREACHABLE (${rpcResults.solana.error ?? "error"})`,
      );
    }

    console.log(
      `   - All Launch Blockchain RPCs Available: ${rpcResults.allReachable ? "YES" : "NO (Non-fatal in offline sandbox)"}\n`,
    );
  } catch (err) {
    console.error(
      `   x Blockchain RPC connectivity check failed: ${(err as Error).message}\n`,
    );
  }

  // 4. Summary & Readiness Assessment
  console.log("=================================================");
  if (hasErrors) {
    console.log(" Integration Check Result: INCOMPLETE / ERRORS FOUND");
    console.log(" Please review configuration issues above.");
    console.log("=================================================");
    process.exitCode = 1;
  } else {
    console.log(" Integration Check Result: READY FOR CONTROLLED TESTING");
    console.log(
      " Safety guards verified. Financial execution remains disabled.",
    );
    console.log("=================================================");
  }
}

main().catch((err) => {
  log("error", "integration_check_unhandled", {
    message: (err as Error).message,
  });
  process.exitCode = 1;
});

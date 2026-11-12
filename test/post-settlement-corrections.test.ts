import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  formatAtomicToDisplay,
  parseDisplayToAtomic,
} from "../src/domain/atomic-amounts.ts";
import {
  getActiveDeployments,
  getSupportedNetworksForAsset,
  MAINNET_SUPPORTED_DEPLOYMENTS,
} from "../src/domain/supported-assets-catalog.ts";
import { getExplorerUrl } from "../src/domain/activities.ts";
import { serializePublicPaymentRequest } from "../src/domain/payment-requests.ts";

describe("post-settlement corrections: balance sync, network filtering & receipt finality", () => {
  it("converts 6-decimal USDC atomic balance (1000000) to genuine 1 display without precision loss", () => {
    const atomicUnits = 1_000_000n;
    const decimals = 6;
    const rawDisplay = formatAtomicToDisplay(atomicUnits, decimals);
    assert.equal(rawDisplay, "1");

    const num = Number(rawDisplay);
    assert.equal(num, 1);

    const formattedTwoDecimal = num.toLocaleString("en-US", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 6,
    });
    assert.equal(formattedTwoDecimal, "1.00");

    // Round-trip back to atomic units
    const parsedAtomic = parseDisplayToAtomic("1.00", decimals);
    assert.equal(parsedAtomic, 1_000_000n);
  });

  it("filters out testnets strictly when SHOW_TESTNETS is unset or false", () => {
    // 1. getSupportedNetworksForAsset returns strictly mainnets by default
    const usdcNetworks = getSupportedNetworksForAsset("USDC");
    assert.deepEqual(usdcNetworks, [
      "ethereum-mainnet",
      "base-mainnet",
      "solana-mainnet",
      "near-mainnet",
    ]);

    const ethNetworks = getSupportedNetworksForAsset("ETH");
    assert.deepEqual(ethNetworks, ["ethereum-mainnet", "base-mainnet"]);

    const solNetworks = getSupportedNetworksForAsset("SOL");
    assert.deepEqual(solNetworks, ["solana-mainnet"]);

    const nearNetworks = getSupportedNetworksForAsset("NEAR");
    assert.deepEqual(nearNetworks, ["near-mainnet"]);

    // 2. Mainnet supported deployments are strictly 11 and all mainnet
    assert.equal(MAINNET_SUPPORTED_DEPLOYMENTS.length, 11);
    assert.ok(
      MAINNET_SUPPORTED_DEPLOYMENTS.every((d) => d.environment === "mainnet"),
    );

    // 3. getActiveDeployments(false) returns strictly mainnet deployments
    const active = getActiveDeployments(false);
    assert.equal(active.length, 11);
    assert.ok(active.every((d) => d.environment === "mainnet"));
    assert.ok(!active.some((d) => d.networkKey.includes("sepolia")));
    assert.ok(!active.some((d) => d.networkKey.includes("devnet")));
    assert.ok(!active.some((d) => d.networkKey.includes("testnet")));
  });

  it("produces canonical Solscan and Basescan explorer URLs for verified transactions", () => {
    const solanaSig =
      "59HS1E6p62oQVBSVDgsNMR9eYWMiazzRn6UBXJMp2xXBA6F6YBk1yerq7oe8yXKFUaR51LKz9gDozjcJQoPqx4QC";
    const baseTx =
      "0xf1bf5396ffaa7e7916be7a3766856323fed8fa56c21a169459d84f5454c7ecf1";

    const solscanUrl = getExplorerUrl("solana", solanaSig);
    assert.equal(solscanUrl, `https://solscan.io/tx/${solanaSig}`);

    const basescanUrl = getExplorerUrl("base", baseTx);
    assert.equal(basescanUrl, `https://basescan.org/tx/${baseTx}`);
  });

  it("serializes public payment request preserving recipient address and completed status", () => {
    const dbRow = {
      public_id: "pr_V-8r6xByjmlZkGtBZ6enKWdDQCkf8pC9",
      title: "Invoice #1042",
      description: "Design services",
      destination_network: "base-mainnet",
      destination_asset_id: "base-mainnet:USDC",
      destination_asset_symbol: "USDC",
      destination_decimals: 6,
      amount_mode: "FIXED" as const,
      requested_atomic_amount: "1000000",
      status: "COMPLETED" as const,
      expires_at: new Date(Date.now() + 86400000),
      payer_memo_required: false,
      recipient_name: "FLOW Personal",
      recipient_kind: "PERSONAL" as const,
    };

    const recipientAddress = "0x436BdB38888998e269E94301C2362C2f46bCF614";
    const serialized = serializePublicPaymentRequest(
      dbRow,
      "http://127.0.0.1:3000",
      recipientAddress,
    );

    assert.equal(serialized.status, "COMPLETED");
    assert.equal(serialized.recipientAddress, recipientAddress);
    assert.equal(serialized.displayAmount, "1");
    assert.ok(
      serialized.eligibleSourceRoutes.every(
        (r) =>
          !r.networkKey.includes("sepolia") &&
          !r.networkKey.includes("devnet") &&
          !r.networkKey.includes("testnet"),
      ),
    );
  });
});

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  formatAtomicToDisplay,
  parseDisplayToAtomic,
} from "../src/domain/atomic-amounts.ts";
import {
  canonicalizeNetworkId,
  getActiveDeployments,
  getEquivalentNetworkTokens,
  getSupportedNetworksForAsset,
  MAINNET_SUPPORTED_DEPLOYMENTS,
} from "../src/domain/supported-assets-catalog.ts";
import {
  isBalanceMatchingDeployment,
  type SerializedWalletBalanceRecord,
} from "../src/domain/portfolio.ts";
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

    // When recipientAddress is null, it should NOT substitute any hardcoded fallback
    const serializedNull = serializePublicPaymentRequest(
      dbRow,
      "http://127.0.0.1:3000",
      null,
    );
    assert.equal(serializedNull.recipientAddress, null);
  });

  it("strictly maps canonical network IDs and isolates testnets from mainnets", () => {
    // Canonical mainnet mappings
    assert.equal(canonicalizeNetworkId("ethereum"), "ethereum-mainnet");
    assert.equal(canonicalizeNetworkId("ethereum-mainnet"), "ethereum-mainnet");
    assert.equal(canonicalizeNetworkId("1"), "ethereum-mainnet");
    assert.equal(canonicalizeNetworkId("eip155:1"), "ethereum-mainnet");

    assert.equal(canonicalizeNetworkId("base"), "base-mainnet");
    assert.equal(canonicalizeNetworkId("base-mainnet"), "base-mainnet");
    assert.equal(canonicalizeNetworkId("8453"), "base-mainnet");
    assert.equal(canonicalizeNetworkId("eip155:8453"), "base-mainnet");

    assert.equal(canonicalizeNetworkId("solana"), "solana-mainnet");
    assert.equal(canonicalizeNetworkId("solana-mainnet"), "solana-mainnet");
    assert.equal(canonicalizeNetworkId("solana:mainnet"), "solana-mainnet");

    assert.equal(canonicalizeNetworkId("near"), "near-mainnet");
    assert.equal(canonicalizeNetworkId("near-mainnet"), "near-mainnet");
    assert.equal(canonicalizeNetworkId("near:mainnet"), "near-mainnet");

    // Canonical testnet mappings — strictly distinct!
    assert.equal(canonicalizeNetworkId("base-sepolia"), "base-sepolia");
    assert.equal(canonicalizeNetworkId("84532"), "base-sepolia");
    assert.equal(canonicalizeNetworkId("eip155:84532"), "base-sepolia");

    assert.equal(canonicalizeNetworkId("solana-devnet"), "solana-devnet");
    assert.equal(canonicalizeNetworkId("solana:devnet"), "solana-devnet");

    assert.equal(canonicalizeNetworkId("near-testnet"), "near-testnet");
    assert.equal(canonicalizeNetworkId("near:testnet"), "near-testnet");

    // Arbitrary / unknown strings do not resolve to canonical
    assert.equal(canonicalizeNetworkId("polygon"), null);
    assert.equal(canonicalizeNetworkId(null), null);
    assert.equal(canonicalizeNetworkId(undefined), null);

    // Equivalent network tokens isolation
    const baseTokens = getEquivalentNetworkTokens("base-mainnet");
    assert.deepEqual(baseTokens, ["base", "base-mainnet"]);

    const sepoliaTokens = getEquivalentNetworkTokens("base-sepolia");
    assert.deepEqual(sepoliaTokens, ["base-sepolia"]);
    assert.ok(!sepoliaTokens.includes("base"));
    assert.ok(!sepoliaTokens.includes("base-mainnet"));
  });

  it("verifies all 11 curated mainnet deployments including NEAR USDT with NEP-141", () => {
    assert.equal(MAINNET_SUPPORTED_DEPLOYMENTS.length, 11);

    const ethDeployments = MAINNET_SUPPORTED_DEPLOYMENTS.filter(
      (d) => d.networkKey === "ethereum-mainnet",
    );
    assert.equal(ethDeployments.length, 3);
    assert.deepEqual(
      ethDeployments.map((d) => d.symbol),
      ["ETH", "USDC", "USDT"],
    );

    const baseDeployments = MAINNET_SUPPORTED_DEPLOYMENTS.filter(
      (d) => d.networkKey === "base-mainnet",
    );
    assert.equal(baseDeployments.length, 2);
    assert.deepEqual(
      baseDeployments.map((d) => d.symbol),
      ["ETH", "USDC"],
    );

    const solDeployments = MAINNET_SUPPORTED_DEPLOYMENTS.filter(
      (d) => d.networkKey === "solana-mainnet",
    );
    assert.equal(solDeployments.length, 3);
    assert.deepEqual(
      solDeployments.map((d) => d.symbol),
      ["SOL", "USDC", "USDT"],
    );

    const nearDeployments = MAINNET_SUPPORTED_DEPLOYMENTS.filter(
      (d) => d.networkKey === "near-mainnet",
    );
    assert.equal(nearDeployments.length, 3);
    assert.deepEqual(
      nearDeployments.map((d) => d.symbol),
      ["NEAR", "USDC", "USDT"],
    );

    // Specifically verify NEAR USDT
    const nearUsdt = nearDeployments.find((d) => d.symbol === "USDT");
    assert.ok(nearUsdt, "NEAR USDT deployment must be present");
    assert.equal(nearUsdt.standard, "NEP141");
    assert.equal(nearUsdt.decimals, 6);
    assert.equal(nearUsdt.contractIdentifier, "usdt.tether-token.near");
    assert.equal(nearUsdt.environment, "mainnet");
  });

  it("prevents testnet balances and spoofed tokens from matching mainnet catalog deployments", () => {
    const baseMainnetUsdc = MAINNET_SUPPORTED_DEPLOYMENTS.find(
      (d) => d.id === "base-mainnet:USDC",
    )!;
    assert.ok(baseMainnetUsdc);

    // 1. Legitimate Base Mainnet balance
    const validBaseBalance: SerializedWalletBalanceRecord = {
      id: "bal_base_mainnet_1",
      walletId: "w_1",
      networkAssetId: "na_1",
      tokenAccountAddress: null,
      atomicBalance: "1000000",
      displayBalance: "1",
      blockHeight: "12345",
      blockTimestamp: new Date().toISOString(),
      observedAt: new Date().toISOString(),
      finality: "FINALIZED",
      syncStatus: "CONFIRMED",
      isZeroConfirmed: false,
      lastSyncedAt: new Date().toISOString(),
      lastError: null,
      networkAsset: {
        id: "na_1",
        assetId: "a_usdc",
        network: "base",
        chainId: "8453",
        tokenStandard: "ERC20",
        contractAddress: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
        decimals: 6,
        symbolOverride: null,
        nameOverride: null,
        isVerified: true,
        isDepositEligible: true,
        status: "ACTIVE",
        asset: {
          id: "a_usdc",
          symbol: "USDC",
          name: "USD Coin",
          kind: "STABLECOIN",
          description: null,
          iconUrl: null,
        },
      },
    };
    assert.ok(
      isBalanceMatchingDeployment(validBaseBalance, baseMainnetUsdc),
      "Genuine Base Mainnet USDC balance must match",
    );

    // 2. Base Sepolia balance MUST NOT match Base Mainnet
    const sepoliaBalance: SerializedWalletBalanceRecord = {
      ...validBaseBalance,
      id: "bal_sepolia_1",
      networkAsset: {
        ...validBaseBalance.networkAsset,
        network: "base-sepolia",
        chainId: "84532",
      },
    };
    assert.equal(
      isBalanceMatchingDeployment(sepoliaBalance, baseMainnetUsdc),
      false,
      "Base Sepolia balance must NEVER match Base Mainnet deployment",
    );

    // 3. Spoofed contract address on Base Mainnet MUST NOT match
    const spoofedContractBalance: SerializedWalletBalanceRecord = {
      ...validBaseBalance,
      id: "bal_spoofed_1",
      networkAsset: {
        ...validBaseBalance.networkAsset,
        contractAddress: "0x000000000000000000000000000000000000dead",
      },
    };
    assert.equal(
      isBalanceMatchingDeployment(spoofedContractBalance, baseMainnetUsdc),
      false,
      "Balance with wrong contract address must NEVER match legitimate deployment",
    );

    // 4. Solana Devnet SOL balance MUST NOT match Solana Mainnet SOL
    const solMainnetSol = MAINNET_SUPPORTED_DEPLOYMENTS.find(
      (d) => d.id === "solana-mainnet:SOL",
    )!;
    assert.ok(solMainnetSol);

    const devnetSolBalance: SerializedWalletBalanceRecord = {
      ...validBaseBalance,
      id: "bal_devnet_sol",
      networkAsset: {
        ...validBaseBalance.networkAsset,
        network: "solana-devnet",
        chainId: "solana:devnet",
        tokenStandard: "NATIVE",
        contractAddress: null,
        decimals: 9,
        asset: {
          ...validBaseBalance.networkAsset.asset,
          symbol: "SOL",
          name: "Solana",
          kind: "NATIVE",
        },
      },
    };
    assert.equal(
      isBalanceMatchingDeployment(devnetSolBalance, solMainnetSol),
      false,
      "Solana Devnet SOL balance must NEVER match Solana Mainnet deployment",
    );
  });
});

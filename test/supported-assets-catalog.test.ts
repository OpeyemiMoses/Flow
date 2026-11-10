import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  APPROVED_ASSET_SYMBOLS,
  APPROVED_MAINNET_NETWORKS,
  CURATED_SUPPORTED_DEPLOYMENTS,
  ECOSYSTEM_METADATA,
  getCanonicalDeploymentsForAsset,
  getEcosystemForNetworkKey,
  getSupportedNetworksForAsset,
  isAssetSupportedOnNetwork,
  validateEcosystemAddress,
} from "../src/domain/supported-assets-catalog.ts";

describe("supported-assets-catalog — five-asset canonical registry & address validation", () => {
  it("covers strictly the five approved assets and four approved mainnet networks", () => {
    assert.deepEqual([...APPROVED_ASSET_SYMBOLS].sort(), [
      "ETH",
      "NEAR",
      "SOL",
      "USDC",
      "USDT",
    ]);

    assert.deepEqual([...APPROVED_MAINNET_NETWORKS].sort(), [
      "base-mainnet",
      "ethereum-mainnet",
      "near-mainnet",
      "solana-mainnet",
    ]);

    const mainnetDeployments = CURATED_SUPPORTED_DEPLOYMENTS.filter(
      (d) => d.environment === "mainnet",
    );
    // Exactly 11 genuine canonical mainnet deployments
    assert.equal(mainnetDeployments.length, 11);

    const allCuratedSymbols = new Set(
      CURATED_SUPPORTED_DEPLOYMENTS.map((d) => d.symbol),
    );
    // Disallowed / non-canonical tokens must NOT be present
    for (const forbidden of [
      "cbETH",
      "WETH",
      "mSOL",
      "JUP",
      "PYTH",
      "wNEAR",
      "USDC.e",
    ]) {
      assert.ok(
        !allCuratedSymbols.has(forbidden),
        `Prohibited token ${forbidden} found in catalog`,
      );
    }
  });

  it("verifies genuine mainnet deployments per network matching the approved matrix", () => {
    const mainnet = CURATED_SUPPORTED_DEPLOYMENTS.filter(
      (d) => d.environment === "mainnet",
    );

    // Ethereum Mainnet: ETH, USDC, USDT
    const ethMainnetSymbols = mainnet
      .filter((d) => d.networkKey === "ethereum-mainnet")
      .map((d) => d.symbol)
      .sort();
    assert.deepEqual(ethMainnetSymbols, ["ETH", "USDC", "USDT"]);

    // Base Mainnet: ETH, USDC (USDT is NOT deployed on Base)
    const baseMainnetSymbols = mainnet
      .filter((d) => d.networkKey === "base-mainnet")
      .map((d) => d.symbol)
      .sort();
    assert.deepEqual(baseMainnetSymbols, ["ETH", "USDC"]);

    // Solana Mainnet: SOL, USDC, USDT
    const solMainnetSymbols = mainnet
      .filter((d) => d.networkKey === "solana-mainnet")
      .map((d) => d.symbol)
      .sort();
    assert.deepEqual(solMainnetSymbols, ["SOL", "USDC", "USDT"]);

    // NEAR Mainnet: NEAR, USDC, USDT
    const nearMainnetSymbols = mainnet
      .filter((d) => d.networkKey === "near-mainnet")
      .map((d) => d.symbol)
      .sort();
    assert.deepEqual(nearMainnetSymbols, ["NEAR", "USDC", "USDT"]);
  });

  it("enforces isAssetSupportedOnNetwork rules correctly across genuine and unsupported combinations", () => {
    // USDT supported on Ethereum, Solana, NEAR — rejected on Base
    assert.equal(isAssetSupportedOnNetwork("USDT", "ethereum-mainnet"), true);
    assert.equal(isAssetSupportedOnNetwork("USDT", "solana-mainnet"), true);
    assert.equal(isAssetSupportedOnNetwork("USDT", "near-mainnet"), true);
    assert.equal(isAssetSupportedOnNetwork("USDT", "base-mainnet"), false);

    // ETH supported on Ethereum and Base — rejected on Solana and NEAR
    assert.equal(isAssetSupportedOnNetwork("ETH", "ethereum-mainnet"), true);
    assert.equal(isAssetSupportedOnNetwork("ETH", "base-mainnet"), true);
    assert.equal(isAssetSupportedOnNetwork("ETH", "solana-mainnet"), false);
    assert.equal(isAssetSupportedOnNetwork("ETH", "near-mainnet"), false);

    // SOL supported only on Solana
    assert.equal(isAssetSupportedOnNetwork("SOL", "solana-mainnet"), true);
    assert.equal(isAssetSupportedOnNetwork("SOL", "ethereum-mainnet"), false);
    assert.equal(isAssetSupportedOnNetwork("SOL", "base-mainnet"), false);
    assert.equal(isAssetSupportedOnNetwork("SOL", "near-mainnet"), false);

    // NEAR supported only on NEAR
    assert.equal(isAssetSupportedOnNetwork("NEAR", "near-mainnet"), true);
    assert.equal(isAssetSupportedOnNetwork("NEAR", "ethereum-mainnet"), false);
    assert.equal(isAssetSupportedOnNetwork("NEAR", "base-mainnet"), false);
    assert.equal(isAssetSupportedOnNetwork("NEAR", "solana-mainnet"), false);

    // USDC supported across all four networks
    assert.equal(isAssetSupportedOnNetwork("USDC", "ethereum-mainnet"), true);
    assert.equal(isAssetSupportedOnNetwork("USDC", "base-mainnet"), true);
    assert.equal(isAssetSupportedOnNetwork("USDC", "solana-mainnet"), true);
    assert.equal(isAssetSupportedOnNetwork("USDC", "near-mainnet"), true);
  });

  it("identifies every deployment uniquely by network, standard, and contract/mint identifier", () => {
    const seenIds = new Set<string>();
    const seenTriplets = new Set<string>();

    for (const dep of CURATED_SUPPORTED_DEPLOYMENTS) {
      assert.ok(!seenIds.has(dep.id), `Duplicate catalog ID: ${dep.id}`);
      seenIds.add(dep.id);

      const triplet = `${dep.networkKey}:${dep.standard}:${dep.contractIdentifier}`;
      assert.ok(
        !seenTriplets.has(triplet),
        `Duplicate network/standard/contract triplet: ${triplet}`,
      );
      seenTriplets.add(triplet);
      assert.ok(dep.decimals >= 0 && dep.decimals <= 24);
    }
  });

  it("maps network keys to their canonical ecosystem family", () => {
    assert.equal(getEcosystemForNetworkKey("ethereum-mainnet"), "evm");
    assert.equal(getEcosystemForNetworkKey("base-sepolia"), "evm");
    assert.equal(getEcosystemForNetworkKey("solana-mainnet"), "solana");
    assert.equal(getEcosystemForNetworkKey("near-testnet"), "near");
  });

  it("validates Ethereum/Base, Solana, and NEAR destination addresses accurately", () => {
    assert.equal(
      validateEcosystemAddress(
        "evm",
        "0x71C7656EC7ab88b098defB751B7401B5f6d8976F",
      ).valid,
      true,
    );
    assert.equal(validateEcosystemAddress("evm", "invalid-evm").valid, false);

    assert.equal(
      validateEcosystemAddress(
        "solana",
        "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
      ).valid,
      true,
    );
    assert.equal(validateEcosystemAddress("solana", "0x1234").valid, false);

    assert.equal(validateEcosystemAddress("near", "treasury.near").valid, true);
    assert.equal(
      validateEcosystemAddress(
        "near",
        "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1",
      ).valid,
      true,
    );
    assert.equal(validateEcosystemAddress("near", "bad address!").valid, false);
  });
});

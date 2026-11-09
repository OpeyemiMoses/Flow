import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  CURATED_SUPPORTED_DEPLOYMENTS,
  ECOSYSTEM_METADATA,
  getEcosystemForNetworkKey,
  validateEcosystemAddress,
} from "../src/domain/supported-assets-catalog.ts";

describe("supported-assets-catalog — multi-chain registry & address validation", () => {
  it("covers all three primary ecosystems: Ethereum/Base (EVM), Solana, and NEAR", () => {
    const families = new Set(ECOSYSTEM_METADATA.map((e) => e.family));
    assert.deepEqual([...families].sort(), ["evm", "near", "solana"]);

    const evmSymbols = new Set(
      CURATED_SUPPORTED_DEPLOYMENTS.filter((d) => d.ecosystem === "evm").map(
        (d) => d.symbol,
      ),
    );
    for (const sym of ["ETH", "USDC", "USDT", "cbETH", "WETH"]) {
      assert.ok(evmSymbols.has(sym), `Expected EVM catalog to include ${sym}`);
    }

    const solSymbols = new Set(
      CURATED_SUPPORTED_DEPLOYMENTS.filter((d) => d.ecosystem === "solana").map(
        (d) => d.symbol,
      ),
    );
    for (const sym of ["SOL", "USDC", "USDT", "mSOL", "JUP", "PYTH"]) {
      assert.ok(
        solSymbols.has(sym),
        `Expected Solana catalog to include ${sym}`,
      );
    }

    const nearSymbols = new Set(
      CURATED_SUPPORTED_DEPLOYMENTS.filter((d) => d.ecosystem === "near").map(
        (d) => d.symbol,
      ),
    );
    for (const sym of ["NEAR", "USDC", "USDT", "wNEAR"]) {
      assert.ok(
        nearSymbols.has(sym),
        `Expected NEAR catalog to include ${sym}`,
      );
    }
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

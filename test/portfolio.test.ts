import assert from "node:assert/strict";
import { test } from "node:test";
import {
  type AccountPortfolioProjection,
  type WalletBalanceRecord,
} from "../src/domain/assets.ts";
import { formatAtomicToDisplay } from "../src/domain/atomic-amounts.ts";
import {
  serializePortfolio,
  REFRESH_COOLDOWN_MS,
} from "../src/domain/portfolio.ts";

test("portfolio: serializePortfolio derives exact decimals and strings for BigInt values", () => {
  const dummyBalance: WalletBalanceRecord = {
    id: "bal-1",
    walletId: "4db1447f-f32d-47ca-be4c-c07bc283c7ac",
    networkAssetId: "asset-dep-near",
    tokenAccountAddress: null,
    atomicBalance: 1500000000000000000000000n, // 1.5 NEAR (24 decimals)
    displayBalance: formatAtomicToDisplay(1500000000000000000000000n, 24),
    blockHeight: 184561234n,
    blockTimestamp: new Date("2026-11-08T08:00:00Z"),
    observedAt: new Date("2026-11-08T08:05:00Z"),
    finality: "FINALIZED",
    syncStatus: "SYNCED",
    isZeroConfirmed: false,
    lastSyncedAt: new Date("2026-11-08T08:05:00Z"),
    lastError: null,
    networkAsset: {
      id: "asset-dep-near",
      assetId: "asset-near",
      network: "near",
      chainId: "testnet",
      tokenStandard: "NATIVE",
      contractAddress: null,
      decimals: 24,
      symbolOverride: null,
      nameOverride: null,
      isVerified: true,
      isDepositEligible: false,
      status: "ACTIVE",
      asset: {
        id: "asset-near",
        symbol: "NEAR",
        name: "NEAR Protocol",
        kind: "NATIVE",
        description: "Native token of NEAR",
        iconUrl: null,
      },
    },
  };

  const projection: AccountPortfolioProjection = {
    accountId: "293ec0df-c298-4f11-b17c-5f4890bfd3f7",
    wallet: {
      id: "4db1447f-f32d-47ca-be4c-c07bc283c7ac",
      environment: "testnet",
      isTestnet: true,
      status: "PROVISIONING",
      policyState: "none",
      eligibleForDeposits: false,
      depositWarning: "TESTNET_WALLET: strictly ineligible for real deposits",
      addresses: [
        {
          network: "near",
          chainId: "testnet",
          address:
            "eccb81cc1bf04b5ce09d31882ee283e1c87a8d6223dfd49067863bc360121c86",
          publicKey: null,
        },
        {
          network: "base",
          chainId: "84532",
          address: "0xaa6bA2Ae7F20748B46A3DB221a418137ec54A5a2",
          publicKey: null,
        },
        {
          network: "solana",
          chainId: "devnet",
          address: "DsesgAr8EguoiioX2kddzdYGHJHZos9ZRLh1VbDr3j1n",
          publicKey: null,
        },
      ],
    },
    balances: [dummyBalance],
    lastSyncedAt: new Date("2026-11-08T08:05:00Z"),
    isStale: false,
  };

  const serialized = serializePortfolio(projection);

  assert.equal(serialized.accountId, "293ec0df-c298-4f11-b17c-5f4890bfd3f7");
  assert.ok(serialized.wallet);
  assert.equal(serialized.wallet.status, "PROVISIONING");
  assert.equal(serialized.wallet.executionDisabled, true);
  assert.equal(serialized.wallet.depositEligible, false);
  assert.equal(serialized.wallet.transferEligible, false);
  assert.ok(serialized.wallet.disclaimer.includes("PROVISIONING"));
  assert.equal(serialized.wallet.addresses.length, 3);

  // Balances validation
  assert.equal(serialized.balances.length, 1);
  const b = serialized.balances[0]!;
  assert.equal(typeof b.atomicBalance, "string");
  assert.equal(b.atomicBalance, "1500000000000000000000000");
  assert.equal(b.displayBalance, "1.5");
  assert.equal(typeof b.blockHeight, "string");
  assert.equal(b.blockHeight, "184561234");
  assert.equal(b.finality, "FINALIZED");
  assert.equal(b.syncStatus, "SYNCED");
  assert.equal(b.isZeroConfirmed, false);
  assert.equal(b.networkAsset.decimals, 24);
  assert.equal(b.networkAsset.network, "near");
  assert.equal(b.networkAsset.chainId, "testnet");
});

test("portfolio: handles confirmed zero balances correctly across chains", () => {
  const zeroBalance: WalletBalanceRecord = {
    id: "bal-eth-zero",
    walletId: "4db1447f-f32d-47ca-be4c-c07bc283c7ac",
    networkAssetId: "asset-dep-eth-sepolia",
    tokenAccountAddress: null,
    atomicBalance: 0n,
    displayBalance: formatAtomicToDisplay(0n, 18),
    blockHeight: 1234567n,
    blockTimestamp: new Date(),
    observedAt: new Date(),
    finality: "FINALIZED",
    syncStatus: "SYNCED",
    isZeroConfirmed: true,
    lastSyncedAt: new Date(),
    lastError: null,
    networkAsset: {
      id: "asset-dep-eth-sepolia",
      assetId: "asset-eth",
      network: "base",
      chainId: "84532",
      tokenStandard: "NATIVE",
      contractAddress: null,
      decimals: 18,
      symbolOverride: null,
      nameOverride: null,
      isVerified: true,
      isDepositEligible: false,
      status: "ACTIVE",
      asset: {
        id: "asset-eth",
        symbol: "ETH",
        name: "Ethereum",
        kind: "NATIVE",
        description: null,
        iconUrl: null,
      },
    },
  };

  const projection: AccountPortfolioProjection = {
    accountId: "acc-1",
    wallet: null,
    balances: [zeroBalance],
    lastSyncedAt: new Date(),
    isStale: false,
  };

  const serialized = serializePortfolio(projection);
  assert.equal(serialized.wallet, null);
  assert.equal(serialized.balances.length, 1);
  assert.equal(serialized.balances[0]!.atomicBalance, "0");
  assert.equal(serialized.balances[0]!.displayBalance, "0");
  assert.equal(serialized.balances[0]!.isZeroConfirmed, true);
  assert.equal(serialized.balances[0]!.networkAsset.asset.symbol, "ETH");
});

test("portfolio: stale-while-revalidate detection and cooldown definition", () => {
  assert.equal(REFRESH_COOLDOWN_MS, 15_000);

  // Stale portfolio with lastSyncedAt > 120s
  const oldDate = new Date(Date.now() - 130_000);
  const staleProjection: AccountPortfolioProjection = {
    accountId: "acc-stale",
    wallet: null,
    balances: [],
    lastSyncedAt: oldDate,
    isStale: true,
  };

  const serialized = serializePortfolio(staleProjection);
  assert.equal(serialized.isStale, true);
  assert.equal(serialized.lastSyncedAt, oldDate.toISOString());
});

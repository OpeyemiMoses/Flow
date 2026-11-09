import test from "node:test";
import assert from "node:assert/strict";
import {
  type WalletActivityRecord,
  serializeActivity,
  serializeActivities,
  getExplorerUrl,
} from "../src/domain/activities.ts";
import {
  padAddressToTopic,
  parseTopicToAddress,
  ERC20_TRANSFER_EVENT_TOPIC,
} from "../src/server/assets/indexers/evm-indexer.ts";

test("evm-indexer: padAddressToTopic and parseTopicToAddress round-trip correctly", () => {
  const address = "0xaa6bA2Ae7F20748B46A3DB221a418137ec54A5a2";
  const topic = padAddressToTopic(address);

  assert.equal(topic.length, 66); // 0x + 64 hex chars (32 bytes)
  assert.ok(topic.startsWith("0x000000000000000000000000"));

  const parsed = parseTopicToAddress(topic);
  assert.equal(parsed.toLowerCase(), address.toLowerCase());
});

test("evm-indexer: ERC20_TRANSFER_EVENT_TOPIC matches standard keccak256", () => {
  assert.equal(
    ERC20_TRANSFER_EVENT_TOPIC,
    "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef",
  );
});

test("domain/activities: getExplorerUrl resolves canonical block explorers across EVM, Solana, and NEAR", () => {
  const evmTx =
    "0x4e83c748c89b43c683790ec37a89ad65cfba4128f645a2789bd0e87612c3f841";
  const solanaTx =
    "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d111111111111111111111111";
  const nearTx = "9kYn6vY8rZ5b5F9V8x5wY3mN6qT4pL2sK8jD1eR3aBcE";

  // Base Sepolia
  const baseSepoliaUrl = getExplorerUrl("base", "84532", evmTx);
  assert.equal(baseSepoliaUrl, `https://sepolia.basescan.org/tx/${evmTx}`);

  // Base Mainnet
  const baseMainnetUrl = getExplorerUrl("base", "8453", evmTx);
  assert.equal(baseMainnetUrl, `https://basescan.org/tx/${evmTx}`);

  // Ethereum Mainnet (separate EVM chain)
  const ethMainnetUrl = getExplorerUrl("ethereum", "1", evmTx);
  assert.equal(ethMainnetUrl, `https://etherscan.io/tx/${evmTx}`);

  // Solana Devnet
  const solDevnetUrl = getExplorerUrl("solana", "solana-devnet", solanaTx);
  assert.equal(
    solDevnetUrl,
    `https://solscan.io/tx/${solanaTx}?cluster=devnet`,
  );

  // Solana Mainnet
  const solMainnetUrl = getExplorerUrl("solana", "solana-mainnet", solanaTx);
  assert.equal(solMainnetUrl, `https://solscan.io/tx/${solanaTx}`);

  // NEAR Testnet
  const nearTestnetUrl = getExplorerUrl("near", "near-testnet", nearTx);
  assert.equal(nearTestnetUrl, `https://testnet.nearblocks.io/txns/${nearTx}`);

  // NEAR Mainnet
  const nearMainnetUrl = getExplorerUrl("near", "near-mainnet", nearTx);
  assert.equal(nearMainnetUrl, `https://nearblocks.io/txns/${nearTx}`);
});

test("domain/activities: serializeActivity preserves exact atomic amount precision without floating point inaccuracies", () => {
  const record: WalletActivityRecord = {
    id: "a1111111-0000-0000-0000-000000000001",
    accountId: "b2222222-0000-0000-0000-000000000002",
    walletId: "c3333333-0000-0000-0000-000000000003",
    network: "base",
    chainId: "84532",
    ecosystem: "evm",
    activityType: "ON_CHAIN_TRANSFER",
    direction: "INCOMING",
    txHash:
      "0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef",
    eventIndex: 0,
    fromAddress: "0x1111111111111111111111111111111111111111",
    toAddress: "0xaa6bA2Ae7F20748B46A3DB221a418137ec54A5a2",
    assetId: "d4444444-0000-0000-0000-000000000004",
    networkAssetId: "e5555555-0000-0000-0000-000000000005",
    assetSymbol: "USDC",
    atomicAmount: 125000000n, // 125 USDC (6 decimals)
    decimals: 6,
    blockHeight: 18239401n,
    blockHash: "0xblockhash123",
    blockTimestamp: new Date("2026-11-09T12:00:00Z"),
    finality: "FINALIZED",
    reorgStatus: "CANONICAL",
    feeAtomicAmount: 21000000000000n,
    metadata: { test: true },
    observedAt: new Date("2026-11-09T12:05:00Z"),
  };

  const serialized = serializeActivity(record);

  assert.equal(serialized.atomicAmount, "125000000");
  assert.equal(serialized.displayAmount, "125");
  assert.equal(serialized.blockHeight, "18239401");
  assert.equal(serialized.feeAtomicAmount, "21000000000000");
  assert.equal(serialized.finality, "FINALIZED");
  assert.equal(serialized.reorgStatus, "CANONICAL");
  assert.equal(
    serialized.explorerUrl,
    `https://sepolia.basescan.org/tx/${record.txHash}`,
  );
});

test("domain/activities: serializeActivities handles zero-amount interactions and null timestamps", () => {
  const record: WalletActivityRecord = {
    id: "a1111111-0000-0000-0000-000000000002",
    accountId: "b2222222-0000-0000-0000-000000000002",
    walletId: "c3333333-0000-0000-0000-000000000003",
    network: "solana",
    chainId: "solana-devnet",
    ecosystem: "solana",
    activityType: "ON_CHAIN_INTERACTION",
    direction: "OUTGOING",
    txHash: "solana_sig_12345",
    eventIndex: 0,
    fromAddress: "DsesgAr8EguoiioX2kddzdYGHJHZos9ZRLh1VbDr3j1n",
    toAddress: "program_id_12345",
    assetId: null,
    networkAssetId: null,
    assetSymbol: "SOL",
    atomicAmount: 0n,
    decimals: 9,
    blockHeight: 310543210n,
    blockHash: null,
    blockTimestamp: null,
    finality: "CONFIRMED",
    reorgStatus: "CANONICAL",
    feeAtomicAmount: 5000n, // 5000 lamports
    metadata: {},
    observedAt: new Date("2026-11-09T12:10:00Z"),
  };

  const [serialized] = serializeActivities([record]);
  assert.ok(serialized);
  assert.equal(serialized.atomicAmount, "0");
  assert.equal(serialized.displayAmount, "0");
  assert.equal(serialized.blockTimestamp, null);
  assert.equal(serialized.feeAtomicAmount, "5000");
  assert.equal(
    serialized.explorerUrl,
    "https://solscan.io/tx/solana_sig_12345?cluster=devnet",
  );
});

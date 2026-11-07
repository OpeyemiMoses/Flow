import assert from "node:assert/strict";
import test from "node:test";
import { FlowError } from "../src/foundation/errors.ts";
import {
  isTestnetChain,
  assertWalletChainConsistency,
} from "../src/domain/assets.ts";
import { scrubRpcEndpoint } from "../src/server/assets/connectors/rpc-client.ts";
import {
  verifyBaseChainId,
  fetchBaseNativeBalance,
  fetchBaseTokenBalance,
} from "../src/server/assets/connectors/base-connector.ts";
import {
  verifyNearChainId,
  fetchNearNativeBalance,
  fetchNearTokenBalance,
} from "../src/server/assets/connectors/near-connector.ts";
import {
  verifySolanaGenesisHash,
  fetchSolanaNativeBalance,
  fetchSolanaTokenBalance,
  SOLANA_GENESIS_HASHES,
} from "../src/server/assets/connectors/solana-connector.ts";
import { reconcileWalletBalances } from "../src/server/assets/connectors/multi-chain-reconciler.ts";

test("rpc-client: scrubRpcEndpoint redacts credentials, query keys and secret path tokens", () => {
  assert.equal(
    scrubRpcEndpoint(
      "https://user:password@base-mainnet.alchemy.com/v2/abcdef1234567890",
    ),
    "https://base-mainnet.alchemy.com/v2/[REDACTED_KEY]",
  );

  assert.equal(
    scrubRpcEndpoint(
      "https://mainnet.infura.io/v3/1234567890abcdef1234567890abcdef?token=secret123",
    ),
    "https://mainnet.infura.io/v3/[REDACTED_KEY]?token=%5BREDACTED%5D",
  );

  assert.equal(
    scrubRpcEndpoint("https://sepolia.base.org"),
    "https://sepolia.base.org/",
  );
});

test("chain consistency: isTestnetChain and assertWalletChainConsistency prevent cross-environment mixing", () => {
  assert.equal(isTestnetChain("near-testnet"), true);
  assert.equal(isTestnetChain("84532"), true);
  assert.equal(isTestnetChain("solana-devnet"), true);
  assert.equal(isTestnetChain("near-mainnet"), false);
  assert.equal(isTestnetChain("8453"), false);
  assert.equal(isTestnetChain("solana-mainnet"), false);

  // Valid combinations do not throw
  assert.doesNotThrow(() =>
    assertWalletChainConsistency("testnet", "near-testnet"),
  );
  assert.doesNotThrow(() => assertWalletChainConsistency("testnet", "84532"));
  assert.doesNotThrow(() =>
    assertWalletChainConsistency("testnet", "solana-devnet"),
  );
  assert.doesNotThrow(() =>
    assertWalletChainConsistency("mainnet", "near-mainnet"),
  );
  assert.doesNotThrow(() => assertWalletChainConsistency("mainnet", "8453"));
  assert.doesNotThrow(() =>
    assertWalletChainConsistency("mainnet", "solana-mainnet"),
  );

  // Invalid cross-environment combinations throw INVALID_CONFIGURATION
  assert.throws(
    () => assertWalletChainConsistency("testnet", "8453"),
    (err: unknown) =>
      err instanceof FlowError &&
      err.code === "INVALID_CONFIGURATION" &&
      err.message.includes(
        "testnet wallet cannot hold balances for mainnet chain 8453",
      ),
  );

  assert.throws(
    () => assertWalletChainConsistency("mainnet", "near-testnet"),
    (err: unknown) =>
      err instanceof FlowError &&
      err.code === "INVALID_CONFIGURATION" &&
      err.message.includes(
        "mainnet wallet cannot hold balances for testnet chain near-testnet",
      ),
  );
});

test("base-connector: verifyBaseChainId validates chain ID and rejects mismatch", async () => {
  // Test with mock fetch
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = (async (_url: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(init?.body as string);
      if (body.method === "eth_chainId") {
        return new Response(
          JSON.stringify({ jsonrpc: "2.0", id: 1, result: "0x14a34" }),
        ); // 84532
      }
      throw new Error(`Unexpected method ${body.method}`);
    }) as typeof fetch;

    // Matching chain ID succeeds
    const ok = await verifyBaseChainId("https://mock-base.test", "84532");
    assert.equal(ok.verified, true);
    assert.equal(ok.chainIdHex, "0x14a34");

    // Mismatched chain ID fails with CHAIN_ID_MISMATCH
    await assert.rejects(
      async () => {
        await verifyBaseChainId("https://mock-base.test", "8453");
      },
      (err: unknown) =>
        err instanceof FlowError &&
        err.code === "CHAIN_ID_MISMATCH" &&
        err.message.includes("expected 8453, got 84532"),
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("base-connector: native balance parsing and ERC-20 balanceOf eth_call", async () => {
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = (async (_url: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(init?.body as string);
      if (body.method === "eth_chainId") {
        return new Response(
          JSON.stringify({ jsonrpc: "2.0", id: body.id, result: "0x2105" }),
        ); // 8453
      }
      if (body.method === "eth_getBalance") {
        // 1.5 ETH = 1500000000000000000 wei = 0x14d1120d7b160000
        return new Response(
          JSON.stringify({
            jsonrpc: "2.0",
            id: body.id,
            result: "0x14d1120d7b160000",
          }),
        );
      }
      if (body.method === "eth_blockNumber") {
        return new Response(
          JSON.stringify({ jsonrpc: "2.0", id: body.id, result: "0x123456" }),
        );
      }
      if (body.method === "eth_call") {
        // 25.5 USDC (6 decimals) = 25500000 = 0x1851960
        const hex =
          "0000000000000000000000000000000000000000000000000000000001851960";
        return new Response(
          JSON.stringify({ jsonrpc: "2.0", id: body.id, result: `0x${hex}` }),
        );
      }
      throw new Error(`Unexpected method ${body.method}`);
    }) as typeof fetch;

    // 1. Native ETH balance
    const native = await fetchBaseNativeBalance(
      "https://mock-base.test",
      "0x1111111111111111111111111111111111111111",
      "8453",
      { networkAssetId: "test-asset-eth" },
    );
    assert.equal(native.atomicBalance, 1_500_000_000_000_000_000n);
    assert.equal(native.blockHeight, 0x123456n);
    assert.equal(native.syncStatus, "SYNCED");
    assert.equal(native.observationState, "SYNCED");

    // 2. ERC-20 token balance
    const token = await fetchBaseTokenBalance(
      "https://mock-base.test",
      "0x1111111111111111111111111111111111111111",
      "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
      "8453",
      { networkAssetId: "test-asset-usdc" },
    );
    assert.equal(token.atomicBalance, 25_500_000n);
    assert.equal(token.syncStatus, "SYNCED");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("near-connector: view_account distinguishes confirmed balance from UNKNOWN_ACCOUNT non-existent state", async () => {
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = (async (_url: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(init?.body as string);
      if (body.method === "status") {
        return new Response(
          JSON.stringify({
            jsonrpc: "2.0",
            id: body.id,
            result: { chain_id: "testnet" },
          }),
        );
      }
      if (body.method === "query") {
        if (body.params.account_id === "existing.testnet") {
          return new Response(
            JSON.stringify({
              jsonrpc: "2.0",
              id: body.id,
              result: {
                amount: "5000000000000000000000000", // 5 NEAR
                block_height: 12345678,
                block_hash: "mock-hash",
              },
            }),
          );
        }
        if (body.params.account_id === "unfunded-implicit.testnet") {
          return new Response(
            JSON.stringify({
              jsonrpc: "2.0",
              id: body.id,
              error: {
                name: "HANDLER_ERROR",
                cause: {
                  name: "UNKNOWN_ACCOUNT",
                  info: { block_height: 12345679, block_hash: "mock-hash-2" },
                },
                code: -32000,
                message: "Server error",
                data: "account unfunded-implicit.testnet does not exist while viewing",
              },
            }),
          );
        }
      }
      throw new Error(`Unexpected query: ${JSON.stringify(body)}`);
    }) as typeof fetch;

    const nearChain = await verifyNearChainId(
      "https://mock-near.test",
      "near-testnet",
    );
    assert.equal(nearChain.verified, true);
    assert.equal(nearChain.chainId, "testnet");

    // 1. Existing account returns confirmed positive balance
    const existing = await fetchNearNativeBalance(
      "https://mock-near.test",
      "existing.testnet",
      "near-testnet",
      { networkAssetId: "test-near-native" },
    );
    assert.equal(existing.atomicBalance, 5_000_000_000_000_000_000_000_000n);
    assert.equal(existing.observationState, "SYNCED");
    assert.equal(existing.syncStatus, "SYNCED");
    assert.equal(existing.blockHeight, 12345678n);

    // 2. Unfunded non-existent account explicitly returns ACCOUNT_NONEXISTENT with confirmed 0 balance
    const unfunded = await fetchNearNativeBalance(
      "https://mock-near.test",
      "unfunded-implicit.testnet",
      "near-testnet",
      { networkAssetId: "test-near-native" },
    );
    assert.equal(unfunded.atomicBalance, 0n);
    assert.equal(unfunded.observationState, "ACCOUNT_NONEXISTENT");
    assert.equal(unfunded.syncStatus, "SYNCED");
    assert.equal(unfunded.blockHeight, 12345679n);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("near-connector: ft_balance_of parses NEP-141 balance and handles unregistered accounts", async () => {
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = (async (_url: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(init?.body as string);
      if (body.method === "status") {
        return new Response(
          JSON.stringify({
            jsonrpc: "2.0",
            id: body.id,
            result: { chain_id: "mainnet" },
          }),
        );
      }
      if (body.method === "query") {
        const decodedArgs = JSON.parse(
          Buffer.from(body.params.args_base64, "base64").toString("utf8"),
        );
        if (decodedArgs.account_id === "registered.near") {
          // returns bytes for "1000000" (1 USDC)
          const bytes = Array.from(Buffer.from('"1000000"', "utf8"));
          return new Response(
            JSON.stringify({
              jsonrpc: "2.0",
              id: body.id,
              result: { result: bytes, block_height: 98765432, logs: [] },
            }),
          );
        }
        if (decodedArgs.account_id === "unregistered.near") {
          return new Response(
            JSON.stringify({
              jsonrpc: "2.0",
              id: body.id,
              error: {
                name: "HANDLER_ERROR",
                message: "Server error",
                data: "Smart contract panicked: The account is not registered",
              },
            }),
          );
        }
      }
      throw new Error(`Unexpected query: ${JSON.stringify(body)}`);
    }) as typeof fetch;

    // 1. Registered account returns confirmed token balance
    const registered = await fetchNearTokenBalance(
      "https://mock-near.test",
      "registered.near",
      "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1",
      "near-mainnet",
      { networkAssetId: "test-near-usdc" },
    );
    assert.equal(registered.atomicBalance, 1_000_000n);
    assert.equal(registered.observationState, "SYNCED");
    assert.equal(registered.syncStatus, "SYNCED");

    // 2. Unregistered account returns TOKEN_ACCOUNT_ABSENT with confirmed 0 balance
    const unregistered = await fetchNearTokenBalance(
      "https://mock-near.test",
      "unregistered.near",
      "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1",
      "near-mainnet",
      { networkAssetId: "test-near-usdc" },
    );
    assert.equal(unregistered.atomicBalance, 0n);
    assert.equal(unregistered.observationState, "TOKEN_ACCOUNT_ABSENT");
    assert.equal(unregistered.syncStatus, "SYNCED");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("solana-connector: native getBalance and SPL multi-account aggregation", async () => {
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = (async (_url: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(init?.body as string);
      if (body.method === "getGenesisHash") {
        return new Response(
          JSON.stringify({
            jsonrpc: "2.0",
            id: body.id,
            result: SOLANA_GENESIS_HASHES.devnet,
          }),
        );
      }
      if (body.method === "getBalance") {
        return new Response(
          JSON.stringify({
            jsonrpc: "2.0",
            id: body.id,
            result: { context: { slot: 345678901 }, value: 2_500_000_000 }, // 2.5 SOL
          }),
        );
      }
      if (body.method === "getTokenAccountsByOwner") {
        const owner = body.params[0];
        if (owner === "owner-with-multiple-accounts") {
          return new Response(
            JSON.stringify({
              jsonrpc: "2.0",
              id: body.id,
              result: {
                context: { slot: 345678902 },
                value: [
                  {
                    pubkey: "token-account-1",
                    account: {
                      data: {
                        parsed: {
                          info: {
                            mint: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
                            tokenAmount: { amount: "1500000", decimals: 6 },
                          },
                        },
                      },
                    },
                  },
                  {
                    pubkey: "token-account-2",
                    account: {
                      data: {
                        parsed: {
                          info: {
                            mint: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
                            tokenAmount: { amount: "3500000", decimals: 6 },
                          },
                        },
                      },
                    },
                  },
                ],
              },
            }),
          );
        }
        if (owner === "owner-without-token-accounts") {
          return new Response(
            JSON.stringify({
              jsonrpc: "2.0",
              id: body.id,
              result: { context: { slot: 345678903 }, value: [] },
            }),
          );
        }
      }
      throw new Error(`Unexpected query: ${JSON.stringify(body)}`);
    }) as typeof fetch;

    const solChain = await verifySolanaGenesisHash(
      "https://mock-solana.test",
      "solana-devnet",
    );
    assert.equal(solChain.verified, true);
    assert.equal(solChain.genesisHash, SOLANA_GENESIS_HASHES.devnet);

    // 1. Native SOL balance
    const native = await fetchSolanaNativeBalance(
      "https://mock-solana.test",
      "owner-1",
      "solana-devnet",
      { networkAssetId: "test-solana-native" },
    );
    assert.equal(native.atomicBalance, 2_500_000_000n);
    assert.equal(native.blockHeight, 345678901n);
    assert.equal(native.observationState, "SYNCED");

    // 2. Multi-account aggregation sums amounts across all token accounts: 1.5M + 3.5M = 5.0M
    const multi = await fetchSolanaTokenBalance(
      "https://mock-solana.test",
      "owner-with-multiple-accounts",
      "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
      "solana-devnet",
      { networkAssetId: "test-solana-usdc" },
    );
    assert.equal(multi.atomicBalance, 5_000_000n);
    assert.equal(multi.tokenAccountAddress, "token-account-1");
    assert.equal(multi.observationState, "SYNCED");
    assert.equal(multi.blockHeight, 345678902n);

    // 3. Absent token accounts list returns TOKEN_ACCOUNT_ABSENT with confirmed 0
    const absent = await fetchSolanaTokenBalance(
      "https://mock-solana.test",
      "owner-without-token-accounts",
      "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
      "solana-devnet",
      { networkAssetId: "test-solana-usdc" },
    );
    assert.equal(absent.atomicBalance, 0n);
    assert.equal(absent.observationState, "TOKEN_ACCOUNT_ABSENT");
    assert.equal(absent.syncStatus, "SYNCED");
    assert.equal(absent.blockHeight, 345678903n);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("reconciler: reconcileWalletBalances correlates authentic registered addresses and includes address in observations", async () => {
  const mockWalletId = "4db1447f-f32d-47ca-be4c-c07bc283c7ac";
  const mockAddresses = [
    {
      id: "addr-near",
      network: "near",
      chainId: "near-testnet",
      address:
        "eccb81cc1bf04b5ce09d31882ee283e1c87a8d6223dfd49067863bc360121c86",
    },
    {
      id: "addr-base",
      network: "base",
      chainId: "84532",
      address: "0xaa6bA2Ae7F20748B46A3DB221a418137ec54A5a2",
    },
    {
      id: "addr-solana",
      network: "solana",
      chainId: "solana-devnet",
      address: "DsesgAr8EguoiioX2kddzdYGHJHZos9ZRLh1VbDr3j1n",
    },
  ];

  const mockNetworkAssets = [
    {
      id: "asset-eth",
      network: "base",
      chainId: "84532",
      tokenStandard: "NATIVE",
      contractAddress: null,
      decimals: 18,
      symbol: "ETH",
    },
    {
      id: "asset-near",
      network: "near",
      chainId: "near-testnet",
      tokenStandard: "NATIVE",
      contractAddress: null,
      decimals: 24,
      symbol: "NEAR",
    },
    {
      id: "asset-sol",
      network: "solana",
      chainId: "solana-devnet",
      tokenStandard: "NATIVE",
      contractAddress: null,
      decimals: 9,
      symbol: "SOL",
    },
  ];

  const executedUpserts: unknown[] = [];
  const mockDb = {
    $queryRaw: async (query: { strings?: string[] }) => {
      const qStr = query?.strings ? query.strings.join(" ") : String(query);
      if (qStr.includes("FROM flow.wallets")) {
        return [{ id: mockWalletId, environment: "testnet" }];
      }
      if (qStr.includes("FROM flow.wallet_addresses")) {
        return mockAddresses;
      }
      if (qStr.includes("FROM flow.network_assets")) {
        return mockNetworkAssets;
      }
      if (qStr.includes("INSERT INTO flow.wallet_balances")) {
        executedUpserts.push(query);
        return [{ id: `bal-${executedUpserts.length}` }];
      }
      return [];
    },
  };

  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
      const urlStr = String(url);
      const body = JSON.parse(init?.body as string);

      if (urlStr.includes("sepolia.base.org")) {
        if (body.method === "eth_chainId") {
          return new Response(
            JSON.stringify({ jsonrpc: "2.0", id: body.id, result: "0x14a34" }),
          );
        }
        if (body.method === "eth_getBalance") {
          assert.equal(
            body.params[0],
            "0xaa6bA2Ae7F20748B46A3DB221a418137ec54A5a2",
          );
          return new Response(
            JSON.stringify({ jsonrpc: "2.0", id: body.id, result: "0x0" }),
          );
        }
        if (body.method === "eth_blockNumber") {
          return new Response(
            JSON.stringify({
              jsonrpc: "2.0",
              id: body.id,
              result: "0x3544d67",
            }),
          );
        }
      }

      if (urlStr.includes("testnet.near.org")) {
        if (
          body.method === "EXPERIMENTAL_genesis_config" ||
          body.method === "status"
        ) {
          return new Response(
            JSON.stringify({
              jsonrpc: "2.0",
              id: body.id,
              result: {
                chain_id: "testnet",
                sync_info: { latest_block_height: 276695570 },
              },
            }),
          );
        }
        if (body.method === "query") {
          assert.equal(
            body.params.account_id,
            "eccb81cc1bf04b5ce09d31882ee283e1c87a8d6223dfd49067863bc360121c86",
          );
          return new Response(
            JSON.stringify({
              jsonrpc: "2.0",
              id: body.id,
              error: {
                cause: {
                  name: "UNKNOWN_ACCOUNT",
                },
              },
            }),
          );
        }
      }

      if (urlStr.includes("api.devnet.solana.com")) {
        if (body.method === "getGenesisHash") {
          return new Response(
            JSON.stringify({
              jsonrpc: "2.0",
              id: body.id,
              result: SOLANA_GENESIS_HASHES.devnet,
            }),
          );
        }
        if (body.method === "getBalance") {
          assert.equal(
            body.params[0],
            "DsesgAr8EguoiioX2kddzdYGHJHZos9ZRLh1VbDr3j1n",
          );
          return new Response(
            JSON.stringify({
              jsonrpc: "2.0",
              id: body.id,
              result: { context: { slot: 519821351 }, value: 0 },
            }),
          );
        }
      }

      throw new Error(`Unexpected query to ${urlStr}: ${JSON.stringify(body)}`);
    }) as typeof fetch;

    const res = await reconcileWalletBalances(mockDb as never, mockWalletId);
    assert.equal(res.walletId, mockWalletId);
    assert.equal(res.environment, "testnet");
    assert.equal(res.observations.length, 3);

    const ethObs = res.observations.find((o) => o.symbol === "ETH")!;
    assert.equal(ethObs.address, "0xaa6bA2Ae7F20748B46A3DB221a418137ec54A5a2");
    assert.equal(ethObs.atomicBalance, 0n);

    const nearObs = res.observations.find((o) => o.symbol === "NEAR")!;
    assert.equal(
      nearObs.address,
      "eccb81cc1bf04b5ce09d31882ee283e1c87a8d6223dfd49067863bc360121c86",
    );
    assert.equal(nearObs.atomicBalance, 0n);
    assert.equal(nearObs.observationState, "ACCOUNT_NONEXISTENT");

    const solObs = res.observations.find((o) => o.symbol === "SOL")!;
    assert.equal(
      solObs.address,
      "DsesgAr8EguoiioX2kddzdYGHJHZos9ZRLh1VbDr3j1n",
    );
    assert.equal(solObs.atomicBalance, 0n);
    assert.equal(solObs.observationState, "CONFIRMED_ZERO");

    assert.equal(executedUpserts.length, 3);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

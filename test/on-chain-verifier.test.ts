import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { describe, it } from "node:test";
import {
  verifyEvmTransfer,
  verifySolanaTransfer,
  verifyNearTransfer,
} from "../src/server/payments/on-chain-verifier.ts";
import {
  ERC20_TRANSFER_EVENT_TOPIC,
  padAddressToTopic,
} from "../src/server/assets/indexers/evm-indexer.ts";

describe("on-chain-verifier: genuine multi-chain transfer verification", () => {
  it("verifies genuine EVM native ETH transfer and detects confirmations", async () => {
    const server = http.createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        const json = JSON.parse(body);
        if (json.method === "eth_getTransactionByHash") {
          res.end(
            JSON.stringify({
              jsonrpc: "2.0",
              id: json.id,
              result: {
                hash: json.params[0],
                from: "0x1111111111111111111111111111111111111111",
                to: "0x2222222222222222222222222222222222222222",
                value: "0xde0b6b3a7640000", // 1 ETH (10^18)
                input: "0x",
                blockNumber: "0x10", // 16
                blockHash: "0xblockhash123",
              },
            }),
          );
        } else if (json.method === "eth_getTransactionReceipt") {
          res.end(
            JSON.stringify({
              jsonrpc: "2.0",
              id: json.id,
              result: {
                status: "0x1",
                blockNumber: "0x10",
                blockHash: "0xblockhash123",
                logs: [],
              },
            }),
          );
        } else if (json.method === "eth_blockNumber") {
          res.end(
            JSON.stringify({
              jsonrpc: "2.0",
              id: json.id,
              result: "0x20", // 32 (17 confirmations)
            }),
          );
        } else if (json.method === "eth_getBlockByNumber") {
          res.end(
            JSON.stringify({
              jsonrpc: "2.0",
              id: json.id,
              result: {
                number: "0x10",
                hash: "0xblockhash123",
              },
            }),
          );
        } else {
          res.end(
            JSON.stringify({
              jsonrpc: "2.0",
              id: json.id,
              result: null,
            }),
          );
        }
      });
    });

    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const port = (server.address() as AddressInfo).port;
    const rpcUrl = `http://127.0.0.1:${port}`;

    try {
      const result = await verifyEvmTransfer({
        rpcUrl,
        network: "ethereum-mainnet",
        txHash: "0x" + "a".repeat(64),
        expectedRecipient: "0x2222222222222222222222222222222222222222",
        expectedAssetId: "ethereum-mainnet:ETH",
        expectedTokenContract: null,
        minimumAtomicAmount: 1000000000000000000n,
      });

      assert.equal(result.isSuccess, true);
      assert.equal(result.finality, "FINALIZED");
      assert.equal(result.atomicAmount, 1000000000000000000n);
      assert.equal(
        result.toAddress,
        "0x2222222222222222222222222222222222222222",
      );
    } finally {
      server.close();
    }
  });

  it("verifies genuine EVM ERC-20 transfer and rejects recipient mismatch", async () => {
    const tokenContract = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";
    const recipient = "0x3333333333333333333333333333333333333333";
    const wrongRecipient = "0x9999999999999999999999999999999999999999";

    const server = http.createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        const json = JSON.parse(body);
        if (json.method === "eth_getTransactionByHash") {
          res.end(
            JSON.stringify({
              jsonrpc: "2.0",
              id: json.id,
              result: {
                hash: json.params[0],
                from: "0x1111111111111111111111111111111111111111",
                to: tokenContract,
                value: "0x0",
                input: "0xa9059cbb...",
                blockNumber: "0x50",
                blockHash: "0xblockhash456",
              },
            }),
          );
        } else if (json.method === "eth_getTransactionReceipt") {
          res.end(
            JSON.stringify({
              jsonrpc: "2.0",
              id: json.id,
              result: {
                status: "0x1",
                blockNumber: "0x50",
                blockHash: "0xblockhash456",
                logs: [
                  {
                    address: tokenContract,
                    topics: [
                      ERC20_TRANSFER_EVENT_TOPIC,
                      padAddressToTopic(
                        "0x1111111111111111111111111111111111111111",
                      ),
                      padAddressToTopic(recipient),
                    ],
                    data: "0x00000000000000000000000000000000000000000000000000000000017d7840", // 25 USDC (25,000,000)
                  },
                ],
              },
            }),
          );
        } else if (json.method === "eth_blockNumber") {
          res.end(
            JSON.stringify({
              jsonrpc: "2.0",
              id: json.id,
              result: "0x55",
            }),
          );
        } else if (json.method === "eth_getBlockByNumber") {
          res.end(
            JSON.stringify({
              jsonrpc: "2.0",
              id: json.id,
              result: {
                number: "0x50",
                hash: "0xblockhash456",
              },
            }),
          );
        } else {
          res.end(
            JSON.stringify({
              jsonrpc: "2.0",
              id: json.id,
              result: null,
            }),
          );
        }
      });
    });

    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const port = (server.address() as AddressInfo).port;
    const rpcUrl = `http://127.0.0.1:${port}`;

    try {
      // 1. Correct recipient passes
      const result = await verifyEvmTransfer({
        rpcUrl,
        network: "base-mainnet",
        txHash: "0x" + "b".repeat(64),
        expectedRecipient: recipient,
        expectedAssetId: "base-mainnet:USDC",
        expectedTokenContract: tokenContract,
        minimumAtomicAmount: 25000000n,
      });

      assert.equal(result.isSuccess, true);
      assert.equal(result.atomicAmount, 25000000n);

      // 2. Wrong recipient rejects
      await assert.rejects(
        verifyEvmTransfer({
          rpcUrl,
          network: "base-mainnet",
          txHash: "0x" + "b".repeat(64),
          expectedRecipient: wrongRecipient,
          expectedAssetId: "base-mainnet:USDC",
          expectedTokenContract: tokenContract,
          minimumAtomicAmount: 25000000n,
        }),
        /RECIPIENT_ADDRESS_MISMATCH/,
      );

      // 3. Underpaid amount rejects
      await assert.rejects(
        verifyEvmTransfer({
          rpcUrl,
          network: "base-mainnet",
          txHash: "0x" + "b".repeat(64),
          expectedRecipient: recipient,
          expectedAssetId: "base-mainnet:USDC",
          expectedTokenContract: tokenContract,
          minimumAtomicAmount: 50000000n,
        }),
        /UNDERPAID_AMOUNT/,
      );
    } finally {
      server.close();
    }
  });

  it("verifies genuine Solana transfer and checks memo requirements", async () => {
    const recipient = "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin";

    const server = http.createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        const json = JSON.parse(body);
        if (json.method === "getTransaction") {
          res.end(
            JSON.stringify({
              jsonrpc: "2.0",
              id: json.id,
              result: {
                slot: 123456,
                blockTime: 1700000000,
                transaction: {
                  signatures: [json.params[0]],
                  message: {
                    accountKeys: [
                      {
                        pubkey: "SenderKey111111111111111111111111111111111",
                        signer: true,
                        writable: true,
                      },
                      { pubkey: recipient, signer: false, writable: true },
                    ],
                    instructions: [],
                  },
                },
                meta: {
                  err: null,
                  preBalances: [2000000000, 1000000000],
                  postBalances: [1000000000, 2000000000], // +1 SOL
                  logMessages: [
                    "Program log: Instruction: Transfer",
                    "Program log: Memo: invoice_memo_123",
                  ],
                },
              },
            }),
          );
        } else {
          res.end(
            JSON.stringify({
              jsonrpc: "2.0",
              id: json.id,
              result: null,
            }),
          );
        }
      });
    });

    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const port = (server.address() as AddressInfo).port;
    const rpcUrl = `http://127.0.0.1:${port}`;

    try {
      const validSig =
        "5VERv8NMvzbJMEdV8xnrLkEaWR436xQsGhmGLxrNdEd137KqD5N2wK1i4tGv3d8nZbG1mR6tWv2tB9gH8yK3mQp2";

      // 1. Valid verification with correct memo
      const result = await verifySolanaTransfer({
        rpcUrl,
        network: "solana-mainnet",
        txSignature: validSig,
        expectedRecipient: recipient,
        expectedAssetId: "solana-mainnet:SOL",
        expectedTokenMint: null,
        minimumAtomicAmount: 1000000000n,
        expectedMemo: "invoice_memo_123",
      });

      assert.equal(result.isSuccess, true);
      assert.equal(result.atomicAmount, 1000000000n);
      assert.equal(result.finality, "FINALIZED");

      // 2. Mismatched memo rejected
      await assert.rejects(
        verifySolanaTransfer({
          rpcUrl,
          network: "solana-mainnet",
          txSignature: validSig,
          expectedRecipient: recipient,
          expectedAssetId: "solana-mainnet:SOL",
          expectedTokenMint: null,
          minimumAtomicAmount: 1000000000n,
          expectedMemo: "different_memo",
        }),
        /MEMO_MISMATCH/,
      );
    } finally {
      server.close();
    }
  });

  it("verifies genuine NEAR native transfer and rejects receiver mismatch", async () => {
    const recipient = "merchant.near";
    const server = http.createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        const json = JSON.parse(body);
        if (json.method === "tx") {
          res.end(
            JSON.stringify({
              jsonrpc: "2.0",
              id: json.id,
              result: {
                status: { SuccessValue: "" },
                transaction: {
                  hash: json.params[0],
                  signer_id: "payer.near",
                  receiver_id: recipient,
                  actions: [
                    {
                      Transfer: {
                        deposit: "5000000000000000000000000", // 5 NEAR
                      },
                    },
                  ],
                },
                transaction_outcome: {
                  block_hash: "nearblockhash123",
                  outcome: {
                    status: { SuccessReceiptId: "receipt123" },
                  },
                },
              },
            }),
          );
        } else {
          res.end(
            JSON.stringify({
              jsonrpc: "2.0",
              id: json.id,
              result: null,
            }),
          );
        }
      });
    });

    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const port = (server.address() as AddressInfo).port;
    const rpcUrl = `http://127.0.0.1:${port}`;

    try {
      const validNearHash = "9tVNmJcQ1qXzZ6yL2p8bW4vR7mK5nE3tY1uH8oP6aDsF";

      const result = await verifyNearTransfer({
        rpcUrl,
        network: "near-mainnet",
        txHash: validNearHash,
        senderAccountId: "payer.near",
        expectedRecipient: recipient,
        expectedAssetId: "near-mainnet:NEAR",
        expectedTokenContract: null,
        minimumAtomicAmount: 5000000000000000000000000n,
      });

      assert.equal(result.isSuccess, true);
      assert.equal(result.atomicAmount, 5000000000000000000000000n);
      assert.equal(result.eventIndex, 0);

      // Wrong recipient
      await assert.rejects(
        verifyNearTransfer({
          rpcUrl,
          network: "near-mainnet",
          txHash: validNearHash,
          senderAccountId: "payer.near",
          expectedRecipient: "other.near",
          expectedAssetId: "near-mainnet:NEAR",
          expectedTokenContract: null,
          minimumAtomicAmount: 5000000000000000000000000n,
        }),
        /RECIPIENT_ADDRESS_MISMATCH/,
      );
    } finally {
      server.close();
    }
  });

  it("detects on-chain reorganizations when canonical block hash diverges", async () => {
    const server = http.createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        const json = JSON.parse(body);
        if (json.method === "eth_getTransactionByHash") {
          res.end(
            JSON.stringify({
              jsonrpc: "2.0",
              id: json.id,
              result: {
                hash: json.params[0],
                from: "0x1111111111111111111111111111111111111111",
                to: "0x2222222222222222222222222222222222222222",
                value: "0xde0b6b3a7640000",
                input: "0x",
                blockNumber: "0x10", // 16
                blockHash: "0xreorged_old_blockhash",
              },
            }),
          );
        } else if (json.method === "eth_getTransactionReceipt") {
          res.end(
            JSON.stringify({
              jsonrpc: "2.0",
              id: json.id,
              result: {
                status: "0x1",
                blockNumber: "0x10",
                blockHash: "0xreorged_old_blockhash",
                logs: [],
              },
            }),
          );
        } else if (json.method === "eth_blockNumber") {
          res.end(
            JSON.stringify({
              jsonrpc: "2.0",
              id: json.id,
              result: "0x20",
            }),
          );
        } else if (json.method === "eth_getBlockByNumber") {
          // Canonical chain has diverged: different block hash at height 16
          res.end(
            JSON.stringify({
              jsonrpc: "2.0",
              id: json.id,
              result: {
                number: "0x10",
                hash: "0xcanonical_new_diverged_blockhash",
              },
            }),
          );
        } else {
          res.end(
            JSON.stringify({
              jsonrpc: "2.0",
              id: json.id,
              result: null,
            }),
          );
        }
      });
    });

    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const port = (server.address() as AddressInfo).port;
    const rpcUrl = `http://127.0.0.1:${port}`;

    try {
      await assert.rejects(
        verifyEvmTransfer({
          rpcUrl,
          network: "base-mainnet",
          txHash: "0x" + "b".repeat(64),
          expectedRecipient: "0x2222222222222222222222222222222222222222",
          expectedAssetId: "base-mainnet:ETH",
          expectedTokenContract: null,
          minimumAtomicAmount: 1000000000000000000n,
        }),
        /REORG_DETECTED/,
      );
    } finally {
      server.close();
    }
  });

  it("distinguishes confirmation depth (CONFIRMED) from consensus finality (FINALIZED)", async () => {
    const server = http.createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        const json = JSON.parse(body);
        if (json.method === "eth_getTransactionByHash") {
          res.end(
            JSON.stringify({
              jsonrpc: "2.0",
              id: json.id,
              result: {
                hash: json.params[0],
                from: "0x1111111111111111111111111111111111111111",
                to: "0x2222222222222222222222222222222222222222",
                value: "0xde0b6b3a7640000",
                input: "0x",
                blockNumber: "0x20", // Block 32
                blockHash: "0xblockhash32",
              },
            }),
          );
        } else if (json.method === "eth_getTransactionReceipt") {
          res.end(
            JSON.stringify({
              jsonrpc: "2.0",
              id: json.id,
              result: {
                status: "0x1",
                blockNumber: "0x20",
                blockHash: "0xblockhash32",
                logs: [],
              },
            }),
          );
        } else if (json.method === "eth_blockNumber") {
          res.end(
            JSON.stringify({
              jsonrpc: "2.0",
              id: json.id,
              result: "0x30", // Block 48 (17 confirmations, >= required 6)
            }),
          );
        } else if (json.method === "eth_getBlockByNumber") {
          if (json.params[0] === "finalized") {
            // Consensus finalized block is only at 25 (less than txBlock 32)
            res.end(
              JSON.stringify({
                jsonrpc: "2.0",
                id: json.id,
                result: {
                  number: "0x19", // Block 25
                  hash: "0xfinalizedblock25",
                },
              }),
            );
          } else {
            res.end(
              JSON.stringify({
                jsonrpc: "2.0",
                id: json.id,
                result: {
                  number: json.params[0],
                  hash: "0xblockhash32",
                },
              }),
            );
          }
        } else {
          res.end(
            JSON.stringify({ jsonrpc: "2.0", id: json.id, result: null }),
          );
        }
      });
    });

    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const port = (server.address() as AddressInfo).port;
    const rpcUrl = `http://127.0.0.1:${port}`;

    try {
      const result = await verifyEvmTransfer({
        rpcUrl,
        network: "ethereum-mainnet",
        txHash: "0x" + "c".repeat(64),
        expectedRecipient: "0x2222222222222222222222222222222222222222",
        expectedAssetId: "ethereum-mainnet:ETH",
        expectedTokenContract: null,
        minimumAtomicAmount: 1000000000000000000n,
        requiredConfirmations: 6,
      });

      assert.equal(result.isSuccess, true);
      // With 17 confirmations but txBlock > finalizedHeight, it is CONFIRMED, not FINALIZED
      assert.equal(result.finality, "CONFIRMED");
    } finally {
      server.close();
    }
  });

  it("parses actual hex logIndex from receipt into eventIndex for ERC-20 transfers", async () => {
    const payerAddr = "0x1111111111111111111111111111111111111111";
    const recipientAddr = "0x2222222222222222222222222222222222222222";
    const tokenContract = "0x3333333333333333333333333333333333333333";

    const server = http.createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        const json = JSON.parse(body);
        if (json.method === "eth_getTransactionByHash") {
          res.end(
            JSON.stringify({
              jsonrpc: "2.0",
              id: json.id,
              result: {
                hash: json.params[0],
                from: payerAddr,
                to: tokenContract,
                value: "0x0",
                input: "0xa9059cbb",
                blockNumber: "0x10",
                blockHash: "0xblock16",
              },
            }),
          );
        } else if (json.method === "eth_getTransactionReceipt") {
          res.end(
            JSON.stringify({
              jsonrpc: "2.0",
              id: json.id,
              result: {
                status: "0x1",
                blockNumber: "0x10",
                blockHash: "0xblock16",
                logs: [
                  {
                    address: "0x4444444444444444444444444444444444444444",
                    topics: ["0xother"],
                    data: "0x",
                    logIndex: "0x0",
                  },
                  {
                    address: tokenContract,
                    topics: [
                      ERC20_TRANSFER_EVENT_TOPIC,
                      padAddressToTopic(payerAddr),
                      padAddressToTopic(recipientAddr),
                    ],
                    data: "0x05f5e100", // 100,000,000 (100 USDC)
                    logIndex: "0x4", // log index 4 in receipt
                  },
                ],
              },
            }),
          );
        } else if (json.method === "eth_blockNumber") {
          res.end(
            JSON.stringify({ jsonrpc: "2.0", id: json.id, result: "0x20" }),
          );
        } else if (json.method === "eth_getBlockByNumber") {
          res.end(
            JSON.stringify({
              jsonrpc: "2.0",
              id: json.id,
              result: { number: "0x15", hash: "0xblock16" },
            }),
          );
        } else {
          res.end(
            JSON.stringify({ jsonrpc: "2.0", id: json.id, result: null }),
          );
        }
      });
    });

    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const port = (server.address() as AddressInfo).port;
    const rpcUrl = `http://127.0.0.1:${port}`;

    try {
      const result = await verifyEvmTransfer({
        rpcUrl,
        network: "ethereum-mainnet",
        txHash: "0x" + "d".repeat(64),
        expectedRecipient: recipientAddr,
        expectedAssetId: "ethereum-mainnet:USDC",
        expectedTokenContract: tokenContract,
        minimumAtomicAmount: 50000000n,
      });

      assert.equal(result.isSuccess, true);
      assert.equal(result.eventIndex, 4);
      assert.equal(result.atomicAmount, 100000000n);
      assert.equal(result.finality, "FINALIZED");
    } finally {
      server.close();
    }
  });
});

import assert from "node:assert/strict";
import http from "node:http";
import { test } from "node:test";
import {
  checkAllBlockchainRpcs,
  checkBaseRpc,
  checkNearRpc,
  checkSolanaRpc,
} from "../src/server/custody/blockchain-connectivity.ts";

async function createMockRpcServer(
  handler: (req: http.IncomingMessage, res: http.ServerResponse) => void,
): Promise<{ url: string; close: () => Promise<void> }> {
  const server = http.createServer(handler);
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}

test("checkNearRpc parses valid status response from NEAR JSON-RPC", async () => {
  const mock = await createMockRpcServer((req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        jsonrpc: "2.0",
        id: "flow-health-check",
        result: {
          chain_id: "mainnet",
          sync_info: {
            latest_block_height: 223449716,
            latest_block_time: "2026-11-07T10:00:00.000Z",
          },
          version: { version: "2.4.0" },
        },
      }),
    );
  });

  try {
    const result = await checkNearRpc(mock.url, 1000);
    assert.equal(result.network, "near");
    assert.equal(result.reachable, true);
    assert.equal(result.chainEnvironment, "mainnet");
    assert.equal(result.details.chainId, "mainnet");
    assert.equal(result.details.latestBlockHeight, 223449716);
  } finally {
    await mock.close();
  }
});

test("checkBaseRpc parses valid net_version and eth_blockNumber batch response from Base JSON-RPC", async () => {
  const mock = await createMockRpcServer((req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify([
        { jsonrpc: "2.0", id: 1, result: "8453" },
        { jsonrpc: "2.0", id: 2, result: "0x33c234b" }, // 54272843
      ]),
    );
  });

  try {
    const result = await checkBaseRpc(mock.url, 1000);
    assert.equal(result.network, "base");
    assert.equal(result.reachable, true);
    assert.equal(result.chainEnvironment, "mainnet");
    assert.equal(result.details.networkId, "8453");
    assert.equal(result.details.latestBlockHeight, 54272843);
  } finally {
    await mock.close();
  }
});

test("checkSolanaRpc parses valid getSlot response from Solana JSON-RPC", async () => {
  const mock = await createMockRpcServer((req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify([
        { jsonrpc: "2.0", id: 1, result: 466467757 },
        {
          jsonrpc: "2.0",
          id: 2,
          result: "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d",
        },
      ]),
    );
  });

  try {
    const result = await checkSolanaRpc(mock.url, 1000);
    assert.equal(result.network, "solana");
    assert.equal(result.reachable, true);
    assert.equal(result.chainEnvironment, "mainnet");
    assert.equal(result.details.latestSlot, 466467757);
  } finally {
    await mock.close();
  }
});

test("checkSolanaRpc identifies devnet genesis hash correctly", async () => {
  const mock = await createMockRpcServer((req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify([
        { jsonrpc: "2.0", id: 1, result: 12345 },
        {
          jsonrpc: "2.0",
          id: 2,
          result: "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG",
        },
      ]),
    );
  });

  try {
    const result = await checkSolanaRpc(mock.url, 1000);
    assert.equal(result.reachable, true);
    assert.equal(result.chainEnvironment, "devnet");
  } finally {
    await mock.close();
  }
});

test("RPC checks handle timeouts and HTTP errors gracefully without leaking credentials or raw urls", async () => {
  const mock = await createMockRpcServer((req, res) => {
    res.writeHead(502, { "Content-Type": "text/html" });
    res.end("<html><body>502 Bad Gateway</body></html>");
  });

  try {
    const result = await checkNearRpc(
      `${mock.url}?apiKey=secret_key_12345`,
      500,
    );
    assert.equal(result.reachable, false);
    assert.ok(!result.endpoint.includes("secret_key_12345"));
    assert.ok(result.error?.includes("HTTP 502"));
  } finally {
    await mock.close();
  }
});

test("checkAllBlockchainRpcs orchestrates NEAR, Base, and Solana connectivity checks", async () => {
  const mock = await createMockRpcServer((req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        result: {
          chain_id: "testnet",
          sync_info: { latest_block_height: 100 },
        },
      }),
    );
  });

  try {
    const all = await checkAllBlockchainRpcs({
      nearRpcUrl: mock.url,
      baseRpcUrl: mock.url,
      solanaRpcUrl: mock.url,
      timeoutMs: 500,
    });
    assert.equal(typeof all.allReachable, "boolean");
    assert.equal(all.near.network, "near");
    assert.equal(all.base.network, "base");
    assert.equal(all.solana.network, "solana");
  } finally {
    await mock.close();
  }
});

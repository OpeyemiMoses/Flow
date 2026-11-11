import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { describe, it } from "node:test";
import { fetchOneClickExecutionStatus } from "../src/server/providers/one-click-adapter.ts";

describe("one-click-adapter: execution status lifecycle stages", () => {
  it("maps provider status values to canonical execution stages", async () => {
    let currentStatusResponse = {
      status: "DEPOSIT_DETECTED",
      sourceTxHash: "0xsource123",
    };

    const server = http.createServer((req, res) => {
      const url = new URL(req.url!, `http://${req.headers.host}`);
      if (url.pathname === "/v0/status") {
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify(currentStatusResponse));
        return;
      }
      res.statusCode = 404;
      res.end();
    });

    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const port = (server.address() as AddressInfo).port;
    const apiBase = `http://127.0.0.1:${port}`;

    try {
      // 1. SOURCE_DEPOSIT_OBSERVED
      currentStatusResponse = {
        status: "DEPOSIT_DETECTED",
        sourceTxHash: "0xsource123",
      };
      let res = await fetchOneClickExecutionStatus({
        depositAddress: "0xdeposit",
        apiBase,
      });
      assert.equal(res.ok, true);
      assert.equal(res.stage, "SOURCE_DEPOSIT_OBSERVED");
      assert.equal(res.sourceTxHash, "0xsource123");

      // 2. SOURCE_FINALIZED
      currentStatusResponse = {
        status: "SOURCE_FINALIZED",
        sourceTxHash: "0xsource123",
      };
      res = await fetchOneClickExecutionStatus({
        depositAddress: "0xdeposit",
        apiBase,
      });
      assert.equal(res.ok, true);
      assert.equal(res.stage, "SOURCE_FINALIZED");

      // 3. ROUTING_IN_PROGRESS
      currentStatusResponse = {
        status: "PROCESSING",
        sourceTxHash: "0xsource123",
      };
      res = await fetchOneClickExecutionStatus({
        depositAddress: "0xdeposit",
        apiBase,
      });
      assert.equal(res.ok, true);
      assert.equal(res.stage, "ROUTING_IN_PROGRESS");

      // 4. DESTINATION_TRANSFER_OBSERVED
      currentStatusResponse = {
        status: "DESTINATION_TRANSFER_OBSERVED",
        sourceTxHash: "0xsource123",
      };
      res = await fetchOneClickExecutionStatus({
        depositAddress: "0xdeposit",
        apiBase,
      });
      assert.equal(res.ok, true);
      assert.equal(res.stage, "DESTINATION_TRANSFER_OBSERVED");

      // 5. DESTINATION_FINALIZED
      currentStatusResponse = {
        status: "COMPLETED",
        sourceTxHash: "0xsource123",
        // @ts-expect-error property destinationTxHash is not in original type definition for mock
        destinationTxHash: "0xdest456",
      };
      res = await fetchOneClickExecutionStatus({
        depositAddress: "0xdeposit",
        apiBase,
      });
      assert.equal(res.ok, true);
      assert.equal(res.stage, "DESTINATION_FINALIZED");
      assert.equal(res.destinationTxHash, "0xdest456");

      // 6. REFUNDED
      currentStatusResponse = {
        status: "REFUNDED",
        // @ts-expect-error property refundTxHash is not in original type definition for mock
        refundTxHash: "0xrefund789",
      };
      res = await fetchOneClickExecutionStatus({
        depositAddress: "0xdeposit",
        apiBase,
      });
      assert.equal(res.ok, true);
      assert.equal(res.stage, "REFUNDED");
      assert.equal(res.refundTxHash, "0xrefund789");

      // 7. FAILED
      currentStatusResponse = {
        status: "FAILED",
        // @ts-expect-error property failureReason is not in original type definition for mock
        failureReason: "Slippage exceeded",
      };
      res = await fetchOneClickExecutionStatus({
        depositAddress: "0xdeposit",
        apiBase,
      });
      assert.equal(res.ok, true);
      assert.equal(res.stage, "FAILED");
      assert.equal(res.failureReason, "Slippage exceeded");
    } finally {
      server.close();
    }
  });

  it("distinguishes quoteRequest guaranteed rate deadline from quote deposit address inactivity time", async () => {
    const quoteRequestDeadline = new Date(
      Date.now() + 15 * 60 * 1000,
    ).toISOString();
    const timeWhenInactive = new Date(
      Date.now() + 72 * 60 * 60 * 1000,
    ).toISOString();

    const server = http.createServer((req, res) => {
      const url = new URL(req.url!, `http://${req.headers.host}`);
      if (url.pathname === "/v0/quote") {
        res.setHeader("Content-Type", "application/json");
        res.end(
          JSON.stringify({
            depositAddress: "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM",
            quote: {
              amountIn: "11977245",
              amountOut: "1000000",
              deadline: timeWhenInactive,
              timeWhenInactive: timeWhenInactive,
            },
            quoteRequest: {
              originAsset: "solana:sol",
              destinationAsset: "base:usdc",
              amount: "1000000",
              refundTo: "Ck7JNaqjS9otRa72z8AxmP8YKdheiC42AacJGoP3AJRY",
              recipient: "0x436BdB38888998e269E94301C2362C2f46bCF614",
              deadline: quoteRequestDeadline,
            },
            signature: "sig123",
          }),
        );
        return;
      }
      res.statusCode = 404;
      res.end();
    });

    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const port = (server.address() as AddressInfo).port;
    const apiBase = `http://127.0.0.1:${port}`;

    try {
      const { fetchOneClickCommittedQuote } =
        await import("../src/server/providers/one-click-adapter.ts");
      const res = await fetchOneClickCommittedQuote({
        originAsset: "solana:sol",
        destinationAsset: "base:usdc",
        swapType: "EXACT_OUTPUT",
        amountAtomic: "1000000",
        refundTo: "Ck7JNaqjS9otRa72z8AxmP8YKdheiC42AacJGoP3AJRY",
        recipient: "0x436BdB38888998e269E94301C2362C2f46bCF614",
        apiBase,
        skipSignatureVerification: true,
      });

      assert.equal(res.ok, true);
      assert.equal(
        res.depositAddress,
        "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM",
      );
      assert.equal(
        res.depositDeadline,
        quoteRequestDeadline,
        "Must bind to 15-minute rate guarantee deadline!",
      );
      assert.equal(
        res.timeWhenInactive,
        timeWhenInactive,
        "Must extract 72-hour physical address inactivity time!",
      );
      assert.equal(
        res.amountInAtomic,
        "11977245",
        "Must extract committed amountIn atomic!",
      );
    } finally {
      server.close();
    }
  });

  it("fails closed when provider rate guarantee deadline is absent or only address lifetime is returned", async () => {
    const timeWhenInactive = new Date(
      Date.now() + 72 * 60 * 60 * 1000,
    ).toISOString();

    const server = http.createServer((req, res) => {
      const url = new URL(req.url!, `http://${req.headers.host}`);
      if (url.pathname === "/v0/quote") {
        res.setHeader("Content-Type", "application/json");
        res.end(
          JSON.stringify({
            depositAddress: "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM",
            quote: {
              amountIn: "11977245",
              amountOut: "1000000",
              deadline: timeWhenInactive,
              timeWhenInactive: timeWhenInactive,
            },
            quoteRequest: {
              originAsset: "solana:sol",
              destinationAsset: "base:usdc",
              amount: "1000000",
              refundTo: "Ck7JNaqjS9otRa72z8AxmP8YKdheiC42AacJGoP3AJRY",
              recipient: "0x436BdB38888998e269E94301C2362C2f46bCF614",
              // quoteRequest.deadline is deliberately omitted to simulate absent rate-guarantee deadline
            },
            signature: "sig123",
          }),
        );
        return;
      }
      res.statusCode = 404;
      res.end();
    });

    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const port = (server.address() as AddressInfo).port;
    const apiBase = `http://127.0.0.1:${port}`;

    try {
      const { fetchOneClickCommittedQuote } =
        await import("../src/server/providers/one-click-adapter.ts");
      const res = await fetchOneClickCommittedQuote({
        originAsset: "solana:sol",
        destinationAsset: "base:usdc",
        swapType: "EXACT_OUTPUT",
        amountAtomic: "1000000",
        refundTo: "Ck7JNaqjS9otRa72z8AxmP8YKdheiC42AacJGoP3AJRY",
        recipient: "0x436BdB38888998e269E94301C2362C2f46bCF614",
        apiBase,
        skipSignatureVerification: true,
      });

      assert.equal(
        res.ok,
        false,
        "Must fail closed without manufacturing a fake deadline!",
      );
      assert.equal(res.isAmbiguousDeadline, true);
      assert.equal(
        res.depositAddress,
        "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM",
        "Must capture remotely allocated deposit address for quarantine",
      );
      assert.equal(
        res.timeWhenInactive,
        timeWhenInactive,
        "timeWhenInactive remains preserved for physical address lifetime monitoring",
      );
      assert.ok(
        res.errorMessage?.includes("PROVIDER_DEADLINE_ABSENT"),
        `Error message must indicate deadline was absent: ${res.errorMessage}`,
      );
    } finally {
      server.close();
    }
  });

  it("fails closed when quoteRequest.deadline conflates with 72h address inactivity lifetime", async () => {
    const timeWhenInactive = new Date(
      Date.now() + 72 * 60 * 60 * 1000,
    ).toISOString();

    const server = http.createServer((req, res) => {
      const url = new URL(req.url!, `http://${req.headers.host}`);
      if (url.pathname === "/v0/quote") {
        res.setHeader("Content-Type", "application/json");
        res.end(
          JSON.stringify({
            depositAddress: "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM",
            quote: {
              amountIn: "11977245",
              amountOut: "1000000",
              deadline: timeWhenInactive,
              timeWhenInactive: timeWhenInactive,
            },
            quoteRequest: {
              originAsset: "solana:sol",
              destinationAsset: "base:usdc",
              amount: "1000000",
              refundTo: "Ck7JNaqjS9otRa72z8AxmP8YKdheiC42AacJGoP3AJRY",
              recipient: "0x436BdB38888998e269E94301C2362C2f46bCF614",
              deadline: timeWhenInactive, // Ambiguously set to 72h address lifetime
            },
            signature: "sig123",
          }),
        );
        return;
      }
      res.statusCode = 404;
      res.end();
    });

    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const port = (server.address() as AddressInfo).port;
    const apiBase = `http://127.0.0.1:${port}`;

    try {
      const { fetchOneClickCommittedQuote } =
        await import("../src/server/providers/one-click-adapter.ts");
      const res = await fetchOneClickCommittedQuote({
        originAsset: "solana:sol",
        destinationAsset: "base:usdc",
        swapType: "EXACT_OUTPUT",
        amountAtomic: "1000000",
        refundTo: "Ck7JNaqjS9otRa72z8AxmP8YKdheiC42AacJGoP3AJRY",
        recipient: "0x436BdB38888998e269E94301C2362C2f46bCF614",
        apiBase,
        skipSignatureVerification: true,
      });

      assert.equal(
        res.ok,
        false,
        "Must fail closed on ambiguous 72-hour deadline!",
      );
      assert.equal(res.isAmbiguousDeadline, true);
      assert.ok(
        res.errorMessage?.includes("PROVIDER_DEADLINE_AMBIGUOUS"),
        `Error message must indicate ambiguous deadline: ${res.errorMessage}`,
      );
    } finally {
      server.close();
    }
  });
});

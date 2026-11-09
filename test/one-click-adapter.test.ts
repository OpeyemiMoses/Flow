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
});

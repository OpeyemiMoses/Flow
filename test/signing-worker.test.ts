import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { SigningPreparationWorker } from "../src/server/custody/signing-worker.ts";

describe("custody: privileged signing preparation worker", () => {
  it("rejects construction when caller is not privileged flow_worker", () => {
    assert.throws(
      () => new SigningPreparationWorker("flow_app"),
      /Caller role 'flow_app' cannot access custody signing credentials/,
    );

    assert.throws(
      () => new SigningPreparationWorker("guest"),
      /Caller role 'guest' cannot access custody signing credentials/,
    );
  });

  it("prepares EVM transaction with address validation and gates execution", () => {
    const worker = new SigningPreparationWorker("flow_worker");
    const validRecipient = "0x1234567890123456789012345678901234567890";

    const prepared = worker.prepareEvmTransaction({
      chainId: 8453,
      to: validRecipient,
      valueAtomic: 1000000n,
      nonce: 1,
      maxFeePerGasAtomic: 1000000000n,
      maxPriorityFeePerGasAtomic: 100000000n,
    });

    assert.equal(prepared.chainId, 8453);
    assert.equal(prepared.to.toLowerCase(), validRecipient.toLowerCase());
    assert.equal(prepared.valueAtomic, 1000000n);
    assert.equal(prepared.executionGated, true);

    // Rejects invalid recipient address
    assert.throws(
      () =>
        worker.prepareEvmTransaction({
          chainId: 8453,
          to: "not-an-evm-address",
          valueAtomic: 1000000n,
          nonce: 1,
          maxFeePerGasAtomic: 1000000000n,
          maxPriorityFeePerGasAtomic: 100000000n,
        }),
      /Invalid EVM recipient address/,
    );
  });

  it("prepares Solana transaction with Base58 pubkey validation and gates execution", () => {
    const worker = new SigningPreparationWorker("flow_worker");
    const validPubkey = "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin";

    const prepared = worker.prepareSolanaTransaction({
      recentBlockhash: "EkSnNWid2cvwEVnPx9aZaINghZZu4HHasztNGLWDGbdD",
      fromPubkey: validPubkey,
      toPubkey: validPubkey,
      lamportsAtomic: 5000000n,
    });

    assert.equal(prepared.fromPubkey, validPubkey);
    assert.equal(prepared.lamportsAtomic, 5000000n);
    assert.equal(prepared.executionGated, true);

    // Rejects invalid pubkey
    assert.throws(
      () =>
        worker.prepareSolanaTransaction({
          recentBlockhash: "EkSnNWid2cvwEVnPx9aZaINghZZu4HHasztNGLWDGbdD",
          fromPubkey: "invalid",
          toPubkey: validPubkey,
          lamportsAtomic: 1000n,
        }),
      /Invalid Solana pubkey/,
    );
  });

  it("prepares NEAR transaction with named account validation and gates execution", () => {
    const worker = new SigningPreparationWorker("flow_worker");

    const prepared = worker.prepareNearTransaction({
      signerId: "sender.near",
      receiverId: "recipient.near",
      nonce: 42n,
      blockHash: "9tVNmJcQ1qXzZ6yL2p8bW4vR7mK5nE3tY1uI8oP6aDsF",
      depositYoctoAtomic: 1000000000000000000000000n,
    });

    assert.equal(prepared.signerId, "sender.near");
    assert.equal(prepared.receiverId, "recipient.near");
    assert.equal(prepared.executionGated, true);

    // Rejects invalid NEAR receiver ID
    assert.throws(
      () =>
        worker.prepareNearTransaction({
          signerId: "sender.near",
          receiverId: "Invalid_Uppercase.near",
          nonce: 1n,
          blockHash: "9tVNmJcQ1qXzZ6yL2p8bW4vR7mK5nE3tY1uI8oP6aDsF",
          depositYoctoAtomic: 100n,
        }),
      /Invalid NEAR recipient account ID/,
    );
  });

  it("signAndBroadcast throws CUSTODY_EXECUTION_BLOCKED while FLOW_EXECUTION=disabled", async () => {
    const worker = new SigningPreparationWorker("flow_worker");

    await assert.rejects(
      () => worker.signAndBroadcast(),
      /Signing and transaction broadcast are strictly prohibited while FLOW_EXECUTION=disabled/,
    );
  });
});

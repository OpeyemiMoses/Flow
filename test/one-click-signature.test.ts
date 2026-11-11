import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { type AddressInfo } from "node:net";
import {
  fetchOneClickCommittedQuote,
  getOneClickHeaders,
} from "../src/server/providers/one-click-adapter.ts";
import {
  verifyQuoteSignature,
  quoteHash,
  type OneClickQuoteResponse,
} from "@defuse-protocol/one-click-sdk-typescript";
import nacl from "tweetnacl";

// Helper to encode Uint8Array to base58 using standard Bitcoin alphabet
const B58_ALPHABET =
  "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function encodeBase58(buffer: Uint8Array): string {
  const digits = [0];
  for (let i = 0; i < buffer.length; i++) {
    for (let j = 0; j < digits.length; j++) digits[j]! <<= 8;
    digits[0]! += buffer[i]!;
    let carry = 0;
    for (let j = 0; j < digits.length; ++j) {
      digits[j]! += carry;
      carry = (digits[j]! / 58) | 0;
      digits[j]! %= 58;
    }
    while (carry) {
      digits.push(carry % 58);
      carry = (carry / 58) | 0;
    }
  }
  for (let i = 0; i < buffer.length && buffer[i] === 0; i++) digits.push(0);
  return digits
    .reverse()
    .map((digit) => B58_ALPHABET[digit])
    .join("");
}

test("one-click-signature: verifies authentic signature and rejects tampered quote", () => {
  const keypair = nacl.sign.keyPair();
  const managerPublicKey = `ed25519:${encodeBase58(keypair.publicKey)}`;

  const quoteResponse = {
    quoteRequest: {
      dry: false,
      swapType: "EXACT_OUTPUT",
      slippageTolerance: 100,
      originAsset:
        "nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near",
      depositType: "ORIGIN_CHAIN" as const,
      destinationAsset:
        "nep141:sol-5ce3bf3a31af18be40ba30f721101b4341690186.omft.near",
      amount: "10000000",
      refundTo: "0x1111111111111111111111111111111111111111",
      refundType: "ORIGIN_CHAIN" as const,
      recipient: "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU",
      recipientType: "DESTINATION_CHAIN" as const,
      deadline: "2026-11-10T12:00:00.000Z",
    },
    quote: {
      amountIn: "10050000",
      amountOut: "10000000",
      depositAddress: "0x2222222222222222222222222222222222222222",
      deadline: "2026-11-10T12:00:00.000Z",
    },
    timestamp: "2026-11-09T22:00:00.000Z",
    signature: "",
  };

  // Sign quote hash
  const hash = quoteHash(quoteResponse as OneClickQuoteResponse);
  const signatureBytes = nacl.sign.detached(
    new TextEncoder().encode(hash),
    keypair.secretKey,
  );
  quoteResponse.signature = `ed25519:${encodeBase58(signatureBytes)}`;

  // 1. Authentic signature validates successfully
  const valid = verifyQuoteSignature(
    quoteResponse as OneClickQuoteResponse,
    managerPublicKey,
  );
  assert.equal(valid, true);

  // 2. Tampered destination amountOut fails verification
  const tamperedAmount = {
    ...quoteResponse,
    quote: {
      ...quoteResponse.quote,
      amountOut: "999999999",
    },
  };
  const tamperedAmountValid = verifyQuoteSignature(
    tamperedAmount as OneClickQuoteResponse,
    managerPublicKey,
  );
  assert.equal(tamperedAmountValid, false);

  // 3. Tampered depositAddress fails verification
  const tamperedAddress = {
    ...quoteResponse,
    quote: {
      ...quoteResponse.quote,
      depositAddress: "0xBadAttackerAddress00000000000000000000",
    },
  };
  const tamperedAddrValid = verifyQuoteSignature(
    tamperedAddress as OneClickQuoteResponse,
    managerPublicKey,
  );
  assert.equal(tamperedAddrValid, false);

  // 4. Tampered recipient in quoteRequest fails verification
  const tamperedRecipient = {
    ...quoteResponse,
    quoteRequest: {
      ...quoteResponse.quoteRequest,
      recipient: "AttackerSolanaRecipientAddress111111111111",
    },
  };
  const tamperedRecipValid = verifyQuoteSignature(
    tamperedRecipient as OneClickQuoteResponse,
    managerPublicKey,
  );
  assert.equal(tamperedRecipValid, false);
});

test("one-click-adapter: fetchOneClickCommittedQuote validates cryptographic signature and schema", async () => {
  const keypair = nacl.sign.keyPair();
  const managerPublicKey = `ed25519:${encodeBase58(keypair.publicKey)}`;

  let mockStatus = 200;
  let mockBody: Record<string, unknown> = {};

  const server = http.createServer((_req, res) => {
    res.writeHead(mockStatus, { "Content-Type": "application/json" });
    res.end(JSON.stringify(mockBody));
  });

  await new Promise<void>((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve()),
  );
  const address = server.address() as AddressInfo;
  const apiBase = `http://127.0.0.1:${address.port}`;

  const validRequest = {
    originAsset:
      "nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near",
    destinationAsset:
      "nep141:sol-5ce3bf3a31af18be40ba30f721101b4341690186.omft.near",
    swapType: "EXACT_OUTPUT" as const,
    amountAtomic: "10000000",
    refundTo: "0x1111111111111111111111111111111111111111",
    recipient: "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU",
  };

  try {
    // 1. Success case: fully signed, valid schema and matching parameters
    const deadlineIso = new Date(Date.now() + 1200_000).toISOString();
    const rawQuote = {
      quoteRequest: {
        dry: false,
        swapType: "EXACT_OUTPUT",
        slippageTolerance: 100,
        originAsset: validRequest.originAsset,
        depositType: "ORIGIN_CHAIN",
        destinationAsset: validRequest.destinationAsset,
        amount: validRequest.amountAtomic,
        refundTo: validRequest.refundTo,
        refundType: "ORIGIN_CHAIN",
        recipient: validRequest.recipient,
        recipientType: "DESTINATION_CHAIN",
        deadline: deadlineIso,
      },
      quote: {
        amountIn: "10050000",
        amountOut: "10000000",
        depositAddress: "0x3333333333333333333333333333333333333333",
        depositMemo: "memo-test-123",
        deadline: deadlineIso,
        timeWhenInactive: new Date(Date.now() + 72 * 3600_000).toISOString(),
        timeEstimate: 25,
      },
      timestamp: new Date().toISOString(),
      correlationId: "corr-signed-1",
      signature: "",
    };

    const hash = quoteHash(rawQuote as unknown as OneClickQuoteResponse);
    const signatureBytes = nacl.sign.detached(
      new TextEncoder().encode(hash),
      keypair.secretKey,
    );
    rawQuote.signature = `ed25519:${encodeBase58(signatureBytes)}`;

    mockStatus = 200;
    mockBody = rawQuote;

    const res1 = await fetchOneClickCommittedQuote({
      ...validRequest,
      apiBase,
      managerPublicKey,
    });

    assert.equal(res1.ok, true);
    assert.equal(
      res1.depositAddress,
      "0x3333333333333333333333333333333333333333",
    );
    assert.equal(res1.depositMemo, "memo-test-123");
    assert.equal(res1.amountInAtomic, "10050000");
    assert.equal(res1.amountOutAtomic, "10000000");

    // 2. Failure: Forged signature rejected
    const forgedQuote = {
      ...rawQuote,
      signature:
        "ed25519:1111111111111111111111111111111111111111111111111111111111111111",
    };
    mockBody = forgedQuote;

    const res2 = await fetchOneClickCommittedQuote({
      ...validRequest,
      apiBase,
      managerPublicKey,
    });
    assert.equal(res2.ok, false);
    assert.ok(res2.errorMessage?.includes("signature verification failed"));

    // 3. Failure: Missing signature rejected
    const unsignedQuote = {
      ...rawQuote,
      signature: undefined,
    };
    mockBody = unsignedQuote;

    const res3 = await fetchOneClickCommittedQuote({
      ...validRequest,
      apiBase,
      managerPublicKey,
    });
    assert.equal(res3.ok, false);
    assert.ok(res3.errorMessage?.includes("Missing cryptographic signature"));

    // 4. Failure: Recipient address schema mismatch rejected
    const mismatchedRecipientQuote = {
      ...rawQuote,
      quoteRequest: {
        ...rawQuote.quoteRequest,
        recipient: "MismatchedRecipientAddress123456789012345",
      },
    };
    const hashMismatched = quoteHash(
      mismatchedRecipientQuote as unknown as OneClickQuoteResponse,
    );
    const sigMismatched = nacl.sign.detached(
      new TextEncoder().encode(hashMismatched),
      keypair.secretKey,
    );
    mismatchedRecipientQuote.signature = `ed25519:${encodeBase58(sigMismatched)}`;
    mockBody = mismatchedRecipientQuote;

    const res4 = await fetchOneClickCommittedQuote({
      ...validRequest,
      apiBase,
      managerPublicKey,
    });
    assert.equal(res4.ok, false);
    assert.ok(
      res4.errorMessage?.includes(
        "PROVIDER_SCHEMA_MISMATCH: Recipient address mismatch",
      ),
    );

    // 5. Failure: Synthetic deposit address rejected
    const syntheticAddrQuote = {
      ...rawQuote,
      quote: {
        ...rawQuote.quote,
        depositAddress: "flow-synthetic-deposit.near",
      },
    };
    const hashSynthetic = quoteHash(
      syntheticAddrQuote as unknown as OneClickQuoteResponse,
    );
    const sigSynthetic = nacl.sign.detached(
      new TextEncoder().encode(hashSynthetic),
      keypair.secretKey,
    );
    syntheticAddrQuote.signature = `ed25519:${encodeBase58(sigSynthetic)}`;
    mockBody = syntheticAddrQuote;

    const res5 = await fetchOneClickCommittedQuote({
      ...validRequest,
      apiBase,
      managerPublicKey,
    });
    assert.equal(res5.ok, false);
    assert.ok(res5.errorMessage?.includes("valid non-synthetic"));
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("one-click-adapter: getOneClickHeaders securely isolates partner credentials on the server", () => {
  const originalKey = process.env.FLOW_ONE_CLICK_API_KEY;
  const originalPartner = process.env.FLOW_ONE_CLICK_PARTNER_ID;

  try {
    process.env.FLOW_ONE_CLICK_API_KEY = "test-secret-key-12345";
    process.env.FLOW_ONE_CLICK_PARTNER_ID = "partner-flow-official";

    const headers = getOneClickHeaders();
    assert.equal(headers["Content-Type"], "application/json");
    assert.equal(headers["Accept"], "application/json");
    assert.equal(headers["Authorization"], "Bearer test-secret-key-12345");
    assert.equal(headers["x-partner-id"], "partner-flow-official");

    // Clear and verify omission
    delete process.env.FLOW_ONE_CLICK_API_KEY;
    delete process.env.FLOW_ONE_CLICK_PARTNER_ID;

    const headersWithoutAuth = getOneClickHeaders();
    assert.equal(headersWithoutAuth["Authorization"], undefined);
    assert.equal(headersWithoutAuth["x-partner-id"], undefined);
  } finally {
    if (originalKey !== undefined) {
      process.env.FLOW_ONE_CLICK_API_KEY = originalKey;
    } else {
      delete process.env.FLOW_ONE_CLICK_API_KEY;
    }
    if (originalPartner !== undefined) {
      process.env.FLOW_ONE_CLICK_PARTNER_ID = originalPartner;
    } else {
      delete process.env.FLOW_ONE_CLICK_PARTNER_ID;
    }
  }
});

import { createECDH, createHash, randomBytes, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { appendFile, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

if (
  process.env.FLOW_ENV !== "test" ||
  process.env.FLOW_GOOGLE_CLIENT_ID !==
    "000000-flow-fixture.apps.googleusercontent.com" ||
  !process.env.FLOW_PROVIDER_FIXTURE_DIR
)
  throw new Error("Provider fixture requires isolated test configuration.");

const directory = process.env.FLOW_PROVIDER_FIXTURE_DIR;
const fetchThrough = globalThis.fetch;

const BASE58_ALPHABET =
  "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

function encodeBase58(bytes) {
  let leadingZeros = 0;
  while (leadingZeros < bytes.length && bytes[leadingZeros] === 0) {
    leadingZeros++;
  }
  let num = 0n;
  for (const b of bytes) {
    num = (num << 8n) + BigInt(b);
  }
  const chars = [];
  while (num > 0n) {
    const rem = Number(num % 58n);
    chars.push(BASE58_ALPHABET[rem]);
    num = num / 58n;
  }
  for (let i = 0; i < leadingZeros; i++) {
    chars.push("1");
  }
  return chars.reverse().join("");
}

const KECCAK_RC = [
  0x0000000000000001n,
  0x0000000000008082n,
  0x800000000000808an,
  0x8000000080008000n,
  0x000000000000808bn,
  0x0000000080000001n,
  0x8000000080008081n,
  0x8000000000008009n,
  0x000000000000008an,
  0x0000000000000088n,
  0x0000000080008009n,
  0x000000008000000an,
  0x000000008000808bn,
  0x800000000000008bn,
  0x8000000000008089n,
  0x8000000000008003n,
  0x8000000000008002n,
  0x8000000000000080n,
  0x000000000000800an,
  0x800000008000000an,
  0x8000000080008081n,
  0x8000000000008080n,
  0x0000000080000001n,
  0x8000000080008008n,
];
const KECCAK_ROTC = [
  1, 3, 6, 10, 15, 21, 28, 36, 45, 55, 2, 14, 27, 41, 56, 8, 25, 43, 62, 18, 39,
  61, 20, 44,
];
const KECCAK_PILN = [
  10, 7, 11, 17, 18, 3, 5, 16, 8, 21, 24, 4, 15, 23, 19, 13, 12, 2, 20, 14, 22,
  9, 6, 1,
];
const MASK_64 = 0xffffffffffffffffn;
const rotl64 = (x, n) => ((x << BigInt(n)) | (x >> BigInt(64 - n))) & MASK_64;

function keccak256Bytes(input) {
  const rate = 136;
  const msg = Buffer.from(input);
  const padLen = rate - (msg.length % rate);
  const buf = Buffer.alloc(msg.length + padLen);
  msg.copy(buf);
  buf[msg.length] = 0x01;
  buf[buf.length - 1] |= 0x80;
  const st = new Array(25).fill(0n);
  const bc = new Array(5).fill(0n);
  for (let off = 0; off < buf.length; off += rate) {
    for (let i = 0; i < 17; i++) st[i] ^= buf.readBigUInt64LE(off + i * 8);
    for (let r = 0; r < 24; r++) {
      for (let i = 0; i < 5; i++)
        bc[i] = st[i] ^ st[i + 5] ^ st[i + 10] ^ st[i + 15] ^ st[i + 20];
      for (let i = 0; i < 5; i++) {
        const t = bc[(i + 4) % 5] ^ rotl64(bc[(i + 1) % 5], 1);
        for (let j = 0; j < 25; j += 5) st[j + i] ^= t;
      }
      let t = st[1];
      for (let i = 0; i < 24; i++) {
        const j = KECCAK_PILN[i];
        const tmp = st[j];
        st[j] = rotl64(t, KECCAK_ROTC[i]);
        t = tmp;
      }
      for (let j = 0; j < 25; j += 5) {
        for (let i = 0; i < 5; i++) bc[i] = st[j + i];
        for (let i = 0; i < 5; i++)
          st[j + i] ^= ~bc[(i + 1) % 5] & MASK_64 & bc[(i + 2) % 5];
      }
      st[0] ^= KECCAK_RC[r];
    }
  }
  const out = Buffer.alloc(32);
  for (let i = 0; i < 4; i++) out.writeBigUInt64LE(st[i], i * 8);
  return out.toString("hex");
}

function generateSecp256k1KeyAndAddress() {
  const ecdh = createECDH("secp256k1");
  ecdh.generateKeys();
  const uncompressed = ecdh.getPublicKey(null, "uncompressed");
  const xy = uncompressed.subarray(1); // 64 bytes
  const rawAddrLower = keccak256Bytes(xy).slice(-40).toLowerCase();
  const addrHash = keccak256Bytes(Buffer.from(rawAddrLower, "utf8"));
  let checksummed = "0x";
  for (let i = 0; i < 40; i++) {
    const ch = rawAddrLower[i];
    checksummed +=
      Number.parseInt(addrHash[i], 16) >= 8 ? ch.toUpperCase() : ch;
  }
  return {
    publicKey: `secp256k1:0x${uncompressed.toString("hex")}`,
    address: checksummed,
  };
}

const outlayerWalletsByKey = new Map();

globalThis.fetch = async (input, init) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  if (url.href === "https://www.googleapis.com/oauth2/v3/certs") {
    return Response.json(
      JSON.parse(await readFile(path.join(directory, "jwks.json"), "utf8")),
    );
  }
  if (url.href === "https://oauth2.googleapis.com/token") {
    const request = new Request(input, init);
    const body = new URLSearchParams(await request.text());
    const code = body.get("code");
    if (!code || !/^[a-f0-9]{32}$/.test(code))
      return Response.json({ error: "invalid_grant" }, { status: 400 });
    const recordPath = path.join(directory, `code-${code}.json`);
    const spentPath = path.join(directory, `spent-${code}.json`);
    try {
      await rename(recordPath, spentPath);
      const expected = JSON.parse(await readFile(spentPath, "utf8"));
      const challenge = createHash("sha256")
        .update(body.get("code_verifier") ?? "")
        .digest("base64url");
      if (
        body.get("grant_type") !== "authorization_code" ||
        body.get("client_id") !== process.env.FLOW_GOOGLE_CLIENT_ID ||
        body.get("client_secret") !== process.env.FLOW_GOOGLE_CLIENT_SECRET ||
        body.get("redirect_uri") !== expected.redirect ||
        challenge !== expected.challenge
      )
        return Response.json({ error: "invalid_grant" }, { status: 400 });
      if (expected.pauseExchange) {
        const release = path.join(directory, `exchange-${code}.release`);
        await writeFile(path.join(directory, `exchange-${code}.waiting`), "");
        const deadline = Date.now() + 7_000;
        while (!existsSync(release) && Date.now() < deadline) await delay(10);
        if (!existsSync(release))
          return Response.json(
            { error: "temporarily_unavailable" },
            { status: 503 },
          );
      }
      return Response.json({
        access_token: expected.access,
        refresh_token: expected.refresh,
        id_token: expected.idToken,
        token_type: "Bearer",
        scope: "openid email profile",
        expires_in: 3600,
      });
    } catch {
      return Response.json({ error: "invalid_grant" }, { status: 400 });
    }
  }
  if (url.href === "https://api.resend.com/emails") {
    const request = new Request(input, init);
    if (
      request.headers.get("authorization") !==
      `Bearer ${process.env.FLOW_MAIL_API_KEY}`
    ) {
      return Response.json({ error: "invalid_credentials" }, { status: 401 });
    }
    await appendFile(
      path.join(directory, "mail.jsonl"),
      `${JSON.stringify(await request.json())}\n`,
      { mode: 0o600 },
    );
    return Response.json({ id: "fixture-delivery" });
  }
  if (url.href === "https://1click.chaindefuser.com/v0/quote") {
    const request = new Request(input, init);
    const body = await request.json();
    const depositAddress =
      body.dry === false
        ? "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin"
        : undefined;
    return Response.json({
      depositAddress,
      quote: {
        depositAddress,
        amountIn: "50000000",
        amountInFormatted: "0.05",
        amountInUsd: "10.00",
        amountOut: body.amount || "10000000",
        amountOutFormatted: "10.00",
        amountOutUsd: "10.00",
        timeEstimate: 30,
        refundFee: "0",
        withdrawFee: "0",
        deadline: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
      },
      quoteRequest: body,
      signature: "0x1clickfixturesignature",
      timestamp: new Date().toISOString(),
      correlationId: "fixture-1click-corr-id",
    });
  }
  if (
    url.hostname === "127.0.0.1" &&
    url.pathname.startsWith("/outlayer-fixture/")
  ) {
    const subPath = url.pathname.slice("/outlayer-fixture".length);
    const request = new Request(input, init);
    if (request.method === "POST" && subPath === "/register") {
      const walletId = randomUUID();
      const apiKey = `wk_${randomBytes(16).toString("hex")}`;
      const nearBytes = randomBytes(32);
      if (nearBytes[0] === 0) nearBytes[0] = 1;
      const nearAccountId = nearBytes.toString("hex");
      const nearPublicKey = `ed25519:${encodeBase58(nearBytes)}`;
      const evm = generateSecp256k1KeyAndAddress();
      const solBytes = randomBytes(32);
      if (solBytes[0] === 0) solBytes[0] = 1;
      const solanaAddress = encodeBase58(solBytes);
      const solanaPublicKey = `ed25519:${solanaAddress}`;

      outlayerWalletsByKey.set(apiKey, {
        walletId,
        apiKey,
        nearAccountId,
        nearPublicKey,
        baseAddress: evm.address,
        basePublicKey: evm.publicKey,
        solanaAddress,
        solanaPublicKey,
      });

      return Response.json({
        wallet_id: walletId,
        api_key: apiKey,
        near_account_id: nearAccountId,
        handoff_url: `https://app.outlayer.ai/wallet?key=${apiKey}`,
        trial: {
          available: true,
          calls: 10,
          days: 7,
          claim_url: "POST /trial-key",
          scope: "connectors.outlayer.near/*",
        },
      });
    }
    if (request.method === "GET" && subPath === "/wallet/v1/address") {
      const auth = request.headers.get("authorization") || "";
      const bearer = auth.replace(/^Bearer\s+/i, "").trim();
      const w = outlayerWalletsByKey.get(bearer);
      if (!w) {
        return Response.json({ error: "Unauthorized" }, { status: 401 });
      }
      const chain = url.searchParams.get("chain") || "base";
      const address =
        chain === "near"
          ? w.nearAccountId
          : chain === "solana"
            ? w.solanaAddress
            : w.baseAddress;
      const publicKey =
        chain === "near"
          ? w.nearPublicKey
          : chain === "solana"
            ? w.solanaPublicKey
            : w.basePublicKey;
      return Response.json({
        wallet_id: w.walletId,
        chain,
        sub_path: null,
        address,
        public_key: publicKey,
        vault_id: null,
        asset_account_id: w.nearAccountId,
        executor_account_id: chain === "near" ? address : null,
        gas_balance: "0",
      });
    }
    if (request.method === "GET" && subPath === "/wallet/v1/policy") {
      const auth = request.headers.get("authorization") || "";
      const bearer = auth.replace(/^Bearer\s+/i, "").trim();
      const w = outlayerWalletsByKey.get(bearer);
      if (!w) {
        return Response.json({ error: "Unauthorized" }, { status: 401 });
      }
      return Response.json({
        wallet_id: w.walletId,
        controller: "controller.near",
        frozen: false,
        version: 1,
        locked: false,
        policy: "stored",
        rules: {
          defaultAction: "DENY",
          requireControllerApproval: true,
          maxTransferUsd: "0",
          transferSigning: "disabled",
        },
        capabilities: {
          raw_sign: { allowed: false, requires_approval: true },
          evm_sign: { allowed: false, raw_tx: false },
          solana_sign: { allowed: false, raw_tx: false },
        },
        authorized_key_hashes: [],
        refund_addresses: {},
        usage: {},
      });
    }
  }
  if (
    [
      "rpc.mainnet.near.org",
      "rpc.testnet.near.org",
      "mainnet.base.org",
      "sepolia.base.org",
      "api.mainnet-beta.solana.com",
      "api.devnet.solana.com",
    ].includes(url.hostname)
  ) {
    const request = new Request(input, init);
    const rpcBody = await request.json().catch(() => ({}));
    const id = rpcBody.id ?? 1;
    const method = rpcBody.method;
    if (url.hostname.includes("near")) {
      if (method === "status") {
        return Response.json({
          jsonrpc: "2.0",
          id,
          result: {
            chain_id: url.hostname.includes("testnet") ? "testnet" : "mainnet",
            sync_info: { latest_block_height: 12345678 },
          },
        });
      }
      if (
        method === "query" &&
        rpcBody.params?.request_type === "view_account"
      ) {
        return Response.json({
          jsonrpc: "2.0",
          id,
          result: {
            amount: "0",
            locked: "0",
            code_hash: "11111111111111111111111111111111",
            storage_usage: 182,
            block_height: 12345678,
            block_hash: "11111111111111111111111111111111",
          },
        });
      }
      if (
        method === "query" &&
        rpcBody.params?.request_type === "call_function"
      ) {
        return Response.json({
          jsonrpc: "2.0",
          id,
          result: {
            result: Array.from(Buffer.from('"0"', "utf8")),
            logs: [],
            block_height: 12345678,
            block_hash: "11111111111111111111111111111111",
          },
        });
      }
    }
    if (url.hostname.includes("base.org")) {
      if (method === "eth_chainId") {
        return Response.json({
          jsonrpc: "2.0",
          id,
          result: url.hostname.includes("sepolia") ? "0x14a34" : "0x2105",
        });
      }
      if (method === "eth_getBalance") {
        return Response.json({ jsonrpc: "2.0", id, result: "0x0" });
      }
      if (method === "eth_blockNumber") {
        return Response.json({ jsonrpc: "2.0", id, result: "0x123456" });
      }
      if (method === "eth_call") {
        return Response.json({
          jsonrpc: "2.0",
          id,
          result:
            "0x0000000000000000000000000000000000000000000000000000000000000000",
        });
      }
    }
    if (url.hostname.includes("solana.com")) {
      if (method === "getGenesisHash") {
        return Response.json({
          jsonrpc: "2.0",
          id,
          result: url.hostname.includes("devnet")
            ? "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG"
            : "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d",
        });
      }
      if (method === "getBalance") {
        return Response.json({
          jsonrpc: "2.0",
          id,
          result: { context: { slot: 280000000 }, value: 0 },
        });
      }
      if (method === "getTokenAccountsByOwner") {
        return Response.json({
          jsonrpc: "2.0",
          id,
          result: { context: { slot: 280000000 }, value: [] },
        });
      }
    }
  }
  if (["127.0.0.1", "localhost", "[::1]"].includes(url.hostname))
    return fetchThrough(input, init);
  throw new Error("Unexpected external fetch in provider fixture.");
};

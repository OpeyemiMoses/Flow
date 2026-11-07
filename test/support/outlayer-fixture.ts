import { createECDH, randomBytes, randomUUID } from "node:crypto";
import {
  createServer,
  type Server,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import {
  deriveEvmAddressFromSecp256k1PublicKey,
  encodeBase58,
} from "../../src/domain/custody.ts";

function generateRealSecp256k1KeyAndAddress(seedBytes?: Buffer): {
  readonly publicKey: string;
  readonly address: string;
} {
  const ecdh = createECDH("secp256k1");
  if (seedBytes) {
    ecdh.setPrivateKey(seedBytes);
  } else {
    ecdh.generateKeys();
  }
  const uncompressedHex = ecdh.getPublicKey("hex", "uncompressed");
  const publicKey = `secp256k1:0x${uncompressedHex}`;
  const address = deriveEvmAddressFromSecp256k1PublicKey(publicKey);
  if (!address) {
    throw new Error("Failed to derive EVM address from secp256k1 key");
  }
  return { publicKey, address };
}

const DEFAULT_NEAR_ACCOUNT_ID =
  "98793cd91a3f870fb126f66285808c7e094afcfc4eda8a970f6644ac0a4961ac";
const DEFAULT_NEAR_PUBLIC_KEY = `ed25519:${encodeBase58(
  Buffer.from(DEFAULT_NEAR_ACCOUNT_ID, "hex"),
)}`;
const DEFAULT_SOLANA_ADDRESS = "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU";
const DEFAULT_SOLANA_PUBLIC_KEY = `ed25519:${DEFAULT_SOLANA_ADDRESS}`;
const DEFAULT_SECP256K1 = generateRealSecp256k1KeyAndAddress(
  Buffer.from(
    "1111111111111111111111111111111111111111111111111111111111111111",
    "hex",
  ),
);
export const DEFAULT_MOCK_BASE_ADDRESS = DEFAULT_SECP256K1.address;
export const DEFAULT_MOCK_BASE_PUBLIC_KEY = DEFAULT_SECP256K1.publicKey;

export interface SimulatedWalletContainer {
  readonly walletId: string;
  readonly apiKey: string;
  readonly nearAccountId: string;
  readonly nearPublicKey: string;
  readonly baseAddress: string;
  readonly basePublicKey: string;
  readonly solanaAddress: string;
  readonly solanaPublicKey: string;
}

export interface OutLayerMockOptions {
  forceStatus?: number;
  forceTimeout?: boolean;
  dropConnection?: boolean;
  rateLimitCount?: number;
  policyState?: "none" | "stored";
  frozen?: boolean;
  controller?: string;
  policyRules?: Record<string, unknown>;
  policyCapabilities?: Record<string, unknown>;
  mismatchWalletId?: boolean;
  corruptNearId?: boolean;
  corruptAddress?: boolean;
  corruptPublicKey?: boolean;
  corruptExecutorId?: boolean;
  chainMismatch?: boolean;
  rawErrorBody?: string;
  rawErrorContentType?: string;
  multiWalletMode?: boolean;
  failEndpoint?: "/register" | "/wallet/v1/address" | "/wallet/v1/policy";
}

export interface OutLayerMockServer {
  server: Server;
  url: string;
  close: () => Promise<void>;
  setOptions: (options: OutLayerMockOptions) => void;
  getCallCount: () => number;
  getRegisterCallCount: () => number;
  getAddressCallCount: () => number;
  getPolicyCallCount: () => number;
  getRegisteredWallets: () => SimulatedWalletContainer[];
  resetCounts: () => void;
}

const DEFAULT_POLICY_RULES: Record<string, unknown> = {
  defaultAction: "DENY",
  requireControllerApproval: true,
  maxTransferUsd: "0",
  transferSigning: "disabled",
  transaction_types: [],
  limits: {
    per_transaction: { "*": "0" },
    daily: { "*": "0" },
  },
};

const DEFAULT_POLICY_CAPABILITIES: Record<string, unknown> = {
  raw_sign: { allowed: false, requires_approval: true },
  evm_sign: { allowed: false, raw_tx: false },
  solana_sign: { allowed: false, raw_tx: false },
  swap: { allowed: false, requires_approval: true },
  cross_chain_withdraw: { allowed: false, requires_approval: true },
  limit_order: { allowed: false, requires_approval: true },
  payment_check: { allowed: false, requires_approval: true },
  confidential: { allowed: false, requires_approval: true },
  sign_message: { allowed: true, requires_approval: false },
};

export async function createOutLayerMockServer(
  initialOptions: OutLayerMockOptions = {},
): Promise<OutLayerMockServer> {
  let options = { ...initialOptions };
  let callCount = 0;
  let registerCallCount = 0;
  let addressCallCount = 0;
  let policyCallCount = 0;
  let rateLimitRemaining = initialOptions.rateLimitCount ?? 0;

  const walletsByApiKey = new Map<string, SimulatedWalletContainer>();

  const server = createServer(
    async (req: IncomingMessage, res: ServerResponse) => {
      callCount++;
      const parsedUrl = new URL(req.url ?? "/", "http://127.0.0.1");
      const pathname = parsedUrl.pathname;

      if (pathname === "/register" && req.method === "POST") {
        registerCallCount++;
      } else if (pathname === "/wallet/v1/address" && req.method === "GET") {
        addressCallCount++;
      } else if (pathname === "/wallet/v1/policy" && req.method === "GET") {
        policyCallCount++;
      }

      const targetMatches =
        !options.failEndpoint || options.failEndpoint === pathname;

      if (targetMatches && options.dropConnection) {
        req.socket.destroy();
        return;
      }

      if (targetMatches && options.forceTimeout) {
        // Intentionally stall response beyond client timeout
        return;
      }

      if (targetMatches && rateLimitRemaining > 0) {
        rateLimitRemaining--;
        res.writeHead(429, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Rate limit exceeded" }));
        return;
      }

      if (
        targetMatches &&
        ((options.forceStatus && options.forceStatus !== 200) ||
          options.rawErrorBody !== undefined)
      ) {
        res.writeHead(options.forceStatus ?? 200, {
          "Content-Type": options.rawErrorContentType ?? "application/json",
        });
        res.end(
          options.rawErrorBody ??
            JSON.stringify({ error: `Mock fault ${options.forceStatus}` }),
        );
        return;
      }

      // Route: POST /register
      if (req.method === "POST" && pathname === "/register") {
        if (options.multiWalletMode) {
          const walletId = options.mismatchWalletId
            ? "00000000-0000-0000-0000-000000000000"
            : randomUUID();
          const apiKey = `wk_${randomBytes(16).toString("hex")}`;
          const nearBytes = randomBytes(32);
          if (nearBytes[0] === 0) nearBytes[0] = 1;
          const nearAccountId = options.corruptNearId
            ? "invalid-near-!!!"
            : nearBytes.toString("hex");
          const nearPublicKey = `ed25519:${encodeBase58(nearBytes)}`;

          const evmKeyAndAddr = generateRealSecp256k1KeyAndAddress();

          const solBytes = randomBytes(32);
          if (solBytes[0] === 0) solBytes[0] = 1;
          const solanaAddress = encodeBase58(solBytes);
          const solanaPublicKey = `ed25519:${solanaAddress}`;

          const container: SimulatedWalletContainer = {
            walletId,
            apiKey,
            nearAccountId,
            nearPublicKey,
            baseAddress: evmKeyAndAddr.address,
            basePublicKey: evmKeyAndAddr.publicKey,
            solanaAddress,
            solanaPublicKey,
          };
          walletsByApiKey.set(apiKey, container);

          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
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
            }),
          );
          return;
        }

        const walletId = options.mismatchWalletId
          ? "00000000-0000-0000-0000-000000000000"
          : "9c3c9e10-1c1f-4f5e-9c4a-1d7b9a8f3c20";
        const nearAccountId = options.corruptNearId
          ? "invalid-near-!!!"
          : DEFAULT_NEAR_ACCOUNT_ID;

        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            wallet_id: walletId,
            api_key: "wk_2a8b1f3c4d5e6789abcdef0123456789",
            near_account_id: nearAccountId,
            handoff_url:
              "https://app.outlayer.ai/wallet?key=wk_2a8b1f3c4d5e6789abcdef0123456789",
            trial: {
              available: true,
              calls: 10,
              days: 7,
              claim_url: "POST /trial-key",
              scope: "connectors.outlayer.near/*",
            },
          }),
        );
        return;
      }

      // Route: GET /wallet/v1/address?chain=<chain>
      if (req.method === "GET" && pathname === "/wallet/v1/address") {
        const auth = req.headers.authorization;
        if (!auth || !auth.startsWith("Bearer wk_")) {
          res.writeHead(401, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Unauthorized" }));
          return;
        }

        const bearerKey = auth.slice("Bearer ".length).trim();
        const registered = walletsByApiKey.get(bearerKey);

        const chain = parsedUrl.searchParams.get("chain");
        if (chain === "bitcoin") {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({ error: "Bitcoin unsupported in wallet v1" }),
          );
          return;
        }

        const walletId = options.mismatchWalletId
          ? "00000000-0000-0000-0000-000000000000"
          : (registered?.walletId ?? "9c3c9e10-1c1f-4f5e-9c4a-1d7b9a8f3c20");
        const returnedChain =
          options.chainMismatch && chain === "base" ? "ethereum" : chain;

        let address = registered?.baseAddress ?? DEFAULT_MOCK_BASE_ADDRESS;
        let publicKey =
          registered?.basePublicKey ?? DEFAULT_MOCK_BASE_PUBLIC_KEY;
        if (options.corruptAddress) {
          address = "0x833589"; // Invalid EVM length
        } else if (chain === "near") {
          address = registered?.nearAccountId ?? DEFAULT_NEAR_ACCOUNT_ID;
          publicKey = registered?.nearPublicKey ?? DEFAULT_NEAR_PUBLIC_KEY;
        } else if (chain === "solana") {
          address = registered?.solanaAddress ?? DEFAULT_SOLANA_ADDRESS;
          publicKey = registered?.solanaPublicKey ?? DEFAULT_SOLANA_PUBLIC_KEY;
        }

        if (options.corruptPublicKey) {
          publicKey =
            chain === "base" || chain === "ethereum"
              ? `ed25519:${DEFAULT_SOLANA_ADDRESS}`
              : DEFAULT_MOCK_BASE_PUBLIC_KEY;
        }

        const executorAccountId =
          chain === "near"
            ? options.corruptExecutorId
              ? "wrong-executor.near"
              : address
            : null;

        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            wallet_id: walletId,
            chain: returnedChain,
            address,
            public_key: publicKey,
            vault_id: null,
            asset_account_id: null,
            executor_account_id: executorAccountId,
          }),
        );
        return;
      }

      // Route: GET /wallet/v1/policy
      if (req.method === "GET" && pathname === "/wallet/v1/policy") {
        const auth = req.headers.authorization;
        if (!auth || !auth.startsWith("Bearer wk_")) {
          res.writeHead(401, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Unauthorized" }));
          return;
        }

        const bearerKey = auth.slice("Bearer ".length).trim();
        const registered = walletsByApiKey.get(bearerKey);

        const walletId = options.mismatchWalletId
          ? "00000000-0000-0000-0000-000000000000"
          : (registered?.walletId ?? "9c3c9e10-1c1f-4f5e-9c4a-1d7b9a8f3c20");

        const defaultPolicyState = options.multiWalletMode ? "stored" : "none";

        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            wallet_id: walletId,
            controller: options.controller ?? "controller.near",
            frozen: options.frozen ?? false,
            policy: options.policyState ?? defaultPolicyState,
            rules: options.policyRules ?? DEFAULT_POLICY_RULES,
            capabilities:
              options.policyCapabilities ?? DEFAULT_POLICY_CAPABILITIES,
            authorized_key_hashes: [],
            refund_addresses: {},
            usage: {},
          }),
        );
        return;
      }

      // Fallback 404
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Not found" }));
    },
  );

  await new Promise<void>((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve()),
  );
  const addr = server.address();
  if (!addr || typeof addr === "string")
    throw new Error("Server failed to bind");
  const url = `http://127.0.0.1:${addr.port}`;

  return {
    server,
    url,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
    setOptions: (newOpts) => {
      options = { ...newOpts };
      rateLimitRemaining = newOpts.rateLimitCount ?? 0;
    },
    getCallCount: () => callCount,
    getRegisterCallCount: () => registerCallCount,
    getAddressCallCount: () => addressCallCount,
    getPolicyCallCount: () => policyCallCount,
    getRegisteredWallets: () => Array.from(walletsByApiKey.values()),
    resetCounts: () => {
      callCount = 0;
      registerCallCount = 0;
      addressCallCount = 0;
      policyCallCount = 0;
      walletsByApiKey.clear();
    },
  };
}

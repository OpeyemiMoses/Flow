import { randomBytes, randomUUID } from "node:crypto";
import {
  createServer,
  type Server,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { toEip55ChecksumAddress } from "../../src/domain/custody.ts";

const BASE58_CHARS =
  "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

function encodeBase58From32Bytes(bytes: Uint8Array): string {
  let leadingZeros = 0;
  while (leadingZeros < bytes.length && bytes[leadingZeros] === 0) {
    leadingZeros++;
  }
  let num = 0n;
  for (const b of bytes) {
    num = (num << 8n) + BigInt(b);
  }
  const chars: string[] = [];
  while (num > 0n) {
    const rem = Number(num % 58n);
    chars.push(BASE58_CHARS[rem]!);
    num = num / 58n;
  }
  for (let i = 0; i < leadingZeros; i++) {
    chars.push("1");
  }
  return chars.reverse().join("");
}

export interface SimulatedWalletContainer {
  readonly walletId: string;
  readonly apiKey: string;
  readonly nearAccountId: string;
  readonly baseAddress: string;
  readonly solanaAddress: string;
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
  mismatchWalletId?: boolean;
  corruptNearId?: boolean;
  corruptAddress?: boolean;
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
          const nearAccountId = options.corruptNearId
            ? "invalid-near-!!!"
            : randomBytes(32).toString("hex");
          const rawEvmHex = randomBytes(20).toString("hex");
          const baseAddress = toEip55ChecksumAddress(`0x${rawEvmHex}`);
          const solBytes = randomBytes(32);
          if (solBytes[0] === 0) solBytes[0] = 1;
          const solanaAddress = encodeBase58From32Bytes(solBytes);

          const container: SimulatedWalletContainer = {
            walletId,
            apiKey,
            nearAccountId,
            baseAddress,
            solanaAddress,
          };
          walletsByApiKey.set(apiKey, container);

          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              wallet_id: walletId,
              api_key: apiKey,
              near_account_id: nearAccountId,
              handoff_url: `https://app.outlayer.ai/wallet?key=${apiKey}`,
              trial: { available: true, calls: 10, days: 7 },
            }),
          );
          return;
        }

        const walletId = options.mismatchWalletId
          ? "00000000-0000-0000-0000-000000000000"
          : "9c3c9e10-1c1f-4f5e-9c4a-1d7b9a8f3c20";
        const nearAccountId = options.corruptNearId
          ? "invalid-near-!!!"
          : "98793cd91a3f870fb126f66285808c7e094afcfc4eda8a970f6644ac0a4961ac";

        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            wallet_id: walletId,
            api_key: "wk_2a8b1f3c4d5e6789abcdef0123456789",
            near_account_id: nearAccountId,
            handoff_url:
              "https://app.outlayer.ai/wallet?key=wk_2a8b1f3c4d5e6789abcdef0123456789",
            trial: { available: true, calls: 10, days: 7 },
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

        let address =
          registered?.baseAddress ??
          "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
        let publicKey = "secp256k1:0x04abc...";
        if (options.corruptAddress) {
          address = "0x833589"; // Invalid EVM length
        } else if (chain === "near") {
          address =
            registered?.nearAccountId ??
            "98793cd91a3f870fb126f66285808c7e094afcfc4eda8a970f6644ac0a4961ac";
          publicKey = "ed25519:7BcBZ9Z...";
        } else if (chain === "solana") {
          address =
            registered?.solanaAddress ??
            "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU";
          publicKey = "ed25519:7xKXtg...";
        }

        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            wallet_id: walletId,
            chain: returnedChain,
            address,
            public_key: publicKey,
            asset_account_id: null,
            executor_account_id: address,
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

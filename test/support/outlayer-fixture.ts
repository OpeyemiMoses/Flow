import {
  createServer,
  type Server,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";

export interface OutLayerMockOptions {
  forceStatus?: number;
  forceTimeout?: boolean;
  dropConnection?: boolean;
  rateLimitCount?: number;
  policyState?: "none" | "stored";
  mismatchWalletId?: boolean;
  corruptNearId?: boolean;
  corruptAddress?: boolean;
  chainMismatch?: boolean;
  rawErrorBody?: string;
  rawErrorContentType?: string;
}

export interface OutLayerMockServer {
  server: Server;
  url: string;
  close: () => Promise<void>;
  setOptions: (options: OutLayerMockOptions) => void;
  getCallCount: () => number;
}

export async function createOutLayerMockServer(
  initialOptions: OutLayerMockOptions = {},
): Promise<OutLayerMockServer> {
  let options = { ...initialOptions };
  let callCount = 0;

  const server = createServer(
    async (req: IncomingMessage, res: ServerResponse) => {
      callCount++;

      if (options.dropConnection) {
        req.socket.destroy();
        return;
      }

      if (options.forceTimeout) {
        // Intentionally stall response beyond client timeout
        return;
      }

      if (
        (options.forceStatus && options.forceStatus !== 200) ||
        options.rawErrorBody !== undefined
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

      const parsedUrl = new URL(req.url ?? "/", "http://127.0.0.1");

      // Route: POST /register
      if (req.method === "POST" && parsedUrl.pathname === "/register") {
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
      if (req.method === "GET" && parsedUrl.pathname === "/wallet/v1/address") {
        const auth = req.headers.authorization;
        if (!auth || !auth.startsWith("Bearer wk_")) {
          res.writeHead(401, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Unauthorized" }));
          return;
        }

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
          : "9c3c9e10-1c1f-4f5e-9c4a-1d7b9a8f3c20";
        const returnedChain =
          options.chainMismatch && chain === "base" ? "ethereum" : chain;

        let address = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
        let publicKey = "secp256k1:0x04abc...";
        if (options.corruptAddress) {
          address = "0x833589"; // Invalid EVM length
        } else if (chain === "near") {
          address =
            "98793cd91a3f870fb126f66285808c7e094afcfc4eda8a970f6644ac0a4961ac";
          publicKey = "ed25519:7BcBZ9Z...";
        } else if (chain === "solana") {
          address = "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU";
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
      if (req.method === "GET" && parsedUrl.pathname === "/wallet/v1/policy") {
        const auth = req.headers.authorization;
        if (!auth || !auth.startsWith("Bearer wk_")) {
          res.writeHead(401, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Unauthorized" }));
          return;
        }

        const walletId = options.mismatchWalletId
          ? "00000000-0000-0000-0000-000000000000"
          : "9c3c9e10-1c1f-4f5e-9c4a-1d7b9a8f3c20";

        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            wallet_id: walletId,
            controller: "controller.near",
            frozen: false,
            policy: options.policyState ?? "none",
            rules: {},
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
    },
    getCallCount: () => callCount,
  };
}

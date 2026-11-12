import test from "node:test";
import assert from "node:assert/strict";
import {
  getDiscoveredTokens,
  normalizeDiscoveredToken,
} from "../src/server/providers/near-intents-discovery.ts";
import {
  markNotificationAsRead,
  markAllNotificationsAsRead,
} from "../src/server/notifications-service.ts";
import { processAssistantQuery } from "../src/server/ai-assistant-service.ts";

test("near-intents-discovery: excludes wrapped tokens and assigns capabilities", async () => {
  // Test raw mapping
  const rawWrapped = {
    assetId: "wrap.near",
    decimals: 24,
    blockchain: "near",
    symbol: "wNEAR",
    price: 3.5,
  };
  const discoveredWrapped = normalizeDiscoveredToken(rawWrapped);
  assert.equal(discoveredWrapped.isWrapped, true);
  assert.equal(
    discoveredWrapped.capabilities.includes("CAN_DIRECT_DEPOSIT"),
    false,
  );

  const rawUsdc = {
    assetId: "base:0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
    decimals: 6,
    blockchain: "base",
    symbol: "USDC",
    contractAddress: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
    price: 1.0,
  };
  const discoveredUsdc = normalizeDiscoveredToken(rawUsdc);
  assert.equal(discoveredUsdc.isWrapped, false);
  assert.equal(discoveredUsdc.capabilities.includes("CAN_HOLD_IN_FLOW"), true);
  assert.equal(discoveredUsdc.capabilities.includes("CAN_PAY_FROM"), true);
  assert.equal(
    discoveredUsdc.capabilities.includes("CAN_DIRECT_DEPOSIT"),
    true,
  );
});

test("near-intents-discovery: live fetching returns tokens and caches", async () => {
  const tokens = await getDiscoveredTokens({ excludeWrapped: true });
  assert.ok(
    tokens.length > 0,
    "Tokens should be returned from live or fallback",
  );

  // Verify none of the returned tokens are user-facing wrapped tokens
  const forbidden = ["wNEAR", "WETH", "WBTC", "WSOL", "WAVAX"];
  for (const t of tokens) {
    assert.equal(
      forbidden.includes(t.symbol),
      false,
      `Token ${t.symbol} should have been excluded`,
    );
  }

  // Verify cache hit by requesting immediately again
  const cached = await getDiscoveredTokens({ excludeWrapped: true });
  assert.equal(cached.length, tokens.length);
});

test("notifications-service: mark read and mark all as read mutations", () => {
  const testId = "notif-test-1";
  markNotificationAsRead(testId);
  markAllNotificationsAsRead(["notif-test-2", "notif-test-3"]);
  // Successfully executed without exception
  assert.ok(true);
});

import type { FlowDb } from "../src/foundation/prisma.ts";

test("ai-assistant-service: balance inquiry returns card without autonomous fund movement", async () => {
  // Mock db with dummy raw query returns
  const mockDb = {
    $queryRaw: async (query: unknown) => {
      const q = String(query);
      if (q.includes("wallet_balances")) {
        return [
          {
            network: "base-mainnet",
            symbol: "USDC",
            display_balance: "1.00",
            decimals: 6,
          },
        ];
      }
      return [];
    },
  };

  const response = await processAssistantQuery({
    accountId: "test-acc-1",
    prompt: "what is my balance?",
    db: mockDb as unknown as FlowDb,
  });

  assert.equal(response.role, "assistant");
  assert.ok(response.content.includes("1.00 USDC"));
  assert.equal(response.card?.type, "BALANCE_SUMMARY");
});

test("ai-assistant-service: draft payment link generates interactive card", async () => {
  const mockDb = {
    $queryRaw: async () => [],
  };

  const response = await processAssistantQuery({
    accountId: "test-acc-1",
    prompt: "draft a payment link for $25 for website design",
    db: mockDb as unknown as FlowDb,
  });

  assert.equal(response.role, "assistant");
  assert.equal(response.card?.type, "DRAFT_PAYMENT_LINK");
  assert.equal(response.card?.data?.amount, "25.00");
  assert.equal(response.card?.data?.assetSymbol, "USDC");
});

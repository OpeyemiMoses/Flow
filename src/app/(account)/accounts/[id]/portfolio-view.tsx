"use client";

import { useEffect, useState } from "react";
import { describe, Feedback, send } from "../../../controls.tsx";
import type {
  SerializedAccountPortfolio,
  SerializedWalletBalanceRecord,
} from "../../../../server/portfolio.ts";

export function PortfolioView({
  accountId,
  initialPortfolio,
}: {
  accountId: string;
  initialPortfolio: SerializedAccountPortfolio;
}) {
  const [portfolio, setPortfolio] =
    useState<SerializedAccountPortfolio>(initialPortfolio);
  const [refreshing, setRefreshing] = useState(false);
  const [message, setMessage] = useState("");
  const [cooldown, setCooldown] = useState(
    initialPortfolio.cooldownRemainingSeconds ?? 0,
  );
  const [copiedNetwork, setCopiedNetwork] = useState<string | null>(null);

  useEffect(() => {
    if (cooldown <= 0) return;
    const timer = setInterval(() => {
      setCooldown((prev) => (prev > 1 ? prev - 1 : 0));
    }, 1000);
    return () => clearInterval(timer);
  }, [cooldown]);

  async function handleRefresh() {
    if (refreshing || cooldown > 0) return;
    setRefreshing(true);
    setMessage("");
    try {
      const updated = await send<SerializedAccountPortfolio>(
        `/api/accounts/${accountId}/portfolio/refresh`,
        {},
        "POST",
      );
      setPortfolio(updated);
      setCooldown(updated.cooldownRemainingSeconds ?? 15);
      setMessage("Balances refreshed successfully.");
    } catch (error) {
      setMessage(describe(error));
    } finally {
      setRefreshing(false);
    }
  }

  async function copyAddress(network: string, address: string) {
    try {
      await navigator.clipboard.writeText(address);
      setCopiedNetwork(network);
      setTimeout(() => setCopiedNetwork(null), 2000);
    } catch {
      setMessage("Failed to copy address to clipboard.");
    }
  }

  const wallet = portfolio.wallet;
  const balances = portfolio.balances;

  return (
    <section className="flow-panel flow-stack">
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          flexWrap: "wrap",
          gap: "1rem",
        }}
      >
        <div>
          <h2>Multi-Chain Portfolio</h2>
          <p style={{ fontSize: "0.9rem", color: "#94a3b8" }}>
            Real-time on-chain balances across NEAR, Base, and Solana testnets.
          </p>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: "0.75rem" }}>
          {portfolio.lastSyncedAt && (
            <span
              style={{
                fontSize: "0.8rem",
                color: portfolio.isStale ? "#f59e0b" : "#94a3b8",
              }}
            >
              {portfolio.isStale ? "Stale " : "Synced "}
              {new Date(portfolio.lastSyncedAt).toLocaleTimeString()}
            </span>
          )}
          <button
            type="button"
            onClick={handleRefresh}
            disabled={refreshing || cooldown > 0}
            className="flow-secondary"
            style={{ fontSize: "0.85rem", padding: "0.4rem 0.8rem" }}
          >
            {refreshing
              ? "Refreshing RPC..."
              : cooldown > 0
                ? `Wait ${cooldown}s`
                : "Refresh Balances"}
          </button>
        </div>
      </div>

      <Feedback text={message} />

      {/* Safety Notice Banner */}
      <div
        style={{
          padding: "0.85rem 1rem",
          borderRadius: "0.5rem",
          backgroundColor: "#1e1b4b",
          border: "1px solid #4338ca",
          display: "grid",
          gap: "0.4rem",
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: "0.5rem",
            fontWeight: 700,
            color: "#a5b4fc",
          }}
        >
          <span>🛡️ TESTNET SAFETY & LIFECYCLE ENFORCEMENT</span>
          <span
            style={{
              fontSize: "0.75rem",
              padding: "0.15rem 0.5rem",
              borderRadius: "999px",
              backgroundColor: "#312e81",
              color: "#c7d2fe",
            }}
          >
            {wallet?.status ?? "PROVISIONING"}
          </span>
        </div>
        <p style={{ fontSize: "0.85rem", color: "#c7d2fe", margin: 0 }}>
          {wallet?.disclaimer ??
            "Execution is disabled (FLOW_EXECUTION=disabled). Ineligible for deposits or transfers."}
        </p>
      </div>

      {/* Registered Multi-Chain Addresses */}
      {wallet && wallet.addresses.length > 0 && (
        <div className="flow-stack" style={{ gap: "0.6rem" }}>
          <h3
            style={{
              fontSize: "1rem",
              fontWeight: 650,
              color: "#e2e8f0",
              margin: 0,
            }}
          >
            Registered Wallet Addresses
          </h3>
          <div className="flow-grid" style={{ gap: "0.75rem" }}>
            {wallet.addresses.map((addr) => (
              <div
                key={`${addr.network}-${addr.chainId}`}
                style={{
                  padding: "0.75rem",
                  borderRadius: "0.5rem",
                  backgroundColor: "#020617",
                  border: "1px solid #1e293b",
                  display: "grid",
                  gap: "0.35rem",
                }}
              >
                <div
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "center",
                  }}
                >
                  <span
                    style={{
                      fontSize: "0.8rem",
                      fontWeight: 600,
                      color: "#38bdf8",
                      textTransform: "uppercase",
                    }}
                  >
                    {addr.network} ({addr.chainId})
                  </span>
                  <button
                    type="button"
                    onClick={() => copyAddress(addr.network, addr.address)}
                    className="flow-secondary"
                    style={{
                      fontSize: "0.7rem",
                      padding: "0.15rem 0.5rem",
                      cursor: "pointer",
                    }}
                  >
                    {copiedNetwork === addr.network ? "Copied!" : "Copy"}
                  </button>
                </div>
                <div
                  style={{
                    fontFamily: "monospace",
                    fontSize: "0.8rem",
                    color: "#94a3b8",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                  title={addr.address}
                >
                  {addr.address}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Asset Balances Table */}
      <div className="flow-stack" style={{ gap: "0.6rem" }}>
        <h3
          style={{
            fontSize: "1rem",
            fontWeight: 650,
            color: "#e2e8f0",
            margin: 0,
          }}
        >
          Tracked Assets & Balances
        </h3>
        {balances.length === 0 ? (
          <p style={{ color: "#64748b", fontStyle: "italic" }}>
            No balance observations recorded yet. Click &quot;Refresh
            Balances&quot; to fetch the latest on-chain state from testnet RPCs.
          </p>
        ) : (
          <div
            style={{
              display: "grid",
              gap: "0.6rem",
            }}
          >
            {balances.map((b: SerializedWalletBalanceRecord) => (
              <div
                key={b.id}
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                  flexWrap: "wrap",
                  gap: "0.75rem",
                  padding: "0.8rem 1rem",
                  backgroundColor: "#020617",
                  border: "1px solid #1e293b",
                  borderRadius: "0.5rem",
                }}
              >
                <div style={{ display: "grid", gap: "0.2rem" }}>
                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: "0.5rem",
                    }}
                  >
                    <span
                      style={{
                        fontWeight: 700,
                        color: "#f8fafc",
                        fontSize: "1rem",
                      }}
                    >
                      {b.networkAsset.asset.name}
                    </span>
                    <span
                      style={{
                        fontSize: "0.75rem",
                        padding: "0.1rem 0.4rem",
                        borderRadius: "0.25rem",
                        backgroundColor: "#1e293b",
                        color: "#94a3b8",
                      }}
                    >
                      {b.networkAsset.tokenStandard}
                    </span>
                    <span
                      style={{
                        fontSize: "0.75rem",
                        padding: "0.1rem 0.4rem",
                        borderRadius: "0.25rem",
                        backgroundColor:
                          b.syncStatus === "SYNCED" ? "#064e3b" : "#78350f",
                        color:
                          b.syncStatus === "SYNCED" ? "#6ee7b7" : "#fcd34d",
                      }}
                    >
                      {b.isZeroConfirmed
                        ? "CONFIRMED ZERO"
                        : b.syncStatus === "SYNCED"
                          ? "SYNCED"
                          : b.syncStatus}
                    </span>
                  </div>
                  <div style={{ fontSize: "0.8rem", color: "#64748b" }}>
                    <span>
                      {b.networkAsset.network} · Chain {b.networkAsset.chainId}
                    </span>
                    {b.networkAsset.contractAddress && (
                      <span
                        style={{
                          marginLeft: "0.5rem",
                          fontFamily: "monospace",
                        }}
                        title={b.networkAsset.contractAddress}
                      >
                        · Contract: {b.networkAsset.contractAddress.slice(0, 8)}
                        ...
                        {b.networkAsset.contractAddress.slice(-6)}
                      </span>
                    )}
                    {b.blockHeight && (
                      <span style={{ marginLeft: "0.5rem" }}>
                        · Block #{b.blockHeight}
                      </span>
                    )}
                  </div>
                </div>

                <div
                  style={{
                    display: "grid",
                    justifyItems: "end",
                    gap: "0.15rem",
                  }}
                >
                  <div
                    style={{
                      fontSize: "1.1rem",
                      fontWeight: 700,
                      color: "#f8fafc",
                      fontFamily: "monospace",
                    }}
                  >
                    {b.displayBalance} {b.networkAsset.asset.symbol}
                  </div>
                  <div
                    style={{
                      fontSize: "0.75rem",
                      color: "#64748b",
                      fontFamily: "monospace",
                    }}
                  >
                    {b.atomicBalance} atomic units ({b.networkAsset.decimals}{" "}
                    dec)
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}

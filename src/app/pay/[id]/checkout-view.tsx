"use client";

import { useMemo, useState } from "react";
import type {
  EligibleSourceRoute,
  PublicPaymentRequest,
} from "../../../domain/payment-requests.ts";
import { FlowLogo } from "../../../components/flow-logo.tsx";
import { ThemeToggle } from "../../../components/theme-toggle.tsx";
import {
  IconCheck,
  IconCopy,
  IconExternalLink,
  IconInfo,
  IconShield,
  IconWallet,
} from "../../../components/icons.tsx";

interface CheckoutViewProps {
  request: PublicPaymentRequest;
}

type PayerMode = "WALLET" | "EXCHANGE";

export function CheckoutView({ request }: CheckoutViewProps) {
  const [payerMode, setPayerMode] = useState<PayerMode>("WALLET");
  const [selectedEcosystem, setSelectedEcosystem] = useState<
    "evm" | "solana" | "near"
  >("evm");
  const [selectedRouteId, setSelectedRouteId] = useState<string>("");
  const [customAmount, setCustomAmount] = useState<string>(
    request.displayAmount ?? "10",
  );
  const [refundAddress, setRefundAddress] = useState<string>("");
  const [copiedLink, setCopiedLink] = useState(false);

  // Group eligible routes by ecosystem
  const ecosystemRoutes = useMemo(() => {
    return request.eligibleSourceRoutes.filter(
      (r) => r.ecosystem === selectedEcosystem,
    );
  }, [request.eligibleSourceRoutes, selectedEcosystem]);

  // Selected route object
  const activeRoute: EligibleSourceRoute | undefined = useMemo(() => {
    if (selectedRouteId) {
      return request.eligibleSourceRoutes.find((r) => r.id === selectedRouteId);
    }
    return ecosystemRoutes[0];
  }, [ecosystemRoutes, request.eligibleSourceRoutes, selectedRouteId]);

  const handleCopyLink = () => {
    if (typeof navigator !== "undefined" && navigator.clipboard) {
      void navigator.clipboard.writeText(request.shareUrl);
      setCopiedLink(true);
      setTimeout(() => setCopiedLink(false), 2000);
    }
  };

  const isExpired = request.status === "EXPIRED" || request.isExpired;

  return (
    <div className="min-h-screen bg-[var(--bg-app)] text-[var(--text-primary)] transition-colors">
      {/* Top Navigation */}
      <header className="border-b border-[var(--border-subtle)] bg-[var(--bg-card)] px-4 py-3">
        <div className="mx-auto flex max-w-4xl items-center justify-between">
          <div className="flex items-center gap-3">
            <FlowLogo size={24} />
            <span className="text-sm font-semibold tracking-wide text-[var(--text-primary)]">
              FLOW Checkout
            </span>
            <span className="hidden sm:inline-flex items-center gap-1.5 rounded-full bg-[#34D8B2]/10 px-2.5 py-0.5 text-xs font-medium text-[#0F9F80] border border-[#34D8B2]/30">
              <IconShield size={12} />
              Public Payment Link
            </span>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={handleCopyLink}
              type="button"
              className="inline-flex items-center gap-1.5 rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-app)] px-3 py-1.5 text-xs font-medium text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:border-[var(--border-strong)] transition-colors"
              title="Copy shareable link"
            >
              {copiedLink ? (
                <>
                  <IconCheck size={13} className="text-[#34D8B2]" />
                  Copied
                </>
              ) : (
                <>
                  <IconCopy size={13} />
                  Share Link
                </>
              )}
            </button>
            <ThemeToggle />
          </div>
        </div>
      </header>

      {/* Main Container */}
      <main className="mx-auto max-w-4xl px-4 py-8 space-y-6">
        {/* Banner if Expired */}
        {isExpired && (
          <div className="rounded-xl border border-red-500/30 bg-red-500/10 p-4 text-sm text-red-600 dark:text-red-400">
            <strong>Payment Request Expired:</strong> This payment request is
            past its expiration deadline and cannot accept new payments.
          </div>
        )}

        {/* Execution Guardrail Notice */}
        <div className="rounded-xl border border-blue-500/20 bg-blue-500/5 p-4 text-xs text-[var(--text-secondary)] flex items-start gap-3">
          <IconInfo size={16} className="text-[#2563FF] shrink-0 mt-0.5" />
          <div className="space-y-1">
            <div className="font-medium text-[var(--text-primary)]">
              M5 Phase 1 Staged Checkout · Zero Funds Movement
            </div>
            <div>
              FLOW is running in preview mode (
              <code className="text-xs">FLOW_EXECUTION=disabled</code>). You can
              configure your source asset, inspect verified routes, and preview
              checkout stages. No deposit address will be issued, and no real
              funds will be moved.
            </div>
          </div>
        </div>

        {/* Grid: 2 Columns on desktop */}
        <div className="grid grid-cols-1 md:grid-cols-12 gap-6 items-start">
          {/* Left Column: Request Details & Recipient Summary (5 cols) */}
          <div className="md:col-span-5 space-y-5">
            {/* Recipient Card */}
            <div className="rounded-2xl border border-[var(--border-subtle)] bg-[var(--bg-card)] p-5 shadow-sm space-y-4">
              <div className="space-y-1">
                <span className="text-xs font-medium uppercase tracking-wider text-[var(--text-muted)]">
                  Payment Request
                </span>
                <h1 className="text-xl font-bold tracking-tight text-[var(--text-primary)]">
                  {request.title}
                </h1>
                {request.description && (
                  <p className="text-sm text-[var(--text-secondary)] whitespace-pre-wrap">
                    {request.description}
                  </p>
                )}
              </div>

              {/* Recipient & Destination Box */}
              <div className="rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-app)] p-3.5 space-y-2.5 text-xs">
                <div className="flex justify-between items-center">
                  <span className="text-[var(--text-secondary)]">Pay To</span>
                  <span className="font-semibold text-[var(--text-primary)]">
                    {request.recipientName}
                  </span>
                </div>
                <div className="flex justify-between items-center">
                  <span className="text-[var(--text-secondary)]">
                    Recipient Chain
                  </span>
                  <span className="font-medium text-[var(--text-primary)]">
                    {request.destinationNetwork}
                  </span>
                </div>
                <div className="flex justify-between items-center">
                  <span className="text-[var(--text-secondary)]">
                    Settlement Asset
                  </span>
                  <span className="font-semibold text-[#2563FF] dark:text-[#3876FF]">
                    {request.destinationAssetSymbol}
                  </span>
                </div>
                {request.expiresAt && (
                  <div className="flex justify-between items-center pt-1 border-t border-[var(--border-subtle)]">
                    <span className="text-[var(--text-secondary)]">
                      Expires
                    </span>
                    <span className="text-[var(--text-muted)]">
                      {new Date(request.expiresAt).toLocaleString()}
                    </span>
                  </div>
                )}
              </div>

              {/* Amount Display */}
              <div className="rounded-xl border border-[#2563FF]/20 bg-[#2563FF]/5 p-4 text-center space-y-1">
                <span className="text-xs font-medium text-[var(--text-secondary)]">
                  {request.amountMode === "FIXED"
                    ? "Requested Amount"
                    : "Optional Amount"}
                </span>
                <div className="text-2xl font-black tracking-tight text-[var(--text-primary)]">
                  {request.amountMode === "FIXED"
                    ? `${request.displayAmount} ${request.destinationAssetSymbol}`
                    : "Payer Specified"}
                </div>
                <span className="text-2xl text-[var(--text-muted)] text-[11px] block">
                  Settles directly into recipient&apos;s verified FLOW custody
                  wallet
                </span>
              </div>
            </div>

            {/* Checkout Protocol Stages Card */}
            <div className="rounded-2xl border border-[var(--border-subtle)] bg-[var(--bg-card)] p-5 shadow-sm space-y-3">
              <h3 className="text-xs font-semibold uppercase tracking-wider text-[var(--text-muted)]">
                Staged Checkout Progression
              </h3>
              <ol className="space-y-2.5 text-xs">
                <li className="flex items-center gap-2.5 text-[#34D8B2] font-medium">
                  <span className="flex h-5 w-5 items-center justify-center rounded-full bg-[#34D8B2]/20 text-[10px]">
                    ✓
                  </span>
                  1. View Request & Recipient
                </li>
                <li className="flex items-center gap-2.5 text-[#2563FF] font-medium">
                  <span className="flex h-5 w-5 items-center justify-center rounded-full bg-[#2563FF]/20 text-[10px]">
                    2
                  </span>
                  2. Choose Source Asset & Network
                </li>
                <li className="flex items-center gap-2.5 text-[var(--text-secondary)]">
                  <span className="flex h-5 w-5 items-center justify-center rounded-full bg-[var(--border-subtle)] text-[10px]">
                    3
                  </span>
                  3. Check Route Availability
                </li>
                <li className="flex items-center gap-2.5 text-[var(--text-muted)]">
                  <span className="flex h-5 w-5 items-center justify-center rounded-full bg-[var(--border-subtle)] text-[10px]">
                    4
                  </span>
                  4. Review Quote (M6)
                </li>
                <li className="flex items-center gap-2.5 text-[var(--text-muted)]">
                  <span className="flex h-5 w-5 items-center justify-center rounded-full bg-[var(--border-subtle)] text-[10px]">
                    5
                  </span>
                  5. Payment Instructions & Deposit (M6)
                </li>
                <li className="flex items-center gap-2.5 text-[var(--text-muted)]">
                  <span className="flex h-5 w-5 items-center justify-center rounded-full bg-[var(--border-subtle)] text-[10px]">
                    6
                  </span>
                  6. Verified Cross-Chain Settlement
                </li>
              </ol>
            </div>
          </div>

          {/* Right Column: Payer Source Configuration (7 cols) */}
          <div className="md:col-span-7 space-y-5">
            {/* Payment Method & Payer Mode Card */}
            <div className="rounded-2xl border border-[var(--border-subtle)] bg-[var(--bg-card)] p-5 shadow-sm space-y-5">
              <div>
                <h2 className="text-base font-bold text-[var(--text-primary)]">
                  Pay From Your Wallet or Exchange
                </h2>
                <p className="text-xs text-[var(--text-secondary)] mt-0.5">
                  You choose the network and asset you want to pay with. No FLOW
                  account needed.
                </p>
              </div>

              {/* Payer Mode Switcher */}
              <div className="grid grid-cols-2 gap-2 p-1 rounded-xl bg-[var(--bg-app)] border border-[var(--border-subtle)]">
                <button
                  type="button"
                  onClick={() => setPayerMode("WALLET")}
                  className={`flex items-center justify-center gap-2 py-2 px-3 rounded-lg text-xs font-semibold transition-all ${
                    payerMode === "WALLET"
                      ? "bg-[var(--bg-card)] text-[#2563FF] shadow-sm border border-[var(--border-subtle)]"
                      : "text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
                  }`}
                >
                  <IconWallet size={14} />
                  Self-Custody Wallet
                </button>
                <button
                  type="button"
                  onClick={() => setPayerMode("EXCHANGE")}
                  className={`flex items-center justify-center gap-2 py-2 px-3 rounded-lg text-xs font-semibold transition-all ${
                    payerMode === "EXCHANGE"
                      ? "bg-[var(--bg-card)] text-[#2563FF] shadow-sm border border-[var(--border-subtle)]"
                      : "text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
                  }`}
                >
                  <IconExternalLink size={14} />
                  Exchange Withdrawal
                </button>
              </div>

              {/* Mode Notice */}
              {payerMode === "WALLET" ? (
                <div className="rounded-lg bg-slate-500/5 p-3 text-xs text-[var(--text-secondary)]">
                  Compatible with MetaMask, OKX Wallet, Phantom, Coinbase
                  Wallet, Rainbow, or any standard self-custody wallet.
                </div>
              ) : (
                <div className="rounded-lg bg-amber-500/10 border border-amber-500/20 p-3 text-xs text-amber-700 dark:text-amber-400 space-y-1.5">
                  <div className="font-semibold">Exchange Withdrawal Mode</div>
                  <div>
                    Compatible with Binance, Coinbase, Kraken, or OKX
                    withdrawals. Because exchange transfers originate from
                    pooled hot wallets, an explicit self-custody refund address
                    is mandatory.
                  </div>
                  <div className="pt-2">
                    <label className="block text-[11px] font-medium text-[var(--text-primary)] mb-1">
                      Your Personal Refund Address (Required for Exchange Mode):
                    </label>
                    <input
                      type="text"
                      value={refundAddress}
                      onChange={(e) => setRefundAddress(e.target.value)}
                      placeholder="0x... or Solana Base58 or NEAR account"
                      className="w-full rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-card)] px-3 py-1.5 text-xs text-[var(--text-primary)] placeholder-[var(--text-muted)] focus:border-[#2563FF] focus:outline-none"
                    />
                  </div>
                </div>
              )}

              {/* Ecosystem Selector */}
              <div className="space-y-2">
                <label className="block text-xs font-semibold text-[var(--text-secondary)] uppercase tracking-wider">
                  Select Source Ecosystem
                </label>
                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={() => {
                      setSelectedEcosystem("evm");
                      setSelectedRouteId("");
                    }}
                    className={`flex-1 py-2 px-3 rounded-xl border text-xs font-medium transition-all ${
                      selectedEcosystem === "evm"
                        ? "border-[#2563FF] bg-[#2563FF]/10 text-[#2563FF] font-semibold"
                        : "border-[var(--border-subtle)] bg-[var(--bg-app)] text-[var(--text-secondary)] hover:border-[var(--border-strong)]"
                    }`}
                  >
                    Ethereum & Base
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setSelectedEcosystem("solana");
                      setSelectedRouteId("");
                    }}
                    className={`flex-1 py-2 px-3 rounded-xl border text-xs font-medium transition-all ${
                      selectedEcosystem === "solana"
                        ? "border-[#2563FF] bg-[#2563FF]/10 text-[#2563FF] font-semibold"
                        : "border-[var(--border-subtle)] bg-[var(--bg-app)] text-[var(--text-secondary)] hover:border-[var(--border-strong)]"
                    }`}
                  >
                    Solana
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setSelectedEcosystem("near");
                      setSelectedRouteId("");
                    }}
                    className={`flex-1 py-2 px-3 rounded-xl border text-xs font-medium transition-all ${
                      selectedEcosystem === "near"
                        ? "border-[#2563FF] bg-[#2563FF]/10 text-[#2563FF] font-semibold"
                        : "border-[var(--border-subtle)] bg-[var(--bg-app)] text-[var(--text-secondary)] hover:border-[var(--border-strong)]"
                    }`}
                  >
                    NEAR Protocol
                  </button>
                </div>
              </div>

              {/* Source Asset & Network Dropdown / Grid */}
              <div className="space-y-2">
                <label className="block text-xs font-semibold text-[var(--text-secondary)] uppercase tracking-wider">
                  Select Source Asset & Network
                </label>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 max-h-56 overflow-y-auto p-1">
                  {ecosystemRoutes.map((route) => {
                    const isSelected = activeRoute?.id === route.id;
                    return (
                      <button
                        key={route.id}
                        type="button"
                        onClick={() => setSelectedRouteId(route.id)}
                        className={`flex items-start justify-between p-3 rounded-xl border text-left transition-all ${
                          isSelected
                            ? "border-[#2563FF] bg-[#2563FF]/10 shadow-sm"
                            : "border-[var(--border-subtle)] bg-[var(--bg-app)] hover:border-[var(--border-strong)]"
                        }`}
                      >
                        <div className="space-y-0.5">
                          <div className="flex items-center gap-1.5">
                            <span className="font-bold text-xs text-[var(--text-primary)]">
                              {route.assetSymbol}
                            </span>
                            <span className="text-[10px] text-[var(--text-muted)]">
                              ({route.standard})
                            </span>
                          </div>
                          <div className="text-[11px] text-[var(--text-secondary)] truncate max-w-[140px]">
                            {route.networkName}
                          </div>
                        </div>
                        <span
                          className={`text-[10px] px-1.5 py-0.5 rounded font-medium ${
                            route.routeType === "DIRECT_TRANSFER"
                              ? "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border border-emerald-500/20"
                              : "bg-blue-500/10 text-blue-600 dark:text-blue-400 border border-blue-500/20"
                          }`}
                        >
                          {route.routeType === "DIRECT_TRANSFER"
                            ? "Direct"
                            : "1Click"}
                        </span>
                      </button>
                    );
                  })}
                </div>
              </div>

              {/* Custom Amount Field if OPTIONAL */}
              {request.amountMode === "OPTIONAL" && (
                <div className="space-y-1.5 pt-2 border-t border-[var(--border-subtle)]">
                  <label className="block text-xs font-semibold text-[var(--text-secondary)]">
                    Amount to Send ({activeRoute?.assetSymbol ?? "Asset"})
                  </label>
                  <input
                    type="text"
                    value={customAmount}
                    onChange={(e) => setCustomAmount(e.target.value)}
                    placeholder="e.g. 25"
                    className="w-full rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-app)] px-3.5 py-2 text-sm text-[var(--text-primary)] font-semibold focus:border-[#2563FF] focus:outline-none"
                  />
                </div>
              )}

              {/* Route Summary & Terms Preview */}
              {activeRoute && (
                <div className="rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-app)] p-4 space-y-3">
                  <div className="flex justify-between items-center text-xs">
                    <span className="font-semibold text-[var(--text-primary)]">
                      Route Configuration
                    </span>
                    <span className="text-[11px] font-mono text-[var(--text-muted)]">
                      {activeRoute.routeType}
                    </span>
                  </div>

                  <div className="text-xs space-y-1.5 text-[var(--text-secondary)]">
                    <div className="flex justify-between">
                      <span>Source Asset:</span>
                      <span className="font-medium text-[var(--text-primary)]">
                        {activeRoute.assetName} ({activeRoute.assetSymbol}) on{" "}
                        {activeRoute.networkName}
                      </span>
                    </div>
                    <div className="flex justify-between">
                      <span>Destination Settlement:</span>
                      <span className="font-medium text-[var(--text-primary)]">
                        {request.destinationAssetSymbol} on{" "}
                        {request.destinationNetwork}
                      </span>
                    </div>
                  </div>

                  <div className="p-2.5 rounded-lg bg-amber-500/10 border border-amber-500/20 text-[11px] text-amber-700 dark:text-amber-400">
                    <strong>Route Staging Notice:</strong>{" "}
                    {activeRoute.availabilityNotice}
                  </div>
                </div>
              )}

              {/* Disabled Action Button with Clear Reason */}
              <div className="space-y-2 pt-2">
                <button
                  type="button"
                  disabled
                  className="w-full cursor-not-allowed rounded-xl bg-[var(--border-subtle)] py-3 px-4 text-center text-xs font-semibold text-[var(--text-muted)]"
                >
                  Generate Deposit Address (Disabled in M5 Phase 1)
                </button>
                <p className="text-center text-[11px] text-[var(--text-muted)]">
                  Live deposit address issuance is blocked until M6 integration.
                  No real payments are accepted.
                </p>
              </div>
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}

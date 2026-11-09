"use client";

import { useEffect, useMemo, useState } from "react";
import type {
  EligibleSourceRoute,
  PublicPaymentRequest,
} from "../../../domain/payment-requests.ts";
import type {
  IndicativeQuote,
  PaymentDepositInstructions,
} from "../../../domain/quote-discovery.ts";
import { FlowLogo } from "../../../components/flow-logo.tsx";
import { ThemeToggle } from "../../../components/theme-toggle.tsx";
import { QrCode } from "../../../components/qr-code.tsx";
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

  // Indicative Quote State
  const [quote, setQuote] = useState<IndicativeQuote | null>(null);
  const [loadingQuote, setLoadingQuote] = useState<boolean>(false);
  const [quoteError, setQuoteError] = useState<string | null>(null);
  const [secondsRemaining, setSecondsRemaining] = useState<number>(60);

  // M5 Phase 4 Deposit Instructions & Settlement Lifecycle State
  const [instructions, setInstructions] =
    useState<PaymentDepositInstructions | null>(null);
  const [committing, setCommitting] = useState<boolean>(false);
  const [commitError, setCommitError] = useState<string | null>(null);
  const [copiedAddress, setCopiedAddress] = useState<boolean>(false);
  const [copiedMemo, setCopiedMemo] = useState<boolean>(false);
  const [depositSecondsRemaining, setDepositSecondsRemaining] =
    useState<number>(900);

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

  // Validate refund address in Exchange mode
  const refundValidationMessage = useMemo(() => {
    if (payerMode !== "EXCHANGE") return null;
    const trimmed = refundAddress.trim();
    if (!trimmed) {
      return "A valid self-custody refund address is required for exchange withdrawals.";
    }
    if (selectedEcosystem === "evm" && !/^0x[0-9a-fA-F]{40}$/.test(trimmed)) {
      return "Ethereum & Base refund address must be a valid 42-character 0x address.";
    }
    if (
      selectedEcosystem === "solana" &&
      !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(trimmed)
    ) {
      return "Solana refund address must be a valid Base58 public key.";
    }
    if (
      selectedEcosystem === "near" &&
      !/^[0-9a-f]{64}$/.test(trimmed) &&
      !/^(?=.{2,64}$)[a-z0-9_-]+(\.[a-z0-9_-]+)+$/.test(trimmed)
    ) {
      return "NEAR refund address must be a valid named account (e.g. alice.near) or 64-char hex.";
    }
    return null;
  }, [payerMode, refundAddress, selectedEcosystem]);

  const [refreshTrigger, setRefreshTrigger] = useState(0);

  // Trigger quote discovery when route, mode, or amount changes
  useEffect(() => {
    if (!activeRoute || isExpired) return;

    // In exchange mode, do not quote if refund address is invalid
    if (payerMode === "EXCHANGE" && refundValidationMessage) {
      return;
    }

    // In optional amount mode, require explicit positive payer amount
    if (
      request.amountMode === "OPTIONAL" &&
      (!customAmount || customAmount.trim().length === 0)
    ) {
      Promise.resolve().then(() => {
        if (active) {
          setQuote(null);
          setLoadingQuote(false);
        }
      });
      return;
    }

    let active = true;
    Promise.resolve().then(() => {
      if (active) {
        setLoadingQuote(true);
        setQuoteError(null);
      }
    });

    fetch(`/api/pay/${request.publicId}/quote`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sourceDeploymentId: activeRoute.id,
        payerMode,
        refundAddress: refundAddress.trim() || undefined,
        customSourceDisplayAmount:
          request.amountMode === "OPTIONAL" ? customAmount : undefined,
      }),
    })
      .then(async (res) => {
        const data = await res.json();
        if (!active) return;
        if (!res.ok) {
          setQuoteError(data.error?.message ?? "Failed to retrieve quote");
          setQuote(null);
        } else {
          setQuote(data);
          setSecondsRemaining(60);
        }
      })
      .catch(() => {
        if (!active) return;
        setQuoteError("Network error while discovering quote");
        setQuote(null);
      })
      .finally(() => {
        if (active) setLoadingQuote(false);
      });

    return () => {
      active = false;
    };
  }, [
    activeRoute,
    customAmount,
    isExpired,
    payerMode,
    refundAddress,
    refundValidationMessage,
    refreshTrigger,
    request.amountMode,
    request.publicId,
  ]);

  // Countdown timer for quote expiry
  useEffect(() => {
    if (!quote) return;
    const interval = setInterval(() => {
      setSecondsRemaining((prev) => {
        if (prev <= 1) {
          clearInterval(interval);
          return 0;
        }
        return prev - 1;
      });
    }, 1000);
    return () => clearInterval(interval);
  }, [quote]);

  // Countdown timer for deposit deadline
  useEffect(() => {
    if (!instructions || !instructions.depositDeadline) return;
    const deadlineMs = new Date(instructions.depositDeadline).getTime();

    const updateTimer = () => {
      const remaining = Math.max(
        0,
        Math.floor((deadlineMs - Date.now()) / 1000),
      );
      setDepositSecondsRemaining(remaining);
    };

    updateTimer();
    const interval = setInterval(updateTimer, 1000);
    return () => clearInterval(interval);
  }, [instructions]);

  // Status Polling when instructions are issued and not yet settled
  useEffect(() => {
    if (
      !instructions ||
      instructions.status === "SETTLED" ||
      instructions.status === "FAILED"
    ) {
      return;
    }

    const interval = setInterval(async () => {
      try {
        const res = await fetch(
          `/api/pay/${request.publicId}/attempt/${instructions.attemptPublicId}`,
        );
        if (res.ok) {
          const updated = (await res.json()) as PaymentDepositInstructions;
          setInstructions(updated);
        }
      } catch {
        // Handled silently
      }
    }, 3000);

    return () => clearInterval(interval);
  }, [instructions, request.publicId]);

  const handleProceedToPayment = async () => {
    if (!quote || quote.routeStatus !== "SUPPORTED_AND_QUOTABLE") return;
    setCommitting(true);
    setCommitError(null);
    try {
      const res = await fetch(`/api/pay/${request.publicId}/commit`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          attemptPublicId: quote.attemptPublicId,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setCommitError(
          data.error?.message ?? "Failed to commit payment attempt",
        );
      } else {
        setInstructions(data as PaymentDepositInstructions);
      }
    } catch {
      setCommitError("Network error while generating deposit instructions");
    } finally {
      setCommitting(false);
    }
  };

  const handleCopyDepositAddress = () => {
    if (
      instructions &&
      typeof navigator !== "undefined" &&
      navigator.clipboard
    ) {
      void navigator.clipboard.writeText(instructions.depositAddress);
      setCopiedAddress(true);
      setTimeout(() => setCopiedAddress(false), 2000);
    }
  };

  const handleCopyMemo = () => {
    if (
      instructions?.depositMemo &&
      typeof navigator !== "undefined" &&
      navigator.clipboard
    ) {
      void navigator.clipboard.writeText(instructions.depositMemo);
      setCopiedMemo(true);
      setTimeout(() => setCopiedMemo(false), 2000);
    }
  };

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
            <span className="hidden sm:inline-flex items-center gap-1.5 rounded-full bg-emerald-500/10 px-2.5 py-0.5 text-xs font-medium text-emerald-600 dark:text-emerald-400 border border-emerald-500/30">
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
                  <IconCheck size={13} className="text-emerald-500" />
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
        <div className="rounded-xl border border-[#FF1A1A]/20 bg-neutral-50 dark:bg-neutral-900 p-4 text-xs text-[var(--text-secondary)] flex items-start gap-3">
          <IconInfo size={16} className="text-[#FF1A1A] shrink-0 mt-0.5" />
          <div className="space-y-1">
            <div className="font-medium text-[var(--text-primary)]">
              M5 Phase 3 Staged Checkout · Verified Quote Integrity &amp;
              Payment Readiness
            </div>
            <div>
              FLOW is running in preview mode (
              <code className="text-xs">FLOW_EXECUTION=disabled</code>). Quotes
              are dynamically discovered from real provider solvers without
              authorizing deposit addresses or financial mutations.
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
                  <span className="font-semibold text-[#FF1A1A] dark:text-[#3876FF]">
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
              <div className="rounded-xl border border-[#FF1A1A]/20 bg-[#FF1A1A]/5 p-4 text-center space-y-1">
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
                <span className="text-[11px] text-[var(--text-muted)] block">
                  Settles directly into recipient&apos;s verified FLOW custody
                  wallet
                </span>
              </div>
            </div>

            {/* Checkout Progression Stages Card */}
            <div className="rounded-2xl border border-[var(--border-subtle)] bg-[var(--bg-card)] p-5 shadow-sm space-y-3">
              <h3 className="text-xs font-semibold uppercase tracking-wider text-[var(--text-muted)]">
                Checkout Protocol Progress
              </h3>
              <ol className="space-y-2.5 text-xs">
                <li className="flex items-center gap-2.5 text-emerald-500 font-medium">
                  <span className="flex h-5 w-5 items-center justify-center rounded-full bg-emerald-500/20 text-[10px]">
                    ✓
                  </span>
                  1. View Request & Recipient
                </li>
                <li className="flex items-center gap-2.5 text-emerald-500 font-medium">
                  <span className="flex h-5 w-5 items-center justify-center rounded-full bg-emerald-500/20 text-[10px]">
                    ✓
                  </span>
                  2. Choose Source Asset & Network
                </li>
                <li className="flex items-center gap-2.5 text-[#FF1A1A] font-medium">
                  <span className="flex h-5 w-5 items-center justify-center rounded-full bg-[#FF1A1A]/20 text-[10px]">
                    3
                  </span>
                  3. Real Indicative Quote Discovery (M5 Phase 2)
                </li>
                <li className="flex items-center gap-2.5 text-[var(--text-muted)]">
                  <span className="flex h-5 w-5 items-center justify-center rounded-full bg-[var(--border-subtle)] text-[10px]">
                    4
                  </span>
                  4. Deposit Address Issuance (M6)
                </li>
                <li className="flex items-center gap-2.5 text-[var(--text-muted)]">
                  <span className="flex h-5 w-5 items-center justify-center rounded-full bg-[var(--border-subtle)] text-[10px]">
                    5
                  </span>
                  5. Cross-Chain Settlement
                </li>
              </ol>
            </div>
          </div>

          {/* Right Column: Payer Source Configuration & Quote Card (7 cols) */}
          <div className="md:col-span-7 space-y-5">
            {request.status === "COMPLETED" ? (
              <div className="rounded-2xl border border-emerald-500/30 bg-[var(--bg-card)] p-6 shadow-sm space-y-4">
                <div className="flex items-center gap-3 text-emerald-600 dark:text-emerald-400">
                  <div className="p-3 rounded-full bg-emerald-500/20">
                    <IconCheck size={24} />
                  </div>
                  <div>
                    <h2 className="text-lg font-bold text-[var(--text-primary)]">
                      Payment Completed!
                    </h2>
                    <p className="text-xs text-emerald-600 dark:text-emerald-400">
                      Funds credited to recipient ledger.
                    </p>
                  </div>
                </div>

                <div className="p-4 rounded-xl bg-[var(--bg-app)] border border-[var(--border-subtle)] space-y-2.5 text-xs">
                  <div className="flex justify-between">
                    <span className="text-[var(--text-secondary)]">
                      Settled Amount:
                    </span>
                    <span className="font-bold text-[var(--text-primary)]">
                      {request.displayAmount} {request.destinationAssetSymbol}
                    </span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-[var(--text-secondary)]">
                      Destination Network:
                    </span>
                    <span className="font-medium text-[var(--text-primary)]">
                      {request.destinationNetwork}
                    </span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-[var(--text-secondary)]">
                      Invoice Status:
                    </span>
                    <span className="font-semibold text-emerald-600 dark:text-emerald-400">
                      PAID &amp; SETTLED
                    </span>
                  </div>
                </div>
              </div>
            ) : (
              /* Payment Method & Payer Mode Card */
              <div className="rounded-2xl border border-[var(--border-subtle)] bg-[var(--bg-card)] p-5 shadow-sm space-y-5">
                <div>
                  <h2 className="text-base font-bold text-[var(--text-primary)]">
                    Pay From Your Wallet or Exchange
                  </h2>
                  <p className="text-xs text-[var(--text-secondary)] mt-0.5">
                    Choose your network and asset. No FLOW account required.
                  </p>
                </div>

                {/* Payer Mode Switcher */}
                <div className="grid grid-cols-2 gap-2 p-1 rounded-xl bg-[var(--bg-app)] border border-[var(--border-subtle)]">
                  <button
                    type="button"
                    onClick={() => setPayerMode("WALLET")}
                    className={`flex items-center justify-center gap-2 py-2 px-3 rounded-lg text-xs font-semibold transition-all ${
                      payerMode === "WALLET"
                        ? "bg-[var(--bg-card)] text-[#FF1A1A] shadow-sm border border-[var(--border-subtle)]"
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
                        ? "bg-[var(--bg-card)] text-[#FF1A1A] shadow-sm border border-[var(--border-subtle)]"
                        : "text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
                    }`}
                  >
                    <IconExternalLink size={14} />
                    Exchange Withdrawal
                  </button>
                </div>

                {/* Mode Notice & Refund Address Input */}
                {payerMode === "WALLET" ? (
                  <div className="rounded-lg bg-slate-500/5 p-3 text-xs text-[var(--text-secondary)]">
                    Compatible with MetaMask, OKX Wallet, Phantom, Coinbase
                    Wallet, Rainbow, or any standard self-custody wallet.
                  </div>
                ) : (
                  <div className="rounded-lg bg-amber-500/10 border border-amber-500/20 p-3 text-xs text-amber-700 dark:text-amber-400 space-y-2">
                    <div className="font-semibold">
                      Exchange Withdrawal Mode
                    </div>
                    <div>
                      Because exchange transfers originate from pooled hot
                      wallets, an explicit self-custody refund address is
                      mandatory for safety.
                    </div>
                    <div className="pt-1">
                      <label className="block text-[11px] font-semibold text-[var(--text-primary)] mb-1">
                        Your Personal Refund Address:
                      </label>
                      <input
                        type="text"
                        value={refundAddress}
                        onChange={(e) => setRefundAddress(e.target.value)}
                        placeholder="Enter 0x... or Solana Base58 or NEAR account"
                        className="w-full rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-card)] px-3 py-1.5 text-xs text-[var(--text-primary)] placeholder-[var(--text-muted)] focus:border-[#FF1A1A] focus:outline-none"
                      />
                      {refundValidationMessage && (
                        <p className="text-[11px] text-amber-600 dark:text-amber-400 mt-1 font-medium">
                          ⚠️ {refundValidationMessage}
                        </p>
                      )}
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
                          ? "border-[#FF1A1A] bg-[#FF1A1A]/10 text-[#FF1A1A] font-semibold"
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
                          ? "border-[#FF1A1A] bg-[#FF1A1A]/10 text-[#FF1A1A] font-semibold"
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
                          ? "border-[#FF1A1A] bg-[#FF1A1A]/10 text-[#FF1A1A] font-semibold"
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
                              ? "border-[#FF1A1A] bg-[#FF1A1A]/10 shadow-sm"
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
                                : "bg-[#FF1A1A]/10 text-[#FF1A1A] dark:text-blue-400 border border-[#FF1A1A]/20"
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
                      className="w-full rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-app)] px-3.5 py-2 text-sm text-[var(--text-primary)] font-semibold focus:border-[#FF1A1A] focus:outline-none"
                    />
                  </div>
                )}

                {/* Settlement Lifecycle & Deposit Card (M5 Phase 4) */}
                <div className="rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-app)] p-4 space-y-3">
                  {instructions ? (
                    <div className="space-y-4">
                      {/* Header / Status Banner */}
                      <div className="flex items-center justify-between">
                        <span className="text-xs font-bold text-[var(--text-primary)] uppercase tracking-wider">
                          Deposit Instructions
                        </span>
                        <span
                          className={`text-[10px] px-2 py-0.5 rounded-full font-semibold border flex items-center gap-1 ${
                            instructions.status === "SETTLED"
                              ? "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-emerald-500/30"
                              : instructions.status === "SETTLING"
                                ? "bg-[#FF1A1A]/10 text-[#FF1A1A] border-[#FF1A1A]/30"
                                : "bg-amber-500/10 text-amber-600 dark:text-amber-400 border-amber-500/30"
                          }`}
                        >
                          {instructions.status === "SETTLED" ? (
                            <>
                              <IconCheck size={10} />
                              SETTLED
                            </>
                          ) : instructions.status === "SETTLING" ? (
                            <>
                              <span className="h-1.5 w-1.5 rounded-full bg-[#FF1A1A] animate-ping" />
                              SETTLING
                            </>
                          ) : (
                            <>
                              <span className="h-1.5 w-1.5 rounded-full bg-amber-500 animate-pulse" />
                              AWAITING DEPOSIT
                            </>
                          )}
                        </span>
                      </div>

                      {/* Settled Success State */}
                      {instructions.status === "SETTLED" ? (
                        <div className="p-4 rounded-xl bg-emerald-500/10 border border-emerald-500/30 space-y-3">
                          <div className="flex items-center gap-2 text-emerald-700 dark:text-emerald-400">
                            <div className="p-2 rounded-full bg-emerald-500/20">
                              <IconCheck size={20} />
                            </div>
                            <div>
                              <div className="font-bold text-sm">
                                Payment Completed!
                              </div>
                              <div className="text-xs text-emerald-600 dark:text-emerald-500">
                                Funds credited to recipient ledger.
                              </div>
                            </div>
                          </div>

                          <div className="p-3 rounded-lg bg-[var(--bg-card)] border border-[var(--border-subtle)] space-y-2 text-xs">
                            <div className="flex justify-between">
                              <span className="text-[var(--text-secondary)]">
                                Settled Amount:
                              </span>
                              <span className="font-bold text-[var(--text-primary)]">
                                {instructions.destinationDisplayAmount}{" "}
                                {instructions.destinationAssetSymbol}
                              </span>
                            </div>
                            <div className="flex justify-between">
                              <span className="text-[var(--text-secondary)]">
                                Destination Network:
                              </span>
                              <span className="font-medium">
                                {instructions.destinationNetwork}
                              </span>
                            </div>
                            {instructions.sourceTxHash && (
                              <div className="flex justify-between text-[11px] pt-1 border-t border-[var(--border-subtle)]">
                                <span className="text-[var(--text-secondary)]">
                                  Source Tx:
                                </span>
                                <span className="font-mono text-[var(--text-primary)]">
                                  {instructions.sourceTxHash.slice(0, 10)}...
                                  {instructions.sourceTxHash.slice(-8)}
                                </span>
                              </div>
                            )}
                            {instructions.destinationTxHash && (
                              <div className="flex justify-between text-[11px]">
                                <span className="text-[var(--text-secondary)]">
                                  Settlement Tx:
                                </span>
                                <span className="font-mono text-[#FF1A1A]">
                                  {instructions.destinationTxHash.slice(0, 10)}
                                  ...
                                  {instructions.destinationTxHash.slice(-8)}
                                </span>
                              </div>
                            )}
                          </div>

                          <button
                            type="button"
                            onClick={() => {
                              setInstructions(null);
                              setRefreshTrigger((n) => n + 1);
                            }}
                            className="w-full rounded-xl bg-[var(--bg-card)] border border-[var(--border-subtle)] py-2.5 text-center text-xs font-semibold text-[var(--text-primary)] hover:border-[#FF1A1A] transition-colors"
                          >
                            Make Another Payment
                          </button>
                        </div>
                      ) : (
                        /* Pending Deposit State */
                        <div className="space-y-3 text-xs">
                          {/* QR Code */}
                          <div className="flex flex-col items-center justify-center p-3 rounded-xl bg-[var(--bg-card)] border border-[var(--border-subtle)]">
                            <QrCode
                              value={
                                instructions.qrData ||
                                instructions.depositAddress
                              }
                              size={130}
                            />
                            <span className="mt-2 text-[10px] text-[var(--text-muted)] font-mono">
                              Scan to pay with any compatible wallet
                            </span>
                          </div>

                          {/* Required Amount Card */}
                          <div className="p-3 rounded-lg bg-[var(--bg-card)] border border-[var(--border-subtle)] space-y-1">
                            <div className="text-[11px] text-[var(--text-secondary)]">
                              Required Transfer:
                            </div>
                            <div className="text-base font-extrabold text-[var(--text-primary)]">
                              {instructions.requiredDisplayAmount}{" "}
                              <span className="text-[#FF1A1A]">
                                {instructions.sourceAssetSymbol}
                              </span>
                            </div>
                            <div className="text-[11px] text-[var(--text-muted)]">
                              Network:{" "}
                              <strong className="text-[var(--text-primary)]">
                                {instructions.sourceNetwork}
                              </strong>
                            </div>
                          </div>

                          {/* Deposit Address Box */}
                          <div className="space-y-1">
                            <label className="text-[11px] font-medium text-[var(--text-secondary)]">
                              Deposit Address:
                            </label>
                            <div className="flex items-center gap-1.5 p-2 rounded-lg bg-[var(--bg-card)] border border-[var(--border-subtle)] font-mono text-[11px]">
                              <span className="flex-1 truncate select-all">
                                {instructions.depositAddress}
                              </span>
                              <button
                                type="button"
                                onClick={handleCopyDepositAddress}
                                className="p-1 rounded hover:bg-[var(--border-subtle)] text-[var(--text-secondary)] transition-colors"
                                title="Copy address"
                              >
                                {copiedAddress ? (
                                  <IconCheck
                                    size={14}
                                    className="text-emerald-500"
                                  />
                                ) : (
                                  <IconCopy size={14} />
                                )}
                              </button>
                            </div>
                          </div>

                          {/* Memo / Tag Box if present */}
                          {instructions.depositMemo && (
                            <div className="space-y-1">
                              <label className="text-[11px] font-medium text-amber-600 dark:text-amber-400">
                                Required Memo / Tag (Do not forget):
                              </label>
                              <div className="flex items-center gap-1.5 p-2 rounded-lg bg-amber-500/10 border border-amber-500/30 font-mono text-[11px]">
                                <span className="flex-1 truncate select-all">
                                  {instructions.depositMemo}
                                </span>
                                <button
                                  type="button"
                                  onClick={handleCopyMemo}
                                  className="p-1 rounded hover:bg-amber-500/20 text-amber-700 transition-colors"
                                  title="Copy memo"
                                >
                                  {copiedMemo ? (
                                    <IconCheck
                                      size={14}
                                      className="text-emerald-500"
                                    />
                                  ) : (
                                    <IconCopy size={14} />
                                  )}
                                </button>
                              </div>
                            </div>
                          )}

                          {/* Expiry Countdown */}
                          <div className="flex justify-between items-center text-[11px] text-[var(--text-secondary)] px-1">
                            <span>Deposit Deadline:</span>
                            <span
                              className={`font-mono font-bold ${
                                depositSecondsRemaining < 120
                                  ? "text-rose-500"
                                  : "text-[var(--text-primary)]"
                              }`}
                            >
                              {Math.floor(depositSecondsRemaining / 60)}:
                              {(depositSecondsRemaining % 60)
                                .toString()
                                .padStart(2, "0")}{" "}
                              remaining
                            </span>
                          </div>

                          {/* Staged Execution Notice */}
                          <div className="p-2.5 rounded-lg bg-amber-500/10 border border-amber-500/20 text-[11px] text-amber-700 dark:text-amber-400">
                            <strong>
                              Staged Mode (FLOW_EXECUTION=disabled):
                            </strong>{" "}
                            Valid deposit instructions generated. Live chain
                            funds are gated.
                          </div>

                          <div className="pt-1 text-center">
                            <button
                              type="button"
                              onClick={() => setInstructions(null)}
                              className="text-[11px] text-[var(--text-muted)] hover:text-[var(--text-primary)] underline"
                            >
                              Back to Quote Preview
                            </button>
                          </div>
                        </div>
                      )}
                    </div>
                  ) : (
                    <>
                      <div className="flex justify-between items-center">
                        <span className="text-xs font-bold text-[var(--text-primary)]">
                          Indicative Route Quote
                        </span>
                        {/* Status Badge */}
                        {loadingQuote ? (
                          <span className="text-[11px] text-[var(--text-muted)] animate-pulse">
                            Discovering solvers...
                          </span>
                        ) : quote ? (
                          <span
                            className={`text-[10px] px-2 py-0.5 rounded-full font-semibold border ${
                              quote.routeStatus === "SUPPORTED_AND_QUOTABLE"
                                ? "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-emerald-500/30"
                                : quote.routeStatus === "UNSUPPORTED_PAIR"
                                  ? "bg-slate-500/10 text-slate-600 dark:text-slate-400 border-slate-500/30"
                                  : quote.routeStatus ===
                                      "NOT_YET_ENABLED_FOR_PAYMENT"
                                    ? "bg-purple-500/10 text-purple-600 dark:text-purple-400 border-purple-500/30"
                                    : "bg-amber-500/10 text-amber-600 dark:text-amber-400 border-amber-500/30"
                            }`}
                          >
                            {quote.routeStatus.replace(/_/g, " ")}
                          </span>
                        ) : quoteError ? (
                          <span className="text-[10px] px-2 py-0.5 rounded-full font-semibold bg-rose-500/10 text-rose-600 border border-rose-500/30">
                            PROVIDER ERROR
                          </span>
                        ) : null}
                      </div>

                      {/* Quote Content */}
                      {loadingQuote ? (
                        <div className="py-6 text-center text-xs text-[var(--text-muted)] animate-pulse">
                          Querying read-only provider solvers for live
                          cross-chain quote...
                        </div>
                      ) : quote &&
                        quote.routeStatus === "SUPPORTED_AND_QUOTABLE" ? (
                        <div className="space-y-3 text-xs">
                          {/* Amounts breakdown */}
                          <div className="p-3 rounded-lg bg-[var(--bg-card)] border border-[var(--border-subtle)] space-y-2">
                            <div className="flex justify-between items-center">
                              <span className="text-[var(--text-secondary)]">
                                You Pay:
                              </span>
                              <span className="font-bold text-sm text-[var(--text-primary)]">
                                {quote.sourceDisplayAmount}{" "}
                                {quote.sourceAssetSymbol}
                              </span>
                            </div>
                            <div className="flex justify-between items-center">
                              <span className="text-[var(--text-secondary)]">
                                Recipient Gets:
                              </span>
                              <span className="font-bold text-sm text-[#FF1A1A] dark:text-[#3876FF]">
                                {quote.destinationDisplayAmount}{" "}
                                {quote.destinationAssetSymbol}
                              </span>
                            </div>
                          </div>

                          {/* Routing Details */}
                          <div className="space-y-1.5 text-[var(--text-secondary)] text-[11px]">
                            <div className="flex justify-between">
                              <span>Exchange Rate:</span>
                              <span className="font-medium text-[var(--text-primary)]">
                                {quote.exchangeRateDescription}
                              </span>
                            </div>
                            <div className="flex justify-between">
                              <span>Estimated Duration:</span>
                              <span className="font-medium text-[var(--text-primary)]">
                                {quote.estimatedDurationSeconds !== null
                                  ? `~${quote.estimatedDurationSeconds} seconds`
                                  : "Variable / Unknown"}
                              </span>
                            </div>
                            <div className="flex justify-between">
                              <span>Fees & Slippage:</span>
                              <span className="font-medium text-[var(--text-primary)]">
                                {quote.fees.description}
                              </span>
                            </div>
                            <div className="flex justify-between items-center pt-1 border-t border-[var(--border-subtle)]">
                              <span>Local Preview Expiry:</span>
                              <div className="flex items-center gap-1.5">
                                <span
                                  className={`font-mono ${
                                    secondsRemaining < 15
                                      ? "text-amber-500 font-bold"
                                      : "text-[var(--text-muted)]"
                                  }`}
                                >
                                  {secondsRemaining > 0
                                    ? `Refresh in ${secondsRemaining}s`
                                    : "Expired"}
                                </span>
                                <button
                                  type="button"
                                  onClick={() =>
                                    setRefreshTrigger((n) => n + 1)
                                  }
                                  className="text-[#FF1A1A] hover:underline font-semibold"
                                >
                                  Refresh
                                </button>
                              </div>
                            </div>
                          </div>
                        </div>
                      ) : quote &&
                        quote.routeStatus === "NOT_YET_ENABLED_FOR_PAYMENT" ? (
                        <div className="space-y-2 text-xs">
                          <div className="p-3 rounded-lg bg-purple-500/10 border border-purple-500/20 text-purple-800 dark:text-purple-300">
                            <strong>Direct Transfer:</strong> 1:1 direct
                            on-chain transfer on {quote.destinationNetwork}.
                            Live execution is disabled for safety.
                          </div>
                        </div>
                      ) : quote && quote.routeStatus === "UNSUPPORTED_PAIR" ? (
                        <div className="p-3 rounded-lg bg-slate-500/10 border border-slate-500/20 text-xs text-[var(--text-secondary)] space-y-1">
                          <div className="font-semibold text-[var(--text-primary)]">
                            Unsupported Route Pair
                          </div>
                          <div>
                            {quote.statusMessage ??
                              "No automated solver routes currently support this token pair."}
                          </div>
                        </div>
                      ) : quoteError ? (
                        <div className="p-3 rounded-lg bg-rose-500/10 border border-rose-500/20 text-xs text-rose-600 dark:text-rose-400">
                          <strong>Quote Discovery Error:</strong> {quoteError}
                        </div>
                      ) : (
                        <div className="py-3 text-center text-xs text-[var(--text-muted)]">
                          Select a source asset to discover live solver quotes.
                        </div>
                      )}

                      {/* Staging & Execution Disabled Notice */}
                      <div className="p-2.5 rounded-lg bg-amber-500/10 border border-amber-500/20 text-[11px] text-amber-700 dark:text-amber-400">
                        <strong>Indicative Preview Only:</strong>{" "}
                        {quote?.executionBlockedNotice ??
                          "Live deposit address issuance and payment execution are disabled (FLOW_EXECUTION=disabled)."}
                      </div>

                      {commitError && (
                        <div className="p-2.5 rounded-lg bg-rose-500/10 border border-rose-500/20 text-xs text-rose-600 dark:text-rose-400">
                          <strong>Commit Error:</strong> {commitError}
                        </div>
                      )}

                      {/* Action Button: Gated while execution is disabled */}
                      <div className="space-y-2 pt-2">
                        <button
                          type="button"
                          onClick={handleProceedToPayment}
                          disabled={
                            committing ||
                            !quote ||
                            quote.routeStatus !== "SUPPORTED_AND_QUOTABLE" ||
                            (quote.isExecutionDisabled ?? true)
                          }
                          className={`w-full rounded-xl py-3 px-4 text-center text-xs font-semibold transition-all ${
                            !committing &&
                            quote &&
                            quote.routeStatus === "SUPPORTED_AND_QUOTABLE" &&
                            !quote.isExecutionDisabled
                              ? "bg-[#FF1A1A] hover:bg-[#1D4ED8] text-white cursor-pointer shadow-sm"
                              : "bg-[var(--border-subtle)] text-[var(--text-muted)] cursor-not-allowed"
                          }`}
                        >
                          {committing
                            ? "Securing Deposit Address..."
                            : quote &&
                                quote.routeStatus === "SUPPORTED_AND_QUOTABLE"
                              ? quote.isExecutionDisabled
                                ? "Pay Now (Payment Execution Disabled)"
                                : "Pay Now & Get Deposit Address"
                              : "Select Quotable Route to Continue"}
                        </button>

                        <p className="text-center text-[11px] text-[var(--text-muted)]">
                          Real solver route discovered. Live deposit address
                          issuance is gated while FLOW_EXECUTION=disabled.
                        </p>
                      </div>
                    </>
                  )}
                </div>
              </div>
            )}
          </div>
        </div>
      </main>
    </div>
  );
}

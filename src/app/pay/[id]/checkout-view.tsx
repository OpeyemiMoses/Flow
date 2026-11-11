"use client";

import Link from "next/link";
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
import { QrCode } from "../../../components/qr-code.tsx";
import {
  ChainBadge,
  IconCheck,
  IconCopy,
  IconExternalLink,
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

  // Deposit Instructions & Settlement Lifecycle State
  const [instructions, setInstructions] =
    useState<PaymentDepositInstructions | null>(request.activeAttempt ?? null);
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

  // Wallet Connection & Auto-Refund State (Task 2)
  const [connectedWallet, setConnectedWallet] = useState<{
    address: string;
    ecosystem: "evm" | "solana" | "near";
    label: string;
  } | null>(null);
  const [connectingWallet, setConnectingWallet] = useState(false);
  const [walletConnectError, setWalletConnectError] = useState<string | null>(
    null,
  );

  // Copy Feedback State
  const [copiedRecipientAddress, setCopiedRecipientAddress] = useState(false);
  const [copiedAmount, setCopiedAmount] = useState(false);

  const handleCopyLink = () => {
    if (typeof navigator !== "undefined" && navigator.clipboard) {
      void navigator.clipboard.writeText(request.shareUrl);
      setCopiedLink(true);
      setTimeout(() => setCopiedLink(false), 2000);
    }
  };

  const handleCopyRecipientAddress = () => {
    const addr =
      request.recipientAddress || "0x436BdB38888998e269E94301C2362C2f46bCF614";
    if (typeof navigator !== "undefined" && navigator.clipboard) {
      void navigator.clipboard.writeText(addr);
      setCopiedRecipientAddress(true);
      setTimeout(() => setCopiedRecipientAddress(false), 2000);
    }
  };

  const handleCopyAmount = () => {
    const amt =
      instructions?.requiredDisplayAmount ??
      quote?.sourceDisplayAmount ??
      request.displayAmount;
    if (amt && typeof navigator !== "undefined" && navigator.clipboard) {
      void navigator.clipboard.writeText(amt);
      setCopiedAmount(true);
      setTimeout(() => setCopiedAmount(false), 2000);
    }
  };

  const handleSelectEcosystem = (eco: "evm" | "solana" | "near") => {
    if (eco === selectedEcosystem) return;
    setSelectedEcosystem(eco);
    setSelectedRouteId("");
    setQuote(null);
    setQuoteError(null);
    setWalletConnectError(null);

    // Invalidate connected wallet if switching to a different ecosystem
    if (connectedWallet && connectedWallet.ecosystem !== eco) {
      setConnectedWallet(null);
      setRefundAddress("");
    } else if (refundAddress.trim()) {
      // Validate whether current manual refund address matches the new ecosystem format; if not, clear
      const trimmed = refundAddress.trim();
      let validForNew = false;
      if (eco === "evm" && /^0x[0-9a-fA-F]{40}$/.test(trimmed))
        validForNew = true;
      if (eco === "solana" && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(trimmed))
        validForNew = true;
      if (
        eco === "near" &&
        (/^[0-9a-f]{64}$/.test(trimmed) ||
          /^(?=.{2,64}$)[a-z0-9_-]+(\.[a-z0-9_-]+)+$/.test(trimmed))
      )
        validForNew = true;
      if (!validForNew) {
        setRefundAddress("");
      }
    }
  };

  const handleConnectWallet = async () => {
    if (typeof window === "undefined") return;
    setConnectingWallet(true);
    setWalletConnectError(null);
    try {
      if (selectedEcosystem === "solana") {
        const solana =
          (
            window as unknown as {
              phantom?: {
                solana?: {
                  connect: () => Promise<{
                    publicKey?: { toString: () => string };
                  }>;
                  publicKey?: { toString: () => string };
                  isPhantom?: boolean;
                };
              };
              solana?: {
                connect: () => Promise<{
                  publicKey?: { toString: () => string };
                }>;
                publicKey?: { toString: () => string };
                isPhantom?: boolean;
              };
            }
          ).phantom?.solana ||
          (
            window as unknown as {
              solana?: {
                connect: () => Promise<{
                  publicKey?: { toString: () => string };
                }>;
                publicKey?: { toString: () => string };
                isPhantom?: boolean;
              };
            }
          ).solana;

        if (!solana) {
          setWalletConnectError(
            "No Solana wallet extension detected (Phantom, Solflare, etc.). Enter address manually.",
          );
          return;
        }

        const resp = await solana.connect();
        const pubkey =
          resp?.publicKey?.toString() || solana.publicKey?.toString();
        if (!pubkey) {
          throw new Error("Could not retrieve public key from Solana wallet");
        }

        if (
          pubkey === "GvTihjQRfzPtuk4iptiDnsWLojCFX1QBSDgzgi8JAgAS" ||
          pubkey.toLowerCase() ===
            (request.recipientAddress || "").toLowerCase()
        ) {
          setWalletConnectError(
            "The recipient's Flow custody wallet cannot be used as the refund address. Please enter a genuine payer-controlled self-custody wallet.",
          );
          return;
        }

        setRefundAddress(pubkey);
        setConnectedWallet({
          address: pubkey,
          ecosystem: "solana",
          label: solana.isPhantom ? "Phantom" : "Solana Wallet",
        });
      } else if (selectedEcosystem === "evm") {
        const ethereum = (
          window as unknown as {
            ethereum?: {
              request: (args: { method: string }) => Promise<string[]>;
              isMetaMask?: boolean;
            };
          }
        ).ethereum;

        if (!ethereum || !ethereum.request) {
          setWalletConnectError(
            "No EVM wallet extension detected (MetaMask, Coinbase Wallet, Rabby, etc.). Enter address manually.",
          );
          return;
        }

        const accounts = await ethereum.request({
          method: "eth_requestAccounts",
        });
        if (!accounts || accounts.length === 0 || !accounts[0]) {
          throw new Error("No accounts approved in EVM wallet");
        }

        const addr = accounts[0];
        const recipientLower = (
          request.recipientAddress ||
          "0x436BdB38888998e269E94301C2362C2f46bCF614"
        ).toLowerCase();
        if (addr.toLowerCase() === recipientLower) {
          setWalletConnectError(
            "The recipient's Flow custody wallet cannot be used as the refund address. Please enter a genuine payer-controlled self-custody wallet.",
          );
          return;
        }

        setRefundAddress(addr);
        setConnectedWallet({
          address: addr,
          ecosystem: "evm",
          label: ethereum.isMetaMask ? "MetaMask" : "EVM Wallet",
        });
      } else if (selectedEcosystem === "near") {
        const near = (
          window as unknown as {
            near?: { getAccountId?: () => Promise<string> };
          }
        ).near;

        if (!near || !near.getAccountId) {
          setWalletConnectError(
            "No NEAR wallet extension detected. Enter address manually.",
          );
          return;
        }

        const accountId = await near.getAccountId();
        if (accountId) {
          if (
            accountId ===
              "8dd1fb6f9ca1f542d1faa6a8526f3ca0c68fab6d2081d52aa86bb10a73349628" ||
            accountId.toLowerCase() ===
              (request.recipientAddress || "").toLowerCase()
          ) {
            setWalletConnectError(
              "The recipient's Flow custody wallet cannot be used as the refund address. Please enter a genuine payer-controlled self-custody wallet.",
            );
            return;
          }

          setRefundAddress(accountId);
          setConnectedWallet({
            address: accountId,
            ecosystem: "near",
            label: "NEAR Wallet",
          });
        }
      }
    } catch (err: unknown) {
      setWalletConnectError(
        err instanceof Error ? err.message : "Failed to connect wallet",
      );
    } finally {
      setConnectingWallet(false);
    }
  };

  const handleDisconnectWallet = () => {
    setConnectedWallet(null);
    setRefundAddress("");
    setWalletConnectError(null);
  };

  const isExpired = request.status === "EXPIRED" || request.isExpired;
  const isCrossChain = activeRoute
    ? activeRoute.networkKey !== request.destinationNetwork
    : false;
  const isRefundRequired = payerMode === "EXCHANGE" || isCrossChain;

  // Validate refund address in Exchange mode or for cross-chain settlements
  const refundValidationMessage = useMemo(() => {
    if (!isRefundRequired) return null;
    const trimmed = refundAddress.trim();
    if (!trimmed) {
      return payerMode === "EXCHANGE"
        ? "A valid self-custody refund address is required for exchange withdrawals."
        : `A payer-controlled ${selectedEcosystem.toUpperCase()} refund address is required for cross-chain settlement.`;
    }

    // Inbound/Outbound address separation invariant (Task 2 & 3)
    const recipientAddrLower = (
      request.recipientAddress || "0x436BdB38888998e269E94301C2362C2f46bCF614"
    ).toLowerCase();
    if (
      trimmed.toLowerCase() === recipientAddrLower ||
      trimmed === "GvTihjQRfzPtuk4iptiDnsWLojCFX1QBSDgzgi8JAgAS" ||
      trimmed ===
        "8dd1fb6f9ca1f542d1faa6a8526f3ca0c68fab6d2081d52aa86bb10a73349628" ||
      trimmed.toLowerCase() === "0x436bdb38888998e269e94301c2362c2f46bcf614"
    ) {
      return "The recipient's Flow custody wallet cannot be used as the refund address. Please enter a genuine payer-controlled self-custody wallet.";
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
  }, [
    isRefundRequired,
    payerMode,
    refundAddress,
    selectedEcosystem,
    request.recipientAddress,
  ]);

  const [refreshTrigger, setRefreshTrigger] = useState(0);

  // Trigger quote discovery when route, mode, or amount changes
  useEffect(() => {
    if (instructions || !activeRoute || isExpired) return;

    if (payerMode === "EXCHANGE" && refundValidationMessage) {
      return;
    }

    let active = true;
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
    instructions,
    isExpired,
    isRefundRequired,
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
    if (isRefundRequired && refundValidationMessage) {
      setCommitError(refundValidationMessage);
      return;
    }
    setCommitting(true);
    setCommitError(null);
    try {
      const res = await fetch(`/api/pay/${request.publicId}/commit`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          attemptPublicId: quote.attemptPublicId,
          payerRefundAddress: refundAddress.trim() || undefined,
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

  const isCompletedReceipt =
    request.status === "COMPLETED" || instructions?.status === "SETTLED";

  return (
    <div className="min-h-screen bg-[#FAF8F5] text-neutral-950 relative overflow-hidden">
      {/* Top-Right & Bottom-Left Red Diagonal Wave Accents (Matches Flow Crypto Payment Checkout.png) */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute -top-10 right-0 w-[340px] sm:w-[500px] h-[200px] z-0 overflow-hidden"
      >
        <svg viewBox="0 0 500 200" fill="none" className="w-full h-full">
          <path
            d="M120 -20 C240 80, 360 20, 520 150 L520 -20 Z"
            fill="url(#payTopWave)"
          />
          <defs>
            <linearGradient id="payTopWave" x1="0" y1="0" x2="1" y2="1">
              <stop offset="0%" stopColor="#FF2E2E" />
              <stop offset="65%" stopColor="#CC0000" />
              <stop offset="100%" stopColor="#1A0000" />
            </linearGradient>
          </defs>
        </svg>
      </div>

      {/* Top Navigation Bar */}
      <header className="relative z-10 mx-auto flex max-w-[1140px] items-center justify-between px-4 sm:px-8 pt-6 pb-4">
        <Link
          href="/"
          prefetch={false}
          className="inline-flex items-center gap-2.5"
        >
          <FlowLogo size={26} />
        </Link>

        <div className="flex items-center gap-2.5">
          <span className="hidden sm:inline-flex items-center gap-1.5 rounded-full border border-neutral-200 bg-white px-3.5 py-1.5 text-xs font-medium text-neutral-700 shadow-2xs">
            <span className="h-2 w-2 rounded-full bg-emerald-500" />
            Secure Checkout
          </span>
          <button
            onClick={handleCopyLink}
            type="button"
            className="inline-flex items-center gap-1.5 rounded-full border border-neutral-200 bg-white px-4 py-1.5 text-xs font-semibold text-neutral-900 shadow-2xs hover:bg-neutral-50 transition-colors"
          >
            {copiedLink ? (
              <>
                <IconCheck size={13} className="text-emerald-600" />
                Copied
              </>
            ) : (
              <>
                <IconCopy size={13} />
                Share Link
              </>
            )}
          </button>
        </div>
      </header>

      {/* Main Content */}
      <main className="relative z-10 mx-auto max-w-[1140px] px-4 sm:px-8 pt-4 pb-20 space-y-7">
        {/* Heading */}
        <div>
          <p className="text-[11px] font-bold uppercase tracking-[0.14em] text-[#FF1A1A]">
            {isCompletedReceipt ? "PAYMENT RECEIPT" : "FLOW CHECKOUT"}
          </p>
          <h1 className="mt-1 font-serif text-3xl sm:text-[44px] font-normal tracking-[-0.02em] text-neutral-950 leading-[1.08]">
            {isCompletedReceipt ? (
              "Payment Successful"
            ) : (
              <>
                Complete your{" "}
                <span className="relative inline-block">
                  payment
                  <svg
                    viewBox="0 0 180 12"
                    fill="none"
                    className="absolute -bottom-1 left-0 w-full h-2.5"
                  >
                    <path
                      d="M3 9 C55 2, 125 2, 177 8"
                      stroke="#FF1A1A"
                      strokeWidth="3.5"
                      strokeLinecap="round"
                    />
                  </svg>
                </span>
              </>
            )}
          </h1>
          <p className="mt-2 text-sm text-neutral-600">
            {isCompletedReceipt
              ? "Your payment has been verified on-chain and settled to the recipient."
              : "Choose how you want to pay — Flow routes and settles your payment automatically."}
          </p>
        </div>

        {/* Expired Banner */}
        {isExpired && (
          <div className="rounded-[20px] border border-red-200 bg-red-50 p-4 text-sm text-[#FF1A1A]">
            <strong>Payment Request Expired:</strong> This payment request is
            past its expiration deadline and cannot accept new payments.
          </div>
        )}

        {/* ===================================================================
            COMPLETED RECEIPT VIEW (Matches Flow Payment Successful Receipt-4.png & 08_56_36 PM-10.png)
           =================================================================== */}
        {isCompletedReceipt ? (
          <div className="mx-auto max-w-2xl rounded-[28px] border border-neutral-200/90 bg-white p-6 sm:p-10 shadow-md space-y-6">
            <div className="flex flex-col items-center text-center space-y-3">
              <div className="inline-flex h-16 w-16 items-center justify-center rounded-full bg-[#FF1A1A] text-white shadow-lg">
                <IconCheck size={30} />
              </div>
              <span className="inline-flex items-center gap-1.5 rounded-full bg-emerald-50 px-3 py-1 text-xs font-semibold text-emerald-700">
                <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
                Paid &amp; Settled
              </span>
              <h2 className="font-serif text-3xl text-neutral-950">
                Payment Completed!
              </h2>
              <p className="text-sm text-neutral-600">
                Funds credited to{" "}
                <strong className="text-neutral-950">
                  {request.recipientName}
                </strong>{" "}
                for{" "}
                <strong className="text-neutral-950">{request.title}</strong>.
              </p>
            </div>

            <div className="rounded-[20px] border border-neutral-200/80 bg-neutral-50 p-5 space-y-3 text-xs">
              <div className="flex justify-between items-center">
                <span className="text-neutral-500">Recipient</span>
                <span className="font-bold text-neutral-950">
                  {request.recipientName}
                </span>
              </div>
              <div className="flex justify-between items-center">
                <span className="text-neutral-500">Settled Amount</span>
                <span className="font-display text-base font-bold text-neutral-950">
                  {instructions?.destinationDisplayAmount ??
                    request.displayAmount}{" "}
                  {instructions?.destinationAssetSymbol ??
                    request.destinationAssetSymbol}
                </span>
              </div>
              <div className="flex justify-between items-center">
                <span className="text-neutral-500">Destination Network</span>
                <span className="font-semibold text-neutral-900">
                  {instructions?.destinationNetwork ??
                    request.destinationNetwork}
                </span>
              </div>
              {instructions?.sourceTxHash && (
                <div className="flex justify-between items-center pt-2 border-t border-neutral-200">
                  <span className="text-neutral-500">Source Transaction</span>
                  <span className="font-mono text-neutral-800">
                    {instructions.sourceTxHash.slice(0, 10)}...
                    {instructions.sourceTxHash.slice(-8)}
                  </span>
                </div>
              )}
              {instructions?.destinationTxHash && (
                <div className="flex justify-between items-center">
                  <span className="text-neutral-500">
                    Settlement Transaction
                  </span>
                  <span className="font-mono font-semibold text-[#FF1A1A]">
                    {instructions.destinationTxHash.slice(0, 10)}...
                    {instructions.destinationTxHash.slice(-8)}
                  </span>
                </div>
              )}
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              {instructions && (
                <button
                  type="button"
                  onClick={() => {
                    setInstructions(null);
                    setRefreshTrigger((n) => n + 1);
                  }}
                  className="rounded-full bg-[#FF1A1A] py-3 text-xs font-semibold text-white hover:bg-[#E01515]"
                >
                  Make Another Payment
                </button>
              )}
              <Link
                href="/"
                prefetch={false}
                className="flex items-center justify-center rounded-full border border-neutral-200 bg-white py-3 text-xs font-semibold text-neutral-900 hover:bg-neutral-50"
              >
                Return to Flow
              </Link>
            </div>
          </div>
        ) : (
          /* ===================================================================
              MAIN 2-COLUMN CHECKOUT (Matches Flow Crypto Payment Checkout.png & Flow Mobile Crypto Payment Screen-8.png)
             =================================================================== */
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-7 items-start">
            {/* LEFT 7 COLUMNS: White Checkout Card */}
            <div className="lg:col-span-7 rounded-[28px] border border-neutral-200/90 bg-white p-6 sm:p-8 shadow-sm space-y-6">
              {/* Merchant & Request Header */}
              <div className="flex flex-wrap items-start justify-between gap-4 border-b border-neutral-100 pb-5">
                <div className="flex items-center gap-3.5">
                  <span className="inline-flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-[#FF1A1A] font-display text-lg font-bold text-white shadow-xs">
                    {request.recipientName.slice(0, 1).toUpperCase()}
                  </span>
                  <div>
                    <p className="text-xs font-medium text-neutral-500">
                      Pay{" "}
                      <strong className="text-neutral-900">
                        {request.recipientName}
                      </strong>
                    </p>
                    <h2 className="font-display text-xl font-bold text-neutral-950">
                      {request.title}
                    </h2>
                    {request.description && (
                      <p className="mt-0.5 text-xs text-neutral-500">
                        {request.description}
                      </p>
                    )}
                  </div>
                </div>

                <span className="inline-flex items-center gap-1.5 rounded-full bg-emerald-50 px-3 py-1 text-[11px] font-semibold text-emerald-700">
                  <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
                  Active Request
                </span>
              </div>

              {/* Amount Due & Recipient Settlement Summary */}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3.5 rounded-[20px] border border-neutral-200/70 bg-neutral-50/70 p-4">
                <div>
                  <span className="text-[11px] font-medium text-neutral-500">
                    {request.amountMode === "FIXED"
                      ? "Amount due"
                      : "Optional Amount"}
                  </span>
                  <p className="mt-1 font-display text-2xl font-bold text-neutral-950">
                    {request.amountMode === "FIXED"
                      ? `${request.displayAmount} ${request.destinationAssetSymbol}`
                      : "Payer Specified"}
                  </p>
                </div>
                <div className="sm:border-l sm:border-neutral-200/80 sm:pl-4">
                  <span className="text-[11px] font-medium text-neutral-500">
                    Recipient receives
                  </span>
                  <p className="mt-1 font-display text-sm font-bold text-neutral-950">
                    {request.destinationAssetSymbol} on{" "}
                    {request.destinationNetwork}
                  </p>
                  <p className="text-[11px] text-neutral-500">
                    Automatic cross-chain settlement
                  </p>
                </div>
              </div>

              {/* Step 1: Select Source Ecosystem ("You're paying from") */}
              <div className="space-y-2.5">
                <label className="block text-xs font-semibold text-neutral-800">
                  You&apos;re paying from
                </label>
                <div className="grid grid-cols-3 gap-2.5">
                  <button
                    type="button"
                    onClick={() => handleSelectEcosystem("evm")}
                    className={`flex items-center justify-center gap-2 rounded-[14px] border py-3 px-3 text-xs font-semibold transition-all ${
                      selectedEcosystem === "evm"
                        ? "border-[#FF1A1A] bg-red-50/40 text-neutral-950 shadow-2xs"
                        : "border-neutral-200 bg-white text-neutral-700 hover:bg-neutral-50"
                    }`}
                  >
                    <ChainBadge chainKey="ethereum-mainnet" size={16} />
                    <span>Ethereum &amp; Base</span>
                  </button>

                  <button
                    type="button"
                    onClick={() => handleSelectEcosystem("solana")}
                    className={`flex items-center justify-center gap-2 rounded-[14px] border py-3 px-3 text-xs font-semibold transition-all ${
                      selectedEcosystem === "solana"
                        ? "border-[#FF1A1A] bg-red-50/40 text-neutral-950 shadow-2xs"
                        : "border-neutral-200 bg-white text-neutral-700 hover:bg-neutral-50"
                    }`}
                  >
                    <ChainBadge chainKey="solana-mainnet" size={16} />
                    <span>Solana</span>
                  </button>

                  <button
                    type="button"
                    onClick={() => handleSelectEcosystem("near")}
                    className={`flex items-center justify-center gap-2 rounded-[14px] border py-3 px-3 text-xs font-semibold transition-all ${
                      selectedEcosystem === "near"
                        ? "border-[#FF1A1A] bg-red-50/40 text-neutral-950 shadow-2xs"
                        : "border-neutral-200 bg-white text-neutral-700 hover:bg-neutral-50"
                    }`}
                  >
                    <ChainBadge chainKey="near-mainnet" size={16} />
                    <span>NEAR Protocol</span>
                  </button>
                </div>
              </div>

              {/* Step 2: Select Source Asset & Network */}
              <div className="space-y-2.5">
                <label className="block text-xs font-semibold text-neutral-800">
                  Source asset &amp; network
                </label>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
                  {ecosystemRoutes.map((route) => {
                    const isSelected = activeRoute?.id === route.id;
                    return (
                      <button
                        key={route.id}
                        type="button"
                        onClick={() => setSelectedRouteId(route.id)}
                        className={`flex items-center justify-between rounded-[14px] border p-3.5 text-left transition-all ${
                          isSelected
                            ? "border-[#FF1A1A] bg-red-50/30 shadow-2xs"
                            : "border-neutral-200 bg-white hover:bg-neutral-50"
                        }`}
                      >
                        <div>
                          <div className="flex items-center gap-1.5">
                            <span className="font-display text-xs font-bold text-neutral-950">
                              {route.assetSymbol}
                            </span>
                            <span className="text-[10px] text-neutral-400">
                              ({route.standard})
                            </span>
                          </div>
                          <p className="text-[11px] text-neutral-500">
                            {route.networkName}
                          </p>
                        </div>
                        <span
                          className={`rounded-full px-2 py-0.5 text-[10px] font-bold ${
                            route.routeType === "DIRECT_TRANSFER"
                              ? "bg-emerald-50 text-emerald-700"
                              : "bg-red-50 text-[#FF1A1A]"
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

              {/* Optional Custom Amount Input */}
              {request.amountMode === "OPTIONAL" && (
                <div>
                  <label className="block text-xs font-semibold text-neutral-800 mb-1.5">
                    Amount to Send ({activeRoute?.assetSymbol ?? "Asset"})
                  </label>
                  <input
                    type="text"
                    value={customAmount}
                    onChange={(e) => setCustomAmount(e.target.value)}
                    placeholder="e.g. 25"
                    className="w-full rounded-[14px] border border-neutral-200 bg-white px-4 py-3 font-display text-base font-bold text-neutral-950 focus:border-neutral-950 focus:outline-none"
                  />
                </div>
              )}

              {/* Step 3: Payment Method (Self-Custody Wallet vs Exchange Withdrawal) */}
              <div className="space-y-2.5">
                <label className="block text-xs font-semibold text-neutral-800">
                  Payment method
                </label>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
                  <button
                    type="button"
                    onClick={() => setPayerMode("WALLET")}
                    className={`flex items-center gap-3 rounded-[14px] border p-3.5 text-left transition-all ${
                      payerMode === "WALLET"
                        ? "border-[#FF1A1A] bg-red-50/30 shadow-2xs"
                        : "border-neutral-200 bg-white hover:bg-neutral-50"
                    }`}
                  >
                    <span className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-[10px] bg-neutral-950 text-white">
                      <IconWallet size={15} />
                    </span>
                    <div>
                      <p className="font-display text-xs font-bold text-neutral-950">
                        Self-Custody Wallet
                      </p>
                      <p className="text-[11px] text-neutral-500">
                        MetaMask, Phantom, Coinbase
                      </p>
                    </div>
                  </button>

                  <button
                    type="button"
                    onClick={() => setPayerMode("EXCHANGE")}
                    className={`flex items-center gap-3 rounded-[14px] border p-3.5 text-left transition-all ${
                      payerMode === "EXCHANGE"
                        ? "border-[#FF1A1A] bg-red-50/30 shadow-2xs"
                        : "border-neutral-200 bg-white hover:bg-neutral-50"
                    }`}
                  >
                    <span className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-[10px] bg-neutral-100 text-neutral-800">
                      <IconExternalLink size={15} />
                    </span>
                    <div>
                      <p className="font-display text-xs font-bold text-neutral-950">
                        Exchange Withdrawal
                      </p>
                      <p className="text-[11px] text-neutral-500">
                        Binance, Coinbase, Kraken
                      </p>
                    </div>
                  </button>
                </div>

                {/* Refund Address Input for Exchange Mode or Cross-Chain Payments */}
                {isRefundRequired && (
                  <div className="mt-3 rounded-[16px] border border-amber-200 bg-amber-50/70 p-4 space-y-2.5 text-xs">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <p className="font-semibold text-amber-950">
                        {payerMode === "EXCHANGE"
                          ? "Self-custody refund address required for exchange withdrawals"
                          : `Payer-controlled ${selectedEcosystem.toUpperCase()} refund address required`}
                      </p>
                      {payerMode === "WALLET" && (
                        <div className="flex items-center gap-2">
                          {connectedWallet ? (
                            <span className="inline-flex items-center gap-1.5 rounded-full bg-emerald-100/90 px-2.5 py-0.5 text-[11px] font-semibold text-emerald-800">
                              <span className="h-1.5 w-1.5 rounded-full bg-emerald-600" />
                              Connected: {connectedWallet.address.slice(0, 4)}
                              ...
                              {connectedWallet.address.slice(-4)} (used for
                              refunds)
                              <button
                                type="button"
                                onClick={handleDisconnectWallet}
                                className="ml-1 text-[10px] text-emerald-900 underline hover:text-red-700"
                              >
                                Disconnect
                              </button>
                            </span>
                          ) : (
                            <button
                              type="button"
                              onClick={handleConnectWallet}
                              disabled={connectingWallet}
                              className="inline-flex items-center gap-1 rounded-full border border-neutral-300 bg-white px-2.5 py-1 text-[11px] font-semibold text-neutral-800 hover:bg-neutral-100 shadow-2xs"
                            >
                              <IconWallet size={12} />
                              {connectingWallet
                                ? "Connecting..."
                                : "Connect Wallet"}
                            </button>
                          )}
                        </div>
                      )}
                    </div>

                    <p className="text-[11px] text-neutral-600">
                      {payerMode === "EXCHANGE"
                        ? "Exchanges cannot route incoming refunds to your account. You must provide a self-custody wallet address you control in case this payment needs to be returned. The recipient's Flow wallet address cannot be used."
                        : connectedWallet
                          ? "Refunds will be sent to this address if the payment cannot be completed. You can manually adjust this address below."
                          : "In case of an unfillable deposit, funds are returned directly to this address. Connect your wallet above or enter a self-custody address manually. The recipient's Flow wallet address cannot be used."}
                    </p>

                    {walletConnectError && (
                      <p className="text-[11px] font-semibold text-red-600">
                        {walletConnectError}
                      </p>
                    )}

                    <input
                      type="text"
                      value={refundAddress}
                      onChange={(e) => {
                        setRefundAddress(e.target.value);
                        if (walletConnectError) setWalletConnectError(null);
                      }}
                      placeholder="Enter 0x... or Solana Base58 or NEAR account"
                      className="w-full rounded-[12px] border border-neutral-200 bg-white px-3.5 py-2.5 text-xs text-neutral-950 placeholder:text-neutral-400 focus:border-neutral-950 focus:outline-none"
                    />

                    {refundValidationMessage && (
                      <p className="text-[11px] font-semibold text-amber-800">
                        ⚠️ {refundValidationMessage}
                      </p>
                    )}
                  </div>
                )}
              </div>

              {/* Step 4: Deposit Instructions OR Indicative Route Quote */}
              <div className="rounded-[20px] border border-neutral-200/90 bg-neutral-50/80 p-5 space-y-4">
                {instructions ? (
                  /* DEPOSIT INSTRUCTIONS VIEW (Matches Flow Wallet Payment Instructions.png & 08_56_32 PM-8.png) */
                  <div className="space-y-4 text-xs">
                    <div className="flex items-center justify-between">
                      <div>
                        <span className="text-[10px] font-bold uppercase tracking-wider text-[#FF1A1A]">
                          DEPOSIT INSTRUCTIONS
                        </span>
                        <h3 className="font-serif text-xl text-neutral-950">
                          Send exact amount to deposit address
                        </h3>
                      </div>
                      <span
                        className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-[11px] font-semibold ${
                          instructions.status === "FAILED" ||
                          instructions.status === "EXPIRED" ||
                          instructions.status === "EXCEPTION_REFUND_REQUIRED"
                            ? "bg-red-50 border-red-200 text-[#FF1A1A]"
                            : "bg-amber-50 border-amber-200 text-amber-800"
                        }`}
                      >
                        <span
                          className={`h-1.5 w-1.5 rounded-full ${
                            instructions.status === "FAILED" ||
                            instructions.status === "EXPIRED" ||
                            instructions.status === "EXCEPTION_REFUND_REQUIRED"
                              ? "bg-[#FF1A1A]"
                              : "bg-amber-500 animate-pulse"
                          }`}
                        />
                        {instructions.status === "SETTLING" ||
                        instructions.status === "DETECTED"
                          ? "SETTLING"
                          : instructions.status === "EXCEPTION_REFUND_REQUIRED"
                            ? "REFUND REQUIRED"
                            : instructions.status === "EXPIRED"
                              ? "QUOTE EXPIRED"
                              : instructions.status === "FAILED"
                                ? "ROUTE FAILED"
                                : "AWAITING DEPOSIT"}
                      </span>
                    </div>

                    {instructions.status === "EXCEPTION_REFUND_REQUIRED" && (
                      <div className="rounded-[14px] border border-red-200 bg-red-50 p-3 text-xs text-[#FF1A1A]">
                        <strong>
                          Refund Required — Do Not Send Additional Funds:
                        </strong>{" "}
                        Deposit was received outside the valid quote window or
                        could not be routed. Funds are queued for refund to the
                        configured refund address.
                      </div>
                    )}

                    {instructions.status === "EXPIRED" && (
                      <div className="rounded-[14px] border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900">
                        <strong>Deposit Window Expired:</strong> Do not send
                        funds to this expired deposit address. Click &ldquo;Back
                        to Quote Preview&rdquo; below to request a fresh quote.
                      </div>
                    )}

                    {instructions.status === "FAILED" && (
                      <div className="rounded-[14px] border border-red-200 bg-red-50 p-3 text-xs text-[#FF1A1A]">
                        <strong>Route Execution Failed:</strong> This payment
                        attempt could not be completed. Click &ldquo;Back to
                        Quote Preview&rdquo; to select another route.
                      </div>
                    )}

                    <div className="grid grid-cols-1 sm:grid-cols-12 gap-4 items-center rounded-[18px] border border-neutral-200 bg-white p-4">
                      <div className="sm:col-span-5 flex flex-col items-center justify-center">
                        <QrCode
                          value={
                            instructions.qrData || instructions.depositAddress
                          }
                          size={136}
                        />
                        <span className="mt-2 text-[10px] text-neutral-400">
                          Scan with any wallet
                        </span>
                      </div>

                      <div className="sm:col-span-7 space-y-3">
                        <div>
                          <span className="text-[11px] text-neutral-500">
                            Amount to send
                          </span>
                          <p className="font-display text-xl font-bold text-neutral-950">
                            {instructions.requiredDisplayAmount}{" "}
                            <span className="text-[#FF1A1A]">
                              {instructions.sourceAssetSymbol}
                            </span>
                          </p>
                          <p className="text-[11px] text-neutral-500">
                            Network:{" "}
                            <strong className="text-neutral-900">
                              {instructions.sourceNetwork}
                            </strong>
                          </p>
                        </div>

                        <div>
                          <span className="text-[11px] text-neutral-500 block mb-1">
                            Deposit Address
                          </span>
                          <div className="flex items-center justify-between gap-2 rounded-[10px] border border-neutral-200 bg-neutral-50 px-3 py-2 font-mono text-[11px]">
                            <span className="truncate select-all">
                              {instructions.depositAddress}
                            </span>
                            <button
                              type="button"
                              onClick={handleCopyDepositAddress}
                              className="shrink-0 font-sans font-semibold text-[#FF1A1A]"
                            >
                              {copiedAddress ? "Copied" : "Copy"}
                            </button>
                          </div>
                        </div>

                        {instructions.depositMemo && (
                          <div>
                            <span className="text-[11px] font-semibold text-amber-800 block mb-1">
                              Required Memo / Tag
                            </span>
                            <div className="flex items-center justify-between gap-2 rounded-[10px] border border-amber-200 bg-amber-50 px-3 py-2 font-mono text-[11px]">
                              <span className="truncate select-all">
                                {instructions.depositMemo}
                              </span>
                              <button
                                type="button"
                                onClick={handleCopyMemo}
                                className="shrink-0 font-sans font-semibold text-amber-900"
                              >
                                {copiedMemo ? "Copied" : "Copy"}
                              </button>
                            </div>
                          </div>
                        )}

                        <div className="flex items-center justify-between pt-1 text-[11px]">
                          <span className="text-neutral-500">
                            Quote expires in
                          </span>
                          <span className="font-mono font-bold text-neutral-950">
                            {Math.floor(depositSecondsRemaining / 60)}:
                            {(depositSecondsRemaining % 60)
                              .toString()
                              .padStart(2, "0")}{" "}
                            remaining
                          </span>
                        </div>
                      </div>
                    </div>

                    <div className="text-center">
                      <button
                        type="button"
                        onClick={() => setInstructions(null)}
                        className="text-xs font-semibold text-neutral-600 hover:text-neutral-950 underline"
                      >
                        Back to Quote Preview
                      </button>
                    </div>
                  </div>
                ) : (
                  /* INDICATIVE QUOTE PREVIEW */
                  <>
                    <div className="flex items-center justify-between">
                      <span className="text-xs font-bold text-neutral-950">
                        Quote Summary
                      </span>
                      {loadingQuote ? (
                        <span className="text-[11px] text-neutral-500 animate-pulse">
                          Discovering route...
                        </span>
                      ) : quote ? (
                        <span
                          className={`rounded-full px-2.5 py-0.5 text-[10px] font-bold ${
                            quote.routeStatus === "SUPPORTED_AND_QUOTABLE"
                              ? "bg-emerald-50 text-emerald-700"
                              : quote.routeStatus === "UNSUPPORTED_PAIR"
                                ? "bg-neutral-200 text-neutral-700"
                                : "bg-amber-50 text-amber-800"
                          }`}
                        >
                          {quote.routeStatus.replace(/_/g, " ")}
                        </span>
                      ) : quoteError ? (
                        <span className="rounded-full bg-red-50 px-2.5 py-0.5 text-[10px] font-bold text-[#FF1A1A]">
                          PROVIDER ERROR
                        </span>
                      ) : null}
                    </div>

                    {loadingQuote ? (
                      <div className="py-5 text-center text-xs text-neutral-500">
                        Fetching live cross-chain quote...
                      </div>
                    ) : quote &&
                      quote.routeStatus === "SUPPORTED_AND_QUOTABLE" ? (
                      <div className="space-y-3 text-xs">
                        <div className="rounded-[14px] border border-neutral-200/80 bg-white p-3.5 space-y-2">
                          <div className="flex justify-between items-center">
                            <span className="text-neutral-500">You Pay:</span>
                            <span className="font-display text-sm font-bold text-neutral-950">
                              {quote.sourceDisplayAmount}{" "}
                              {quote.sourceAssetSymbol}
                            </span>
                          </div>
                          <div className="flex justify-between items-center">
                            <span className="text-neutral-500">
                              Recipient Gets:
                            </span>
                            <span className="font-display text-sm font-bold text-[#FF1A1A]">
                              {quote.destinationDisplayAmount}{" "}
                              {quote.destinationAssetSymbol}
                            </span>
                          </div>
                        </div>

                        <div className="space-y-1.5 text-[11px] text-neutral-600">
                          <div className="flex justify-between">
                            <span>Exchange Rate:</span>
                            <span className="font-semibold text-neutral-900">
                              {quote.exchangeRateDescription}
                            </span>
                          </div>
                          <div className="flex justify-between">
                            <span>Estimated Settlement:</span>
                            <span className="font-semibold text-neutral-900">
                              {quote.estimatedDurationSeconds !== null
                                ? `~${quote.estimatedDurationSeconds} seconds`
                                : "Instant"}
                            </span>
                          </div>
                          <div className="flex justify-between">
                            <span>Settlement Fee:</span>
                            <span className="font-semibold text-neutral-900">
                              {quote.fees.withdrawFeeDisplay
                                ? `${quote.fees.withdrawFeeDisplay} ${quote.fees.withdrawFeeAssetSymbol || request.destinationAssetSymbol} (included)`
                                : "Included in quote"}
                            </span>
                          </div>
                          {quote.fees.refundFeeDisplay && (
                            <div className="flex justify-between">
                              <span>Conditional Refund Fee:</span>
                              <span className="font-semibold text-neutral-900">
                                {quote.fees.refundFeeDisplay}{" "}
                                {quote.fees.refundFeeAssetSymbol ||
                                  quote.sourceAssetSymbol}{" "}
                                <span className="text-[10px] text-neutral-500 font-normal">
                                  (charged only on refund)
                                </span>
                              </span>
                            </div>
                          )}
                          <div className="flex justify-between">
                            <span>Estimated Network Gas:</span>
                            <span className="font-semibold text-neutral-900">
                              ~
                              {quote.fees.networkGasEstimateDisplay ||
                                "0.000005"}{" "}
                              {quote.fees.networkGasAssetSymbol ||
                                quote.sourceAssetSymbol}{" "}
                              <span className="text-[10px] text-neutral-500 font-normal">
                                (paid by wallet)
                              </span>
                            </span>
                          </div>
                          <div className="pt-1 text-[10px] text-neutral-500 italic">
                            * Note: USD values are live indicative estimates
                            based on current oracle rates, not a guaranteed
                            maximum. Payer authorization is bounded strictly in{" "}
                            {quote.sourceAssetSymbol} atomic units (
                            {quote.sourceAtomicAmount}{" "}
                            {quote.sourceAssetSymbol === "SOL"
                              ? "lamports"
                              : "atomic units"}
                            ).
                          </div>
                          <div className="flex justify-between items-center pt-1.5 border-t border-neutral-200/70">
                            <span>Quote refreshes in:</span>
                            <div className="flex items-center gap-2">
                              <span className="font-mono font-semibold text-neutral-800">
                                {secondsRemaining > 0
                                  ? `${secondsRemaining}s`
                                  : "Expired"}
                              </span>
                              <button
                                type="button"
                                onClick={() => setRefreshTrigger((n) => n + 1)}
                                className="font-semibold text-[#FF1A1A] hover:underline"
                              >
                                Refresh
                              </button>
                            </div>
                          </div>
                        </div>
                      </div>
                    ) : quote &&
                      quote.routeStatus === "NOT_YET_ENABLED_FOR_PAYMENT" ? (
                      <div className="rounded-[14px] border border-purple-200 bg-purple-50/70 p-3.5 text-xs text-purple-900">
                        <strong>Direct Transfer:</strong> 1:1 direct on-chain
                        transfer on {quote.destinationNetwork}. Live execution
                        is disabled for safety.
                      </div>
                    ) : quote && quote.routeStatus === "UNSUPPORTED_PAIR" ? (
                      <div className="rounded-[14px] border border-neutral-200 bg-white p-3.5 text-xs text-neutral-700 space-y-1">
                        <div className="font-bold text-neutral-950">
                          Unsupported Route Pair
                        </div>
                        <div>
                          {quote.statusMessage ??
                            "No automated solver routes currently support this token pair."}
                        </div>
                      </div>
                    ) : quoteError ? (
                      <div className="rounded-[14px] border border-red-200 bg-red-50 p-3.5 text-xs text-[#FF1A1A]">
                        <strong>Quote Discovery Error:</strong> {quoteError}
                      </div>
                    ) : (
                      <div className="py-3 text-center text-xs text-neutral-500">
                        Select a source asset to discover live quotes.
                      </div>
                    )}

                    {commitError && (
                      <div className="rounded-[12px] border border-red-200 bg-red-50 p-3 text-xs text-[#FF1A1A]">
                        <strong>Commit Error:</strong> {commitError}
                      </div>
                    )}

                    {/* Primary CTA Button */}
                    <button
                      type="button"
                      onClick={handleProceedToPayment}
                      disabled={
                        committing ||
                        !quote ||
                        quote.routeStatus !== "SUPPORTED_AND_QUOTABLE" ||
                        (isRefundRequired && !!refundValidationMessage) ||
                        (quote.isExecutionDisabled ?? true)
                      }
                      className={`w-full rounded-full py-3.5 px-6 text-xs sm:text-sm font-semibold transition-all ${
                        !committing &&
                        quote &&
                        quote.routeStatus === "SUPPORTED_AND_QUOTABLE" &&
                        (!isRefundRequired || !refundValidationMessage) &&
                        !quote.isExecutionDisabled
                          ? "bg-[#FF1A1A] hover:bg-[#E01515] text-white cursor-pointer shadow-md"
                          : "bg-neutral-950 text-white/90 opacity-85 cursor-not-allowed"
                      }`}
                    >
                      {committing
                        ? "Securing Deposit Address..."
                        : quote &&
                            quote.routeStatus === "SUPPORTED_AND_QUOTABLE"
                          ? quote.isExecutionDisabled
                            ? "Pay Now (Payment Execution Disabled)"
                            : "Continue to payment →"
                          : "Select Quotable Route to Continue"}
                    </button>
                  </>
                )}
              </div>
            </div>

            {/* RIGHT 5 COLUMNS: Recipient Wallet (State A) OR Deposit Instructions (State B) + Trust Highlights */}
            <div className="lg:col-span-5 space-y-5">
              {!instructions ? (
                /* STATE A: Recipient Wallet Address (Before Payment Commitment) */
                <div className="rounded-[28px] border border-neutral-200/90 bg-white p-6 shadow-sm space-y-5">
                  <div className="flex items-center justify-between">
                    <div>
                      <span className="text-[10px] font-bold uppercase tracking-[0.14em] text-[#FF1A1A]">
                        RECIPIENT DESTINATION
                      </span>
                      <h2 className="font-serif text-xl text-neutral-950">
                        Recipient Wallet Address
                      </h2>
                    </div>
                    <span className="rounded-full bg-neutral-100 px-2.5 py-1 text-[10px] font-semibold text-neutral-700">
                      Permanent Address
                    </span>
                  </div>

                  <div className="flex flex-col items-center justify-center rounded-[22px] border border-neutral-200/70 bg-neutral-50 p-6">
                    <QrCode
                      value={
                        request.recipientAddress ||
                        "0x436BdB38888998e269E94301C2362C2f46bCF614"
                      }
                      size={156}
                    />
                    <p className="mt-3 text-xs font-medium text-neutral-600 text-center">
                      Recipient destination wallet on{" "}
                      <strong className="text-neutral-900">
                        {request.destinationNetwork}
                      </strong>
                    </p>
                  </div>

                  <div className="space-y-3">
                    <div className="rounded-[14px] border border-neutral-200/80 bg-neutral-50/70 p-3.5 space-y-2 text-xs">
                      <div className="flex justify-between items-center">
                        <span className="text-neutral-500">Recipient:</span>
                        <span className="font-bold text-neutral-900">
                          {request.recipientName}
                        </span>
                      </div>
                      <div className="flex justify-between items-center">
                        <span className="text-neutral-500">Destination:</span>
                        <span className="font-semibold text-neutral-900">
                          {request.destinationAssetSymbol} on{" "}
                          {request.destinationNetwork}
                        </span>
                      </div>
                    </div>

                    <div>
                      <span className="text-[11px] font-medium text-neutral-500 block mb-1">
                        Recipient Destination Address
                      </span>
                      <div className="flex items-center justify-between gap-2 rounded-[12px] border border-neutral-200 bg-neutral-50 px-3.5 py-2.5 font-mono text-xs">
                        <span className="truncate select-all text-neutral-800">
                          {request.recipientAddress ||
                            "0x436BdB38888998e269E94301C2362C2f46bCF614"}
                        </span>
                        <button
                          type="button"
                          onClick={handleCopyRecipientAddress}
                          className="shrink-0 font-sans font-semibold text-[#FF1A1A] hover:underline"
                        >
                          {copiedRecipientAddress ? "Copied" : "Copy"}
                        </button>
                      </div>
                    </div>

                    {/* Informational Safety Warning */}
                    <div className="rounded-[14px] border border-amber-200/90 bg-amber-50/80 p-3.5 text-xs text-amber-950 space-y-1">
                      <p className="font-bold text-[#FF1A1A] flex items-center gap-1.5">
                        <span>⚠️</span> Recipient wallet address — not the
                        deposit address for this payment.
                      </p>
                      <p className="text-[11px] leading-relaxed text-neutral-700">
                        Do not send funds directly to this address when paying
                        cross-chain. Select your source asset on the left and
                        proceed to generate your dedicated payment deposit
                        address.
                      </p>
                    </div>
                  </div>
                </div>
              ) : (
                /* STATE B: Payment Instructions (After Authorized Payment Commitment) */
                <div className="rounded-[28px] border border-neutral-200/90 bg-white p-6 shadow-sm space-y-5">
                  <div className="flex items-center justify-between">
                    <div>
                      <span className="text-[10px] font-bold uppercase tracking-[0.14em] text-[#FF1A1A]">
                        PAYMENT INSTRUCTIONS
                      </span>
                      <h2 className="font-serif text-xl text-neutral-950">
                        Deposit Instructions
                      </h2>
                    </div>
                    <span
                      className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[10px] font-semibold ${
                        instructions.status === "FAILED" ||
                        instructions.status === "EXPIRED" ||
                        instructions.status === "EXCEPTION_REFUND_REQUIRED"
                          ? "bg-red-50 border-red-200 text-[#FF1A1A]"
                          : "bg-amber-50 border-amber-200 text-amber-800"
                      }`}
                    >
                      <span
                        className={`h-1.5 w-1.5 rounded-full ${
                          instructions.status === "FAILED" ||
                          instructions.status === "EXPIRED" ||
                          instructions.status === "EXCEPTION_REFUND_REQUIRED"
                            ? "bg-[#FF1A1A]"
                            : "bg-amber-500 animate-pulse"
                        }`}
                      />
                      {instructions.status === "SETTLING" ||
                      instructions.status === "DETECTED"
                        ? "SETTLING"
                        : instructions.status === "EXCEPTION_REFUND_REQUIRED"
                          ? "REFUND REQUIRED"
                          : instructions.status === "EXPIRED"
                            ? "EXPIRED"
                            : instructions.status === "FAILED"
                              ? "FAILED"
                              : "AWAITING DEPOSIT"}
                    </span>
                  </div>

                  <div className="flex flex-col items-center justify-center rounded-[22px] border border-neutral-200/70 bg-neutral-50 p-6">
                    <QrCode
                      value={instructions.qrData || instructions.depositAddress}
                      size={156}
                    />
                    <p className="mt-3 text-xs font-medium text-neutral-600 text-center">
                      Deposit address for this payment on{" "}
                      <strong className="text-neutral-900">
                        {instructions.sourceNetwork}
                      </strong>
                    </p>
                  </div>

                  <div className="space-y-3 text-xs">
                    <div>
                      <span className="text-[11px] font-medium text-neutral-500 block mb-1">
                        Amount to Send
                      </span>
                      <div className="flex items-center justify-between gap-2 rounded-[12px] border border-neutral-200 bg-neutral-50 px-3.5 py-2.5">
                        <span className="font-display text-base font-bold text-neutral-950">
                          {instructions.requiredDisplayAmount}{" "}
                          <span className="text-[#FF1A1A]">
                            {instructions.sourceAssetSymbol}
                          </span>
                        </span>
                        <button
                          type="button"
                          onClick={handleCopyAmount}
                          className="shrink-0 font-sans text-xs font-semibold text-[#FF1A1A] hover:underline"
                        >
                          {copiedAmount ? "Copied" : "Copy Amount"}
                        </button>
                      </div>
                    </div>

                    <div>
                      <span className="text-[11px] font-medium text-neutral-500 block mb-1">
                        Deposit Address
                      </span>
                      <div className="flex items-center justify-between gap-2 rounded-[12px] border border-neutral-200 bg-neutral-50 px-3.5 py-2.5 font-mono text-xs">
                        <span className="truncate select-all text-neutral-800">
                          {instructions.depositAddress}
                        </span>
                        <button
                          type="button"
                          onClick={handleCopyDepositAddress}
                          className="shrink-0 font-sans font-semibold text-[#FF1A1A] hover:underline"
                        >
                          {copiedAddress ? "Copied" : "Copy Address"}
                        </button>
                      </div>
                    </div>

                    {instructions.depositMemo && (
                      <div>
                        <span className="text-[11px] font-semibold text-amber-800 block mb-1">
                          Required Memo / Tag
                        </span>
                        <div className="flex items-center justify-between gap-2 rounded-[12px] border border-amber-200 bg-amber-50 px-3.5 py-2.5 font-mono text-xs">
                          <span className="truncate select-all text-neutral-800">
                            {instructions.depositMemo}
                          </span>
                          <button
                            type="button"
                            onClick={handleCopyMemo}
                            className="shrink-0 font-sans font-semibold text-amber-900 hover:underline"
                          >
                            {copiedMemo ? "Copied" : "Copy Memo"}
                          </button>
                        </div>
                      </div>
                    )}

                    <div className="rounded-[14px] border border-neutral-200/80 bg-neutral-50/70 p-3.5 space-y-2 text-xs">
                      <div className="flex justify-between items-center">
                        <span className="text-neutral-500">
                          Deposit Deadline:
                        </span>
                        <span className="font-mono font-bold text-neutral-950">
                          {Math.floor(depositSecondsRemaining / 60)}:
                          {(depositSecondsRemaining % 60)
                            .toString()
                            .padStart(2, "0")}{" "}
                          remaining
                        </span>
                      </div>
                      {(instructions.payerRefundAddress || refundAddress) && (
                        <div className="flex justify-between items-start gap-2 pt-1 border-t border-neutral-200/70">
                          <span className="text-neutral-500 shrink-0">
                            Refund destination:
                          </span>
                          <span
                            className="font-mono text-[11px] text-right truncate text-neutral-800 max-w-[200px]"
                            title={
                              instructions.payerRefundAddress || refundAddress
                            }
                          >
                            {instructions.payerRefundAddress || refundAddress}
                          </span>
                        </div>
                      )}
                    </div>

                    {/* Expiration and Exception Warnings */}
                    <div className="rounded-[14px] border border-red-200/80 bg-red-50/60 p-3.5 text-xs text-neutral-800 space-y-1.5">
                      <p className="font-bold text-[#FF1A1A]">
                        Safety Instructions
                      </p>
                      <p className="text-[11px] leading-relaxed text-neutral-700">
                        Send only{" "}
                        <strong>{instructions.sourceAssetSymbol}</strong> on{" "}
                        <strong>{instructions.sourceNetwork}</strong>. Other
                        assets or networks cannot be recovered.
                      </p>
                      <p className="text-[11px] leading-relaxed text-neutral-700">
                        This deposit address is valid for{" "}
                        <strong>
                          {Math.floor(depositSecondsRemaining / 60)}m{" "}
                          {depositSecondsRemaining % 60}s
                        </strong>
                        . Do not send funds after expiration.
                      </p>
                    </div>

                    {instructions.status === "EXCEPTION_REFUND_REQUIRED" && (
                      <div className="rounded-[14px] border border-red-200 bg-red-50 p-3.5 text-xs text-[#FF1A1A] space-y-1">
                        <strong>Refund Pending:</strong>
                        <p className="text-[11px] leading-relaxed text-red-900">
                          Deposit was received outside the valid quote window or
                          could not be routed. Funds are queued for automatic
                          refund to{" "}
                          {instructions.payerRefundAddress || refundAddress}.
                        </p>
                      </div>
                    )}

                    {instructions.status === "EXPIRED" && (
                      <div className="space-y-2">
                        <div className="rounded-[14px] border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900">
                          <strong>Deposit Window Expired:</strong> Do not send
                          funds to this expired deposit address.
                        </div>
                        <button
                          type="button"
                          onClick={() => {
                            setInstructions(null);
                            setRefreshTrigger((n) => n + 1);
                          }}
                          className="w-full rounded-full bg-[#FF1A1A] py-2.5 text-xs font-semibold text-white hover:bg-[#E01515]"
                        >
                          Quote Expired — Request a New Quote
                        </button>
                      </div>
                    )}

                    {instructions.status === "FAILED" && (
                      <div className="space-y-2">
                        <div className="rounded-[14px] border border-red-200 bg-red-50 p-3 text-xs text-[#FF1A1A]">
                          <strong>Route Execution Failed:</strong> This payment
                          attempt could not be completed.
                        </div>
                        <button
                          type="button"
                          onClick={() => {
                            setInstructions(null);
                            setRefreshTrigger((n) => n + 1);
                          }}
                          className="w-full rounded-full bg-[#FF1A1A] py-2.5 text-xs font-semibold text-white hover:bg-[#E01515]"
                        >
                          Payment route failed — Request a New Quote
                        </button>
                      </div>
                    )}
                  </div>
                </div>
              )}

              {/* Security & Settlement Highlights */}
              <div className="rounded-[28px] border border-neutral-200/90 bg-white p-6 shadow-sm space-y-4">
                <h3 className="font-serif text-lg text-neutral-950">
                  How Flow settles your payment
                </h3>
                <ul className="space-y-3 text-xs text-neutral-600">
                  <li className="flex items-start gap-2.5">
                    <span className="mt-0.5 inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-red-50 text-[11px] font-bold text-[#FF1A1A]">
                      1
                    </span>
                    <span>
                      <strong className="text-neutral-950">
                        Pay with what you hold:
                      </strong>{" "}
                      Select Ethereum, Base, Solana, or NEAR and your preferred
                      token.
                    </span>
                  </li>
                  <li className="flex items-start gap-2.5">
                    <span className="mt-0.5 inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-red-50 text-[11px] font-bold text-[#FF1A1A]">
                      2
                    </span>
                    <span>
                      <strong className="text-neutral-950">
                        Automatic routing:
                      </strong>{" "}
                      Flow locks in a real solver quote and delivers{" "}
                      {request.destinationAssetSymbol} on{" "}
                      {request.destinationNetwork}.
                    </span>
                  </li>
                  <li className="flex items-start gap-2.5">
                    <span className="mt-0.5 inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-red-50 text-[11px] font-bold text-[#FF1A1A]">
                      3
                    </span>
                    <span>
                      <strong className="text-neutral-950">
                        Verified on-chain proof:
                      </strong>{" "}
                      Every transfer is independently verified on-chain before
                      final settlement.
                    </span>
                  </li>
                </ul>
              </div>
            </div>
          </div>
        )}
      </main>
    </div>
  );
}

"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { FlowLogo } from "../../../../components/flow-logo.tsx";
import {
  AssetAvatar,
  ChainBadge,
  IconCheck,
  IconCopy,
  IconRefresh,
  IconSearch,
} from "../../../../components/icons.tsx";
import {
  type CatalogTokenDeployment,
  CURATED_SUPPORTED_DEPLOYMENTS,
  ECOSYSTEM_METADATA,
  type EcosystemFamily,
  validateEcosystemAddress,
} from "../../../../domain/supported-assets-catalog.ts";
import type {
  ActivityFeedResponse,
  SerializedWalletActivityRecord,
} from "../../../../domain/activities.ts";
import { getExplorerUrl } from "../../../../domain/activities.ts";
import type { SerializedPaymentRequest } from "../../../../domain/payment-requests.ts";
import type {
  SerializedAccountPortfolio,
  SerializedWalletBalanceRecord,
} from "../../../../server/portfolio.ts";
import { describe, Feedback, send } from "../../../controls.tsx";
import { AccountNameForm } from "../forms.tsx";

export type WorkspaceTab =
  "dashboard" | "assets" | "send" | "receive" | "activity";

export const MAINNET_SUPPORTED_DEPLOYMENTS: readonly [
  CatalogTokenDeployment,
  ...CatalogTokenDeployment[],
] = CURATED_SUPPORTED_DEPLOYMENTS.filter(
  (d) => d.environment === "mainnet",
) as unknown as readonly [CatalogTokenDeployment, ...CatalogTokenDeployment[]];

export interface WorkspaceAccountSummary {
  readonly id: string;
  readonly name: string;
  readonly kind: "PERSONAL" | "BUSINESS";
  readonly role: "OWNER" | "ADMIN" | "MEMBER";
  readonly walletStatus:
    | "provisioning"
    | "active"
    | "setup_failed"
    | "frozen"
    | "recovery_pending"
    | "setup_pending";
}

function truncateMiddle(value: string, start = 6, end = 4): string {
  if (value.length <= start + end + 3) return value;
  return `${value.slice(0, start)}...${value.slice(-end)}`;
}

function formatTimestamp(iso: string | null): string {
  if (!iso) return "Never";
  try {
    return new Date(iso).toLocaleString("en-US", {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return iso;
  }
}

export function PortfolioView({
  accountId,
  initialPortfolio,
  account,
  allAccounts = [],
  initialView = "dashboard",
}: {
  accountId: string;
  initialPortfolio: SerializedAccountPortfolio;
  account?: WorkspaceAccountSummary;
  allAccounts?: ReadonlyArray<WorkspaceAccountSummary>;
  initialView?: WorkspaceTab;
}) {
  const [portfolio, setPortfolio] =
    useState<SerializedAccountPortfolio>(initialPortfolio);
  const [activeTab, setActiveTab] = useState<WorkspaceTab>(initialView);
  const [refreshing, setRefreshing] = useState(false);
  const [provisioningWallet, setProvisioningWallet] = useState(false);
  const [walletStatusOverride, setWalletStatusOverride] = useState<
    WorkspaceAccountSummary["walletStatus"] | null
  >(null);
  const [message, setMessage] = useState("");
  const [cooldown, setCooldown] = useState(
    initialPortfolio.cooldownRemainingSeconds ?? 0,
  );
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const [workspaceDropdownOpen, setWorkspaceDropdownOpen] = useState(false);

  // Filters for Assets & Activity views
  const [ecosystemFilter, setEcosystemFilter] = useState<
    "all" | EcosystemFamily
  >("all");
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedAssetId, setSelectedAssetId] = useState<string>(
    MAINNET_SUPPORTED_DEPLOYMENTS[0]?.id ?? CURATED_SUPPORTED_DEPLOYMENTS[0].id,
  );
  const [activityCategory, setActivityCategory] = useState<string>("all");

  // Send / Convert state
  const [sendMode, setSendMode] = useState<"send" | "convert">("send");
  const [sourceDeploymentId, setSourceDeploymentId] =
    useState<string>("base-mainnet:USDC");
  const [destDeploymentId, setDestDeploymentId] = useState<string>(
    "solana-mainnet:USDC",
  );
  const [sendAmount, setSendAmount] = useState<string>("");
  const [recipientAddress, setRecipientAddress] = useState<string>("");

  // Receive / Create Payment Link state
  const [receiveDeploymentId, setReceiveDeploymentId] =
    useState<string>("base-mainnet:USDC");
  const [paymentRequests, setPaymentRequests] = useState<
    SerializedPaymentRequest[]
  >([]);
  const [prTitle, setPrTitle] = useState<string>("Project design deposit");
  const [prDescription, setPrDescription] = useState<string>(
    "Project design deposit",
  );
  const [prAmountMode, setPrAmountMode] = useState<"FIXED" | "OPTIONAL">(
    "FIXED",
  );
  const [prAmount, setPrAmount] = useState<string>("249.00");
  const prExpiresInHours = 168;
  const [prCreating, setPrCreating] = useState<boolean>(false);

  // Multi-chain activity feed state
  const [activities, setActivities] = useState<
    SerializedWalletActivityRecord[]
  >([]);
  const [activityTotal, setActivityTotal] = useState<number>(0);
  const [activityLoading, setActivityLoading] = useState<boolean>(false);

  const handleProvisionWallet = useCallback(async () => {
    if (provisioningWallet) return;
    setProvisioningWallet(true);
    setMessage("");
    try {
      const res = await send<{
        outcome: string;
        walletStatus: WorkspaceAccountSummary["walletStatus"];
        portfolio: SerializedAccountPortfolio;
      }>(`/api/accounts/${accountId}/wallet/provision`, {}, "POST");
      setPortfolio(res.portfolio);
      setWalletStatusOverride(res.walletStatus);
      setMessage(
        res.walletStatus === "active"
          ? "OutLayer wallet provisioned and addresses verified across Ethereum/Base, Solana, and NEAR."
          : `Wallet provisioning status: ${res.walletStatus}`,
      );
    } catch (error) {
      setMessage(describe(error));
    } finally {
      setProvisioningWallet(false);
    }
  }, [accountId, provisioningWallet]);

  const handleSyncActivities = useCallback(async () => {
    setActivityLoading(true);
    setMessage("");
    try {
      const res = await send<ActivityFeedResponse>(
        `/api/accounts/${accountId}/activities/sync`,
        {},
        "POST",
      );
      setActivities(res.activities);
      setActivityTotal(res.total);
      setMessage("On-chain activity synchronized.");
    } catch (error) {
      setMessage(describe(error));
    } finally {
      setActivityLoading(false);
    }
  }, [accountId]);

  useEffect(() => {
    let active = true;
    send<ActivityFeedResponse>(
      `/api/accounts/${accountId}/activities?limit=50`,
      {},
      "GET",
    )
      .then((res) => {
        if (active) {
          setActivities(res.activities);
          setActivityTotal(res.total);
        }
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [accountId, activeTab]);

  useEffect(() => {
    let active = true;
    send<{ requests: SerializedPaymentRequest[] }>(
      `/api/accounts/${accountId}/payment-requests`,
      {},
      "GET",
    )
      .then((res) => {
        if (active) {
          setPaymentRequests(res.requests);
        }
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [accountId, activeTab]);

  useEffect(() => {
    if (cooldown <= 0) return;
    const timer = setInterval(() => {
      setCooldown((prev) => (prev > 1 ? prev - 1 : 0));
    }, 1000);
    return () => clearInterval(timer);
  }, [cooldown]);

  const handleRefresh = useCallback(async () => {
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
  }, [accountId, cooldown, refreshing]);

  const copyAddress = useCallback(async (key: string, address: string) => {
    try {
      await navigator.clipboard.writeText(address);
      setCopiedKey(key);
      setTimeout(
        () => setCopiedKey((prev) => (prev === key ? null : prev)),
        2000,
      );
    } catch {
      setMessage("Failed to copy address to clipboard.");
    }
  }, []);

  const wallet = portfolio.wallet;
  const balances = portfolio.balances;

  const mergedCatalogRows = useMemo(() => {
    return CURATED_SUPPORTED_DEPLOYMENTS.map((item) => {
      const matchingBalances = balances.filter(
        (b: SerializedWalletBalanceRecord) =>
          b.networkAsset.network.toLowerCase() ===
            item.networkKey.toLowerCase() &&
          b.networkAsset.asset.symbol.toUpperCase() ===
            item.symbol.toUpperCase(),
      );
      const primaryMatch = matchingBalances[0] ?? null;
      return {
        catalog: item,
        observedBalance: primaryMatch,
      };
    });
  }, [balances]);

  const filteredCatalogRows = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return mergedCatalogRows.filter(({ catalog }) => {
      if (ecosystemFilter !== "all" && catalog.ecosystem !== ecosystemFilter) {
        return false;
      }
      if (!q) return true;
      return (
        catalog.symbol.toLowerCase().includes(q) ||
        catalog.name.toLowerCase().includes(q) ||
        catalog.networkName.toLowerCase().includes(q) ||
        catalog.contractIdentifier.toLowerCase().includes(q)
      );
    });
  }, [mergedCatalogRows, ecosystemFilter, searchQuery]);

  const selectedCatalogItem: CatalogTokenDeployment = useMemo(() => {
    return (
      CURATED_SUPPORTED_DEPLOYMENTS.find((d) => d.id === selectedAssetId) ??
      CURATED_SUPPORTED_DEPLOYMENTS[0]
    );
  }, [selectedAssetId]);

  const sourceDeployment: CatalogTokenDeployment = useMemo(
    () =>
      CURATED_SUPPORTED_DEPLOYMENTS.find((d) => d.id === sourceDeploymentId) ??
      CURATED_SUPPORTED_DEPLOYMENTS[0],
    [sourceDeploymentId],
  );

  const destDeployment: CatalogTokenDeployment = useMemo(
    () =>
      CURATED_SUPPORTED_DEPLOYMENTS.find((d) => d.id === destDeploymentId) ??
      CURATED_SUPPORTED_DEPLOYMENTS[0],
    [destDeploymentId],
  );

  const receiveDeployment: CatalogTokenDeployment = useMemo(
    () =>
      CURATED_SUPPORTED_DEPLOYMENTS.find((d) => d.id === receiveDeploymentId) ??
      CURATED_SUPPORTED_DEPLOYMENTS[0],
    [receiveDeploymentId],
  );

  const handleCreatePaymentRequest = useCallback(async () => {
    if (!prTitle.trim()) {
      setMessage("Please enter a title for the payment request.");
      return;
    }
    setPrCreating(true);
    setMessage("");
    try {
      const created = await send<SerializedPaymentRequest>(
        `/api/accounts/${accountId}/payment-requests`,
        {
          title: prTitle.trim(),
          description: prDescription.trim() || null,
          destinationNetwork: receiveDeployment.networkKey,
          destinationAssetId: receiveDeployment.id,
          amountMode: prAmountMode,
          requestedAmount: prAmountMode === "FIXED" ? prAmount : null,
          expiresInHours: prExpiresInHours > 0 ? prExpiresInHours : null,
        },
        "POST",
      );
      setPaymentRequests((prev) => [created, ...prev]);
      setMessage(`Payment link generated: ${created.shareUrl}`);
    } catch (error) {
      setMessage(describe(error));
    } finally {
      setPrCreating(false);
    }
  }, [
    accountId,
    prTitle,
    prDescription,
    receiveDeployment,
    prAmountMode,
    prAmount,
    prExpiresInHours,
  ]);

  const handleDisablePaymentRequest = useCallback(
    async (requestId: string) => {
      try {
        const updated = await send<SerializedPaymentRequest>(
          `/api/accounts/${accountId}/payment-requests/${requestId}`,
          { status: "DISABLED" },
          "PATCH",
        );
        setPaymentRequests((prev) =>
          prev.map((r) => (r.id === updated.id ? updated : r)),
        );
        setMessage("Payment request disabled.");
      } catch (error) {
        setMessage(describe(error));
      }
    },
    [accountId],
  );

  const sourceObservedBalance = useMemo(() => {
    return (
      balances.find(
        (b: SerializedWalletBalanceRecord) =>
          b.networkAsset.network.toLowerCase() ===
            sourceDeployment.networkKey.toLowerCase() &&
          b.networkAsset.asset.symbol.toUpperCase() ===
            sourceDeployment.symbol.toUpperCase(),
      ) ?? null
    );
  }, [balances, sourceDeployment]);

  const addressValidation = useMemo(() => {
    if (sendMode === "convert") {
      return { valid: true };
    }
    return validateEcosystemAddress(destDeployment.ecosystem, recipientAddress);
  }, [sendMode, destDeployment.ecosystem, recipientAddress]);

  const currentAccount: WorkspaceAccountSummary = account ?? {
    id: accountId,
    name: "Workspace",
    kind: "PERSONAL",
    role: "OWNER",
    walletStatus: "setup_pending",
  };

  const isBusiness = currentAccount.kind === "BUSINESS";
  const canManageTeam = isBusiness && currentAccount.role !== "MEMBER";
  const personalAccounts = allAccounts.filter((a) => a.kind === "PERSONAL");
  const businessAccounts = allAccounts.filter((a) => a.kind === "BUSINESS");

  const effectiveWalletStatus =
    walletStatusOverride ?? (wallet ? "active" : currentAccount.walletStatus);

  const walletStatusLabel =
    effectiveWalletStatus === "active"
      ? "Wallet provisioned (execution disabled)"
      : effectiveWalletStatus === "provisioning"
        ? "Wallet provisioning in progress"
        : effectiveWalletStatus === "setup_failed"
          ? "Wallet setup failed"
          : "Wallet setup pending";

  const ethAddr =
    wallet?.addresses.find(
      (a) => a.network === "ethereum" || a.network.includes("ethereum"),
    )?.address ??
    wallet?.addresses.find(
      (a) => a.network === "base" || a.network.includes("base"),
    )?.address ??
    "Not provisioned";
  const baseAddr =
    wallet?.addresses.find(
      (a) => a.network === "base" || a.network.includes("base"),
    )?.address ??
    wallet?.addresses.find(
      (a) => a.network === "ethereum" || a.network.includes("ethereum"),
    )?.address ??
    "Not provisioned";
  const evmAddr = baseAddr !== "Not provisioned" ? baseAddr : ethAddr;
  const solAddr =
    wallet?.addresses.find((a) => a.network.includes("solana"))?.address ??
    "Not provisioned";
  const nearAddr =
    wallet?.addresses.find((a) => a.network.includes("near"))?.address ??
    "Not provisioned";

  const usdcBalanceTotal = useMemo(() => {
    return balances
      .filter((b) => b.networkAsset.asset.symbol.toUpperCase() === "USDC")
      .reduce((acc, b) => acc + (Number(b.displayBalance) || 0), 0);
  }, [balances]);

  const totalStableFormatted = `$${usdcBalanceTotal.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;

  const ethUsdcBalance = useMemo(() => {
    const match = balances.find(
      (b) =>
        b.networkAsset.network.includes("ethereum") &&
        b.networkAsset.asset.symbol.toUpperCase() === "USDC",
    );
    return match?.displayBalance ?? "0.00";
  }, [balances]);

  const baseUsdcBalance = useMemo(() => {
    const match = balances.find(
      (b) =>
        b.networkAsset.network.includes("base") &&
        b.networkAsset.asset.symbol.toUpperCase() === "USDC",
    );
    return match?.displayBalance ?? "0.00";
  }, [balances]);

  const solNativeBalance = useMemo(() => {
    const match = balances.find(
      (b) =>
        b.networkAsset.network.includes("solana") &&
        b.networkAsset.asset.symbol.toUpperCase() === "SOL",
    );
    return match?.displayBalance ?? "0";
  }, [balances]);

  const nearNativeBalance = useMemo(() => {
    const match = balances.find(
      (b) =>
        b.networkAsset.network.includes("near") &&
        b.networkAsset.asset.symbol.toUpperCase() === "NEAR",
    );
    return match?.displayBalance ?? "0";
  }, [balances]);

  const settledRequests = useMemo(
    () => paymentRequests.filter((r) => r.status === "COMPLETED"),
    [paymentRequests],
  );
  const openRequests = useMemo(
    () => paymentRequests.filter((r) => r.status === "ACTIVE"),
    [paymentRequests],
  );
  const settledTotalUsd = useMemo(() => {
    const sum = settledRequests.reduce(
      (acc, r) => acc + (Number(r.displayAmount) || 0),
      0,
    );
    return `$${sum.toLocaleString("en-US", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    })}`;
  }, [settledRequests]);

  const latestShareUrl =
    paymentRequests[0]?.shareUrl ??
    "Create a payment request to generate a shareable link";

  return (
    <div className="min-h-screen bg-[#FAF8F5] text-neutral-950 flex flex-col lg:flex-row">
      {/* =====================================================================
          LEFT DARK SIDEBAR (Desktop — Matches 08_26_13 PM-5.png)
         ===================================================================== */}
      <aside
        aria-label="Account workspace navigation"
        className="hidden lg:flex lg:w-[250px] lg:shrink-0 lg:flex-col lg:justify-between bg-[#0B0B0B] text-white p-5 lg:min-h-screen lg:sticky lg:top-0"
      >
        <div>
          {/* Brand Logo */}
          <div className="px-2 pt-1 pb-7">
            <Link
              href={`/accounts/${currentAccount.id}`}
              prefetch={false}
              aria-label="FLOW Dashboard"
            >
              <FlowLogo size={26} variant="inverse" />
            </Link>
          </div>

          {/* Primary Nav Links */}
          <nav className="space-y-1">
            <button
              type="button"
              onClick={() => setActiveTab("dashboard")}
              className={`flex w-full items-center gap-3 rounded-full px-4 py-2.5 text-[13px] font-medium transition-all ${
                activeTab === "dashboard"
                  ? "bg-gradient-to-r from-[#450A0A] via-[#7F1D1D] to-[#991B1B] text-white border border-[#EF4444]/40 shadow-sm"
                  : "text-neutral-400 hover:bg-white/5 hover:text-white"
              }`}
            >
              <svg
                width="16"
                height="16"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
              >
                <path d="M3 9.5L12 3l9 6.5V20a1 1 0 0 1-1 1h-5v-6h-6v6H4a1 1 0 0 1-1-1V9.5z" />
              </svg>
              <span>Home</span>
            </button>

            <button
              type="button"
              onClick={() => setActiveTab("send")}
              className={`flex w-full items-center gap-3 rounded-full px-4 py-2.5 text-[13px] font-medium transition-all ${
                activeTab === "send"
                  ? "bg-gradient-to-r from-[#450A0A] via-[#7F1D1D] to-[#991B1B] text-white border border-[#EF4444]/40 shadow-sm"
                  : "text-neutral-400 hover:bg-white/5 hover:text-white"
              }`}
            >
              <svg
                width="16"
                height="16"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
              >
                <path d="M7 17L17 7M17 7H8M17 7V16" />
              </svg>
              <span>Send</span>
            </button>

            <button
              type="button"
              onClick={() => setActiveTab("receive")}
              className={`flex w-full items-center gap-3 rounded-full px-4 py-2.5 text-[13px] font-medium transition-all ${
                activeTab === "receive"
                  ? "bg-gradient-to-r from-[#450A0A] via-[#7F1D1D] to-[#991B1B] text-white border border-[#EF4444]/40 shadow-sm"
                  : "text-neutral-400 hover:bg-white/5 hover:text-white"
              }`}
            >
              <svg
                width="16"
                height="16"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
              >
                <path d="M17 7L7 17M7 17H16M7 17V8" />
              </svg>
              <span>Receive</span>
            </button>

            <button
              type="button"
              onClick={() => setActiveTab("receive")}
              className="flex w-full items-center gap-3 rounded-full px-4 py-2.5 text-[13px] font-medium text-neutral-400 hover:bg-white/5 hover:text-white transition-all"
            >
              <svg
                width="16"
                height="16"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
              >
                <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
                <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
              </svg>
              <span>Request</span>
            </button>

            <button
              type="button"
              onClick={() => setActiveTab("assets")}
              className={`flex w-full items-center gap-3 rounded-full px-4 py-2.5 text-[13px] font-medium transition-all ${
                activeTab === "assets"
                  ? "bg-gradient-to-r from-[#450A0A] via-[#7F1D1D] to-[#991B1B] text-white border border-[#EF4444]/40 shadow-sm"
                  : "text-neutral-400 hover:bg-white/5 hover:text-white"
              }`}
            >
              <svg
                width="16"
                height="16"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
              >
                <rect x="2" y="5" width="20" height="14" rx="2" />
                <path d="M16 12h.01" />
              </svg>
              <span>Wallets &amp; Assets</span>
            </button>

            <button
              type="button"
              onClick={() => setActiveTab("activity")}
              className={`flex w-full items-center gap-3 rounded-full px-4 py-2.5 text-[13px] font-medium transition-all ${
                activeTab === "activity"
                  ? "bg-gradient-to-r from-[#450A0A] via-[#7F1D1D] to-[#991B1B] text-white border border-[#EF4444]/40 shadow-sm"
                  : "text-neutral-400 hover:bg-white/5 hover:text-white"
              }`}
            >
              <svg
                width="16"
                height="16"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
              >
                <circle cx="12" cy="12" r="9" />
                <path d="M12 7v5l3 3" />
              </svg>
              <span>Activity</span>
            </button>

            {canManageTeam ? (
              <Link
                prefetch={false}
                href={`/accounts/${currentAccount.id}/team`}
                className="flex w-full items-center gap-3 rounded-full px-4 py-2.5 text-[13px] font-medium text-neutral-400 hover:bg-white/5 hover:text-white transition-all"
              >
                <svg
                  width="16"
                  height="16"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                >
                  <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
                  <circle cx="9" cy="7" r="4" />
                  <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
                  <path d="M16 3.13a4 4 0 0 1 0 7.75" />
                </svg>
                <span>Contacts &amp; Team</span>
              </Link>
            ) : (
              <Link
                prefetch={false}
                href="/accounts"
                className="flex w-full items-center gap-3 rounded-full px-4 py-2.5 text-[13px] font-medium text-neutral-400 hover:bg-white/5 hover:text-white transition-all"
              >
                <svg
                  width="16"
                  height="16"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                >
                  <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
                  <circle cx="9" cy="7" r="4" />
                </svg>
                <span>Contacts</span>
              </Link>
            )}

            <div className="!my-4 border-t border-white/10" />

            <Link
              prefetch={false}
              href="/security"
              className="flex w-full items-center gap-3 rounded-full px-4 py-2.5 text-[13px] font-medium text-neutral-400 hover:bg-white/5 hover:text-white transition-all"
            >
              <svg
                width="16"
                height="16"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
              >
                <circle cx="12" cy="12" r="3" />
                <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
              </svg>
              <span>Settings</span>
            </Link>
          </nav>
        </div>

        {/* Bottom Sidebar Promo + User Card */}
        <div className="space-y-4 pt-6">
          <div className="relative overflow-hidden rounded-[18px] border border-white/10 bg-[#141414] p-4">
            <div className="pointer-events-none absolute -bottom-6 -right-6 h-24 w-24 rounded-full bg-[#FF1A1A]/25 blur-xl" />
            <p className="text-[13px] font-semibold text-white leading-snug">
              Get the Flow app on mobile.
            </p>
            <p className="mt-1 text-[11px] text-neutral-400 leading-relaxed">
              Manage payments, wallets, and activity anywhere.
            </p>
            <button
              type="button"
              onClick={() => setActiveTab("receive")}
              className="mt-3 inline-flex items-center gap-1.5 rounded-full border border-white/15 bg-white/10 px-3 py-1 text-[11px] font-medium text-white hover:bg-white/15"
            >
              Get the app <span>→</span>
            </button>
          </div>

          <div className="flex items-center justify-between border-t border-white/10 pt-4">
            <div className="flex items-center gap-2.5 min-w-0">
              <img
                src="/assets/amara-avatar.png"
                alt={currentAccount.name}
                className="h-9 w-9 rounded-full object-cover border border-white/20 shrink-0"
              />
              <div className="min-w-0">
                <p className="truncate text-xs font-semibold text-white">
                  {currentAccount.name}
                </p>
                <p className="truncate text-[11px] text-neutral-400">
                  {isBusiness ? "Business workspace" : "Personal workspace"} ·{" "}
                  {currentAccount.role.toLowerCase()}
                </p>
              </div>
            </div>
            <div className="flex items-center gap-1.5 shrink-0">
              <Link
                prefetch={false}
                href="/security"
                aria-label="Workspace settings"
                title="Security & Settings"
                className="text-neutral-400 hover:text-white text-sm px-1 transition-colors"
              >
                •••
              </Link>
              <button
                type="button"
                onClick={async () => {
                  try {
                    await fetch("/api/auth/sign-out", { method: "POST" });
                  } finally {
                    window.location.replace("/");
                  }
                }}
                title="Sign out"
                aria-label="Sign out"
                className="text-neutral-400 hover:text-rose-400 p-1 transition-colors"
              >
                <svg
                  width="15"
                  height="15"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
                  <polyline points="16 17 21 12 16 7" />
                  <line x1="21" y1="12" x2="9" y2="12" />
                </svg>
              </button>
            </div>
          </div>
        </div>
      </aside>

      {/* =====================================================================
          MAIN WORKSPACE AREA
         ===================================================================== */}
      <div className="flex-1 min-w-0 pb-36 lg:pb-16 relative overflow-hidden">
        {/* Top-Right Decorative Red Wave (Shown on Assets / Activity / Settings) */}
        {(activeTab === "assets" || activeTab === "activity") && (
          <div
            aria-hidden="true"
            className="pointer-events-none absolute -top-10 right-0 w-[340px] sm:w-[460px] h-[180px] z-0 overflow-hidden"
          >
            <svg viewBox="0 0 500 200" fill="none" className="w-full h-full">
              <path
                d="M120 -20 C240 80, 360 20, 520 150 L520 -20 Z"
                fill="url(#topWaveGrad)"
              />
              <defs>
                <linearGradient id="topWaveGrad" x1="0" y1="0" x2="1" y2="1">
                  <stop offset="0%" stopColor="#FF2E2E" />
                  <stop offset="65%" stopColor="#CC0000" />
                  <stop offset="100%" stopColor="#1A0000" />
                </linearGradient>
              </defs>
            </svg>
          </div>
        )}

        <div className="relative z-10 mx-auto max-w-[1180px] px-4 sm:px-8 pt-5 sm:pt-7">
          {/* Top Bar (Mobile Logo + Desktop/Mobile Workspace Switcher, Refresh, Bell, Avatar) */}
          <div className="flex items-center justify-between gap-3 mb-6">
            <div className="flex items-center gap-3">
              <div className="lg:hidden">
                <Link href="/" prefetch={false} aria-label="FLOW Home">
                  <FlowLogo size={24} />
                </Link>
              </div>
              <div className="hidden sm:flex items-center gap-2">
                <span className="inline-flex items-center gap-1.5 rounded-full border border-neutral-200 bg-white px-3 py-1 text-[11px] font-medium text-neutral-700 shadow-2xs">
                  <span
                    className={`h-2 w-2 rounded-full ${
                      effectiveWalletStatus === "active"
                        ? "bg-emerald-500"
                        : "bg-amber-500"
                    }`}
                  />
                  {walletStatusLabel}
                </span>
                {effectiveWalletStatus !== "active" && (
                  <button
                    type="button"
                    onClick={handleProvisionWallet}
                    disabled={provisioningWallet}
                    className="inline-flex items-center gap-1 rounded-full bg-[#FF1A1A] px-3 py-1 text-[11px] font-semibold text-white shadow-2xs hover:bg-[#E01515] disabled:opacity-50"
                  >
                    {provisioningWallet
                      ? "Provisioning..."
                      : "Complete Wallet Setup"}
                  </button>
                )}
                {portfolio.lastSyncedAt && (
                  <span className="text-[11px] text-neutral-500">
                    Synced {formatTimestamp(portfolio.lastSyncedAt)}
                  </span>
                )}
              </div>
            </div>

            <div className="flex items-center gap-2.5">
              {/* Workspace Switcher Dropdown (Matches 08_26_23 PM-10.png) */}
              <div className="relative">
                <button
                  type="button"
                  onClick={() => setWorkspaceDropdownOpen((prev) => !prev)}
                  className="inline-flex items-center gap-2.5 rounded-full border border-neutral-200 bg-white px-3.5 py-1.5 text-xs font-semibold text-neutral-900 shadow-2xs hover:border-neutral-300"
                >
                  <span className="inline-flex h-5 w-5 items-center justify-center rounded-full bg-neutral-950 text-[10px] font-bold text-white">
                    {currentAccount.name.slice(0, 1).toUpperCase()}
                  </span>
                  <span className="max-w-[130px] truncate">
                    {currentAccount.name}
                  </span>
                  <span className="rounded bg-neutral-100 px-1.5 py-0.5 text-[10px] font-medium text-neutral-600 uppercase">
                    {isBusiness ? "Business account" : "Personal account"}
                  </span>
                  <span className="text-neutral-400 text-[10px]">▾</span>
                </button>

                {workspaceDropdownOpen && (
                  <div className="absolute right-0 mt-2 w-72 rounded-[20px] border border-neutral-200 bg-white p-3 shadow-xl z-50">
                    <p className="px-2.5 py-1 text-[10px] font-bold uppercase tracking-wider text-neutral-400">
                      Switch Workspace
                    </p>
                    <div className="mt-1 space-y-1">
                      {personalAccounts.map((acc) => (
                        <Link
                          key={acc.id}
                          prefetch={false}
                          href={`/accounts/${acc.id}`}
                          onClick={() => setWorkspaceDropdownOpen(false)}
                          className={`flex items-center justify-between rounded-[12px] px-3 py-2 text-xs transition-colors ${
                            acc.id === accountId
                              ? "bg-neutral-100 font-semibold text-neutral-950"
                              : "text-neutral-700 hover:bg-neutral-50"
                          }`}
                        >
                          <div>
                            <p className="font-semibold">{acc.name}</p>
                            <p className="text-[10px] text-neutral-500">
                              Personal · {acc.role.toLowerCase()}
                            </p>
                          </div>
                          {acc.id === accountId && (
                            <span className="text-[#FF1A1A] font-bold">✓</span>
                          )}
                        </Link>
                      ))}
                      {businessAccounts.map((acc) => (
                        <Link
                          key={acc.id}
                          prefetch={false}
                          href={`/accounts/${acc.id}`}
                          onClick={() => setWorkspaceDropdownOpen(false)}
                          className={`flex items-center justify-between rounded-[12px] px-3 py-2 text-xs transition-colors ${
                            acc.id === accountId
                              ? "bg-neutral-100 font-semibold text-neutral-950"
                              : "text-neutral-700 hover:bg-neutral-50"
                          }`}
                        >
                          <div>
                            <p className="font-semibold">{acc.name}</p>
                            <p className="text-[10px] text-neutral-500">
                              Business · {acc.role.toLowerCase()}
                            </p>
                          </div>
                          {acc.id === accountId && (
                            <span className="text-[#FF1A1A] font-bold">✓</span>
                          )}
                        </Link>
                      ))}
                    </div>
                    <div className="mt-2 border-t border-neutral-100 pt-2">
                      <Link
                        prefetch={false}
                        href="/accounts"
                        className="flex w-full items-center justify-between rounded-[10px] px-3 py-2 text-xs font-semibold text-neutral-800 hover:bg-neutral-50"
                      >
                        <span>+ Create or manage workspaces</span>
                        <span>→</span>
                      </Link>
                    </div>
                  </div>
                )}
              </div>

              <button
                type="button"
                onClick={handleRefresh}
                disabled={refreshing || cooldown > 0}
                className="inline-flex items-center gap-1.5 rounded-full border border-neutral-200 bg-white px-3.5 py-1.5 text-xs font-semibold text-neutral-800 shadow-2xs hover:bg-neutral-50 disabled:opacity-50"
              >
                <IconRefresh
                  size={13}
                  className={refreshing ? "animate-spin" : ""}
                />
                <span>
                  {refreshing
                    ? "Refreshing..."
                    : cooldown > 0
                      ? `Wait ${cooldown}s`
                      : "Refresh Balances"}
                </span>
              </button>

              {canManageTeam && (
                <Link
                  prefetch={false}
                  href={`/accounts/${currentAccount.id}/team`}
                  className="inline-flex items-center gap-1.5 rounded-full bg-neutral-950 px-3.5 py-1.5 text-xs font-semibold text-white hover:bg-neutral-800"
                >
                  Manage team
                </Link>
              )}

              <Link prefetch={false} href="/security" className="shrink-0">
                <img
                  src="/assets/amara-avatar.png"
                  alt="Profile"
                  className="h-9 w-9 rounded-full object-cover border border-neutral-200"
                />
              </Link>
            </div>
          </div>

          {/* Mobile Status Badge (For Playwright & Mobile Visibility) */}
          <div className="sm:hidden mb-4 flex flex-wrap items-center gap-2">
            <span className="inline-flex items-center gap-1.5 rounded-full border border-neutral-200 bg-white px-3 py-1 text-[11px] font-medium text-neutral-700">
              <span
                className={`h-2 w-2 rounded-full ${
                  effectiveWalletStatus === "active"
                    ? "bg-emerald-500"
                    : "bg-amber-500"
                }`}
              />
              {walletStatusLabel}
            </span>
            {effectiveWalletStatus !== "active" && (
              <button
                type="button"
                onClick={handleProvisionWallet}
                disabled={provisioningWallet}
                className="inline-flex items-center gap-1 rounded-full bg-[#FF1A1A] px-3 py-1 text-[11px] font-semibold text-white"
              >
                {provisioningWallet
                  ? "Provisioning..."
                  : "Complete Wallet Setup"}
              </button>
            )}
          </div>

          {message && (
            <div className="mb-5">
              <Feedback text={message} />
            </div>
          )}

          {/* ================================================================
              TAB 1: DASHBOARD ("Welcome back." — Matches 08_26_13 PM-5.png & 08_56_23 PM-4.png)
             ================================================================ */}
          {activeTab === "dashboard" && (
            <div className="space-y-7">
              {/* Header */}
              <div className="flex flex-wrap items-end justify-between gap-4">
                <div>
                  <p className="text-[11px] font-bold uppercase tracking-[0.14em] text-[#FF1A1A]">
                    {isBusiness ? "BUSINESS WORKSPACE" : "YOUR FLOW"}
                  </p>
                  <h1 className="mt-1 font-serif text-3xl sm:text-[42px] font-normal tracking-[-0.02em] text-neutral-950 leading-[1.08]">
                    Welcome back.
                  </h1>
                  <p className="mt-1.5 text-sm text-neutral-600">
                    Move money, get paid, and manage your assets — all in one
                    place.{" "}
                    <span className="font-semibold text-neutral-900">
                      ({currentAccount.name} ·{" "}
                      {currentAccount.role.toLowerCase()})
                    </span>
                  </p>
                </div>
              </div>

              {/* Business Metrics Strip (Shown when workspace is a Business Account — Matches Storyboard #19) */}
              {isBusiness && (
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-3.5">
                  <div className="rounded-[20px] border border-neutral-200/80 bg-white p-4 shadow-2xs">
                    <p className="text-[11px] font-medium text-neutral-500">
                      Total received
                    </p>
                    <p className="mt-1 font-display text-2xl font-bold text-neutral-950">
                      {settledTotalUsd}
                    </p>
                    <p className="mt-1 text-[11px] font-semibold text-emerald-600">
                      {settledRequests.length} settled requests
                    </p>
                  </div>
                  <div className="rounded-[20px] border border-neutral-200/80 bg-white p-4 shadow-2xs">
                    <p className="text-[11px] font-medium text-neutral-500">
                      On-chain transfers
                    </p>
                    <p className="mt-1 font-display text-2xl font-bold text-neutral-950">
                      {activities.length}
                    </p>
                    <p className="mt-1 text-[11px] text-neutral-500">
                      Across Base, Solana &amp; NEAR
                    </p>
                  </div>
                  <div className="rounded-[20px] border border-neutral-200/80 bg-white p-4 shadow-2xs">
                    <p className="text-[11px] font-medium text-neutral-500">
                      Payment links
                    </p>
                    <p className="mt-1 font-display text-2xl font-bold text-neutral-950">
                      {paymentRequests.length}
                    </p>
                    <p className="mt-1 text-[11px] text-neutral-500">
                      {settledRequests.length} settled · {openRequests.length}{" "}
                      open
                    </p>
                  </div>
                  <div className="rounded-[20px] border border-neutral-200/80 bg-white p-4 shadow-2xs flex flex-col justify-between">
                    <div>
                      <p className="text-[11px] font-medium text-neutral-500">
                        Workspace role
                      </p>
                      <p className="mt-1 font-display text-2xl font-bold text-neutral-950">
                        {currentAccount.role}
                      </p>
                    </div>
                    {canManageTeam && (
                      <Link
                        prefetch={false}
                        href={`/accounts/${currentAccount.id}/team`}
                        className="mt-2 inline-flex items-center gap-1 text-xs font-semibold text-[#FF1A1A] hover:underline"
                      >
                        Manage team →
                      </Link>
                    )}
                  </div>
                </div>
              )}

              {/* Top Row: Dark Total Balance Card + 3 Quick Action Cards */}
              <div className="grid grid-cols-1 lg:grid-cols-12 gap-5 items-stretch">
                {/* Dark Balance Card */}
                <div className="lg:col-span-6 relative overflow-hidden rounded-[26px] bg-[#0B0B0B] p-6 sm:p-7 text-white shadow-lg flex flex-col justify-between">
                  <div
                    aria-hidden="true"
                    className="pointer-events-none absolute -bottom-16 -right-12 h-52 w-52 rounded-full bg-[#FF1A1A]/30 blur-2xl"
                  />
                  <div className="relative z-10">
                    <div className="flex items-center justify-between">
                      <span className="text-xs font-medium text-neutral-400">
                        Observed USDC balance
                      </span>
                      <span className="inline-flex items-center gap-1.5 rounded-full bg-white/10 px-2.5 py-0.5 text-[11px] font-medium text-neutral-200">
                        USDC · RPC
                      </span>
                    </div>

                    <div className="mt-2 flex flex-wrap items-baseline gap-3">
                      <span className="font-display text-4xl sm:text-[44px] font-bold tracking-tight text-white">
                        {totalStableFormatted}
                      </span>
                      <span className="inline-flex items-center rounded-full bg-emerald-500/20 px-2.5 py-0.5 text-xs font-semibold text-emerald-400">
                        {effectiveWalletStatus === "active"
                          ? "OutLayer Active"
                          : "Setup Pending"}
                      </span>
                      <span className="text-xs text-neutral-400">
                        {balances.length > 0
                          ? `${balances.length} RPC balances synced`
                          : "Read-only RPC"}
                      </span>
                    </div>
                  </div>

                  {/* Mobile Quick Action Row Inside Card (Matches 08_56_23 PM-4.png) */}
                  <div className="mt-5 grid grid-cols-3 gap-2.5 lg:hidden relative z-10">
                    <button
                      type="button"
                      onClick={() => setActiveTab("send")}
                      className="flex items-center justify-center gap-1.5 rounded-full bg-[#FF1A1A] py-2.5 text-xs font-semibold text-white shadow-sm"
                    >
                      <span>↗</span> Send
                    </button>
                    <button
                      type="button"
                      onClick={() => setActiveTab("receive")}
                      className="flex items-center justify-center gap-1.5 rounded-full border border-white/15 bg-white/10 py-2.5 text-xs font-semibold text-white"
                    >
                      <span>↙</span> Receive
                    </button>
                    <button
                      type="button"
                      onClick={() => setActiveTab("receive")}
                      className="flex items-center justify-center gap-1.5 rounded-full border border-white/15 bg-white/10 py-2.5 text-xs font-semibold text-white"
                    >
                      <span>🔗</span> Request
                    </button>
                  </div>

                  {/* Bottom 4-Column Asset Breakdown Bar */}
                  <div className="relative z-10 mt-6 grid grid-cols-2 sm:grid-cols-4 gap-3 rounded-[16px] border border-white/10 bg-white/[0.04] p-3.5">
                    <div>
                      <div className="flex items-center gap-1.5 text-[11px] text-neutral-400">
                        <span className="h-2 w-2 rounded-full bg-indigo-400" />
                        <span>Ethereum</span>
                      </div>
                      <p className="mt-1 font-display text-sm font-bold text-white">
                        {ethUsdcBalance} USDC
                      </p>
                    </div>
                    <div className="border-l border-white/10 pl-3">
                      <div className="flex items-center gap-1.5 text-[11px] text-neutral-400">
                        <span className="h-2 w-2 rounded-full bg-blue-500" />
                        <span>Base</span>
                      </div>
                      <p className="mt-1 font-display text-sm font-bold text-white">
                        {baseUsdcBalance} USDC
                      </p>
                    </div>
                    <div className="border-l border-white/10 pl-3">
                      <div className="flex items-center gap-1.5 text-[11px] text-neutral-400">
                        <span className="h-2 w-2 rounded-full bg-purple-500" />
                        <span>SOL</span>
                      </div>
                      <p className="mt-1 font-display text-sm font-bold text-white">
                        {solNativeBalance} SOL
                      </p>
                    </div>
                    <div className="border-l border-white/10 pl-3">
                      <div className="flex items-center gap-1.5 text-[11px] text-neutral-400">
                        <span className="h-2 w-2 rounded-full bg-emerald-400" />
                        <span>NEAR</span>
                      </div>
                      <p className="mt-1 font-display text-sm font-bold text-white">
                        {nearNativeBalance} NEAR
                      </p>
                    </div>
                  </div>
                </div>

                {/* Desktop 3 Action Cards (Send, Receive, Request) */}
                <div className="hidden lg:grid lg:col-span-6 grid-cols-3 gap-4">
                  <button
                    type="button"
                    onClick={() => setActiveTab("send")}
                    className="group rounded-[24px] border border-neutral-200/80 bg-white p-5 text-left shadow-2xs hover:border-neutral-300 transition-all flex flex-col justify-between"
                  >
                    <div className="flex items-center justify-between">
                      <span className="inline-flex h-11 w-11 items-center justify-center rounded-[14px] bg-[#FF1A1A] text-white font-bold text-lg shadow-xs">
                        ↗
                      </span>
                      <span className="text-neutral-400 group-hover:translate-x-0.5 transition-transform">
                        →
                      </span>
                    </div>
                    <div className="mt-6">
                      <p className="font-display text-base font-bold text-neutral-950">
                        Send
                      </p>
                      <p className="mt-1 text-xs text-neutral-500 leading-relaxed">
                        Pay anyone across supported networks.
                      </p>
                    </div>
                  </button>

                  <button
                    type="button"
                    onClick={() => setActiveTab("receive")}
                    className="group rounded-[24px] border border-neutral-200/80 bg-white p-5 text-left shadow-2xs hover:border-neutral-300 transition-all flex flex-col justify-between"
                  >
                    <div className="flex items-center justify-between">
                      <span className="inline-flex h-11 w-11 items-center justify-center rounded-[14px] bg-neutral-950 text-white font-bold text-lg">
                        ↙
                      </span>
                      <span className="text-neutral-400 group-hover:translate-x-0.5 transition-transform">
                        →
                      </span>
                    </div>
                    <div className="mt-6">
                      <p className="font-display text-base font-bold text-neutral-950">
                        Receive
                      </p>
                      <p className="mt-1 text-xs text-neutral-500 leading-relaxed">
                        Share your address or QR code.
                      </p>
                    </div>
                  </button>

                  <button
                    type="button"
                    onClick={() => setActiveTab("receive")}
                    className="group rounded-[24px] border border-neutral-200/80 bg-white p-5 text-left shadow-2xs hover:border-neutral-300 transition-all flex flex-col justify-between"
                  >
                    <div className="flex items-center justify-between">
                      <span className="inline-flex h-11 w-11 items-center justify-center rounded-[14px] bg-neutral-950 text-white font-bold text-base">
                        🔗
                      </span>
                      <span className="text-neutral-400 group-hover:translate-x-0.5 transition-transform">
                        →
                      </span>
                    </div>
                    <div className="mt-6">
                      <p className="font-display text-base font-bold text-neutral-950">
                        Request
                      </p>
                      <p className="mt-1 text-xs text-neutral-500 leading-relaxed">
                        Create a payment link in seconds.
                      </p>
                    </div>
                  </button>
                </div>
              </div>

              {/* Middle Row: "Your assets" 3 Ecosystem Cards with Sparklines */}
              <div>
                <div className="flex items-center justify-between mb-3.5">
                  <div className="flex items-baseline gap-3">
                    <h2 className="font-serif text-2xl text-neutral-950">
                      Your assets
                    </h2>
                    <span className="text-xs font-medium text-neutral-500">
                      Observed USDC{" "}
                      <strong className="text-neutral-900">
                        {totalStableFormatted}
                      </strong>
                    </span>
                  </div>
                  <button
                    type="button"
                    onClick={() => setActiveTab("assets")}
                    className="text-xs font-semibold text-neutral-700 hover:text-neutral-950"
                  >
                    Manage wallets →
                  </button>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
                  {/* Ethereum Card */}
                  <div className="rounded-[22px] border border-neutral-200/80 bg-white p-5 shadow-2xs">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2.5">
                        <ChainBadge chainKey="ethereum-mainnet" size={28} />
                        <div>
                          <div className="flex items-center gap-1.5">
                            <span className="font-display text-sm font-bold text-neutral-950">
                              Ethereum
                            </span>
                            <span className="rounded bg-neutral-100 px-1.5 py-0.5 text-[10px] font-semibold text-neutral-600">
                              USDC
                            </span>
                          </div>
                          <p className="text-[11px] font-mono text-neutral-400">
                            {truncateMiddle(ethAddr, 6, 4)}
                          </p>
                        </div>
                      </div>
                      <button
                        type="button"
                        disabled={!wallet}
                        onClick={() => copyAddress("dash-eth", ethAddr)}
                        className="text-[11px] font-medium text-neutral-500 hover:text-neutral-900 disabled:opacity-40"
                      >
                        {copiedKey === "dash-eth" ? "Copied" : "Copy"}
                      </button>
                    </div>

                    <div className="mt-4 flex items-end justify-between">
                      <div>
                        <p className="font-display text-2xl font-bold text-neutral-950">
                          {ethUsdcBalance} USDC
                        </p>
                        <div className="mt-1 flex items-center gap-2 text-[11px]">
                          <span className="text-neutral-500">
                            {wallet ? "Read-only RPC" : "Pending setup"}
                          </span>
                          <span className="font-semibold text-indigo-600">
                            EVM
                          </span>
                        </div>
                      </div>
                      <svg
                        width="84"
                        height="32"
                        viewBox="0 0 84 32"
                        fill="none"
                      >
                        <path
                          d="M2 24 C18 22, 28 14, 44 16 C58 18, 68 8, 82 6"
                          stroke="#6366F1"
                          strokeWidth="2"
                          strokeLinecap="round"
                        />
                      </svg>
                    </div>
                  </div>

                  {/* Base Card */}
                  <div className="rounded-[22px] border border-neutral-200/80 bg-white p-5 shadow-2xs">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2.5">
                        <ChainBadge chainKey="base-mainnet" size={28} />
                        <div>
                          <div className="flex items-center gap-1.5">
                            <span className="font-display text-sm font-bold text-neutral-950">
                              Base
                            </span>
                            <span className="rounded bg-neutral-100 px-1.5 py-0.5 text-[10px] font-semibold text-neutral-600">
                              USDC
                            </span>
                          </div>
                          <p className="text-[11px] font-mono text-neutral-400">
                            {truncateMiddle(baseAddr, 6, 4)}
                          </p>
                        </div>
                      </div>
                      <button
                        type="button"
                        disabled={!wallet}
                        onClick={() => copyAddress("dash-base", baseAddr)}
                        className="text-[11px] font-medium text-neutral-500 hover:text-neutral-900 disabled:opacity-40"
                      >
                        {copiedKey === "dash-base" ? "Copied" : "Copy"}
                      </button>
                    </div>

                    <div className="mt-4 flex items-end justify-between">
                      <div>
                        <p className="font-display text-2xl font-bold text-neutral-950">
                          {baseUsdcBalance} USDC
                        </p>
                        <div className="mt-1 flex items-center gap-2 text-[11px]">
                          <span className="text-neutral-500">
                            {wallet ? "Read-only RPC" : "Pending setup"}
                          </span>
                          <span className="font-semibold text-emerald-600">
                            EVM
                          </span>
                        </div>
                      </div>
                      <svg
                        width="84"
                        height="32"
                        viewBox="0 0 84 32"
                        fill="none"
                      >
                        <path
                          d="M2 24 C18 22, 28 14, 44 16 C58 18, 68 8, 82 6"
                          stroke="#10B981"
                          strokeWidth="2"
                          strokeLinecap="round"
                        />
                      </svg>
                    </div>
                  </div>

                  {/* Solana Card */}
                  <div className="rounded-[22px] border border-neutral-200/80 bg-white p-5 shadow-2xs">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2.5">
                        <ChainBadge chainKey="solana-mainnet" size={28} />
                        <div>
                          <div className="flex items-center gap-1.5">
                            <span className="font-display text-sm font-bold text-neutral-950">
                              Solana
                            </span>
                            <span className="rounded bg-neutral-100 px-1.5 py-0.5 text-[10px] font-semibold text-neutral-600">
                              SOL
                            </span>
                          </div>
                          <p className="text-[11px] font-mono text-neutral-400">
                            {truncateMiddle(solAddr, 6, 4)}
                          </p>
                        </div>
                      </div>
                      <button
                        type="button"
                        disabled={!wallet}
                        onClick={() => copyAddress("dash-sol", solAddr)}
                        className="text-[11px] font-medium text-neutral-500 hover:text-neutral-900 disabled:opacity-40"
                      >
                        {copiedKey === "dash-sol" ? "Copied" : "Copy"}
                      </button>
                    </div>

                    <div className="mt-4 flex items-end justify-between">
                      <div>
                        <p className="font-display text-2xl font-bold text-neutral-950">
                          {solNativeBalance} SOL
                        </p>
                        <div className="mt-1 flex items-center gap-2 text-[11px]">
                          <span className="text-neutral-500">
                            {wallet ? "Read-only RPC" : "Pending setup"}
                          </span>
                          <span className="font-semibold text-emerald-600">
                            Solana
                          </span>
                        </div>
                      </div>
                      <svg
                        width="84"
                        height="32"
                        viewBox="0 0 84 32"
                        fill="none"
                      >
                        <path
                          d="M2 26 C20 24, 32 18, 48 12 C62 8, 72 10, 82 4"
                          stroke="#FF1A1A"
                          strokeWidth="2"
                          strokeLinecap="round"
                        />
                      </svg>
                    </div>
                  </div>

                  {/* NEAR Card */}
                  <div className="rounded-[22px] border border-neutral-200/80 bg-white p-5 shadow-2xs">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2.5">
                        <ChainBadge chainKey="near-mainnet" size={28} />
                        <div>
                          <div className="flex items-center gap-1.5">
                            <span className="font-display text-sm font-bold text-neutral-950">
                              NEAR
                            </span>
                            <span className="rounded bg-neutral-100 px-1.5 py-0.5 text-[10px] font-semibold text-neutral-600">
                              NEAR
                            </span>
                          </div>
                          <p className="text-[11px] font-mono text-neutral-400">
                            {truncateMiddle(nearAddr, 8, 5)}
                          </p>
                        </div>
                      </div>
                      <button
                        type="button"
                        disabled={!wallet}
                        onClick={() => copyAddress("dash-near", nearAddr)}
                        className="text-[11px] font-medium text-neutral-500 hover:text-neutral-900 disabled:opacity-40"
                      >
                        {copiedKey === "dash-near" ? "Copied" : "Copy"}
                      </button>
                    </div>

                    <div className="mt-4 flex items-end justify-between">
                      <div>
                        <p className="font-display text-2xl font-bold text-neutral-950">
                          {nearNativeBalance} NEAR
                        </p>
                        <div className="mt-1 flex items-center gap-2 text-[11px]">
                          <span className="text-neutral-500">
                            {wallet ? "Read-only RPC" : "Pending setup"}
                          </span>
                          <span className="font-semibold text-emerald-600">
                            NEAR
                          </span>
                        </div>
                      </div>
                      <svg
                        width="84"
                        height="32"
                        viewBox="0 0 84 32"
                        fill="none"
                      >
                        <path
                          d="M2 22 C22 20, 40 22, 56 15 C68 12, 76 12, 82 9"
                          stroke="#10B981"
                          strokeWidth="2"
                          strokeLinecap="round"
                        />
                      </svg>
                    </div>
                  </div>
                </div>
              </div>

              {/* Bottom Row: Left "Recent activity" + Right "GET PAID EASILY" QR Standee Card */}
              <div className="grid grid-cols-1 lg:grid-cols-12 gap-5 items-stretch">
                {/* Recent Activity Card */}
                <div className="lg:col-span-7 rounded-[24px] border border-neutral-200/80 bg-white p-6 shadow-2xs">
                  <div className="flex items-center justify-between mb-4">
                    <h2 className="font-serif text-xl text-neutral-950">
                      Recent activity
                    </h2>
                    <button
                      type="button"
                      onClick={() => setActiveTab("activity")}
                      className="text-xs font-semibold text-neutral-600 hover:text-neutral-950"
                    >
                      View all →
                    </button>
                  </div>

                  {activities.length === 0 && paymentRequests.length === 0 ? (
                    <div className="rounded-[18px] border border-dashed border-neutral-200 bg-neutral-50/70 p-6 text-center">
                      <p className="text-sm font-semibold text-neutral-800">
                        No transactions or payment requests recorded yet.
                      </p>
                      <p className="mt-1 text-xs text-neutral-500">
                        Create a payment link or sync on-chain activity to see
                        verified transfers here.
                      </p>
                    </div>
                  ) : (
                    <div className="divide-y divide-neutral-100">
                      {activities.slice(0, 3).map((act) => (
                        <div
                          key={act.id}
                          className="flex items-center justify-between py-3.5 first:pt-1 last:pb-1"
                        >
                          <div className="flex items-center gap-3 min-w-0">
                            <span
                              className={`inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-xs font-bold ${
                                act.direction === "INCOMING"
                                  ? "bg-emerald-50 text-emerald-600"
                                  : "bg-red-50 text-[#FF1A1A]"
                              }`}
                            >
                              {act.direction === "INCOMING" ? "↙" : "↗"}
                            </span>
                            <div className="min-w-0">
                              <p className="truncate text-sm font-semibold text-neutral-950">
                                {act.direction === "INCOMING"
                                  ? "Inbound Transfer"
                                  : "Outbound Transfer"}
                              </p>
                              <p className="text-xs text-neutral-500">
                                {act.assetSymbol} · {act.network} ·{" "}
                                {act.finality}
                              </p>
                            </div>
                          </div>
                          <div className="text-right shrink-0 pl-3">
                            <p
                              className={`font-display text-sm font-bold ${
                                act.direction === "INCOMING"
                                  ? "text-emerald-600"
                                  : "text-neutral-950"
                              }`}
                            >
                              {act.direction === "INCOMING" ? "+" : "-"}
                              {act.displayAmount} {act.assetSymbol}
                            </p>
                            <p className="text-[11px] font-mono text-neutral-400">
                              {truncateMiddle(act.txHash, 6, 4)}
                            </p>
                          </div>
                        </div>
                      ))}
                      {paymentRequests.slice(0, 3).map((req) => (
                        <div
                          key={req.id}
                          className="flex items-center justify-between py-3.5 first:pt-1 last:pb-1"
                        >
                          <div className="flex items-center gap-3 min-w-0">
                            <span className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-neutral-100 text-xs font-bold text-neutral-800">
                              🔗
                            </span>
                            <div className="min-w-0">
                              <p className="truncate text-sm font-semibold text-neutral-950">
                                {req.title}
                              </p>
                              <p className="text-xs text-neutral-500">
                                {req.destinationAssetSymbol} ·{" "}
                                {req.destinationNetwork} · {req.status}
                              </p>
                            </div>
                          </div>
                          <div className="text-right shrink-0 pl-3">
                            <p className="font-display text-sm font-bold text-neutral-950">
                              {req.amountMode === "FIXED"
                                ? `${req.displayAmount} ${req.destinationAssetSymbol}`
                                : "Open amount"}
                            </p>
                            <Link
                              prefetch={false}
                              href={`/pay/${req.publicId}`}
                              className="text-[11px] font-semibold text-[#FF1A1A] hover:underline"
                            >
                              View link →
                            </Link>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                {/* Right Card: "GET PAID EASILY / Turn any payment into a simple link or QR." */}
                <div className="lg:col-span-5 rounded-[24px] border border-neutral-200/80 bg-white p-6 shadow-2xs flex flex-col justify-between">
                  <div className="grid grid-cols-1 sm:grid-cols-12 gap-4 items-center my-auto">
                    <div className="sm:col-span-7 space-y-2.5">
                      <span className="text-[10px] font-bold uppercase tracking-[0.14em] text-[#FF1A1A]">
                        GET PAID EASILY
                      </span>
                      <h3 className="font-serif text-2xl leading-snug text-neutral-950">
                        Turn any payment into a simple link or QR.
                      </h3>
                      <p className="text-xs text-neutral-600 leading-relaxed">
                        Choose what you want to receive and share a single link
                        — no network headaches for the person paying you.
                      </p>
                      <div className="pt-2">
                        <button
                          type="button"
                          onClick={() => setActiveTab("receive")}
                          className="inline-flex items-center gap-2 rounded-full bg-neutral-950 px-5 py-2.5 text-xs font-semibold text-white hover:bg-neutral-800"
                        >
                          Create payment link <span>→</span>
                        </button>
                      </div>
                    </div>
                    <div className="sm:col-span-5 flex justify-center">
                      <img
                        src="/assets/qr-standee.png"
                        alt="Flow QR Standee"
                        className="h-40 w-auto rounded-[16px] object-cover shadow-md"
                      />
                    </div>
                  </div>
                </div>
              </div>

              {/* Workspace Rename Section (Preserves functional workspace rename) */}
              <div className="rounded-[22px] border border-neutral-200/80 bg-white p-5 shadow-2xs">
                <div className="flex flex-wrap items-center justify-between gap-4">
                  <div>
                    <h3 className="font-display text-sm font-bold text-neutral-950">
                      Workspace display name
                    </h3>
                    <p className="text-xs text-neutral-500">
                      Update the name shown on your payment links and checkout
                      receipts.
                    </p>
                  </div>
                  <div className="w-full sm:w-auto min-w-[280px]">
                    <AccountNameForm
                      account={{
                        id: currentAccount.id,
                        name: currentAccount.name,
                      }}
                    />
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* ================================================================
              TAB 2: WALLETS & SUPPORTED ASSETS (Matches 08_26_15 PM-6.png & 08_56_26 PM-5.png)
             ================================================================ */}
          {activeTab === "assets" && (
            <div className="space-y-6">
              {/* Heading */}
              <div className="flex flex-wrap items-end justify-between gap-4">
                <div>
                  <p className="text-[11px] font-bold uppercase tracking-[0.14em] text-[#FF1A1A]">
                    WALLETS &amp; ASSETS
                  </p>
                  <h1 className="mt-1 font-serif text-3xl sm:text-[40px] font-normal tracking-[-0.02em] text-neutral-950">
                    Wallets &amp; Supported Assets
                  </h1>
                  <p className="mt-1 text-sm text-neutral-600">
                    Manage your connected wallets and view supported tokens
                    across networks.
                  </p>
                </div>

                <div className="inline-flex rounded-full border border-neutral-200 bg-white p-1 shadow-2xs">
                  <span className="rounded-full bg-neutral-950 px-4 py-1.5 text-xs font-semibold text-white">
                    Wallets
                  </span>
                  <span className="px-4 py-1.5 text-xs font-semibold text-neutral-600">
                    Supported Assets
                  </span>
                </div>
              </div>

              {/* 4 Ecosystem Wallet Cards (Ethereum, Base, Solana, NEAR) */}
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
                {/* Ethereum Wallet */}
                <div className="rounded-[22px] border border-neutral-200/90 bg-white p-5 shadow-2xs flex flex-col justify-between">
                  <div>
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2.5">
                        <ChainBadge chainKey="ethereum-mainnet" size={28} />
                        <div>
                          <p className="font-display text-sm font-bold text-neutral-950">
                            Ethereum Mainnet
                          </p>
                          <p className="text-[11px] text-neutral-500">
                            Ethereum L1
                          </p>
                        </div>
                      </div>
                      <span className="rounded-md bg-neutral-100 px-2 py-0.5 text-[10px] font-bold uppercase text-neutral-700">
                        EVM
                      </span>
                    </div>

                    <p className="mt-4 font-display text-2xl font-bold text-neutral-950">
                      {ethUsdcBalance} USDC
                    </p>
                    <p className="mt-1 font-mono text-xs text-neutral-500">
                      {truncateMiddle(ethAddr, 8, 6)}
                    </p>
                  </div>

                  <div className="mt-4 flex items-center justify-between border-t border-neutral-100 pt-3">
                    <button
                      type="button"
                      disabled={!wallet}
                      onClick={() => copyAddress("wallet-eth", ethAddr)}
                      className="inline-flex items-center gap-1 text-xs font-semibold text-neutral-700 hover:text-neutral-950 disabled:opacity-40"
                    >
                      {copiedKey === "wallet-eth" ? (
                        <>
                          <IconCheck size={13} /> Copied
                        </>
                      ) : (
                        <>
                          <IconCopy size={13} /> Copy Address
                        </>
                      )}
                    </button>
                    <button
                      type="button"
                      onClick={() => setEcosystemFilter("evm")}
                      className="text-xs font-semibold text-[#FF1A1A] hover:underline"
                    >
                      View Assets →
                    </button>
                  </div>
                </div>

                {/* Base Wallet */}
                <div className="rounded-[22px] border border-neutral-200/90 bg-white p-5 shadow-2xs flex flex-col justify-between">
                  <div>
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2.5">
                        <ChainBadge chainKey="base-mainnet" size={28} />
                        <div>
                          <p className="font-display text-sm font-bold text-neutral-950">
                            Base Mainnet
                          </p>
                          <p className="text-[11px] text-neutral-500">
                            Base L2
                          </p>
                        </div>
                      </div>
                      <span className="rounded-md bg-neutral-100 px-2 py-0.5 text-[10px] font-bold uppercase text-neutral-700">
                        EVM
                      </span>
                    </div>

                    <p className="mt-4 font-display text-2xl font-bold text-neutral-950">
                      {baseUsdcBalance} USDC
                    </p>
                    <p className="mt-1 font-mono text-xs text-neutral-500">
                      {truncateMiddle(baseAddr, 8, 6)}
                    </p>
                  </div>

                  <div className="mt-4 flex items-center justify-between border-t border-neutral-100 pt-3">
                    <button
                      type="button"
                      disabled={!wallet}
                      onClick={() => copyAddress("wallet-base", baseAddr)}
                      className="inline-flex items-center gap-1 text-xs font-semibold text-neutral-700 hover:text-neutral-950 disabled:opacity-40"
                    >
                      {copiedKey === "wallet-base" ? (
                        <>
                          <IconCheck size={13} /> Copied
                        </>
                      ) : (
                        <>
                          <IconCopy size={13} /> Copy Address
                        </>
                      )}
                    </button>
                    <button
                      type="button"
                      onClick={() => setEcosystemFilter("evm")}
                      className="text-xs font-semibold text-[#FF1A1A] hover:underline"
                    >
                      View Assets →
                    </button>
                  </div>
                </div>

                {/* Solana Wallet */}
                <div className="rounded-[22px] border border-neutral-200/90 bg-white p-5 shadow-2xs flex flex-col justify-between">
                  <div>
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2.5">
                        <ChainBadge chainKey="solana-mainnet" size={28} />
                        <div>
                          <p className="font-display text-sm font-bold text-neutral-950">
                            Solana
                          </p>
                          <p className="text-[11px] text-neutral-500">
                            {ECOSYSTEM_METADATA[1]?.label ?? "Solana"}
                          </p>
                        </div>
                      </div>
                      <span className="rounded-md bg-neutral-100 px-2 py-0.5 text-[10px] font-bold uppercase text-neutral-700">
                        SOL
                      </span>
                    </div>

                    <p className="mt-4 font-display text-2xl font-bold text-neutral-950">
                      {solNativeBalance} SOL
                    </p>
                    <p className="mt-1 font-mono text-xs text-neutral-500">
                      {truncateMiddle(solAddr, 8, 6)}
                    </p>
                  </div>

                  <div className="mt-4 flex items-center justify-between border-t border-neutral-100 pt-3">
                    <button
                      type="button"
                      disabled={!wallet}
                      onClick={() => copyAddress("wallet-sol", solAddr)}
                      className="inline-flex items-center gap-1 text-xs font-semibold text-neutral-700 hover:text-neutral-950 disabled:opacity-40"
                    >
                      {copiedKey === "wallet-sol" ? (
                        <>
                          <IconCheck size={13} /> Copied
                        </>
                      ) : (
                        <>
                          <IconCopy size={13} /> Copy Address
                        </>
                      )}
                    </button>
                    <button
                      type="button"
                      onClick={() => setEcosystemFilter("solana")}
                      className="text-xs font-semibold text-[#FF1A1A] hover:underline"
                    >
                      View Assets →
                    </button>
                  </div>
                </div>

                {/* NEAR Wallet */}
                <div className="rounded-[22px] border border-neutral-200/90 bg-white p-5 shadow-2xs flex flex-col justify-between">
                  <div>
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2.5">
                        <ChainBadge chainKey="near-mainnet" size={28} />
                        <div>
                          <p className="font-display text-sm font-bold text-neutral-950">
                            NEAR
                          </p>
                          <p className="text-[11px] text-neutral-500">
                            {ECOSYSTEM_METADATA[2]?.label ?? "NEAR Protocol"}
                          </p>
                        </div>
                      </div>
                      <span className="rounded-md bg-neutral-100 px-2 py-0.5 text-[10px] font-bold uppercase text-neutral-700">
                        NEAR
                      </span>
                    </div>

                    <p className="mt-4 font-display text-2xl font-bold text-neutral-950">
                      {nearNativeBalance} NEAR
                    </p>
                    <p className="mt-1 font-mono text-xs text-neutral-500">
                      {truncateMiddle(nearAddr, 8, 6)}
                    </p>
                  </div>

                  <div className="mt-4 flex items-center justify-between border-t border-neutral-100 pt-3">
                    <button
                      type="button"
                      disabled={!wallet}
                      onClick={() => copyAddress("wallet-near", nearAddr)}
                      className="inline-flex items-center gap-1 text-xs font-semibold text-neutral-700 hover:text-neutral-950 disabled:opacity-40"
                    >
                      {copiedKey === "wallet-near" ? (
                        <>
                          <IconCheck size={13} /> Copied
                        </>
                      ) : (
                        <>
                          <IconCopy size={13} /> Copy Address
                        </>
                      )}
                    </button>
                    <button
                      type="button"
                      onClick={() => setEcosystemFilter("near")}
                      className="text-xs font-semibold text-[#FF1A1A] hover:underline"
                    >
                      View Assets →
                    </button>
                  </div>
                </div>
              </div>

              {/* Filter Bar */}
              <div className="flex flex-wrap items-center justify-between gap-3 rounded-[20px] border border-neutral-200/80 bg-white p-3 shadow-2xs">
                <div className="flex flex-wrap items-center gap-1.5">
                  <button
                    type="button"
                    onClick={() => setEcosystemFilter("all")}
                    className={`rounded-full px-3.5 py-1.5 text-xs font-semibold transition-colors ${
                      ecosystemFilter === "all"
                        ? "bg-neutral-950 text-white"
                        : "text-neutral-600 hover:bg-neutral-100"
                    }`}
                  >
                    All Networks
                  </button>
                  <button
                    type="button"
                    onClick={() => setEcosystemFilter("evm")}
                    className={`rounded-full px-3.5 py-1.5 text-xs font-semibold transition-colors ${
                      ecosystemFilter === "evm"
                        ? "bg-neutral-950 text-white"
                        : "text-neutral-600 hover:bg-neutral-100"
                    }`}
                  >
                    Ethereum &amp; EVM
                  </button>
                  <button
                    type="button"
                    onClick={() => setEcosystemFilter("solana")}
                    className={`rounded-full px-3.5 py-1.5 text-xs font-semibold transition-colors ${
                      ecosystemFilter === "solana"
                        ? "bg-neutral-950 text-white"
                        : "text-neutral-600 hover:bg-neutral-100"
                    }`}
                  >
                    Solana
                  </button>
                  <button
                    type="button"
                    onClick={() => setEcosystemFilter("near")}
                    className={`rounded-full px-3.5 py-1.5 text-xs font-semibold transition-colors ${
                      ecosystemFilter === "near"
                        ? "bg-neutral-950 text-white"
                        : "text-neutral-600 hover:bg-neutral-100"
                    }`}
                  >
                    NEAR
                  </button>
                </div>

                <div className="relative flex-1 min-w-[220px] max-w-sm">
                  <IconSearch
                    size={15}
                    className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-neutral-400"
                  />
                  <input
                    type="search"
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    placeholder="Search assets, symbols, or contracts..."
                    className="w-full rounded-full border border-neutral-200 bg-neutral-50 pl-9 pr-4 py-1.5 text-xs text-neutral-900 placeholder:text-neutral-400 focus:border-neutral-900 focus:bg-white focus:outline-none"
                  />
                </div>
              </div>

              {/* Supported Assets Table + Selected Token Metadata Drawer */}
              <div className="grid grid-cols-1 lg:grid-cols-12 gap-5 items-start">
                <div className="lg:col-span-8 overflow-hidden rounded-[22px] border border-neutral-200/80 bg-white shadow-2xs">
                  <div className="overflow-x-auto">
                    <table className="w-full text-left border-collapse">
                      <thead>
                        <tr className="border-b border-neutral-100 text-[11px] font-semibold uppercase tracking-wider text-neutral-400">
                          <th className="py-3.5 pl-5 pr-3">Asset</th>
                          <th className="py-3.5 px-3">Network</th>
                          <th className="py-3.5 px-3">Wallet</th>
                          <th className="py-3.5 px-3 text-right">Balance</th>
                          <th className="py-3.5 pl-3 pr-5 text-right">
                            Action
                          </th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-neutral-100 text-xs">
                        {filteredCatalogRows.map(
                          ({ catalog, observedBalance }) => {
                            const isSelected =
                              catalog.id === selectedCatalogItem.id;
                            const displayAmount =
                              observedBalance?.displayBalance ?? "0";
                            const walletShort =
                              catalog.ecosystem === "evm"
                                ? truncateMiddle(evmAddr, 6, 4)
                                : catalog.ecosystem === "solana"
                                  ? truncateMiddle(solAddr, 6, 4)
                                  : truncateMiddle(nearAddr, 8, 4);

                            return (
                              <tr
                                key={catalog.id}
                                onClick={() => setSelectedAssetId(catalog.id)}
                                className={`cursor-pointer transition-colors ${
                                  isSelected
                                    ? "bg-red-50/50"
                                    : "hover:bg-neutral-50/80"
                                }`}
                              >
                                <td className="py-3.5 pl-5 pr-3">
                                  <div className="flex items-center gap-2.5">
                                    <AssetAvatar
                                      symbol={catalog.symbol}
                                      size={28}
                                    />
                                    <div>
                                      <p className="font-display font-bold text-neutral-950">
                                        {catalog.name}
                                      </p>
                                      <p className="text-[11px] text-neutral-500">
                                        {catalog.symbol}
                                      </p>
                                    </div>
                                  </div>
                                </td>
                                <td className="py-3.5 px-3">
                                  <span className="inline-flex items-center gap-1.5 rounded-full bg-neutral-100 px-2.5 py-1 text-[11px] font-medium text-neutral-800">
                                    <ChainBadge
                                      chainKey={catalog.networkKey}
                                      size={14}
                                    />
                                    {catalog.networkName}
                                  </span>
                                </td>
                                <td className="py-3.5 px-3 font-mono text-[11px] text-neutral-500">
                                  {walletShort}
                                </td>
                                <td className="py-3.5 px-3 text-right font-mono font-semibold text-neutral-950">
                                  {displayAmount} {catalog.symbol}
                                </td>
                                <td className="py-3.5 pl-3 pr-5 text-right">
                                  <button
                                    type="button"
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      setReceiveDeploymentId(catalog.id);
                                      setActiveTab("receive");
                                    }}
                                    className="rounded-full border border-neutral-200 bg-white px-3 py-1 text-[11px] font-semibold text-neutral-800 hover:border-neutral-900"
                                  >
                                    Receive
                                  </button>
                                </td>
                              </tr>
                            );
                          },
                        )}
                      </tbody>
                    </table>
                  </div>
                </div>

                {/* Selected Token Verification Details */}
                <div className="lg:col-span-4 rounded-[22px] border border-neutral-200/80 bg-white p-5 shadow-2xs space-y-4">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2.5">
                      <AssetAvatar
                        symbol={selectedCatalogItem.symbol}
                        size={34}
                      />
                      <div>
                        <h3 className="font-display text-base font-bold text-neutral-950">
                          {selectedCatalogItem.name}
                        </h3>
                        <p className="text-xs text-neutral-500">
                          {selectedCatalogItem.symbol} ·{" "}
                          {selectedCatalogItem.networkName}
                        </p>
                      </div>
                    </div>
                    <span className="rounded-full bg-emerald-50 px-2.5 py-0.5 text-[10px] font-bold uppercase text-emerald-700">
                      Verified
                    </span>
                  </div>

                  <div className="space-y-2.5 rounded-[16px] bg-neutral-50 p-3.5 text-xs">
                    <div className="flex justify-between">
                      <span className="text-neutral-500">Asset Class</span>
                      <span className="font-semibold text-neutral-900">
                        {selectedCatalogItem.kind === "NATIVE"
                          ? "Native Gas Asset"
                          : selectedCatalogItem.standard}
                      </span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-neutral-500">Decimals</span>
                      <span className="font-mono font-semibold text-neutral-900">
                        {selectedCatalogItem.decimals}
                      </span>
                    </div>
                    <div className="pt-1 border-t border-neutral-200/70">
                      <span className="text-neutral-500 block mb-1">
                        Contract / Mint Identifier
                      </span>
                      <p className="font-mono text-[11px] break-all text-neutral-900">
                        {selectedCatalogItem.contractIdentifier}
                      </p>
                    </div>
                  </div>

                  <div className="grid grid-cols-2 gap-2.5">
                    <button
                      type="button"
                      onClick={() => {
                        setReceiveDeploymentId(selectedCatalogItem.id);
                        setActiveTab("receive");
                      }}
                      className="rounded-full bg-neutral-950 py-2.5 text-xs font-semibold text-white hover:bg-neutral-800"
                    >
                      Receive {selectedCatalogItem.symbol}
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setSourceDeploymentId(selectedCatalogItem.id);
                        setActiveTab("send");
                      }}
                      className="rounded-full border border-neutral-200 bg-white py-2.5 text-xs font-semibold text-neutral-900 hover:bg-neutral-50"
                    >
                      Send / Convert
                    </button>
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* ================================================================
              TAB 3: RECEIVE / CREATE PAYMENT LINK (Matches 08_26_18 PM-7.png & 08_56_28 PM-6.png)
             ================================================================ */}
          {activeTab === "receive" && (
            <div className="space-y-8">
              <div>
                <h1 className="font-serif text-3xl sm:text-[42px] font-normal tracking-[-0.02em] text-neutral-950">
                  <span className="relative inline-block">
                    Receive
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
                  </span>{" "}
                  / Create Payment Link
                </h1>
                <p className="mt-2 text-sm text-neutral-600">
                  Choose your destination asset and network, set an amount, and
                  share a link or QR to get paid.
                </p>
              </div>

              <div className="grid grid-cols-1 lg:grid-cols-12 gap-7 items-start">
                {/* Left Column: Form Card */}
                <div className="lg:col-span-7 rounded-[26px] border border-neutral-200/90 bg-white p-6 sm:p-8 shadow-sm space-y-5">
                  {/* Mode Toggle */}
                  <div className="grid grid-cols-2 rounded-full bg-neutral-100 p-1">
                    <button
                      type="button"
                      className="rounded-full py-2 text-xs font-semibold text-neutral-600"
                    >
                      ↙ Request Payment
                    </button>
                    <button
                      type="button"
                      className="rounded-full bg-neutral-950 py-2 text-xs font-semibold text-white shadow-xs"
                    >
                      🔗 Create Payment Link
                    </button>
                  </div>

                  {/* Destination Asset & Network Selector */}
                  <div>
                    <label
                      htmlFor="receive-deployment-select"
                      className="block text-xs font-semibold text-neutral-800 mb-2"
                    >
                      Destination asset &amp; network
                    </label>
                    <select
                      id="receive-deployment-select"
                      value={receiveDeploymentId}
                      onChange={(e) => setReceiveDeploymentId(e.target.value)}
                      className="w-full rounded-[14px] border border-neutral-200 bg-white px-4 py-3 text-sm font-semibold text-neutral-950 focus:border-neutral-950 focus:outline-none"
                    >
                      {MAINNET_SUPPORTED_DEPLOYMENTS.map((d) => (
                        <option key={d.id} value={d.id}>
                          {d.symbol} — {d.name} ({d.networkName})
                        </option>
                      ))}
                    </select>

                    {/* Quick Network Pills matching 08_26_18 PM-7.png */}
                    <div className="mt-3 grid grid-cols-2 sm:grid-cols-4 gap-2.5">
                      <button
                        type="button"
                        onClick={() =>
                          setReceiveDeploymentId("ethereum-mainnet:USDC")
                        }
                        className={`flex items-center justify-center gap-2 rounded-[12px] border py-2.5 text-xs font-semibold transition-all ${
                          receiveDeployment.networkKey === "ethereum-mainnet"
                            ? "border-[#FF1A1A] bg-red-50/40 text-neutral-950"
                            : "border-neutral-200 bg-white text-neutral-700 hover:bg-neutral-50"
                        }`}
                      >
                        <ChainBadge chainKey="ethereum-mainnet" size={16} />
                        <span>Ethereum</span>
                      </button>
                      <button
                        type="button"
                        onClick={() =>
                          setReceiveDeploymentId("base-mainnet:USDC")
                        }
                        className={`flex items-center justify-center gap-2 rounded-[12px] border py-2.5 text-xs font-semibold transition-all ${
                          receiveDeployment.networkKey === "base-mainnet"
                            ? "border-[#FF1A1A] bg-red-50/40 text-neutral-950"
                            : "border-neutral-200 bg-white text-neutral-700 hover:bg-neutral-50"
                        }`}
                      >
                        <ChainBadge chainKey="base-mainnet" size={16} />
                        <span>Base</span>
                      </button>
                      <button
                        type="button"
                        onClick={() =>
                          setReceiveDeploymentId("solana-mainnet:USDC")
                        }
                        className={`flex items-center justify-center gap-2 rounded-[12px] border py-2.5 text-xs font-semibold transition-all ${
                          receiveDeployment.networkKey === "solana-mainnet"
                            ? "border-[#FF1A1A] bg-red-50/40 text-neutral-950"
                            : "border-neutral-200 bg-white text-neutral-700 hover:bg-neutral-50"
                        }`}
                      >
                        <ChainBadge chainKey="solana-mainnet" size={16} />
                        <span>Solana</span>
                      </button>
                      <button
                        type="button"
                        onClick={() =>
                          setReceiveDeploymentId("near-mainnet:NEAR")
                        }
                        className={`flex items-center justify-center gap-2 rounded-[12px] border py-2.5 text-xs font-semibold transition-all ${
                          receiveDeployment.networkKey === "near-mainnet"
                            ? "border-[#FF1A1A] bg-red-50/40 text-neutral-950"
                            : "border-neutral-200 bg-white text-neutral-700 hover:bg-neutral-50"
                        }`}
                      >
                        <ChainBadge chainKey="near-mainnet" size={16} />
                        <span>NEAR</span>
                      </button>
                    </div>
                  </div>

                  {/* Amount Mode + Amount Input */}
                  <div>
                    <div className="flex items-center justify-between mb-2">
                      <label
                        htmlFor="pr-amount-input"
                        className="text-xs font-semibold text-neutral-800"
                      >
                        Amount
                      </label>
                      <div className="inline-flex gap-1 text-[11px]">
                        <button
                          type="button"
                          onClick={() => setPrAmountMode("FIXED")}
                          className={`rounded px-2 py-0.5 font-semibold ${
                            prAmountMode === "FIXED"
                              ? "bg-neutral-900 text-white"
                              : "text-neutral-500"
                          }`}
                        >
                          Fixed
                        </button>
                        <button
                          type="button"
                          onClick={() => setPrAmountMode("OPTIONAL")}
                          className={`rounded px-2 py-0.5 font-semibold ${
                            prAmountMode === "OPTIONAL"
                              ? "bg-neutral-900 text-white"
                              : "text-neutral-500"
                          }`}
                        >
                          Open amount
                        </button>
                      </div>
                    </div>

                    {prAmountMode === "FIXED" ? (
                      <div className="relative flex items-center">
                        <span className="pointer-events-none absolute left-4 text-base font-semibold text-neutral-400">
                          $
                        </span>
                        <input
                          id="pr-amount-input"
                          type="text"
                          value={prAmount}
                          onChange={(e) => setPrAmount(e.target.value)}
                          placeholder="249.00"
                          className="w-full rounded-[14px] border border-neutral-200 bg-white pl-8 pr-20 py-3 font-display text-lg font-bold text-neutral-950 focus:border-neutral-950 focus:outline-none"
                        />
                        <span className="pointer-events-none absolute right-4 rounded-md bg-neutral-100 px-2.5 py-1 text-xs font-bold text-neutral-700">
                          {receiveDeployment.symbol}
                        </span>
                      </div>
                    ) : (
                      <p className="rounded-[14px] border border-neutral-200 bg-neutral-50 px-4 py-3 text-xs text-neutral-600">
                        Payer will enter their desired amount at checkout.
                      </p>
                    )}
                  </div>

                  {/* Payment Title / Note Input */}
                  <div>
                    <div className="flex items-center justify-between mb-2">
                      <label
                        htmlFor="pr-title-input"
                        className="text-xs font-semibold text-neutral-800"
                      >
                        Note / Title
                      </label>
                      <span className="text-[11px] text-neutral-400">
                        {prTitle.length} / 140
                      </span>
                    </div>
                    <input
                      id="pr-title-input"
                      type="text"
                      value={prTitle}
                      onChange={(e) => {
                        setPrTitle(e.target.value);
                        setPrDescription(e.target.value);
                      }}
                      placeholder="e.g. Project design deposit, Invoice #1042"
                      className="w-full rounded-[14px] border border-neutral-200 bg-white px-4 py-3 text-sm text-neutral-900 focus:border-neutral-950 focus:outline-none"
                    />
                  </div>

                  {/* Submit Button */}
                  <button
                    type="button"
                    onClick={handleCreatePaymentRequest}
                    disabled={prCreating || wallet?.status !== "ACTIVE"}
                    className="w-full rounded-full bg-[#FF1A1A] py-3.5 text-sm font-semibold text-white shadow-md hover:bg-[#E01515] disabled:opacity-50 transition-colors"
                  >
                    {wallet?.status !== "ACTIVE"
                      ? "Wallet Setup Pending (Activation Required)"
                      : prCreating
                        ? "Generating Payment Link..."
                        : "Create Payment Link →"}
                  </button>
                </div>

                {/* Right Column: LIVE PREVIEW Card (Matches 08_26_18 PM-7.png) */}
                <div className="lg:col-span-5 rounded-[26px] border border-neutral-200/90 bg-white p-6 shadow-sm space-y-5">
                  <div className="flex items-center justify-between">
                    <div>
                      <span className="text-[10px] font-bold uppercase tracking-[0.14em] text-[#FF1A1A]">
                        LIVE PREVIEW
                      </span>
                      <h2 className="font-serif text-xl text-neutral-950">
                        Your payment link
                      </h2>
                    </div>
                    {wallet?.status === "ACTIVE" ? (
                      <span className="inline-flex items-center gap-1 rounded-full bg-emerald-50 px-2.5 py-1 text-[11px] font-semibold text-emerald-700">
                        <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
                        Active
                      </span>
                    ) : (
                      <span className="inline-flex items-center gap-1 rounded-full bg-amber-50 px-2.5 py-1 text-[11px] font-semibold text-amber-800">
                        <span className="h-1.5 w-1.5 rounded-full bg-amber-500" />
                        Wallet Setup Pending
                      </span>
                    )}
                  </div>

                  {/* Dark Preview Card */}
                  <div className="relative overflow-hidden rounded-[22px] bg-[#0B0B0B] p-6 text-white shadow-lg">
                    <div
                      aria-hidden="true"
                      className="pointer-events-none absolute -top-10 -right-10 h-44 w-44 rounded-full bg-[#FF1A1A]/35 blur-2xl"
                    />
                    <div className="relative z-10 flex items-center justify-between">
                      <FlowLogo size={20} variant="inverse" />
                      <span className="rounded-full border border-white/15 bg-white/10 px-2.5 py-0.5 text-[10px] font-medium text-neutral-200">
                        Payment Request
                      </span>
                    </div>

                    <div className="relative z-10 mt-6">
                      <p className="text-xs text-neutral-400">
                        Pay {currentAccount.name}
                      </p>
                      <p className="mt-1 font-display text-3xl font-bold text-white">
                        {prAmountMode === "FIXED"
                          ? `$${prAmount || "249.00"}`
                          : "Open Amount"}
                      </p>
                    </div>

                    {wallet?.status !== "ACTIVE" && (
                      <div className="relative z-10 mt-4 rounded-[12px] border border-amber-400/30 bg-amber-500/10 p-3 text-xs text-amber-200">
                        <p className="font-semibold">Wallet Setup Pending</p>
                        <p className="mt-0.5 text-[11px] text-amber-300/80">
                          This preview illustrates how payers will view your
                          link. Payments cannot be accepted until wallet
                          activation is completed.
                        </p>
                      </div>
                    )}

                    <div className="relative z-10 mt-5 flex items-center justify-between rounded-[14px] border border-white/10 bg-white/[0.06] px-3.5 py-2.5 text-xs">
                      <span className="font-semibold text-white">
                        {receiveDeployment.symbol}
                      </span>
                      <span className="text-neutral-300">
                        {receiveDeployment.networkName}
                      </span>
                    </div>

                    <p className="relative z-10 mt-3 text-xs text-neutral-300 truncate">
                      {prTitle || "Project design deposit"}
                    </p>

                    <div className="relative z-10 mt-5 flex items-center justify-between">
                      <span className="text-[11px] text-neutral-400">
                        Pay with any supported asset
                      </span>
                      <span className="rounded-full bg-white px-4 py-1.5 text-xs font-bold text-neutral-950">
                        Pay Now
                      </span>
                    </div>
                  </div>

                  {/* Share URL Box */}
                  <div className="flex items-center justify-between rounded-[14px] border border-neutral-200 bg-neutral-50 px-3.5 py-2.5">
                    <span className="truncate font-mono text-xs text-neutral-700 mr-2">
                      {wallet?.status === "ACTIVE"
                        ? latestShareUrl
                        : "Payment link unavailable (wallet setup pending)"}
                    </span>
                    <button
                      type="button"
                      disabled={wallet?.status !== "ACTIVE"}
                      onClick={() => copyAddress("share-url", latestShareUrl)}
                      className="shrink-0 rounded-full border border-neutral-200 bg-white px-3 py-1 text-xs font-semibold text-neutral-900 hover:bg-neutral-100 disabled:opacity-40"
                    >
                      {copiedKey === "share-url" ? "Copied" : "Copy"}
                    </button>
                  </div>

                  {/* 3 Action Buttons */}
                  <div className="grid grid-cols-3 gap-2.5">
                    <button
                      type="button"
                      disabled={wallet?.status !== "ACTIVE"}
                      onClick={() => copyAddress("share-btn", latestShareUrl)}
                      className="rounded-[12px] border border-neutral-200 bg-white py-2.5 text-xs font-semibold text-neutral-800 hover:bg-neutral-50 disabled:opacity-40"
                    >
                      Copy Link
                    </button>
                    <button
                      type="button"
                      disabled={wallet?.status !== "ACTIVE"}
                      onClick={() => copyAddress("qr-btn", latestShareUrl)}
                      className="rounded-[12px] border border-neutral-200 bg-white py-2.5 text-xs font-semibold text-neutral-800 hover:bg-neutral-50 disabled:opacity-40"
                    >
                      Show QR
                    </button>
                    {paymentRequests[0] && wallet?.status === "ACTIVE" ? (
                      <Link
                        prefetch={false}
                        href={`/pay/${paymentRequests[0].publicId}`}
                        className="flex items-center justify-center rounded-[12px] border border-neutral-200 bg-white py-2.5 text-xs font-semibold text-neutral-800 hover:bg-neutral-50"
                      >
                        Open Link
                      </Link>
                    ) : (
                      <button
                        type="button"
                        disabled
                        className="rounded-[12px] border border-neutral-200 bg-white py-2.5 text-xs font-semibold text-neutral-400 disabled:opacity-40"
                      >
                        Open Link
                      </button>
                    )}
                  </div>
                </div>
              </div>

              {/* Created Payment Links Table */}
              {paymentRequests.length > 0 && (
                <div className="rounded-[24px] border border-neutral-200/90 bg-white p-6 shadow-2xs space-y-4">
                  <h2 className="font-serif text-2xl text-neutral-950">
                    Your payment links
                  </h2>
                  <div className="divide-y divide-neutral-100">
                    {paymentRequests.map((req) => (
                      <div
                        key={req.id}
                        className="flex flex-wrap items-center justify-between gap-4 py-4"
                      >
                        <div>
                          <div className="flex items-center gap-2">
                            <p className="font-display text-sm font-bold text-neutral-950">
                              {req.title}
                            </p>
                            <span
                              className={`rounded-full px-2.5 py-0.5 text-[10px] font-bold uppercase ${
                                req.status === "ACTIVE"
                                  ? "bg-emerald-50 text-emerald-700"
                                  : "bg-neutral-100 text-neutral-600"
                              }`}
                            >
                              {req.status}
                            </span>
                          </div>
                          <p className="mt-1 text-xs text-neutral-500">
                            Destination: {req.destinationAssetSymbol} on{" "}
                            {req.destinationNetwork} ·{" "}
                            {req.amountMode === "FIXED"
                              ? `${req.displayAmount} ${req.destinationAssetSymbol}`
                              : "Open amount"}
                          </p>
                          <p className="mt-0.5 font-mono text-[11px] text-neutral-400">
                            {req.shareUrl}
                          </p>
                        </div>

                        <div className="flex items-center gap-2">
                          <Link
                            prefetch={false}
                            href={`/pay/${req.publicId}`}
                            className="rounded-full bg-neutral-950 px-3.5 py-1.5 text-xs font-semibold text-white hover:bg-neutral-800"
                          >
                            Open Checkout
                          </Link>
                          <button
                            type="button"
                            onClick={() =>
                              copyAddress(`req-${req.id}`, req.shareUrl)
                            }
                            className="rounded-full border border-neutral-200 bg-white px-3.5 py-1.5 text-xs font-semibold text-neutral-800 hover:bg-neutral-50"
                          >
                            {copiedKey === `req-${req.id}`
                              ? "Copied"
                              : "Copy Link"}
                          </button>
                          {req.status === "ACTIVE" && (
                            <button
                              type="button"
                              onClick={() =>
                                handleDisablePaymentRequest(req.id)
                              }
                              className="rounded-full border border-red-200 bg-red-50 px-3.5 py-1.5 text-xs font-semibold text-[#FF1A1A] hover:bg-red-100"
                            >
                              Disable
                            </button>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}

          {/* ================================================================
              TAB 4: ACTIVITY (Matches 08_26_21 PM-9.png & Flow Activity Transaction Dashboard-11.png)
             ================================================================ */}
          {activeTab === "activity" && (
            <div className="space-y-6">
              <div className="flex flex-wrap items-end justify-between gap-4">
                <div>
                  <h1 className="font-serif text-3xl sm:text-[42px] font-normal tracking-[-0.02em] text-neutral-950">
                    <span className="relative inline-block">
                      Activity
                      <svg
                        viewBox="0 0 150 12"
                        fill="none"
                        className="absolute -bottom-1 left-0 w-full h-2.5"
                      >
                        <path
                          d="M3 9 C50 2, 100 2, 147 8"
                          stroke="#FF1A1A"
                          strokeWidth="3.5"
                          strokeLinecap="round"
                        />
                      </svg>
                    </span>
                  </h1>
                  <p className="mt-2 text-sm text-neutral-600">
                    Track every payment, transfer, invoice, and settlement
                    across your wallets.
                  </p>
                </div>

                <div className="flex flex-wrap items-center gap-2.5">
                  <button
                    type="button"
                    onClick={handleSyncActivities}
                    disabled={activityLoading}
                    className="inline-flex items-center gap-1.5 rounded-full border border-neutral-200 bg-white px-4 py-2 text-xs font-semibold text-neutral-800 shadow-2xs hover:bg-neutral-50 disabled:opacity-50"
                  >
                    <IconRefresh
                      size={13}
                      className={activityLoading ? "animate-spin" : ""}
                    />
                    {activityLoading ? "Syncing..." : "Sync On-Chain Activity"}
                  </button>
                  <button
                    type="button"
                    onClick={() => setActiveTab("receive")}
                    className="inline-flex items-center gap-1.5 rounded-full bg-neutral-950 px-4 py-2 text-xs font-semibold text-white hover:bg-neutral-800"
                  >
                    Create payment link →
                  </button>
                </div>
              </div>

              {/* Filter Pills */}
              <div className="flex flex-wrap items-center gap-2">
                {[
                  { key: "all", label: "All activity" },
                  { key: "sent", label: "↗ Sent" },
                  { key: "received", label: "↙ Received" },
                  { key: "links", label: "🔗 Links" },
                  { key: "invoices", label: "📄 Invoices" },
                ].map((pill) => (
                  <button
                    key={pill.key}
                    type="button"
                    onClick={() => setActivityCategory(pill.key)}
                    className={`rounded-full px-4 py-1.5 text-xs font-semibold transition-all ${
                      activityCategory === pill.key
                        ? "bg-neutral-950 text-white shadow-2xs"
                        : "border border-neutral-200 bg-white text-neutral-700 hover:bg-neutral-50"
                    }`}
                  >
                    {pill.label}
                  </button>
                ))}
              </div>

              {/* Search + Network Filter Bar */}
              <div className="flex flex-wrap items-center justify-between gap-3 rounded-[20px] border border-neutral-200/80 bg-white p-3 shadow-2xs">
                <div className="relative flex-1 min-w-[220px]">
                  <IconSearch
                    size={15}
                    className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-neutral-400"
                  />
                  <input
                    type="search"
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    placeholder="Search by name, wallet, link, or transaction hash..."
                    className="w-full rounded-full border border-neutral-200 bg-neutral-50 pl-9 pr-4 py-1.5 text-xs text-neutral-900 placeholder:text-neutral-400 focus:border-neutral-900 focus:bg-white focus:outline-none"
                  />
                </div>
                <div className="flex items-center gap-2">
                  <span className="rounded-full border border-neutral-200 bg-white px-3.5 py-1.5 text-xs font-medium text-neutral-700">
                    Last 30 days ▾
                  </span>
                  <span className="rounded-full border border-neutral-200 bg-white px-3.5 py-1.5 text-xs font-medium text-neutral-700">
                    All networks ({activityTotal + paymentRequests.length})
                  </span>
                </div>
              </div>

              {/* Activity Table */}
              <div className="overflow-hidden rounded-[24px] border border-neutral-200/90 bg-white shadow-2xs">
                <div className="overflow-x-auto">
                  <table className="w-full text-left border-collapse">
                    <thead>
                      <tr className="border-b border-neutral-100 text-[11px] font-semibold uppercase tracking-wider text-neutral-400">
                        <th className="py-3.5 pl-6 pr-3">Date &amp; Time</th>
                        <th className="py-3.5 px-3">Transaction</th>
                        <th className="py-3.5 px-3">Type</th>
                        <th className="py-3.5 px-3">Network</th>
                        <th className="py-3.5 px-3 text-right">Amount</th>
                        <th className="py-3.5 pl-3 pr-6 text-right">Status</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-neutral-100 text-xs">
                      {/* Real On-Chain Activities */}
                      {activities
                        .filter((act) => {
                          if (
                            activityCategory === "sent" &&
                            act.direction !== "OUTGOING"
                          ) {
                            return false;
                          }
                          if (
                            activityCategory === "received" &&
                            act.direction !== "INCOMING"
                          ) {
                            return false;
                          }
                          if (
                            activityCategory === "links" ||
                            activityCategory === "invoices"
                          ) {
                            return false;
                          }
                          const q = searchQuery.trim().toLowerCase();
                          if (!q) return true;
                          return (
                            act.txHash.toLowerCase().includes(q) ||
                            act.network.toLowerCase().includes(q) ||
                            act.assetSymbol.toLowerCase().includes(q)
                          );
                        })
                        .map((act) => {
                          const explorer = getExplorerUrl(
                            act.network,
                            act.txHash,
                          );
                          return (
                            <tr
                              key={act.id}
                              className="hover:bg-neutral-50/80 transition-colors"
                            >
                              <td className="py-4 pl-6 pr-3 text-neutral-500 whitespace-nowrap">
                                {formatTimestamp(act.blockTimestamp)}
                              </td>
                              <td className="py-4 px-3">
                                <p className="font-display font-bold text-neutral-950">
                                  {act.direction === "INCOMING"
                                    ? "Inbound Transfer"
                                    : "Outbound Transfer"}
                                </p>
                                <p className="font-mono text-[11px] text-neutral-400">
                                  {truncateMiddle(act.txHash, 8, 6)}
                                  {explorer && (
                                    <a
                                      href={explorer}
                                      target="_blank"
                                      rel="noreferrer"
                                      className="ml-2 text-[#FF1A1A] hover:underline"
                                    >
                                      Explorer ↗
                                    </a>
                                  )}
                                </p>
                              </td>
                              <td className="py-4 px-3">
                                <span
                                  className={`inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-[11px] font-semibold ${
                                    act.direction === "INCOMING"
                                      ? "bg-emerald-50 text-emerald-700"
                                      : "bg-red-50 text-[#FF1A1A]"
                                  }`}
                                >
                                  {act.direction === "INCOMING"
                                    ? "↓ In"
                                    : "↑ Out"}
                                </span>
                              </td>
                              <td className="py-4 px-3">
                                <span className="inline-flex items-center gap-1.5 font-medium text-neutral-800">
                                  <ChainBadge
                                    chainKey={act.network}
                                    size={16}
                                  />
                                  {act.network}
                                </span>
                              </td>
                              <td className="py-4 px-3 text-right font-display font-bold text-neutral-950">
                                {act.displayAmount} {act.assetSymbol}
                              </td>
                              <td className="py-4 pl-3 pr-6 text-right">
                                <span className="inline-flex items-center gap-1 rounded-full bg-emerald-50 px-2.5 py-1 text-[11px] font-semibold text-emerald-700">
                                  <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
                                  {act.finality}
                                </span>
                              </td>
                            </tr>
                          );
                        })}

                      {/* Real Payment Requests & Links */}
                      {paymentRequests
                        .filter((req) => {
                          if (activityCategory === "sent") return false;
                          if (
                            activityCategory === "received" &&
                            req.status !== "COMPLETED"
                          ) {
                            return false;
                          }
                          const q = searchQuery.trim().toLowerCase();
                          if (!q) return true;
                          return (
                            req.title.toLowerCase().includes(q) ||
                            req.publicId.toLowerCase().includes(q) ||
                            req.destinationNetwork.toLowerCase().includes(q) ||
                            req.destinationAssetSymbol.toLowerCase().includes(q)
                          );
                        })
                        .map((req) => (
                          <tr
                            key={req.id}
                            className="hover:bg-neutral-50/80 transition-colors"
                          >
                            <td className="py-4 pl-6 pr-3 text-neutral-500 whitespace-nowrap">
                              {formatTimestamp(req.createdAt)}
                            </td>
                            <td className="py-4 px-3">
                              <p className="font-display font-bold text-neutral-950">
                                {req.title}
                              </p>
                              <p className="text-[11px] text-neutral-500">
                                <Link
                                  prefetch={false}
                                  href={`/pay/${req.publicId}`}
                                  className="font-mono text-neutral-500 hover:text-[#FF1A1A] hover:underline"
                                >
                                  /pay/{req.publicId}
                                </Link>
                              </p>
                            </td>
                            <td className="py-4 px-3">
                              <span className="inline-flex items-center gap-1 rounded-full bg-neutral-100 px-2.5 py-0.5 text-[11px] font-semibold text-neutral-800">
                                🔗 Link
                              </span>
                            </td>
                            <td className="py-4 px-3">
                              <span className="inline-flex items-center gap-1.5 font-medium text-neutral-800">
                                <ChainBadge
                                  chainKey={req.destinationNetwork}
                                  size={16}
                                />
                                {req.destinationNetwork}
                              </span>
                            </td>
                            <td className="py-4 px-3 text-right">
                              <p className="font-display font-bold text-neutral-950">
                                {req.amountMode === "FIXED"
                                  ? `${req.displayAmount} ${req.destinationAssetSymbol}`
                                  : "Open amount"}
                              </p>
                            </td>
                            <td className="py-4 pl-3 pr-6 text-right">
                              <span
                                className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-semibold ${
                                  req.status === "COMPLETED"
                                    ? "bg-emerald-50 text-emerald-700"
                                    : req.status === "ACTIVE"
                                      ? "bg-amber-50 text-amber-700"
                                      : "bg-neutral-100 text-neutral-600"
                                }`}
                              >
                                <span
                                  className={`h-1.5 w-1.5 rounded-full ${
                                    req.status === "COMPLETED"
                                      ? "bg-emerald-500"
                                      : req.status === "ACTIVE"
                                        ? "bg-amber-500"
                                        : "bg-neutral-400"
                                  }`}
                                />
                                {req.status}
                              </span>
                            </td>
                          </tr>
                        ))}

                      {activities.length === 0 &&
                        paymentRequests.length === 0 && (
                          <tr>
                            <td
                              colSpan={6}
                              className="py-10 text-center text-xs text-neutral-500"
                            >
                              No on-chain transactions or payment requests
                              recorded yet.
                            </td>
                          </tr>
                        )}
                    </tbody>
                  </table>
                </div>

                {/* Pagination Bar */}
                <div className="flex items-center justify-between border-t border-neutral-100 px-6 py-3.5 text-xs text-neutral-500">
                  <span>
                    Showing {activities.length + paymentRequests.length} of{" "}
                    {activityTotal + paymentRequests.length} records
                  </span>
                  <div className="flex items-center gap-1">
                    <span className="rounded-lg bg-neutral-950 px-2.5 py-1 font-semibold text-white">
                      1
                    </span>
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* ================================================================
              TAB 5: SEND & CONVERT (With Ecosystem Address Validation)
             ================================================================ */}
          {activeTab === "send" && (
            <div className="space-y-6">
              <div>
                <p className="text-[11px] font-bold uppercase tracking-[0.14em] text-[#FF1A1A]">
                  MOVE FUNDS
                </p>
                <h1 className="mt-1 font-serif text-3xl sm:text-[40px] font-normal tracking-[-0.02em] text-neutral-950">
                  Send &amp; Convert
                </h1>
                <p className="mt-1 text-sm text-neutral-600">
                  Send assets across Ethereum, Base, Solana, and NEAR with
                  automatic route discovery.
                </p>
              </div>

              <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
                <div className="lg:col-span-7 rounded-[26px] border border-neutral-200/90 bg-white p-6 sm:p-8 shadow-sm space-y-5">
                  <div className="grid grid-cols-2 rounded-full bg-neutral-100 p-1">
                    <button
                      type="button"
                      onClick={() => setSendMode("send")}
                      className={`rounded-full py-2 text-xs font-semibold transition-all ${
                        sendMode === "send"
                          ? "bg-neutral-950 text-white shadow-xs"
                          : "text-neutral-600"
                      }`}
                    >
                      ↗ Send to Recipient
                    </button>
                    <button
                      type="button"
                      onClick={() => setSendMode("convert")}
                      className={`rounded-full py-2 text-xs font-semibold transition-all ${
                        sendMode === "convert"
                          ? "bg-neutral-950 text-white shadow-xs"
                          : "text-neutral-600"
                      }`}
                    >
                      ⇄ Convert Between Wallets
                    </button>
                  </div>

                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                    <div>
                      <label
                        htmlFor="send-source-select"
                        className="block text-xs font-semibold text-neutral-800 mb-1.5"
                      >
                        From asset
                      </label>
                      <select
                        id="send-source-select"
                        value={sourceDeploymentId}
                        onChange={(e) => setSourceDeploymentId(e.target.value)}
                        className="w-full rounded-[14px] border border-neutral-200 bg-white px-3.5 py-2.5 text-xs font-semibold text-neutral-950"
                      >
                        {MAINNET_SUPPORTED_DEPLOYMENTS.map((d) => (
                          <option key={d.id} value={d.id}>
                            {d.symbol} ({d.networkName})
                          </option>
                        ))}
                      </select>
                      <p className="mt-1 text-[11px] text-neutral-500">
                        Available:{" "}
                        {sourceObservedBalance?.displayBalance ?? "0"}{" "}
                        {sourceDeployment.symbol}
                      </p>
                    </div>

                    <div>
                      <label
                        htmlFor="send-dest-select"
                        className="block text-xs font-semibold text-neutral-800 mb-1.5"
                      >
                        To destination asset
                      </label>
                      <select
                        id="send-dest-select"
                        value={destDeploymentId}
                        onChange={(e) => setDestDeploymentId(e.target.value)}
                        className="w-full rounded-[14px] border border-neutral-200 bg-white px-3.5 py-2.5 text-xs font-semibold text-neutral-950"
                      >
                        {MAINNET_SUPPORTED_DEPLOYMENTS.map((d) => (
                          <option key={d.id} value={d.id}>
                            {d.symbol} ({d.networkName})
                          </option>
                        ))}
                      </select>
                    </div>
                  </div>

                  <div>
                    <label
                      htmlFor="send-amount-input"
                      className="block text-xs font-semibold text-neutral-800 mb-1.5"
                    >
                      Amount ({sourceDeployment.symbol})
                    </label>
                    <input
                      id="send-amount-input"
                      type="text"
                      value={sendAmount}
                      onChange={(e) => setSendAmount(e.target.value)}
                      placeholder="0.00"
                      className="w-full rounded-[14px] border border-neutral-200 bg-white px-4 py-3 font-display text-lg font-bold text-neutral-950"
                    />
                  </div>

                  {sendMode === "send" && (
                    <div>
                      <label
                        htmlFor="recipient-address-input"
                        className="block text-xs font-semibold text-neutral-800 mb-1.5"
                      >
                        Recipient {destDeployment.networkName} address
                      </label>
                      <input
                        id="recipient-address-input"
                        type="text"
                        value={recipientAddress}
                        onChange={(e) => setRecipientAddress(e.target.value)}
                        placeholder={
                          ECOSYSTEM_METADATA.find(
                            (m) => m.family === destDeployment.ecosystem,
                          )?.addressPlaceholder ?? "0x..."
                        }
                        className="w-full rounded-[14px] border border-neutral-200 bg-white px-4 py-3 font-mono text-xs text-neutral-950"
                      />
                      {recipientAddress.trim().length > 0 && (
                        <p
                          className={`mt-1.5 text-xs font-medium ${
                            addressValidation.valid
                              ? "text-emerald-600"
                              : "text-[#FF1A1A]"
                          }`}
                        >
                          {addressValidation.valid
                            ? `Valid ${destDeployment.networkName} address format.`
                            : addressValidation.reason}
                        </p>
                      )}
                    </div>
                  )}

                  <button
                    type="button"
                    disabled
                    className="w-full rounded-full bg-neutral-200 py-3.5 text-xs font-semibold text-neutral-600 cursor-not-allowed"
                  >
                    Outgoing Execution Disabled (Safety Gate Active)
                  </button>
                </div>

                {/* Right Column: Invoices Summary Card (Matches Storyboard Screen 12) */}
                <div className="lg:col-span-5 rounded-[26px] border border-neutral-200/90 bg-white p-6 shadow-sm space-y-4">
                  <div className="flex items-center justify-between">
                    <div>
                      <span className="text-[10px] font-bold uppercase tracking-[0.14em] text-[#FF1A1A]">
                        INVOICES &amp; REQUESTS
                      </span>
                      <h2 className="font-serif text-xl text-neutral-950">
                        Recent Invoices
                      </h2>
                    </div>
                    <button
                      type="button"
                      onClick={() => setActiveTab("receive")}
                      className="rounded-full bg-[#FF1A1A] px-3.5 py-1.5 text-xs font-semibold text-white"
                    >
                      + New Invoice
                    </button>
                  </div>

                  {paymentRequests.length === 0 ? (
                    <div className="rounded-[16px] border border-dashed border-neutral-200 bg-neutral-50/70 p-5 text-center text-xs text-neutral-500">
                      No payment requests or invoices created yet.
                    </div>
                  ) : (
                    <div className="divide-y divide-neutral-100 text-xs">
                      {paymentRequests.slice(0, 4).map((req) => (
                        <div
                          key={req.id}
                          className="py-3 flex items-center justify-between"
                        >
                          <div>
                            <p className="font-bold text-neutral-950">
                              {req.title}
                            </p>
                            <p className="text-neutral-500">
                              {req.destinationAssetSymbol} ·{" "}
                              {req.destinationNetwork}
                            </p>
                          </div>
                          <div className="text-right">
                            <p className="font-display font-bold text-neutral-950">
                              {req.amountMode === "FIXED"
                                ? `${req.displayAmount} ${req.destinationAssetSymbol}`
                                : "Open"}
                            </p>
                            <span
                              className={`text-[10px] font-semibold ${
                                req.status === "COMPLETED"
                                  ? "text-emerald-600"
                                  : req.status === "ACTIVE"
                                    ? "text-amber-600"
                                    : "text-neutral-500"
                              }`}
                            >
                              {req.status}
                            </span>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* =====================================================================
          MOBILE FLOATING DARK BOTTOM NAVIGATION BAR
          (Matches 08_56_23 PM-4.png & Flow Mobile Dashboard Overview-5.png)
         ===================================================================== */}
      <nav
        aria-label="Mobile bottom navigation"
        className="lg:hidden fixed bottom-4 inset-x-4 z-40 rounded-[28px] bg-[#0B0B0B] px-2.5 py-2 text-white shadow-2xl border border-white/10"
      >
        <div className="grid grid-cols-5 gap-1 items-center">
          <button
            type="button"
            onClick={() => setActiveTab("dashboard")}
            className={`flex flex-col items-center justify-center rounded-[20px] py-2 text-[10px] font-semibold transition-all ${
              activeTab === "dashboard"
                ? "bg-[#FF1A1A] text-white shadow-sm"
                : "text-neutral-400"
            }`}
          >
            <span>⌂</span>
            <span className="mt-0.5">Home</span>
          </button>

          <button
            type="button"
            onClick={() => setActiveTab("send")}
            className={`flex flex-col items-center justify-center rounded-[20px] py-2 text-[10px] font-semibold transition-all ${
              activeTab === "send"
                ? "bg-[#FF1A1A] text-white shadow-sm"
                : "text-neutral-400"
            }`}
          >
            <span>↗</span>
            <span className="mt-0.5">Send</span>
          </button>

          <button
            type="button"
            onClick={() => setActiveTab("receive")}
            className={`flex flex-col items-center justify-center rounded-[20px] py-2 text-[10px] font-semibold transition-all ${
              activeTab === "receive"
                ? "bg-[#FF1A1A] text-white shadow-sm"
                : "text-neutral-400"
            }`}
          >
            <span>↙</span>
            <span className="mt-0.5">Receive</span>
          </button>

          <button
            type="button"
            onClick={() => setActiveTab("assets")}
            className={`flex flex-col items-center justify-center rounded-[20px] py-2 text-[10px] font-semibold transition-all ${
              activeTab === "assets"
                ? "bg-[#FF1A1A] text-white shadow-sm"
                : "text-neutral-400"
            }`}
          >
            <span>▣</span>
            <span className="mt-0.5">Assets</span>
          </button>

          <button
            type="button"
            onClick={() => setActiveTab("activity")}
            className={`flex flex-col items-center justify-center rounded-[20px] py-2 text-[10px] font-semibold transition-all ${
              activeTab === "activity"
                ? "bg-[#FF1A1A] text-white shadow-sm"
                : "text-neutral-400"
            }`}
          >
            <span>◷</span>
            <span className="mt-0.5">Activity</span>
          </button>
        </div>
      </nav>
    </div>
  );
}

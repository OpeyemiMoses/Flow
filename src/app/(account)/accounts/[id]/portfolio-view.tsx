"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  FlowLogo,
  FlowWaveGraphic,
} from "../../../../components/flow-logo.tsx";
import {
  AssetAvatar,
  ChainBadge,
  IconActivity,
  IconBuilding,
  IconCheck,
  IconCopy,
  IconDashboard,
  IconLock,
  IconReceive,
  IconRefresh,
  IconSearch,
  IconSend,
  IconSettings,
  IconSwap,
  IconUsers,
  IconWallet,
} from "../../../../components/icons.tsx";
import {
  type CatalogTokenDeployment,
  CURATED_SUPPORTED_DEPLOYMENTS,
  ECOSYSTEM_METADATA,
  type EcosystemFamily,
  getEcosystemForNetworkKey,
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

function truncateMiddle(value: string, start = 8, end = 6): string {
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
  const [message, setMessage] = useState("");
  const [cooldown, setCooldown] = useState(
    initialPortfolio.cooldownRemainingSeconds ?? 0,
  );
  const [copiedKey, setCopiedKey] = useState<string | null>(null);

  // Filters for Assets & Activity views
  const [ecosystemFilter, setEcosystemFilter] = useState<
    "all" | EcosystemFamily
  >("all");
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedAssetId, setSelectedAssetId] = useState<string>(
    CURATED_SUPPORTED_DEPLOYMENTS[0].id,
  );

  // Send / Convert state
  const [sendMode, setSendMode] = useState<"send" | "convert">("send");
  const [sourceDeploymentId, setSourceDeploymentId] =
    useState<string>("base-sepolia:USDC");
  const [destDeploymentId, setDestDeploymentId] =
    useState<string>("solana-devnet:USDC");
  const [sendAmount, setSendAmount] = useState<string>("");
  const [recipientAddress, setRecipientAddress] = useState<string>("");

  // Receive preferences state
  const [receiveDeploymentId, setReceiveDeploymentId] =
    useState<string>("base-sepolia:USDC");

  // Multi-chain activity feed state
  const [activities, setActivities] = useState<
    SerializedWalletActivityRecord[]
  >([]);
  const [activityTotal, setActivityTotal] = useState<number>(0);
  const [activityLoading, setActivityLoading] = useState<boolean>(false);

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
    if (activeTab !== "activity") return;
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
      .catch(() => {
        // Graceful empty state on unauth or network error
      });
    return () => {
      active = false;
    };
  }, [accountId, activeTab]);

  // Payment Requests state (M5 Phase 1)
  const [paymentRequests, setPaymentRequests] = useState<
    SerializedPaymentRequest[]
  >([]);
  const [prTitle, setPrTitle] = useState<string>("");
  const [prDescription, setPrDescription] = useState<string>("");
  const [prAmountMode, setPrAmountMode] = useState<"FIXED" | "OPTIONAL">(
    "FIXED",
  );
  const [prAmount, setPrAmount] = useState<string>("10");
  const [prExpiresInHours, setPrExpiresInHours] = useState<number>(168);
  const [prCreating, setPrCreating] = useState<boolean>(false);

  useEffect(() => {
    if (activeTab !== "receive") return;
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

  // Merge real persisted balances with our curated supported token catalog
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
      setPrTitle("");
      setPrDescription("");
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

  const walletStatusLabel =
    currentAccount.walletStatus === "active"
      ? "Wallet provisioned (execution disabled)"
      : currentAccount.walletStatus === "provisioning"
        ? "Wallet provisioning in progress"
        : currentAccount.walletStatus === "setup_failed"
          ? "Wallet setup failed"
          : "Wallet setup pending";

  return (
    <div className="grid grid-cols-1 gap-6 lg:grid-cols-12 items-start">
      {/* Left Navigation Sidebar (Desktop & Tablet) */}
      <aside
        aria-label="Account workspace navigation"
        className="lg:col-span-3 xl:col-span-3 space-y-5 lg:sticky lg:top-20"
      >
        {/* Account Switcher Card */}
        <div className="flow-card p-4">
          <div className="flex items-center justify-between">
            <span className="text-[10px] font-bold uppercase tracking-wider text-[var(--text-muted)]">
              Active Workspace
            </span>
            <span
              className={`rounded-[4px] px-2 py-0.5 text-[10px] font-bold uppercase ${
                isBusiness
                  ? "bg-[#34D8B2]/15 text-[#0F9F80]"
                  : "bg-[#2563FF]/10 text-[#2563FF]"
              }`}
            >
              {isBusiness ? "Business account" : "Personal account"}
            </span>
          </div>

          <div className="mt-2.5 flex items-center gap-3">
            <span
              className={`inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-[10px] ${
                isBusiness
                  ? "bg-[#34D8B2]/15 text-[#0F9F80]"
                  : "bg-[#2563FF]/10 text-[#2563FF]"
              }`}
            >
              {isBusiness ? (
                <IconBuilding size={19} />
              ) : (
                <IconUsers size={19} />
              )}
            </span>
            <div className="min-w-0 flex-1">
              <p className="truncate font-display text-sm font-bold text-[var(--text-primary)]">
                {currentAccount.name}
              </p>
              <p className="text-[11px] text-[var(--text-muted)]">
                Role:{" "}
                <strong className="text-[var(--text-secondary)]">
                  {currentAccount.role.toLowerCase()}
                </strong>
              </p>
            </div>
          </div>

          {/* Account Switcher List */}
          {allAccounts.length > 1 && (
            <div className="mt-3.5 border-t border-[var(--border-subtle)] pt-3 space-y-1.5">
              <p className="text-[10px] font-bold uppercase tracking-wider text-[var(--text-muted)]">
                Switch Workspace
              </p>
              {personalAccounts.map((acc) => (
                <Link
                  key={acc.id}
                  prefetch={false}
                  href={`/accounts/${acc.id}`}
                  className={`flex items-center justify-between rounded-[8px] px-2.5 py-1.5 text-xs font-medium transition-colors ${
                    acc.id === accountId
                      ? "bg-[#2563FF]/10 text-[#2563FF] font-semibold"
                      : "text-[var(--text-secondary)] hover:bg-[var(--surface-subtle)]"
                  }`}
                >
                  <span className="truncate">{acc.name}</span>
                  <span className="text-[10px] uppercase opacity-75">
                    Personal
                  </span>
                </Link>
              ))}
              {businessAccounts.map((acc) => (
                <Link
                  key={acc.id}
                  prefetch={false}
                  href={`/accounts/${acc.id}`}
                  className={`flex items-center justify-between rounded-[8px] px-2.5 py-1.5 text-xs font-medium transition-colors ${
                    acc.id === accountId
                      ? "bg-[#2563FF]/10 text-[#2563FF] font-semibold"
                      : "text-[var(--text-secondary)] hover:bg-[var(--surface-subtle)]"
                  }`}
                >
                  <span className="truncate">{acc.name}</span>
                  <span className="text-[10px] uppercase opacity-75">
                    {acc.role.toLowerCase()}
                  </span>
                </Link>
              ))}
            </div>
          )}
        </div>

        {/* Primary Workspace Section Links */}
        <div className="flow-card p-3 space-y-1">
          <button
            type="button"
            onClick={() => setActiveTab("dashboard")}
            className={`flex w-full items-center gap-3 rounded-[8px] px-3 py-2.5 text-xs font-semibold transition-colors ${
              activeTab === "dashboard"
                ? "bg-[#0B1F4B] text-white shadow-xs"
                : "text-[var(--text-secondary)] hover:bg-[var(--surface-subtle)] hover:text-[var(--text-primary)]"
            }`}
          >
            <IconDashboard size={17} />
            <span>
              {isBusiness ? "Treasury Dashboard" : "Portfolio Dashboard"}
            </span>
          </button>

          <button
            type="button"
            onClick={() => setActiveTab("assets")}
            className={`flex w-full items-center gap-3 rounded-[8px] px-3 py-2.5 text-xs font-semibold transition-colors ${
              activeTab === "assets"
                ? "bg-[#0B1F4B] text-white shadow-xs"
                : "text-[var(--text-secondary)] hover:bg-[var(--surface-subtle)] hover:text-[var(--text-primary)]"
            }`}
          >
            <IconWallet size={17} />
            <span>Wallets &amp; Assets</span>
          </button>

          <button
            type="button"
            onClick={() => setActiveTab("send")}
            className={`flex w-full items-center gap-3 rounded-[8px] px-3 py-2.5 text-xs font-semibold transition-colors ${
              activeTab === "send"
                ? "bg-[#0B1F4B] text-white shadow-xs"
                : "text-[var(--text-secondary)] hover:bg-[var(--surface-subtle)] hover:text-[var(--text-primary)]"
            }`}
          >
            <IconSend size={17} />
            <span>Send &amp; Convert</span>
          </button>

          <button
            type="button"
            onClick={() => setActiveTab("receive")}
            className={`flex w-full items-center gap-3 rounded-[8px] px-3 py-2.5 text-xs font-semibold transition-colors ${
              activeTab === "receive"
                ? "bg-[#0B1F4B] text-white shadow-xs"
                : "text-[var(--text-secondary)] hover:bg-[var(--surface-subtle)] hover:text-[var(--text-primary)]"
            }`}
          >
            <IconReceive size={17} />
            <span>Receive &amp; Links</span>
          </button>

          <button
            type="button"
            onClick={() => setActiveTab("activity")}
            className={`flex w-full items-center gap-3 rounded-[8px] px-3 py-2.5 text-xs font-semibold transition-colors ${
              activeTab === "activity"
                ? "bg-[#0B1F4B] text-white shadow-xs"
                : "text-[var(--text-secondary)] hover:bg-[var(--surface-subtle)] hover:text-[var(--text-primary)]"
            }`}
          >
            <IconActivity size={17} />
            <span>Activity &amp; Audit</span>
          </button>

          <div className="my-2 border-t border-[var(--border-subtle)]" />

          <Link
            prefetch={false}
            href="/security"
            className="flex w-full items-center gap-3 rounded-[8px] px-3 py-2.5 text-xs font-semibold text-[var(--text-secondary)] hover:bg-[var(--surface-subtle)] hover:text-[var(--text-primary)] transition-colors"
          >
            <IconSettings size={17} />
            <span>Security &amp; Preferences</span>
          </Link>
        </div>

        {/* Sidebar Wave Callout Card (matching Reference #4-#10) */}
        <div className="flow-navy-banner relative overflow-hidden p-5">
          <FlowWaveGraphic className="absolute inset-x-0 bottom-0 h-28 w-full opacity-80" />
          <div className="relative z-10 space-y-2">
            <FlowLogo size={22} variant="inverse" />
            <p className="font-display text-sm font-bold text-white">
              Move value anywhere
            </p>
            <p className="text-[11px] leading-relaxed text-slate-200">
              Senders select their source network and asset; recipients settle
              in their chosen destination asset across Ethereum, Base, Solana,
              and NEAR.
            </p>
          </div>
        </div>
      </aside>

      {/* Main Content Area (9 Columns on Desktop) */}
      <div className="lg:col-span-9 xl:col-span-9 space-y-6">
        {/* Top Account Workspace Identity Bar */}
        <section className="flow-card p-6">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div>
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-xs font-bold uppercase tracking-wider text-[#2563FF]">
                  {isBusiness
                    ? "Business account · Treasury & Team"
                    : "Personal account · Your Portfolio"}
                </span>
                <span className="rounded-[4px] border border-[var(--border-subtle)] bg-[var(--surface-subtle)] px-2 py-0.5 text-[11px] font-semibold text-[var(--text-secondary)]">
                  {currentAccount.role.toLowerCase()}
                </span>
              </div>

              <h1 className="mt-1.5 font-display text-2xl font-extrabold tracking-tight text-[var(--text-primary)] sm:text-3xl">
                {currentAccount.name}
              </h1>

              {/* Single canonical wallet status text required by Playwright integration test */}
              <div className="mt-2.5 flex flex-wrap items-center gap-2.5">
                <p className="inline-flex items-center gap-1.5 rounded-[6px] border border-amber-200 bg-amber-50 dark:bg-amber-950/50 dark:border-amber-800 px-3 py-1 text-xs font-semibold text-amber-900 dark:text-amber-300">
                  <span className="h-2 w-2 rounded-full bg-amber-500" />
                  {walletStatusLabel}
                </p>
                {portfolio.lastSyncedAt && (
                  <span
                    className={`inline-flex items-center rounded-[6px] border px-2.5 py-1 text-xs font-semibold ${
                      portfolio.isStale
                        ? "border-amber-200 bg-amber-50 text-amber-800"
                        : "border-emerald-200 bg-emerald-50 text-emerald-800"
                    }`}
                  >
                    {portfolio.isStale ? "Stale " : "Synced "}
                    {formatTimestamp(portfolio.lastSyncedAt)}
                  </span>
                )}
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-2.5">
              <button
                type="button"
                onClick={handleRefresh}
                disabled={refreshing || cooldown > 0}
                className="flow-btn-secondary inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-semibold disabled:opacity-50"
              >
                <IconRefresh
                  size={14}
                  className={refreshing ? "animate-spin" : ""}
                />
                {refreshing
                  ? "Refreshing RPC..."
                  : cooldown > 0
                    ? `Wait ${cooldown}s`
                    : "Refresh Balances"}
              </button>

              {canManageTeam ? (
                <Link
                  prefetch={false}
                  href={`/accounts/${currentAccount.id}/team`}
                  className="flow-btn-primary inline-flex items-center gap-1.5 px-4 py-2 text-xs"
                >
                  <IconUsers size={14} />
                  Manage team
                </Link>
              ) : null}
            </div>
          </div>

          <div className="mt-3">
            <Feedback text={message} />
          </div>
        </section>

        {/* ================================================================
            TAB 1: DASHBOARD (Personal Portfolio OR Business Treasury)
           ================================================================ */}
        {activeTab === "dashboard" && (
          <div className="space-y-6">
            {/* Hero Portfolio / Treasury Banner */}
            <section className="flow-navy-banner relative overflow-hidden p-6 sm:p-8">
              <FlowWaveGraphic className="absolute inset-x-0 bottom-0 h-40 w-full opacity-85" />
              <div className="relative z-10 grid grid-cols-1 gap-6 lg:grid-cols-12 items-center">
                <div className="lg:col-span-7 space-y-2">
                  <span className="text-xs font-semibold uppercase tracking-wider text-[#34D8B2]">
                    {isBusiness
                      ? "Organization Multi-Chain Treasury"
                      : "Multi-Chain Portfolio Overview"}
                  </span>
                  <div className="flex flex-wrap items-baseline gap-3">
                    <p
                      className="font-display text-4xl font-extrabold tracking-tight text-white sm:text-5xl"
                      data-testid="portfolio-total-usd"
                    >
                      $0.00
                    </p>
                    <span className="rounded-[4px] bg-white/10 px-2.5 py-0.5 text-xs font-semibold text-slate-200">
                      {balances.length} Tracked Balance Observation(s) ·
                      Read-Only RPC
                    </span>
                  </div>
                  <p className="max-w-xl text-xs leading-relaxed text-slate-300">
                    {wallet?.disclaimer ??
                      "Real-time on-chain balances across NEAR, Base, and Solana. Execution is disabled (FLOW_EXECUTION=disabled); accounts are strictly ineligible for live deposits or transfers."}
                  </p>
                </div>

                <div className="lg:col-span-5 flex flex-wrap gap-2.5 lg:justify-end">
                  <button
                    type="button"
                    onClick={() => {
                      setSendMode("send");
                      setActiveTab("send");
                    }}
                    className="flow-btn-primary inline-flex items-center gap-1.5 px-4 py-2.5 text-xs"
                  >
                    <IconSend size={15} />
                    Send
                  </button>
                  <button
                    type="button"
                    onClick={() => setActiveTab("receive")}
                    className="inline-flex items-center gap-1.5 rounded-[8px] border border-white/20 bg-white/10 px-4 py-2.5 text-xs font-semibold text-white hover:bg-white/15 transition-colors"
                  >
                    <IconReceive size={15} />
                    Receive
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setSendMode("convert");
                      setActiveTab("send");
                    }}
                    className="inline-flex items-center gap-1.5 rounded-[8px] border border-white/20 bg-white/10 px-4 py-2.5 text-xs font-semibold text-white hover:bg-white/15 transition-colors"
                  >
                    <IconSwap size={15} />
                    Convert
                  </button>
                  <button
                    type="button"
                    onClick={() => setActiveTab("assets")}
                    className="inline-flex items-center gap-1.5 rounded-[8px] border border-white/20 bg-white/10 px-4 py-2.5 text-xs font-semibold text-white hover:bg-white/15 transition-colors"
                  >
                    <IconWallet size={15} />
                    Asset Registry
                  </button>
                </div>
              </div>

              {/* Business KPI Metric Strip (Reference #5) */}
              {isBusiness && (
                <div className="relative z-10 mt-6 grid grid-cols-2 gap-3 border-t border-white/15 pt-5 sm:grid-cols-4">
                  <div className="rounded-[10px] border border-white/10 bg-white/5 p-3">
                    <span className="text-[11px] text-slate-300">
                      Custody Status
                    </span>
                    <p className="mt-1 font-display text-sm font-bold text-white">
                      {wallet?.status ?? "PROVISIONING"}
                    </p>
                  </div>
                  <div className="rounded-[10px] border border-white/10 bg-white/5 p-3">
                    <span className="text-[11px] text-slate-300">
                      Derived Addresses
                    </span>
                    <p className="mt-1 font-display text-lg font-bold text-white">
                      {wallet?.addresses.length ?? 0}
                    </p>
                  </div>
                  <div className="rounded-[10px] border border-white/10 bg-white/5 p-3">
                    <span className="text-[11px] text-slate-300">
                      Balance Observations
                    </span>
                    <p className="mt-1 font-display text-lg font-bold text-white">
                      {balances.length}
                    </p>
                  </div>
                  <div className="rounded-[10px] border border-white/10 bg-white/5 p-3">
                    <span className="text-[11px] text-slate-300">
                      Your Workspace Role
                    </span>
                    <p className="mt-1 font-display text-lg font-bold text-[#34D8B2]">
                      {currentAccount.role}
                    </p>
                  </div>
                </div>
              )}
            </section>

            {/* 2-Column Dashboard Content */}
            <div className="grid grid-cols-1 gap-6 xl:grid-cols-12">
              {/* Left 8 Columns: Persisted Balances & Registered Wallets */}
              <div className="xl:col-span-8 space-y-6">
                {/* Real Persisted On-Chain Balance Observations */}
                <section className="flow-card p-6">
                  <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[var(--border-subtle)] pb-4">
                    <div>
                      <h2 className="font-display text-base font-bold text-[var(--text-primary)]">
                        Tracked Assets &amp; Balances
                      </h2>
                      <p className="text-xs text-[var(--text-secondary)]">
                        Real on-chain balance observations across registered
                        account wallets.
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={() => setActiveTab("assets")}
                      className="text-xs font-semibold text-[#2563FF] hover:underline"
                    >
                      Explore All {CURATED_SUPPORTED_DEPLOYMENTS.length}{" "}
                      Supported Assets →
                    </button>
                  </div>

                  {balances.length === 0 ? (
                    <div
                      className="mt-4 rounded-[12px] border border-dashed border-[var(--border-strong)] bg-[var(--surface-subtle)]/50 p-6 text-center"
                      data-testid="portfolio-empty-balances"
                    >
                      <p className="text-sm font-semibold text-[var(--text-primary)]">
                        No balance observations recorded yet
                      </p>
                      <p className="mt-1 text-xs text-[var(--text-secondary)]">
                        Click &quot;Refresh Balances&quot; to fetch the latest
                        on-chain state from testnet RPCs, or open Wallets &amp;
                        Assets to browse the multi-chain token registry.
                      </p>
                    </div>
                  ) : (
                    <div className="mt-4 space-y-3">
                      {balances.map((b: SerializedWalletBalanceRecord) => (
                        <div
                          key={b.id}
                          className="flex flex-wrap items-center justify-between gap-3 rounded-[12px] border border-[var(--border-subtle)] bg-[var(--surface-subtle)]/40 p-4"
                        >
                          <div className="flex items-center gap-3">
                            <AssetAvatar
                              symbol={b.networkAsset.asset.symbol}
                              size={34}
                            />
                            <div>
                              <div className="flex flex-wrap items-center gap-2">
                                <span className="font-display text-sm font-bold text-[var(--text-primary)]">
                                  {b.networkAsset.asset.name}
                                </span>
                                <span className="rounded-[4px] border border-[var(--border-subtle)] bg-[var(--surface-card)] px-1.5 py-0.5 font-mono text-[10px] font-semibold text-[var(--text-secondary)]">
                                  {b.networkAsset.tokenStandard}
                                </span>
                                <span
                                  className={`rounded-[4px] px-2 py-0.5 text-[10px] font-bold ${
                                    b.syncStatus === "SYNCED"
                                      ? "bg-emerald-50 text-emerald-800 border border-emerald-200"
                                      : "bg-amber-50 text-amber-800 border border-amber-200"
                                  }`}
                                >
                                  {b.isZeroConfirmed
                                    ? "CONFIRMED ZERO"
                                    : b.syncStatus === "SYNCED"
                                      ? "SYNCED"
                                      : b.syncStatus}
                                </span>
                              </div>
                              <div className="mt-1 flex flex-wrap items-center gap-1.5 text-xs text-[var(--text-muted)]">
                                <ChainBadge
                                  chainKey={b.networkAsset.network}
                                  size={14}
                                />
                                <span>
                                  {b.networkAsset.network} · Chain{" "}
                                  {b.networkAsset.chainId}
                                </span>
                                {b.networkAsset.contractAddress && (
                                  <span
                                    className="font-mono text-[11px]"
                                    title={b.networkAsset.contractAddress}
                                  >
                                    · Contract:{" "}
                                    {truncateMiddle(
                                      b.networkAsset.contractAddress,
                                      8,
                                      6,
                                    )}
                                  </span>
                                )}
                                {b.blockHeight && (
                                  <span>· Block #{b.blockHeight}</span>
                                )}
                              </div>
                            </div>
                          </div>

                          <div className="text-right">
                            <div className="font-mono text-base font-bold text-[var(--text-primary)]">
                              {b.displayBalance} {b.networkAsset.asset.symbol}
                            </div>
                            <div className="font-mono text-[11px] text-[var(--text-muted)]">
                              {b.atomicBalance} atomic units (
                              {b.networkAsset.decimals} dec)
                            </div>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </section>

                {/* Registered Multi-Chain Wallet Addresses Section */}
                <section className="flow-card p-6">
                  <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[var(--border-subtle)] pb-4">
                    <div>
                      <h2 className="font-display text-base font-bold text-[var(--text-primary)]">
                        Registered Wallet Addresses
                      </h2>
                      <p className="text-xs text-[var(--text-secondary)]">
                        Derived multi-chain custody addresses across NEAR, Base
                        (EVM), and Solana.
                      </p>
                    </div>
                    <span className="rounded-[4px] bg-amber-50 border border-amber-200 px-2.5 py-1 text-[11px] font-semibold text-amber-800">
                      {wallet?.status ?? "PROVISIONING"} · Execution Disabled
                    </span>
                  </div>

                  {!wallet || wallet.addresses.length === 0 ? (
                    <div
                      className="mt-4 rounded-[12px] border border-dashed border-[var(--border-strong)] bg-[var(--surface-subtle)]/50 p-5 text-xs text-[var(--text-secondary)]"
                      data-testid="portfolio-empty-wallets"
                    >
                      No provider wallet addresses have been derived for this
                      account yet. Custody provisioning remains gated while{" "}
                      <code className="font-mono">FLOW_EXECUTION=disabled</code>
                      .
                    </div>
                  ) : (
                    <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-3">
                      {wallet.addresses.map((addr) => (
                        <div
                          key={`${addr.network}-${addr.chainId}`}
                          className="rounded-[10px] border border-[var(--border-subtle)] bg-[var(--surface-subtle)]/50 p-3.5 text-xs"
                        >
                          <div className="flex items-center justify-between">
                            <span className="inline-flex items-center gap-1.5 font-bold uppercase text-[var(--text-primary)]">
                              <ChainBadge chainKey={addr.network} size={16} />
                              {addr.network} ({addr.chainId})
                            </span>
                            <button
                              type="button"
                              onClick={() =>
                                copyAddress(addr.network, addr.address)
                              }
                              className="inline-flex items-center gap-1 text-[11px] font-semibold text-[#2563FF] hover:underline"
                            >
                              {copiedKey === addr.network ? (
                                <>
                                  <IconCheck size={12} />
                                  Copied!
                                </>
                              ) : (
                                <>
                                  <IconCopy size={12} />
                                  Copy
                                </>
                              )}
                            </button>
                          </div>
                          <p
                            className="mt-2 truncate font-mono text-[11px] text-[var(--text-secondary)]"
                            title={addr.address}
                          >
                            {addr.address}
                          </p>
                        </div>
                      ))}
                    </div>
                  )}
                </section>
              </div>

              {/* Right 4 Columns: Quick Cross-Chain Route Card + Account Settings */}
              <div className="xl:col-span-4 space-y-6">
                {/* Quick Cross-Chain Send / Convert Widget */}
                <section className="flow-card p-5 space-y-4">
                  <div className="flex items-center justify-between">
                    <div>
                      <span className="text-[10px] font-bold uppercase tracking-wider text-[#2563FF]">
                        Cross-Chain Routing
                      </span>
                      <h2 className="font-display text-sm font-bold text-[var(--text-primary)]">
                        Send One Asset, Settle Another
                      </h2>
                    </div>
                    <IconSwap size={16} className="text-[#2563FF]" />
                  </div>

                  <div className="space-y-2.5 text-xs">
                    <div className="rounded-[10px] border border-[var(--border-subtle)] bg-[var(--surface-subtle)]/60 p-3">
                      <span className="text-[11px] font-semibold text-[var(--text-muted)]">
                        Sender Source
                      </span>
                      <div className="mt-1.5 flex items-center justify-between">
                        <span className="inline-flex items-center gap-1.5 font-bold text-[var(--text-primary)]">
                          <AssetAvatar
                            symbol={sourceDeployment.symbol}
                            size={20}
                          />
                          {sourceDeployment.symbol}
                        </span>
                        <span className="inline-flex items-center gap-1 text-[var(--text-secondary)]">
                          <ChainBadge
                            chainKey={sourceDeployment.networkKey}
                            size={14}
                          />
                          {sourceDeployment.networkName}
                        </span>
                      </div>
                    </div>

                    <div className="rounded-[10px] border border-[var(--border-subtle)] bg-[var(--surface-subtle)]/60 p-3">
                      <span className="text-[11px] font-semibold text-[var(--text-muted)]">
                        Recipient Settlement
                      </span>
                      <div className="mt-1.5 flex items-center justify-between">
                        <span className="inline-flex items-center gap-1.5 font-bold text-[var(--text-primary)]">
                          <AssetAvatar
                            symbol={destDeployment.symbol}
                            size={20}
                          />
                          {destDeployment.symbol}
                        </span>
                        <span className="inline-flex items-center gap-1 text-[var(--text-secondary)]">
                          <ChainBadge
                            chainKey={destDeployment.networkKey}
                            size={14}
                          />
                          {destDeployment.networkName}
                        </span>
                      </div>
                    </div>
                  </div>

                  <button
                    type="button"
                    onClick={() => setActiveTab("send")}
                    className="flow-btn-primary w-full py-2.5 text-xs"
                  >
                    Configure Cross-Chain Route →
                  </button>
                </section>

                {/* Account Settings Card (OWNER only, matching HEAD) */}
                {currentAccount.role === "OWNER" && (
                  <section className="flow-card p-5 space-y-3">
                    <h2 className="font-display text-sm font-bold text-[var(--text-primary)]">
                      Account settings
                    </h2>
                    <AccountNameForm
                      account={{
                        id: currentAccount.id,
                        name: currentAccount.name,
                      }}
                    />
                  </section>
                )}
              </div>
            </div>
          </div>
        )}

        {/* ================================================================
            TAB 2: WALLETS & SUPPORTED ASSETS (Reference #6)
           ================================================================ */}
        {activeTab === "assets" && (
          <div className="space-y-6">
            {/* Ecosystem Custody Overview Cards */}
            <section className="grid grid-cols-1 gap-4 md:grid-cols-3">
              {ECOSYSTEM_METADATA.map((eco) => {
                const matchingAddresses = (wallet?.addresses ?? []).filter(
                  (a) => getEcosystemForNetworkKey(a.network) === eco.family,
                );
                const firstAddr = matchingAddresses[0] ?? null;

                return (
                  <div
                    key={eco.family}
                    className="flow-card p-5 flex flex-col justify-between"
                  >
                    <div>
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-2">
                          <ChainBadge chainKey={eco.networks[0]} size={24} />
                          <h2 className="font-display text-sm font-bold text-[var(--text-primary)]">
                            {eco.label}
                          </h2>
                        </div>
                        <span className="rounded-[4px] bg-[var(--surface-subtle)] px-2 py-0.5 text-[10px] font-semibold text-[var(--text-secondary)]">
                          {
                            CURATED_SUPPORTED_DEPLOYMENTS.filter(
                              (d) => d.ecosystem === eco.family,
                            ).length
                          }{" "}
                          Assets
                        </span>
                      </div>

                      <p className="mt-2 text-[11px] text-[var(--text-muted)]">
                        {eco.addressFormatHint}
                      </p>

                      {firstAddr ? (
                        <div className="mt-3 rounded-[8px] border border-[var(--border-subtle)] bg-[var(--surface-subtle)]/60 p-2.5 text-xs">
                          <div className="flex items-center justify-between">
                            <span className="text-[11px] font-semibold text-[var(--text-secondary)]">
                              {firstAddr.network} ({wallet?.status})
                            </span>
                            <button
                              type="button"
                              onClick={() =>
                                copyAddress(
                                  `eco:${eco.family}`,
                                  firstAddr.address,
                                )
                              }
                              className="text-[11px] font-semibold text-[#2563FF] hover:underline"
                            >
                              {copiedKey === `eco:${eco.family}`
                                ? "Copied!"
                                : "Copy"}
                            </button>
                          </div>
                          <p
                            className="mt-1 truncate font-mono text-[11px] text-[var(--text-primary)]"
                            title={firstAddr.address}
                          >
                            {firstAddr.address}
                          </p>
                        </div>
                      ) : (
                        <div className="mt-3 rounded-[8px] border border-dashed border-[var(--border-strong)] p-2.5 text-[11px] text-[var(--text-muted)]">
                          No derived address registered on this workspace yet.
                        </div>
                      )}
                    </div>
                  </div>
                );
              })}
            </section>

            {/* Curated Multi-Chain Token Registry + Inspector */}
            <div className="grid grid-cols-1 gap-6 xl:grid-cols-12 items-start">
              <section className="xl:col-span-8 flow-card p-6">
                <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[var(--border-subtle)] pb-4">
                  <div>
                    <h2 className="font-display text-base font-bold text-[var(--text-primary)]">
                      Curated Multi-Chain Asset &amp; Token Registry
                    </h2>
                    <p className="text-xs text-[var(--text-secondary)]">
                      Uniquely identified by chain ID, token standard, and
                      verified contract/mint identifier.
                    </p>
                  </div>

                  <div className="relative">
                    <IconSearch
                      size={14}
                      className="absolute left-3 top-1/2 -translate-y-1/2 text-[var(--text-muted)]"
                    />
                    <input
                      type="search"
                      aria-label="Filter supported assets"
                      value={searchQuery}
                      onChange={(e) => setSearchQuery(e.target.value)}
                      placeholder="Search symbol, chain, contract..."
                      className="flow-input pl-8 pr-3 py-1.5 text-xs"
                    />
                  </div>
                </div>

                {/* Ecosystem Filter Pills */}
                <div className="mt-4 flex flex-wrap gap-2">
                  {(
                    [
                      { id: "all", label: "All Ecosystems" },
                      { id: "evm", label: "Ethereum & Base (EVM)" },
                      { id: "solana", label: "Solana" },
                      { id: "near", label: "NEAR Protocol" },
                    ] as const
                  ).map((tab) => (
                    <button
                      key={tab.id}
                      type="button"
                      onClick={() => setEcosystemFilter(tab.id)}
                      className={`rounded-[6px] px-3 py-1.5 text-xs font-semibold transition-colors ${
                        ecosystemFilter === tab.id
                          ? "bg-[#2563FF] text-white"
                          : "border border-[var(--border-subtle)] bg-[var(--surface-subtle)] text-[var(--text-secondary)] hover:bg-[var(--surface-card)]"
                      }`}
                    >
                      {tab.label}
                    </button>
                  ))}
                </div>

                <div className="mt-4 overflow-x-auto">
                  <table className="w-full text-left border-collapse">
                    <thead>
                      <tr className="border-b border-[var(--border-subtle)] text-[11px] font-bold uppercase tracking-wider text-[var(--text-muted)]">
                        <th className="py-2.5 pr-3">Token</th>
                        <th className="py-2.5 px-3">Network</th>
                        <th className="py-2.5 px-3">Standard &amp; Contract</th>
                        <th className="py-2.5 pl-3 text-right">
                          Workspace Balance
                        </th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-[var(--border-subtle)] text-xs">
                      {filteredCatalogRows.map(
                        ({ catalog, observedBalance }) => (
                          <tr
                            key={catalog.id}
                            onClick={() => setSelectedAssetId(catalog.id)}
                            className={`cursor-pointer transition-colors ${
                              selectedAssetId === catalog.id
                                ? "bg-[#2563FF]/8"
                                : "hover:bg-[var(--surface-subtle)]/60"
                            }`}
                          >
                            <td className="py-3 pr-3">
                              <div className="flex items-center gap-2.5">
                                <AssetAvatar
                                  symbol={catalog.symbol}
                                  size={26}
                                />
                                <div>
                                  <div className="font-bold text-[var(--text-primary)]">
                                    {catalog.symbol}
                                  </div>
                                  <div className="text-[11px] text-[var(--text-muted)]">
                                    {catalog.name}
                                  </div>
                                </div>
                              </div>
                            </td>
                            <td className="py-3 px-3">
                              <div className="inline-flex items-center gap-1.5 font-medium text-[var(--text-secondary)]">
                                <ChainBadge
                                  chainKey={catalog.networkKey}
                                  size={15}
                                />
                                <span>{catalog.networkName}</span>
                              </div>
                            </td>
                            <td className="py-3 px-3">
                              <span className="rounded-[4px] border border-[var(--border-subtle)] bg-[var(--surface-card)] px-1.5 py-0.5 font-mono text-[10px] font-semibold text-[var(--text-secondary)]">
                                {catalog.standard}
                              </span>{" "}
                              <span className="font-mono text-[11px] text-[var(--text-muted)]">
                                {catalog.contractIdentifier === "native"
                                  ? "Native Chain Asset"
                                  : truncateMiddle(
                                      catalog.contractIdentifier,
                                      8,
                                      6,
                                    )}
                              </span>
                            </td>
                            <td className="py-3 pl-3 text-right font-mono font-semibold text-[var(--text-primary)]">
                              {observedBalance
                                ? `${observedBalance.displayBalance} ${catalog.symbol}`
                                : `0 ${catalog.symbol}`}
                            </td>
                          </tr>
                        ),
                      )}
                    </tbody>
                  </table>
                </div>
              </section>

              {/* Right-Hand Token & Custody Inspector Panel */}
              <aside className="xl:col-span-4 flow-card p-5 space-y-4">
                <div className="flex items-center justify-between border-b border-[var(--border-subtle)] pb-3">
                  <div>
                    <span className="text-[10px] font-bold uppercase tracking-wider text-[#2563FF]">
                      Asset Deployment Inspector
                    </span>
                    <h3 className="font-display text-base font-bold text-[var(--text-primary)]">
                      {selectedCatalogItem.symbol} on{" "}
                      {selectedCatalogItem.networkName}
                    </h3>
                  </div>
                  <AssetAvatar symbol={selectedCatalogItem.symbol} size={34} />
                </div>

                <dl className="space-y-2.5 text-xs">
                  <div className="flex justify-between py-1 border-b border-[var(--border-subtle)]">
                    <dt className="text-[var(--text-muted)]">Logical Asset</dt>
                    <dd className="font-semibold text-[var(--text-primary)]">
                      {selectedCatalogItem.name} ({selectedCatalogItem.assetKey}
                      )
                    </dd>
                  </div>
                  <div className="flex justify-between py-1 border-b border-[var(--border-subtle)]">
                    <dt className="text-[var(--text-muted)]">Ecosystem</dt>
                    <dd className="font-semibold text-[var(--text-primary)]">
                      {selectedCatalogItem.ecosystemLabel}
                    </dd>
                  </div>
                  <div className="flex justify-between py-1 border-b border-[var(--border-subtle)]">
                    <dt className="text-[var(--text-muted)]">Token Standard</dt>
                    <dd className="font-mono font-semibold text-[var(--text-primary)]">
                      {selectedCatalogItem.standard} (
                      {selectedCatalogItem.decimals} decimals)
                    </dd>
                  </div>
                  <div className="py-1 border-b border-[var(--border-subtle)]">
                    <dt className="text-[var(--text-muted)]">
                      Verified Contract / Mint Identifier
                    </dt>
                    <dd className="mt-1 break-all rounded-[6px] bg-[var(--surface-subtle)] p-2 font-mono text-[11px] text-[var(--text-primary)]">
                      {selectedCatalogItem.contractIdentifier}
                    </dd>
                  </div>
                </dl>

                <div className="pt-2 flex gap-2">
                  <button
                    type="button"
                    onClick={() => {
                      setSourceDeploymentId(selectedCatalogItem.id);
                      setActiveTab("send");
                    }}
                    className="flow-btn-primary flex-1 py-2 text-xs"
                  >
                    Use as Source
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setDestDeploymentId(selectedCatalogItem.id);
                      setActiveTab("send");
                    }}
                    className="flow-btn-secondary flex-1 py-2 text-xs"
                  >
                    Use as Settlement
                  </button>
                </div>
              </aside>
            </div>
          </div>
        )}

        {/* ================================================================
            TAB 3: SEND & CONVERT (Reference #7)
           ================================================================ */}
        {activeTab === "send" && (
          <div className="grid grid-cols-1 gap-6 xl:grid-cols-12 items-start">
            <section className="xl:col-span-7 flow-card p-6 sm:p-7 space-y-6">
              <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[var(--border-subtle)] pb-4">
                <div>
                  <span className="text-[11px] font-bold uppercase tracking-wider text-[#2563FF]">
                    Decoupled Multi-Chain Routing
                  </span>
                  <h2 className="font-display text-xl font-bold text-[var(--text-primary)]">
                    {sendMode === "send" ? "Cross-Chain Send" : "Convert Asset"}
                  </h2>
                </div>

                <div className="inline-flex rounded-[8px] border border-[var(--border-subtle)] bg-[var(--surface-subtle)] p-1">
                  <button
                    type="button"
                    onClick={() => setSendMode("send")}
                    className={`rounded-[6px] px-3 py-1 text-xs font-semibold ${
                      sendMode === "send"
                        ? "bg-[var(--surface-card)] text-[var(--text-primary)] shadow-2xs"
                        : "text-[var(--text-secondary)]"
                    }`}
                  >
                    Send to Recipient
                  </button>
                  <button
                    type="button"
                    onClick={() => setSendMode("convert")}
                    className={`rounded-[6px] px-3 py-1 text-xs font-semibold ${
                      sendMode === "convert"
                        ? "bg-[var(--surface-card)] text-[var(--text-primary)] shadow-2xs"
                        : "text-[var(--text-secondary)]"
                    }`}
                  >
                    Self-Convert
                  </button>
                </div>
              </div>

              {/* 1. Sender Source Selector */}
              <div className="rounded-[12px] border border-[var(--border-subtle)] bg-[var(--surface-subtle)]/50 p-4 space-y-3">
                <div className="flex items-center justify-between text-xs">
                  <span className="font-bold text-[var(--text-primary)]">
                    1. Sender Source Network &amp; Asset
                  </span>
                  <span className="font-mono text-[11px] text-[var(--text-muted)]">
                    Observed Balance:{" "}
                    <strong className="text-[var(--text-primary)]">
                      {sourceObservedBalance
                        ? `${sourceObservedBalance.displayBalance} ${sourceDeployment.symbol}`
                        : `0 ${sourceDeployment.symbol}`}
                    </strong>
                  </span>
                </div>

                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <label className="block text-xs font-semibold text-[var(--text-secondary)]">
                    Source Network &amp; Token
                    <select
                      value={sourceDeploymentId}
                      onChange={(e) => setSourceDeploymentId(e.target.value)}
                      className="flow-input mt-1 w-full px-3 py-2 text-xs font-semibold"
                    >
                      {CURATED_SUPPORTED_DEPLOYMENTS.map((d) => (
                        <option key={d.id} value={d.id}>
                          {d.symbol} — {d.networkName} ({d.standard})
                        </option>
                      ))}
                    </select>
                  </label>

                  <label className="block text-xs font-semibold text-[var(--text-secondary)]">
                    Source Amount ({sourceDeployment.symbol})
                    <input
                      type="text"
                      inputMode="decimal"
                      value={sendAmount}
                      onChange={(e) => setSendAmount(e.target.value)}
                      placeholder={`0.00 (${sourceDeployment.decimals} max decimals)`}
                      className="flow-input mt-1 w-full px-3 py-2 font-mono text-xs"
                    />
                  </label>
                </div>
              </div>

              {/* 2. Recipient Settlement Selector */}
              <div className="rounded-[12px] border border-[var(--border-subtle)] bg-[var(--surface-subtle)]/50 p-4 space-y-3">
                <div className="flex items-center justify-between text-xs">
                  <span className="font-bold text-[var(--text-primary)]">
                    2. Recipient Destination Network &amp; Settlement Asset
                  </span>
                  <span className="rounded-[4px] bg-[#2563FF]/10 px-2 py-0.5 text-[10px] font-bold text-[#2563FF]">
                    Independent Choice
                  </span>
                </div>

                <label className="block text-xs font-semibold text-[var(--text-secondary)]">
                  Destination Network &amp; Settlement Token
                  <select
                    value={destDeploymentId}
                    onChange={(e) => setDestDeploymentId(e.target.value)}
                    className="flow-input mt-1 w-full px-3 py-2 text-xs font-semibold"
                  >
                    {CURATED_SUPPORTED_DEPLOYMENTS.map((d) => (
                      <option key={d.id} value={d.id}>
                        {d.symbol} — {d.networkName} ({d.standard})
                      </option>
                    ))}
                  </select>
                </label>

                {sendMode === "send" && (
                  <div className="pt-1">
                    <label className="block text-xs font-semibold text-[var(--text-secondary)]">
                      Recipient Destination Address (
                      {destDeployment.networkName})
                      <input
                        type="text"
                        value={recipientAddress}
                        onChange={(e) => setRecipientAddress(e.target.value)}
                        placeholder={
                          ECOSYSTEM_METADATA.find(
                            (m) => m.family === destDeployment.ecosystem,
                          )?.addressPlaceholder
                        }
                        className="flow-input mt-1 w-full px-3 py-2 font-mono text-xs"
                      />
                    </label>
                    {recipientAddress.trim().length > 0 && (
                      <p
                        className={`mt-1.5 text-[11px] font-medium ${
                          addressValidation.valid
                            ? "text-emerald-700 dark:text-emerald-400"
                            : "text-red-700 dark:text-red-400"
                        }`}
                      >
                        {addressValidation.valid
                          ? `Valid ${destDeployment.networkName} address format verified.`
                          : addressValidation.reason}
                      </p>
                    )}
                  </div>
                )}
              </div>

              {/* Honest Execution Gate Action Bar */}
              <div className="rounded-[12px] border border-amber-200 bg-amber-50/90 dark:bg-amber-950/40 dark:border-amber-800 p-4 text-xs text-amber-900 dark:text-amber-200 space-y-2">
                <div className="flex items-center gap-2 font-bold">
                  <IconLock size={15} />
                  <span>Execution Gate Active (`FLOW_EXECUTION=disabled`)</span>
                </div>
                <p className="leading-relaxed">
                  Outbound signing, live solver quotes, and cross-chain transfer
                  submission are disabled in Milestone 3. The route
                  configuration above validates network compatibility and
                  destination address syntax without broadcasting transactions.
                </p>
              </div>

              <button
                type="button"
                disabled
                className="flow-btn-primary w-full py-3 text-sm"
              >
                Execution Disabled in Milestone 3 (Read-Only Mode)
              </button>
            </section>

            {/* Right Column: Route Summary Inspector */}
            <aside className="xl:col-span-5 flow-card p-6 space-y-5">
              <div>
                <span className="text-[10px] font-bold uppercase tracking-wider text-[#2563FF]">
                  Route Architecture Summary
                </span>
                <h3 className="mt-1 font-display text-base font-bold text-[var(--text-primary)]">
                  {sourceDeployment.symbol} ({sourceDeployment.networkName}) →{" "}
                  {destDeployment.symbol} ({destDeployment.networkName})
                </h3>
              </div>

              <div className="space-y-3">
                <div className="rounded-[10px] border border-[var(--border-subtle)] bg-[var(--surface-subtle)]/60 p-3.5 text-xs">
                  <span className="text-[10px] font-bold uppercase text-[var(--text-muted)]">
                    Source Leg
                  </span>
                  <div className="mt-1.5 flex items-center justify-between font-semibold text-[var(--text-primary)]">
                    <span>
                      {sendAmount.trim() || "0.00"} {sourceDeployment.symbol}
                    </span>
                    <span>{sourceDeployment.networkName}</span>
                  </div>
                  <p className="mt-1 font-mono text-[10px] text-[var(--text-muted)]">
                    Contract: {sourceDeployment.contractIdentifier}
                  </p>
                </div>

                <div className="rounded-[10px] border border-[var(--border-subtle)] bg-[var(--surface-subtle)]/60 p-3.5 text-xs">
                  <span className="text-[10px] font-bold uppercase text-[var(--text-muted)]">
                    Destination Settlement Leg
                  </span>
                  <div className="mt-1.5 flex items-center justify-between font-semibold text-[var(--text-primary)]">
                    <span>{destDeployment.symbol}</span>
                    <span>{destDeployment.networkName}</span>
                  </div>
                  <p className="mt-1 font-mono text-[10px] text-[var(--text-muted)]">
                    Contract: {destDeployment.contractIdentifier}
                  </p>
                </div>
              </div>

              <dl className="space-y-2 border-t border-[var(--border-subtle)] pt-4 text-xs">
                <div className="flex justify-between">
                  <dt className="text-[var(--text-muted)]">Quote Status</dt>
                  <dd className="font-mono text-[var(--text-secondary)]">
                    Unquoted (Execution Disabled)
                  </dd>
                </div>
                <div className="flex justify-between">
                  <dt className="text-[var(--text-muted)]">Network Fee</dt>
                  <dd className="font-mono text-[var(--text-secondary)]">
                    Not applicable in read-only mode
                  </dd>
                </div>
                <div className="flex justify-between">
                  <dt className="text-[var(--text-muted)]">Custody State</dt>
                  <dd className="font-semibold text-amber-800 dark:text-amber-300">
                    {wallet?.status ?? "PROVISIONING"}
                  </dd>
                </div>
              </dl>
            </aside>
          </div>
        )}

        {/* ================================================================
            TAB 4: RECEIVE & PAYMENT LINKS (Reference #8)
           ================================================================ */}
        {activeTab === "receive" && (
          <div className="space-y-6">
            {/* Safeguard Notice for PROVISIONING Wallets */}
            <div className="rounded-[12px] border border-amber-200 bg-amber-50 dark:bg-amber-950/40 dark:border-amber-800 p-4 text-xs text-amber-900 dark:text-amber-200 flex items-start gap-3">
              <IconLock size={18} className="mt-0.5 shrink-0" />
              <div>
                <p className="font-bold">
                  Custody Safeguard — Wallets Not Yet Eligible for Live Deposits
                </p>
                <p className="mt-1 leading-relaxed">
                  {wallet?.disclaimer ??
                    "Registered wallets on this workspace are in PROVISIONING / Setup Pending state with FLOW_EXECUTION=disabled. Addresses shown below are for read-only balance verification only; do not send production funds."}
                </p>
              </div>
            </div>

            <div className="grid grid-cols-1 gap-6 xl:grid-cols-12 items-start">
              {/* Left 7 Columns: Settlement Asset Preference + Registered Addresses */}
              <section className="xl:col-span-7 flow-card p-6 space-y-5">
                <div>
                  <span className="text-[11px] font-bold uppercase tracking-wider text-[#2563FF]">
                    Recipient Settlement Preference
                  </span>
                  <h2 className="mt-1 font-display text-lg font-bold text-[var(--text-primary)]">
                    Choose How You Want to Settle
                  </h2>
                  <p className="mt-1 text-xs text-[var(--text-secondary)]">
                    Select your preferred destination network and settlement
                    token. Payers can originate from Ethereum, Base, Solana, or
                    NEAR once execution is enabled.
                  </p>
                </div>

                <label className="block text-xs font-semibold text-[var(--text-secondary)]">
                  Preferred Settlement Network &amp; Asset
                  <select
                    value={receiveDeploymentId}
                    onChange={(e) => setReceiveDeploymentId(e.target.value)}
                    className="flow-input mt-1.5 w-full px-3.5 py-2.5 text-xs font-semibold"
                  >
                    {CURATED_SUPPORTED_DEPLOYMENTS.map((d) => (
                      <option key={d.id} value={d.id}>
                        {d.symbol} on {d.networkName} ({d.standard})
                      </option>
                    ))}
                  </select>
                </label>

                <div className="rounded-[12px] border border-[var(--border-subtle)] bg-[var(--surface-subtle)]/50 p-4 space-y-2 text-xs">
                  <div className="flex items-center justify-between">
                    <span className="font-semibold text-[var(--text-primary)]">
                      Selected Settlement Target
                    </span>
                    <span className="inline-flex items-center gap-1.5 font-bold text-[#2563FF]">
                      <ChainBadge
                        chainKey={receiveDeployment.networkKey}
                        size={15}
                      />
                      {receiveDeployment.symbol} (
                      {receiveDeployment.networkName})
                    </span>
                  </div>
                  <p className="font-mono text-[11px] text-[var(--text-muted)]">
                    Verified Contract/Mint:{" "}
                    {receiveDeployment.contractIdentifier}
                  </p>
                </div>

                {/* Registered Addresses for This Account */}
                <div className="border-t border-[var(--border-subtle)] pt-4 space-y-3">
                  <h3 className="font-display text-sm font-bold text-[var(--text-primary)]">
                    Registered Custody Addresses (Read-Only Observation)
                  </h3>
                  {!wallet || wallet.addresses.length === 0 ? (
                    <p className="text-xs text-[var(--text-muted)]">
                      No provider wallets registered for this account yet.
                    </p>
                  ) : (
                    <div className="space-y-2">
                      {wallet.addresses.map((addr) => (
                        <div
                          key={`recv:${addr.network}-${addr.chainId}`}
                          className="flex flex-wrap items-center justify-between gap-2 rounded-[8px] border border-[var(--border-subtle)] bg-[var(--surface-card)] p-3 text-xs"
                        >
                          <div className="min-w-0 flex-1">
                            <div className="flex items-center gap-1.5 font-semibold text-[var(--text-primary)]">
                              <ChainBadge chainKey={addr.network} size={15} />
                              <span>
                                {addr.network} ({addr.chainId})
                              </span>
                              <span className="rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-bold text-amber-900">
                                {wallet.status}
                              </span>
                            </div>
                            <p className="mt-1 truncate font-mono text-[11px] text-[var(--text-secondary)]">
                              {addr.address}
                            </p>
                          </div>
                          <button
                            type="button"
                            onClick={() =>
                              copyAddress(`recv:${addr.network}`, addr.address)
                            }
                            className="flow-btn-secondary px-2.5 py-1 text-xs"
                          >
                            {copiedKey === `recv:${addr.network}`
                              ? "Copied!"
                              : "Copy Address"}
                          </button>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </section>

              {/* Right 5 Columns: Payment Requests Creation & Stored Links */}
              <aside className="xl:col-span-5 flow-card p-6 space-y-5">
                <div className="flex items-center justify-between">
                  <div>
                    <span className="text-[10px] font-bold uppercase tracking-wider text-[#2563FF]">
                      Payment Requests
                    </span>
                    <h3 className="font-display text-base font-bold text-[var(--text-primary)]">
                      Create Payment Link
                    </h3>
                  </div>
                  <span className="rounded-[4px] bg-[#2563FF]/10 px-2 py-0.5 text-[11px] font-semibold text-[#2563FF]">
                    {
                      paymentRequests.filter((r) => r.status === "ACTIVE")
                        .length
                    }{" "}
                    Active
                  </span>
                </div>

                {/* Create Request Form */}
                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    void handleCreatePaymentRequest();
                  }}
                  className="rounded-[12px] border border-[var(--border-subtle)] bg-[var(--surface-subtle)]/40 p-4 space-y-3.5 text-xs"
                >
                  <div>
                    <label className="block text-[11px] font-semibold text-[var(--text-secondary)] mb-1">
                      Request Title / Reference
                    </label>
                    <input
                      type="text"
                      value={prTitle}
                      onChange={(e) => setPrTitle(e.target.value)}
                      placeholder="e.g. Consulting Invoice #1042"
                      required
                      className="flow-input w-full px-3 py-1.5 text-xs"
                    />
                  </div>

                  <div>
                    <label className="block text-[11px] font-semibold text-[var(--text-secondary)] mb-1">
                      Description (Optional)
                    </label>
                    <textarea
                      value={prDescription}
                      onChange={(e) => setPrDescription(e.target.value)}
                      placeholder="Scope of work or payment note"
                      rows={2}
                      className="flow-input w-full px-3 py-1.5 text-xs resize-none"
                    />
                  </div>

                  <div className="grid grid-cols-2 gap-2">
                    <div>
                      <label className="block text-[11px] font-semibold text-[var(--text-secondary)] mb-1">
                        Amount Mode
                      </label>
                      <select
                        value={prAmountMode}
                        onChange={(e) =>
                          setPrAmountMode(
                            e.target.value as "FIXED" | "OPTIONAL",
                          )
                        }
                        className="flow-input w-full px-2.5 py-1.5 text-xs font-semibold"
                      >
                        <option value="FIXED">Fixed Amount</option>
                        <option value="OPTIONAL">Payer Specified</option>
                      </select>
                    </div>

                    <div>
                      <label className="block text-[11px] font-semibold text-[var(--text-secondary)] mb-1">
                        {prAmountMode === "FIXED"
                          ? `Amount (${receiveDeployment.symbol})`
                          : "Amount"}
                      </label>
                      <input
                        type="text"
                        disabled={prAmountMode === "OPTIONAL"}
                        value={prAmountMode === "OPTIONAL" ? "Any" : prAmount}
                        onChange={(e) => setPrAmount(e.target.value)}
                        placeholder="10"
                        className="flow-input w-full px-3 py-1.5 text-xs disabled:opacity-50"
                      />
                    </div>
                  </div>

                  <div className="flex items-center justify-between text-[11px] text-[var(--text-muted)] pt-1">
                    <span>
                      Target: {receiveDeployment.symbol} on{" "}
                      {receiveDeployment.networkName}
                    </span>
                    <select
                      value={prExpiresInHours}
                      onChange={(e) =>
                        setPrExpiresInHours(Number(e.target.value))
                      }
                      className="flow-input px-2 py-1 text-[11px]"
                    >
                      <option value={24}>24 Hours</option>
                      <option value={168}>7 Days</option>
                      <option value={720}>30 Days</option>
                      <option value={0}>No Expiry</option>
                    </select>
                  </div>

                  <button
                    type="submit"
                    disabled={prCreating}
                    className="flow-btn-primary w-full py-2 text-xs font-semibold"
                  >
                    {prCreating
                      ? "Creating Link..."
                      : "Generate Public Payment Link"}
                  </button>
                </form>

                {/* List of Stored Payment Requests */}
                <div className="space-y-3 pt-2">
                  <h4 className="text-xs font-semibold text-[var(--text-primary)]">
                    Active &amp; Stored Payment Links ({paymentRequests.length})
                  </h4>

                  {paymentRequests.length === 0 ? (
                    <div className="rounded-[12px] border border-dashed border-[var(--border-strong)] bg-[var(--surface-subtle)]/30 p-4 text-center text-xs text-[var(--text-muted)]">
                      No payment links generated yet. Create one above to share
                      with payers.
                    </div>
                  ) : (
                    <div className="space-y-2.5 max-h-72 overflow-y-auto pr-1">
                      {paymentRequests.map((req) => (
                        <div
                          key={req.id}
                          className="rounded-[10px] border border-[var(--border-subtle)] bg-[var(--surface-card)] p-3 text-xs space-y-2"
                        >
                          <div className="flex items-start justify-between gap-2">
                            <div>
                              <div className="font-bold text-[var(--text-primary)] truncate max-w-[200px]">
                                {req.title}
                              </div>
                              <div className="text-[11px] text-[var(--text-muted)]">
                                {req.amountMode === "FIXED"
                                  ? `${req.displayAmount} ${req.destinationAssetSymbol}`
                                  : "Payer Specified"}{" "}
                                on {req.destinationNetwork}
                              </div>
                            </div>
                            <span
                              className={`text-[10px] px-1.5 py-0.5 rounded font-bold ${
                                req.status === "ACTIVE"
                                  ? "bg-emerald-100 text-emerald-900 dark:bg-emerald-950 dark:text-emerald-300"
                                  : "bg-slate-100 text-slate-800 dark:bg-slate-800 dark:text-slate-400"
                              }`}
                            >
                              {req.status}
                            </span>
                          </div>

                          <div className="flex items-center gap-1.5 pt-1 border-t border-[var(--border-subtle)]">
                            <input
                              type="text"
                              readOnly
                              value={req.shareUrl}
                              className="font-mono text-[10px] text-[var(--text-secondary)] bg-[var(--surface-subtle)] px-2 py-1 rounded w-full border border-[var(--border-subtle)] select-all"
                            />
                            <button
                              type="button"
                              onClick={() =>
                                copyAddress(`link:${req.id}`, req.shareUrl)
                              }
                              className="flow-btn-secondary px-2 py-1 text-[10px] shrink-0"
                            >
                              {copiedKey === `link:${req.id}`
                                ? "Copied!"
                                : "Copy"}
                            </button>
                            <Link
                              href={`/pay/${req.publicId}`}
                              target="_blank"
                              className="flow-btn-secondary px-2 py-1 text-[10px] shrink-0 text-[#2563FF]"
                            >
                              Open
                            </Link>
                            {req.status === "ACTIVE" && (
                              <button
                                type="button"
                                onClick={() =>
                                  void handleDisablePaymentRequest(req.id)
                                }
                                className="px-1.5 py-1 text-[10px] text-red-600 hover:text-red-700 shrink-0"
                                title="Disable payment request"
                              >
                                Disable
                              </button>
                            )}
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </aside>
            </div>
          </div>
        )}

        {/* ================================================================
            TAB 5: ACTIVITY & AUDIT LOG (Reference #9)
           ================================================================ */}
        {activeTab === "activity" && (
          <div className="space-y-6">
            {/* 4 Summary Metric Cards */}
            <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
              <div className="flow-card p-4">
                <span className="text-xs font-medium text-[var(--text-muted)]">
                  Settled Transfers
                </span>
                <p className="mt-1 font-display text-2xl font-extrabold text-[var(--text-primary)]">
                  {activityTotal}
                </p>
                <span className="text-[11px] text-[var(--text-muted)]">
                  {activityTotal > 0
                    ? "Verified on-chain"
                    : "No activity recorded"}
                </span>
              </div>
              <div className="flow-card p-4">
                <span className="text-xs font-medium text-[var(--text-muted)]">
                  Pending Routes
                </span>
                <p className="mt-1 font-display text-2xl font-extrabold text-[var(--text-primary)]">
                  0
                </p>
                <span className="text-[11px] text-[var(--text-muted)]">
                  No queued payouts
                </span>
              </div>
              <div className="flow-card p-4">
                <span className="text-xs font-medium text-[var(--text-muted)]">
                  Balance Observations
                </span>
                <p className="mt-1 font-display text-2xl font-extrabold text-[#2563FF]">
                  {balances.length}
                </p>
                <span className="text-[11px] text-[var(--text-muted)]">
                  Persisted in PostgreSQL
                </span>
              </div>
              <div className="flow-card p-4">
                <span className="text-xs font-medium text-[var(--text-muted)]">
                  Derived Addresses
                </span>
                <p className="mt-1 font-display text-2xl font-extrabold text-[#0F9F80]">
                  {wallet?.addresses.length ?? 0}
                </p>
                <span className="text-[11px] text-[var(--text-muted)]">
                  Scoped to this tenant
                </span>
              </div>
            </div>

            {/* Verified On-Chain Activity Feed */}
            <section className="flow-card p-6 space-y-4">
              <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[var(--border-subtle)] pb-4">
                <div>
                  <h2 className="font-display text-base font-bold text-[var(--text-primary)]">
                    Transaction History &amp; Custody Observation Log
                  </h2>
                  <p className="text-xs text-[var(--text-secondary)]">
                    Verified ledger of on-chain transfers and read-only RPC
                    balance observations for this workspace.
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <span className="rounded-[4px] border border-[var(--border-subtle)] bg-[var(--surface-subtle)] px-2.5 py-1 text-xs font-semibold text-[var(--text-secondary)]">
                    {activityTotal} Indexed Event(s)
                  </span>
                  <button
                    type="button"
                    onClick={handleSyncActivities}
                    disabled={activityLoading}
                    className="flex items-center gap-1.5 rounded-[6px] border border-[var(--border-subtle)] bg-white px-3 py-1 text-xs font-semibold text-[var(--text-primary)] hover:bg-[var(--surface-subtle)] disabled:opacity-50 transition-colors shadow-xs"
                  >
                    <IconRefresh
                      size={13}
                      className={activityLoading ? "animate-spin" : ""}
                    />
                    <span>
                      {activityLoading ? "Syncing..." : "Sync Activity"}
                    </span>
                  </button>
                </div>
              </div>

              {activities.length === 0 ? (
                <div className="rounded-[12px] border border-dashed border-[var(--border-strong)] bg-[var(--surface-subtle)]/50 p-8 text-center">
                  <p className="text-sm font-semibold text-[var(--text-primary)]">
                    No on-chain transaction activity discovered yet
                  </p>
                  <p className="mt-1 text-xs text-[var(--text-secondary)]">
                    Zero transactions have been recorded on registered wallet
                    addresses for this workspace. Activity will automatically
                    appear here once incoming or outgoing transactions occur on
                    Near, Base, or Solana.
                  </p>
                </div>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-left border-collapse">
                    <thead>
                      <tr className="border-b border-[var(--border-subtle)] text-[11px] font-bold uppercase tracking-wider text-[var(--text-muted)]">
                        <th className="py-2.5 pr-3">Direction &amp; Type</th>
                        <th className="py-2.5 px-3">Network &amp; Asset</th>
                        <th className="py-2.5 px-3 text-right">Amount</th>
                        <th className="py-2.5 px-3">Transaction Hash</th>
                        <th className="py-2.5 px-3 text-right">Block / Slot</th>
                        <th className="py-2.5 px-3 text-right">Timestamp</th>
                        <th className="py-2.5 pl-3 text-right">Finality</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-[var(--border-subtle)] text-xs">
                      {activities.map((act) => {
                        const explorer =
                          act.explorerUrl ??
                          getExplorerUrl(act.network, act.chainId, act.txHash);
                        const isCredit = act.direction === "INCOMING";
                        return (
                          <tr key={`tx:${act.id}`}>
                            <td className="py-3 pr-3">
                              <div className="flex items-center gap-2">
                                <span
                                  className={`rounded-[4px] px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider ${
                                    isCredit
                                      ? "bg-emerald-50 text-emerald-800 border border-emerald-200"
                                      : act.direction === "OUTGOING"
                                        ? "bg-rose-50 text-rose-800 border border-rose-200"
                                        : "bg-blue-50 text-blue-800 border border-blue-200"
                                  }`}
                                >
                                  {act.direction}
                                </span>
                                <span className="text-[11px] font-medium text-[var(--text-muted)]">
                                  {act.activityType === "ON_CHAIN_TRANSFER"
                                    ? "Transfer"
                                    : "Interaction"}
                                </span>
                              </div>
                            </td>
                            <td className="py-3 px-3">
                              <span className="inline-flex items-center gap-1.5 font-medium text-[var(--text-secondary)]">
                                <ChainBadge chainKey={act.network} size={15} />
                                {act.network} · {act.assetSymbol}
                              </span>
                            </td>
                            <td className="py-3 px-3 text-right font-mono font-semibold">
                              <span
                                className={
                                  isCredit
                                    ? "text-emerald-700"
                                    : "text-[var(--text-primary)]"
                                }
                              >
                                {isCredit
                                  ? "+"
                                  : act.direction === "OUTGOING"
                                    ? "-"
                                    : ""}
                                {act.displayAmount} {act.assetSymbol}
                              </span>
                            </td>
                            <td className="py-3 px-3 font-mono text-[11px]">
                              {explorer ? (
                                <a
                                  href={explorer}
                                  target="_blank"
                                  rel="noreferrer"
                                  className="text-[#2563FF] hover:underline"
                                >
                                  {truncateMiddle(act.txHash, 6, 4)} ↗
                                </a>
                              ) : (
                                <span>{truncateMiddle(act.txHash, 6, 4)}</span>
                              )}
                            </td>
                            <td className="py-3 px-3 text-right font-mono text-[11px] text-[var(--text-muted)]">
                              {act.blockHeight ? `#${act.blockHeight}` : "—"}
                            </td>
                            <td className="py-3 px-3 text-right text-[var(--text-muted)]">
                              {act.blockTimestamp
                                ? formatTimestamp(act.blockTimestamp)
                                : formatTimestamp(act.observedAt)}
                            </td>
                            <td className="py-3 pl-3 text-right">
                              <span className="rounded-[4px] bg-slate-100 px-2 py-0.5 text-[10px] font-semibold text-slate-700">
                                {act.finality}
                              </span>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </section>

            {/* Custody RPC Observation Ledger */}
            <section className="flow-card p-6 space-y-4">
              <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[var(--border-subtle)] pb-4">
                <div>
                  <h2 className="font-display text-base font-bold text-[var(--text-primary)]">
                    Custody RPC Observation Log
                  </h2>
                  <p className="text-xs text-[var(--text-secondary)]">
                    Audited ledger of read-only RPC balance observations for
                    this workspace.
                  </p>
                </div>
                <span className="rounded-[4px] border border-[var(--border-subtle)] bg-[var(--surface-subtle)] px-2.5 py-1 text-xs font-semibold text-[var(--text-secondary)]">
                  {balances.length} Balance Observation(s)
                </span>
              </div>

              {balances.length === 0 ? (
                <div className="rounded-[12px] border border-dashed border-[var(--border-strong)] bg-[var(--surface-subtle)]/50 p-8 text-center">
                  <p className="text-sm font-semibold text-[var(--text-primary)]">
                    No balance observation events recorded yet
                  </p>
                  <p className="mt-1 text-xs text-[var(--text-secondary)]">
                    Zero balance observations have been recorded for this
                    account.
                  </p>
                </div>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-left border-collapse">
                    <thead>
                      <tr className="border-b border-[var(--border-subtle)] text-[11px] font-bold uppercase tracking-wider text-[var(--text-muted)]">
                        <th className="py-2.5 pr-3">Event Type</th>
                        <th className="py-2.5 px-3">Network &amp; Asset</th>
                        <th className="py-2.5 px-3 text-right">
                          Observed Quantity
                        </th>
                        <th className="py-2.5 px-3 text-right">Observed At</th>
                        <th className="py-2.5 pl-3 text-right">Status</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-[var(--border-subtle)] text-xs">
                      {balances.map((b: SerializedWalletBalanceRecord) => (
                        <tr key={`act:${b.id}`}>
                          <td className="py-3 pr-3 font-semibold text-[var(--text-primary)]">
                            RPC Balance Observation
                          </td>
                          <td className="py-3 px-3">
                            <span className="inline-flex items-center gap-1.5 font-medium text-[var(--text-secondary)]">
                              <ChainBadge
                                chainKey={b.networkAsset.network}
                                size={15}
                              />
                              {b.networkAsset.network} ·{" "}
                              {b.networkAsset.asset.symbol}
                            </span>
                          </td>
                          <td className="py-3 px-3 text-right font-mono font-semibold text-[var(--text-primary)]">
                            {b.displayBalance} {b.networkAsset.asset.symbol}
                          </td>
                          <td className="py-3 px-3 text-right text-[var(--text-muted)]">
                            {formatTimestamp(b.observedAt)}
                          </td>
                          <td className="py-3 pl-3 text-right">
                            <span className="rounded-[4px] bg-emerald-50 px-2 py-0.5 text-[11px] font-semibold text-emerald-800">
                              {b.syncStatus}
                            </span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </section>
          </div>
        )}
      </div>
    </div>
  );
}

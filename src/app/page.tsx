import Link from "next/link";
import { FlowLogo, FlowWaveGraphic } from "../components/flow-logo.tsx";
import {
  AssetAvatar,
  ChainBadge,
  IconBuilding,
  IconLock,
  IconReceive,
  IconSend,
  IconShield,
  IconSwap,
  IconUsers,
  IconWallet,
} from "../components/icons.tsx";
import { MarketingRoutePreview } from "../components/marketing-route-preview.tsx";
import { ThemeToggle } from "../components/theme-toggle.tsx";
import { CURATED_SUPPORTED_DEPLOYMENTS } from "../domain/supported-assets-catalog.ts";

export default function Home() {
  const evmAssets = ["ETH", "USDC", "USDT", "cbETH", "WETH"];
  const solanaAssets = ["SOL", "USDC", "USDT", "mSOL", "JUP", "PYTH"];
  const nearAssets = ["NEAR", "USDC", "USDT", "wNEAR"];

  return (
    <div className="min-h-screen flex flex-col bg-[var(--surface-canvas)] text-[var(--text-primary)]">
      {/* Top Marketing Header */}
      <header className="sticky top-0 z-30 border-b border-[var(--border-subtle)] bg-[var(--surface-card)]/90 backdrop-blur-md">
        <div className="mx-auto flex max-w-[1360px] items-center justify-between gap-4 px-4 py-3.5 sm:px-6 lg:px-8">
          <div className="flex items-center gap-8">
            <Link href="/" aria-label="FLOW Home">
              <FlowLogo size={32} />
            </Link>
            <nav
              aria-label="Marketing navigation"
              className="hidden md:flex items-center gap-6 text-sm font-medium text-[var(--text-secondary)]"
            >
              <a
                href="#ecosystems"
                className="hover:text-[#2563FF] transition-colors"
              >
                Supported Assets
              </a>
              <a
                href="#capabilities"
                className="hover:text-[#2563FF] transition-colors"
              >
                Features
              </a>
              <a
                href="#how-it-works"
                className="hover:text-[#2563FF] transition-colors"
              >
                How It Works
              </a>
              <a
                href="#security"
                className="hover:text-[#2563FF] transition-colors"
              >
                Security
              </a>
            </nav>
          </div>

          <div className="flex items-center gap-3">
            <ThemeToggle />
            <Link
              href="/sign-in"
              className="flow-btn-secondary px-4 py-2 text-xs sm:text-sm"
            >
              Sign in to FLOW
            </Link>
            <Link
              href="/accounts"
              className="flow-btn-primary px-4 py-2 text-xs sm:text-sm"
            >
              Open your accounts
            </Link>
          </div>
        </div>
      </header>

      <main className="flex-1">
        {/* Hero Section */}
        <section className="relative overflow-hidden border-b border-[var(--border-subtle)] py-14 sm:py-20">
          <div className="mx-auto max-w-[1360px] px-4 sm:px-6 lg:px-8">
            <div className="grid grid-cols-1 items-center gap-10 lg:grid-cols-12">
              <div className="lg:col-span-7 space-y-6">
                <div className="inline-flex flex-wrap items-center gap-2 rounded-full border border-[var(--border-subtle)] bg-[var(--surface-card)] px-3.5 py-1.5 text-xs font-semibold text-[var(--text-secondary)] shadow-2xs">
                  <span className="h-2 w-2 rounded-full bg-[#34D8B2]" />
                  <span>Multi-chain payment accounts</span>
                  <span className="text-[var(--text-muted)]">·</span>
                  <span className="text-[#2563FF]">
                    Ethereum · Base · Solana · NEAR
                  </span>
                </div>

                <h1 className="font-display text-4xl font-extrabold tracking-tight text-[var(--text-primary)] sm:text-5xl lg:text-[54px] lg:leading-[1.08]">
                  Pay with one asset.{" "}
                  <span className="bg-gradient-to-r from-[#2563FF] to-[#15B897] bg-clip-text text-transparent">
                    Receive another
                  </span>{" "}
                  across Ethereum, Base, Solana, and NEAR.
                </h1>

                <p className="max-w-2xl text-base leading-relaxed text-[var(--text-secondary)] sm:text-lg">
                  Pay from one network and settle in the recipient’s preferred
                  asset and network. Senders choose a source chain and supported
                  token while recipients independently select their destination
                  chain and settlement asset—backed by tenant-isolated Personal
                  and Business accounts.
                </p>

                <div className="flex flex-wrap items-center gap-3 pt-1">
                  <Link
                    href="/sign-in"
                    className="flow-btn-primary px-6 py-3 text-sm"
                  >
                    Get Started
                  </Link>
                  <Link
                    href="/accounts"
                    className="flow-btn-secondary px-5 py-3 text-sm"
                  >
                    Workspace Directory
                  </Link>
                </div>

                {/* Ecosystem Summary Pills */}
                <div className="pt-4">
                  <p className="text-xs font-semibold uppercase tracking-wider text-[var(--text-muted)]">
                    Supported Ecosystems &amp; Verified Token Standards
                  </p>
                  <div className="mt-3 flex flex-wrap items-center gap-2.5">
                    <span className="inline-flex items-center gap-2 rounded-[8px] border border-[var(--border-subtle)] bg-[var(--surface-card)] px-3 py-1.5 text-xs font-semibold text-[var(--text-primary)]">
                      <ChainBadge chainKey="ethereum-mainnet" size={18} />
                      Ethereum &amp; Base (ERC-20 / Native)
                    </span>
                    <span className="inline-flex items-center gap-2 rounded-[8px] border border-[var(--border-subtle)] bg-[var(--surface-card)] px-3 py-1.5 text-xs font-semibold text-[var(--text-primary)]">
                      <ChainBadge chainKey="solana-mainnet" size={18} />
                      Solana (SPL / Native)
                    </span>
                    <span className="inline-flex items-center gap-2 rounded-[8px] border border-[var(--border-subtle)] bg-[var(--surface-card)] px-3 py-1.5 text-xs font-semibold text-[var(--text-primary)]">
                      <ChainBadge chainKey="near-mainnet" size={18} />
                      NEAR Protocol (NEP-141 / Native)
                    </span>
                  </div>
                </div>
              </div>

              {/* Right Column: Interactive Route Preview */}
              <div className="lg:col-span-5">
                <MarketingRoutePreview />
              </div>
            </div>
          </div>
        </section>

        {/* 4-Column Feature Strip */}
        <section
          id="capabilities"
          className="border-b border-[var(--border-subtle)] py-14"
        >
          <div className="mx-auto max-w-[1360px] px-4 sm:px-6 lg:px-8">
            <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-4">
              <div className="flow-card p-6">
                <div className="inline-flex h-10 w-10 items-center justify-center rounded-[10px] bg-[#2563FF]/10 text-[#2563FF]">
                  <IconSwap size={20} />
                </div>
                <h2 className="mt-4 font-display text-base font-bold text-[var(--text-primary)]">
                  Decoupled Cross-Chain Routing
                </h2>
                <p className="mt-2 text-xs leading-relaxed text-[var(--text-secondary)]">
                  Senders choose a source network and asset while recipients
                  independently define their preferred destination network and
                  settlement token.
                </p>
              </div>

              <div className="flow-card p-6">
                <div className="inline-flex h-10 w-10 items-center justify-center rounded-[10px] bg-[#34D8B2]/15 text-[#0F9F80]">
                  <IconWallet size={20} />
                </div>
                <h2 className="mt-4 font-display text-base font-bold text-[var(--text-primary)]">
                  Multi-Chain Custody Registry
                </h2>
                <p className="mt-2 text-xs leading-relaxed text-[var(--text-secondary)]">
                  Unified tracking across EVM (`0x`), Solana (Base58), and NEAR
                  accounts with verified contract/mint identity separation and
                  read-only RPC observation.
                </p>
              </div>

              <div className="flow-card p-6">
                <div className="inline-flex h-10 w-10 items-center justify-center rounded-[10px] bg-[#2563FF]/10 text-[#2563FF]">
                  <IconBuilding size={20} />
                </div>
                <h2 className="mt-4 font-display text-base font-bold text-[var(--text-primary)]">
                  Personal &amp; Business Isolation
                </h2>
                <p className="mt-2 text-xs leading-relaxed text-[var(--text-secondary)]">
                  Every user receives a dedicated Personal account and can
                  create independently owned Business accounts with `OWNER`,
                  `ADMIN`, and `MEMBER` role governance.
                </p>
              </div>

              <div className="flow-card p-6">
                <div className="inline-flex h-10 w-10 items-center justify-center rounded-[10px] bg-[#34D8B2]/15 text-[#0F9F80]">
                  <IconShield size={20} />
                </div>
                <h2 className="mt-4 font-display text-base font-bold text-[var(--text-primary)]">
                  Step-Up &amp; Row-Level Security
                </h2>
                <p className="mt-2 text-xs leading-relaxed text-[var(--text-secondary)]">
                  PostgreSQL Row-Level Security enforces tenant isolation at the
                  database boundary, paired with `FreshProof` step-up
                  verification for sensitive actions.
                </p>
              </div>
            </div>
          </div>
        </section>

        {/* Supported Ecosystems & Curated Asset Registry */}
        <section
          id="ecosystems"
          className="border-b border-[var(--border-subtle)] py-16"
        >
          <div className="mx-auto max-w-[1360px] px-4 sm:px-6 lg:px-8">
            <div className="flex flex-wrap items-end justify-between gap-4">
              <div>
                <span className="text-xs font-bold uppercase tracking-wider text-[#2563FF]">
                  Verified Multi-Chain Asset Registry
                </span>
                <h2 className="mt-1 font-display text-2xl font-bold text-[var(--text-primary)] sm:text-3xl">
                  Three Primary Ecosystems. Curated Token Coverage.
                </h2>
                <p className="mt-2 max-w-2xl text-sm text-[var(--text-secondary)]">
                  Every asset is uniquely identified by chain ID, token standard
                  (`NATIVE`, `ERC20`, `SPL`, `NEP141`), and verified contract or
                  mint address—never by ticker symbol alone.
                </p>
              </div>
              <span className="rounded-[6px] border border-[var(--border-subtle)] bg-[var(--surface-card)] px-3 py-1.5 text-xs font-semibold text-[var(--text-secondary)]">
                {CURATED_SUPPORTED_DEPLOYMENTS.length} Curated Network
                Deployments
              </span>
            </div>

            <div className="mt-8 grid grid-cols-1 gap-6 lg:grid-cols-3">
              {/* Ethereum & Base Card */}
              <div className="flow-card flex flex-col justify-between p-6">
                <div>
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2.5">
                      <ChainBadge chainKey="ethereum-mainnet" size={28} />
                      <ChainBadge chainKey="base-mainnet" size={28} />
                      <div>
                        <h3 className="font-display text-base font-bold text-[var(--text-primary)]">
                          Ethereum &amp; Base (EVM)
                        </h3>
                        <p className="text-xs text-[var(--text-muted)]">
                          Mainnet, Base L2 &amp; Base Sepolia
                        </p>
                      </div>
                    </div>
                    <span className="rounded-[4px] bg-[#2563FF]/10 px-2 py-0.5 text-[11px] font-semibold text-[#2563FF]">
                      EVM · 0x
                    </span>
                  </div>

                  <div className="mt-5 flex flex-wrap gap-2">
                    {evmAssets.map((symbol) => (
                      <span
                        key={symbol}
                        className="inline-flex items-center gap-1.5 rounded-[8px] border border-[var(--border-subtle)] bg-[var(--surface-subtle)] px-2.5 py-1.5 text-xs font-semibold text-[var(--text-primary)]"
                      >
                        <AssetAvatar symbol={symbol} size={20} />
                        {symbol}
                      </span>
                    ))}
                  </div>
                </div>
                <p className="mt-5 border-t border-[var(--border-subtle)] pt-3 text-xs text-[var(--text-muted)]">
                  Standards: Native ETH &amp; verified ERC-20 contracts (`USDC`,
                  `USDT`, `cbETH`, `WETH`).
                </p>
              </div>

              {/* Solana Card */}
              <div className="flow-card flex flex-col justify-between p-6">
                <div>
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2.5">
                      <ChainBadge chainKey="solana-mainnet" size={28} />
                      <div>
                        <h3 className="font-display text-base font-bold text-[var(--text-primary)]">
                          Solana
                        </h3>
                        <p className="text-xs text-[var(--text-muted)]">
                          Solana Mainnet &amp; Devnet
                        </p>
                      </div>
                    </div>
                    <span className="rounded-[4px] bg-purple-500/10 px-2 py-0.5 text-[11px] font-semibold text-purple-700 dark:text-purple-300">
                      SVM · Base58
                    </span>
                  </div>

                  <div className="mt-5 flex flex-wrap gap-2">
                    {solanaAssets.map((symbol) => (
                      <span
                        key={symbol}
                        className="inline-flex items-center gap-1.5 rounded-[8px] border border-[var(--border-subtle)] bg-[var(--surface-subtle)] px-2.5 py-1.5 text-xs font-semibold text-[var(--text-primary)]"
                      >
                        <AssetAvatar symbol={symbol} size={20} />
                        {symbol}
                      </span>
                    ))}
                  </div>
                </div>
                <p className="mt-5 border-t border-[var(--border-subtle)] pt-3 text-xs text-[var(--text-muted)]">
                  Standards: Native SOL &amp; verified SPL mints (`USDC`,
                  `USDT`, `mSOL`, `JUP`, `PYTH`).
                </p>
              </div>

              {/* NEAR Card */}
              <div className="flow-card flex flex-col justify-between p-6">
                <div>
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2.5">
                      <ChainBadge chainKey="near-mainnet" size={28} />
                      <div>
                        <h3 className="font-display text-base font-bold text-[var(--text-primary)]">
                          NEAR Protocol
                        </h3>
                        <p className="text-xs text-[var(--text-muted)]">
                          NEAR Mainnet &amp; Testnet
                        </p>
                      </div>
                    </div>
                    <span className="rounded-[4px] bg-[#34D8B2]/15 px-2 py-0.5 text-[11px] font-semibold text-[#0F9F80]">
                      NEAR · NEP-141
                    </span>
                  </div>

                  <div className="mt-5 flex flex-wrap gap-2">
                    {nearAssets.map((symbol) => (
                      <span
                        key={symbol}
                        className="inline-flex items-center gap-1.5 rounded-[8px] border border-[var(--border-subtle)] bg-[var(--surface-subtle)] px-2.5 py-1.5 text-xs font-semibold text-[var(--text-primary)]"
                      >
                        <AssetAvatar symbol={symbol} size={20} />
                        {symbol}
                      </span>
                    ))}
                  </div>
                </div>
                <p className="mt-5 border-t border-[var(--border-subtle)] pt-3 text-xs text-[var(--text-muted)]">
                  Standards: Native NEAR (24 decimals) &amp; verified NEP-141
                  contracts (`USDC`, `USDT`, `wNEAR`).
                </p>
              </div>
            </div>
          </div>
        </section>

        {/* How FLOW Works */}
        <section
          id="how-it-works"
          className="border-b border-[var(--border-subtle)] py-16"
        >
          <div className="mx-auto max-w-[1360px] px-4 sm:px-6 lg:px-8">
            <div className="text-center max-w-2xl mx-auto">
              <span className="text-xs font-bold uppercase tracking-wider text-[#2563FF]">
                Architecture Workflow
              </span>
              <h2 className="mt-1 font-display text-2xl font-bold text-[var(--text-primary)] sm:text-3xl">
                How FLOW Works
              </h2>
              <p className="mt-2 text-sm text-[var(--text-secondary)]">
                Built on strict tenant isolation, verified token registries, and
                separated source/destination settlement preferences.
              </p>
            </div>

            <div className="mt-10 grid grid-cols-1 gap-6 md:grid-cols-3">
              <div className="flow-card p-6">
                <div className="flex items-center justify-between">
                  <span className="inline-flex h-8 w-8 items-center justify-center rounded-full bg-[#0B1F4B] text-xs font-bold text-white">
                    1
                  </span>
                  <IconSend size={18} className="text-[#2563FF]" />
                </div>
                <h3 className="mt-4 font-display text-base font-bold text-[var(--text-primary)]">
                  Select Source Network &amp; Asset
                </h3>
                <p className="mt-2 text-xs leading-relaxed text-[var(--text-secondary)]">
                  Choose the account workspace (Personal or Business), source
                  blockchain (`Ethereum`, `Base`, `Solana`, or `NEAR`), and the
                  token you want to send.
                </p>
              </div>

              <div className="flow-card p-6">
                <div className="flex items-center justify-between">
                  <span className="inline-flex h-8 w-8 items-center justify-center rounded-full bg-[#2563FF] text-xs font-bold text-white">
                    2
                  </span>
                  <IconSwap size={18} className="text-[#34D8B2]" />
                </div>
                <h3 className="mt-4 font-display text-base font-bold text-[var(--text-primary)]">
                  Specify Destination &amp; Settlement Asset
                </h3>
                <p className="mt-2 text-xs leading-relaxed text-[var(--text-secondary)]">
                  Recipients define their target chain and preferred settlement
                  asset independently, validated against canonical network
                  address rules before execution.
                </p>
              </div>

              <div className="flow-card p-6">
                <div className="flex items-center justify-between">
                  <span className="inline-flex h-8 w-8 items-center justify-center rounded-full bg-[#34D8B2] text-xs font-bold text-[#0B1F4B]">
                    3
                  </span>
                  <IconReceive
                    size={18}
                    className="text-[#0B1F4B] dark:text-[#34D8B2]"
                  />
                </div>
                <h3 className="mt-4 font-display text-base font-bold text-[var(--text-primary)]">
                  Verify Balances &amp; Audit State
                </h3>
                <p className="mt-2 text-xs leading-relaxed text-[var(--text-secondary)]">
                  Read-only multi-chain RPC connectors observe exact atomic
                  balances across registered wallets with durable refresh leases
                  and explicit stale/error attribution.
                </p>
              </div>
            </div>
          </div>
        </section>

        {/* Security & Trust Banner */}
        <section id="security" className="py-16">
          <div className="mx-auto max-w-[1360px] px-4 sm:px-6 lg:px-8">
            <div className="flow-navy-banner relative overflow-hidden p-8 sm:p-10 lg:p-12">
              <FlowWaveGraphic className="absolute inset-x-0 bottom-0 h-44 w-full opacity-80" />
              <div className="relative z-10 grid grid-cols-1 gap-8 lg:grid-cols-12 items-center">
                <div className="lg:col-span-7 space-y-4">
                  <span className="inline-flex items-center gap-1.5 rounded-[4px] bg-white/10 px-3 py-1 text-xs font-semibold text-[#34D8B2]">
                    <IconShield size={14} />
                    Verified Platform Security Architecture
                  </span>
                  <h2 className="font-display text-2xl font-bold text-white sm:text-3xl">
                    Defense-in-Depth Custody &amp; Database Isolation
                  </h2>
                  <p className="text-sm leading-relaxed text-slate-200 max-w-2xl">
                    FLOW enforces least-privilege PostgreSQL roles, one-time
                    cryptographic authentication issuance tickets, AES-256-GCM
                    envelope encryption for custody credentials, and an explicit{" "}
                    <code className="rounded bg-white/10 px-1.5 py-0.5 font-mono text-xs text-[#34D8B2]">
                      FLOW_EXECUTION=disabled
                    </code>{" "}
                    safety gate during Milestone 3 read-only portfolio
                    operation.
                  </p>
                  <div className="flex flex-wrap gap-2.5 pt-2">
                    <span className="rounded-[6px] border border-white/15 bg-white/10 px-3 py-1.5 text-xs font-semibold text-white">
                      Scoped Custody Isolation
                    </span>
                    <span className="rounded-[6px] border border-white/15 bg-white/10 px-3 py-1.5 text-xs font-semibold text-white">
                      Envelope-Encrypted Keys
                    </span>
                    <span className="rounded-[6px] border border-white/15 bg-white/10 px-3 py-1.5 text-xs font-semibold text-white">
                      Passwordless OAuth PKCE &amp; OTP
                    </span>
                    <span className="rounded-[6px] border border-white/15 bg-white/10 px-3 py-1.5 text-xs font-semibold text-white">
                      Row-Level Tenant Isolation
                    </span>
                  </div>
                </div>

                <div className="lg:col-span-5 flex flex-col sm:flex-row lg:flex-col gap-3 justify-end">
                  <div className="rounded-[12px] border border-white/15 bg-[#0B1F4B]/80 backdrop-blur-md p-5">
                    <div className="flex items-center gap-2 text-xs font-semibold text-[#34D8B2]">
                      <IconUsers size={15} />
                      Ready to access your workspace?
                    </div>
                    <p className="mt-1.5 text-xs text-slate-300">
                      Sign in with Google or one-time email verification code to
                      manage your Personal and Business accounts.
                    </p>
                    <div className="mt-4 flex flex-wrap gap-2.5">
                      <Link
                        href="/sign-in"
                        className="flow-btn-primary px-4 py-2 text-xs"
                      >
                        Get Started with FLOW
                      </Link>
                      <Link
                        href="/accounts"
                        className="rounded-[8px] border border-white/20 bg-white/10 px-4 py-2 text-xs font-semibold text-white hover:bg-white/15 transition-colors"
                      >
                        Accounts Directory
                      </Link>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </section>
      </main>

      {/* Footer */}
      <footer className="border-t border-[var(--border-subtle)] bg-[var(--surface-card)] py-8">
        <div className="mx-auto flex max-w-[1360px] flex-wrap items-center justify-between gap-4 px-4 text-xs text-[var(--text-muted)] sm:px-6 lg:px-8">
          <div className="flex items-center gap-3">
            <FlowLogo size={24} />
            <span>·</span>
            <span>Multi-Chain Payments &amp; Treasury Workspace</span>
          </div>
          <div className="flex items-center gap-4">
            <span className="inline-flex items-center gap-1">
              <IconLock size={12} />
              Execution Gate: Disabled (Read-Only M3)
            </span>
          </div>
        </div>
      </footer>
    </div>
  );
}

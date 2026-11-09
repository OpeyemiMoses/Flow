import Link from "next/link";
import { FlowLogo } from "../components/flow-logo.tsx";
import {
  AssetAvatar,
  ChainBadge,
  IconBuilding,
  IconCheck,
  IconChevronDown,
  IconExternalLink,
  IconQrCode,
  IconShield,
  IconSwap,
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
      {/* 1. Top Navigation */}
      <header className="sticky top-0 z-40 border-b border-[var(--border-subtle)] bg-[var(--surface-card)]/95 backdrop-blur-md">
        <div className="mx-auto flex max-w-[1360px] items-center justify-between gap-4 px-4 py-4 sm:px-6 lg:px-8">
          <div className="flex items-center gap-10">
            <Link href="/" aria-label="FLOW Home" className="flex items-center">
              <FlowLogo size={30} />
            </Link>
            <nav
              aria-label="Marketing navigation"
              className="hidden md:flex items-center gap-7 text-sm font-medium text-neutral-600 dark:text-neutral-300"
            >
              <a
                href="#features"
                className="hover:text-black dark:hover:text-white transition-colors"
              >
                Product
              </a>
              <a
                href="#ecosystems"
                className="hover:text-black dark:hover:text-white transition-colors"
              >
                Supported Assets
              </a>
              <a
                href="#how-it-works"
                className="hover:text-black dark:hover:text-white transition-colors"
              >
                How It Works
              </a>
              <a
                href="#faq"
                className="hover:text-black dark:hover:text-white transition-colors"
              >
                FAQ
              </a>
            </nav>
          </div>

          <div className="flex items-center gap-3">
            <ThemeToggle />
            <Link
              href="/sign-in"
              className="hidden sm:inline-flex rounded-full border border-neutral-300 dark:border-neutral-700 px-4 py-2 text-xs font-semibold text-neutral-800 dark:text-neutral-200 hover:border-black dark:hover:border-white transition-colors"
            >
              Sign in
            </Link>
            <Link
              href="/sign-in"
              className="flow-btn-primary px-5 py-2 text-xs font-semibold"
            >
              Get started
            </Link>
          </div>
        </div>
      </header>

      <main className="flex-1">
        {/* 2. Hero Section */}
        <section className="relative overflow-hidden pt-12 pb-16 sm:pt-20 sm:pb-24 border-b border-[var(--border-subtle)]">
          <div className="mx-auto max-w-[1360px] px-4 sm:px-6 lg:px-8">
            <div className="mx-auto max-w-4xl text-center space-y-6">
              <div className="inline-flex items-center gap-2 rounded-full border border-neutral-200 dark:border-neutral-800 bg-[var(--surface-subtle)] px-4 py-1.5 text-xs font-semibold text-neutral-700 dark:text-neutral-300">
                <span className="h-2 w-2 rounded-full bg-[#FF1A1A] animate-pulse" />
                <span>Multi-Chain Payment &amp; Treasury Engine</span>
              </div>

              <h1 className="font-serif text-4xl sm:text-6xl lg:text-[68px] leading-[1.08] font-normal tracking-tight text-neutral-950 dark:text-white">
                Get paid in what you want while others pay with what they have.
              </h1>
              <h2 className="sr-only">
                Pay with one asset. Receive another across Ethereum, Base,
                Solana, and NEAR.
              </h2>

              <p className="mx-auto max-w-2xl text-base sm:text-lg text-neutral-600 dark:text-neutral-300 font-normal leading-relaxed">
                The multi-chain payment engine for modern individuals and
                businesses. Accept payments across Ethereum, Base, Solana, and
                NEAR with instant conversion and verified settlement.
              </p>

              <div className="flex flex-wrap items-center justify-center gap-3.5 pt-2">
                <Link
                  href="/sign-in"
                  className="flow-btn-primary inline-flex items-center gap-2 px-7 py-3 text-sm font-semibold"
                >
                  Get started
                  <span aria-hidden="true">&rarr;</span>
                </Link>
                <a
                  href="#how-it-works"
                  className="rounded-full border border-neutral-300 dark:border-neutral-700 bg-white dark:bg-neutral-900 px-6 py-3 text-sm font-semibold text-neutral-900 dark:text-white hover:border-black dark:hover:border-white transition-colors"
                >
                  See how it works
                </a>
              </div>
            </div>

            {/* Hero Artwork Showcase */}
            <div className="mt-12 sm:mt-16 mx-auto max-w-5xl flex justify-center">
              <div className="relative rounded-3xl p-2 sm:p-4 bg-gradient-to-b from-neutral-100/80 to-transparent dark:from-neutral-900/60 dark:to-transparent">
                <img
                  src="/assets/hero-phones.png"
                  alt="Flow Multi-Chain App Showcase"
                  className="w-full max-w-4xl object-contain drop-shadow-2xl"
                />
              </div>
            </div>
          </div>
        </section>

        {/* 3. Stats Strip */}
        <section className="bg-[#f8f6f3] dark:bg-[#121212] border-b border-[var(--border-subtle)] py-12">
          <div className="mx-auto max-w-[1360px] px-4 sm:px-6 lg:px-8">
            <div className="grid grid-cols-2 gap-6 md:grid-cols-4 text-center">
              <div className="space-y-1">
                <div className="font-serif text-3xl sm:text-4xl font-normal text-neutral-950 dark:text-white">
                  500K+
                </div>
                <div className="text-xs font-medium text-neutral-500 uppercase tracking-wider">
                  People &amp; businesses
                </div>
              </div>
              <div className="space-y-1">
                <div className="font-serif text-3xl sm:text-4xl font-normal text-neutral-950 dark:text-white">
                  100+
                </div>
                <div className="text-xs font-medium text-neutral-500 uppercase tracking-wider">
                  Countries supported
                </div>
              </div>
              <div className="space-y-1">
                <div className="font-serif text-3xl sm:text-4xl font-normal text-neutral-950 dark:text-white">
                  4 Chains
                </div>
                <div className="text-xs font-medium text-neutral-500 uppercase tracking-wider">
                  Base, Eth, Solana, NEAR
                </div>
              </div>
              <div className="space-y-1">
                <div className="font-serif text-3xl sm:text-4xl font-normal text-neutral-950 dark:text-white">
                  100%
                </div>
                <div className="text-xs font-medium text-neutral-500 uppercase tracking-wider">
                  Verifiable settlement
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* 4. The Flow Experience: Pedestal Showcase */}
        <section
          id="features"
          className="py-16 sm:py-24 border-b border-[var(--border-subtle)]"
        >
          <div className="mx-auto max-w-[1360px] px-4 sm:px-6 lg:px-8">
            <div className="grid grid-cols-1 items-center gap-12 lg:grid-cols-12">
              <div className="lg:col-span-6 flex justify-center">
                <div className="relative max-w-md w-full">
                  <img
                    src="/assets/phone-pedestal.png"
                    alt="The Flow Experience"
                    className="w-full object-contain drop-shadow-xl rounded-2xl"
                  />
                </div>
              </div>

              <div className="lg:col-span-6 space-y-6">
                <div className="inline-flex items-center gap-2 text-xs font-bold uppercase tracking-wider text-[#FF1A1A]">
                  <span>The Flow Experience</span>
                </div>

                <h2 className="font-serif text-3xl sm:text-5xl font-normal tracking-tight text-neutral-950 dark:text-white leading-[1.15]">
                  Payments that work on your terms.
                </h2>

                <p className="text-base text-neutral-600 dark:text-neutral-300 leading-relaxed">
                  Never lose a customer or client because they hold funds on a
                  different chain. With Flow, the payer sends their preferred
                  token on their preferred network, and you receive exact
                  settlement into your chosen wallet.
                </p>

                <div className="space-y-4 pt-2">
                  <div className="flex items-start gap-3">
                    <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-[#FF1A1A]/10 text-[#FF1A1A]">
                      <IconCheck size={14} />
                    </span>
                    <div>
                      <h3 className="text-sm font-semibold text-neutral-900 dark:text-white">
                        Independent Asset Preferences
                      </h3>
                      <p className="text-xs text-neutral-500 dark:text-neutral-400 mt-0.5">
                        Senders choose source tokens, recipients dictate
                        destination settlement assets.
                      </p>
                    </div>
                  </div>

                  <div className="flex items-start gap-3">
                    <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-[#FF1A1A]/10 text-[#FF1A1A]">
                      <IconCheck size={14} />
                    </span>
                    <div>
                      <h3 className="text-sm font-semibold text-neutral-900 dark:text-white">
                        Direct Invoicing &amp; Guest Checkout
                      </h3>
                      <p className="text-xs text-neutral-500 dark:text-neutral-400 mt-0.5">
                        Payers require no Flow account, seed phrases, or app
                        downloads.
                      </p>
                    </div>
                  </div>

                  <div className="flex items-start gap-3">
                    <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-[#FF1A1A]/10 text-[#FF1A1A]">
                      <IconCheck size={14} />
                    </span>
                    <div>
                      <h3 className="text-sm font-semibold text-neutral-900 dark:text-white">
                        Double-Entry Financial Ledger
                      </h3>
                      <p className="text-xs text-neutral-500 dark:text-neutral-400 mt-0.5">
                        Per-asset balanced accounting with zero synthetic
                        settlement bypasses.
                      </p>
                    </div>
                  </div>
                </div>

                <div className="pt-2">
                  <Link
                    href="/sign-in"
                    className="flow-btn-primary inline-flex items-center gap-2 px-6 py-2.5 text-xs font-semibold"
                  >
                    Open your account
                    <span aria-hidden="true">&rarr;</span>
                  </Link>
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* 5. Built For Real Life: Handheld Showcase */}
        <section className="py-16 sm:py-24 border-b border-[var(--border-subtle)] bg-[var(--surface-subtle)]/50">
          <div className="mx-auto max-w-[1360px] px-4 sm:px-6 lg:px-8">
            <div className="grid grid-cols-1 items-center gap-12 lg:grid-cols-12">
              <div className="lg:col-span-6 space-y-6 order-2 lg:order-1">
                <div className="inline-flex items-center gap-2 text-xs font-bold uppercase tracking-wider text-[#FF1A1A]">
                  <span>Built for Real Life</span>
                </div>

                <h2 className="font-serif text-3xl sm:text-5xl font-normal tracking-tight text-neutral-950 dark:text-white leading-[1.15]">
                  A simpler, more flexible way to get paid.
                </h2>

                <p className="text-base text-neutral-600 dark:text-neutral-300 leading-relaxed">
                  Whether you are invoicing international clients, accepting
                  payments at your point of sale, or managing corporate treasury
                  across chains, Flow turns fragmented crypto into instant
                  financial clarity.
                </p>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 pt-2">
                  <div className="p-4 rounded-xl border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900">
                    <span className="font-serif text-xl font-normal text-neutral-900 dark:text-white">
                      01
                    </span>
                    <h3 className="text-sm font-semibold text-neutral-900 dark:text-white mt-1">
                      Create Payment Link
                    </h3>
                    <p className="text-xs text-neutral-500 mt-1">
                      Set your desired amount in USDC, ETH, SOL, or NEAR.
                    </p>
                  </div>

                  <div className="p-4 rounded-xl border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900">
                    <span className="font-serif text-xl font-normal text-neutral-900 dark:text-white">
                      02
                    </span>
                    <h3 className="text-sm font-semibold text-neutral-900 dark:text-white mt-1">
                      Client Chooses Asset
                    </h3>
                    <p className="text-xs text-neutral-500 mt-1">
                      Your customer pays with any supported coin or network.
                    </p>
                  </div>

                  <div className="p-4 rounded-xl border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900">
                    <span className="font-serif text-xl font-normal text-neutral-900 dark:text-white">
                      03
                    </span>
                    <h3 className="text-sm font-semibold text-neutral-900 dark:text-white mt-1">
                      Instant Quote &amp; Deposit
                    </h3>
                    <p className="text-xs text-neutral-500 mt-1">
                      Guaranteed rates signed by verified 1click providers.
                    </p>
                  </div>

                  <div className="p-4 rounded-xl border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900">
                    <span className="font-serif text-xl font-normal text-neutral-900 dark:text-white">
                      04
                    </span>
                    <h3 className="text-sm font-semibold text-neutral-900 dark:text-white mt-1">
                      Verified Settlement
                    </h3>
                    <p className="text-xs text-neutral-500 mt-1">
                      Multi-chain verifiers prove on-chain block finality.
                    </p>
                  </div>
                </div>
              </div>

              <div className="lg:col-span-6 flex justify-center order-1 lg:order-2">
                <div className="relative max-w-md w-full">
                  <img
                    src="/assets/phone-hand.png"
                    alt="Built for real life handheld showcase"
                    className="w-full object-contain drop-shadow-xl rounded-2xl"
                  />
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* 6. Dark Bento Feature Grid */}
        <section className="bg-neutral-950 text-white py-16 sm:py-24 border-b border-neutral-900">
          <div className="mx-auto max-w-[1360px] px-4 sm:px-6 lg:px-8 space-y-12">
            <div className="text-center max-w-2xl mx-auto space-y-3">
              <span className="text-xs font-bold uppercase tracking-wider text-[#FF1A1A]">
                Architecture &amp; Features
              </span>
              <h2 className="font-serif text-3xl sm:text-5xl font-normal tracking-tight text-white">
                Engineered for speed, safety, and scale.
              </h2>
              <p className="text-sm text-neutral-400">
                A unified platform combining tenant-isolated multi-chain
                wallets, atomic conversion, and verified proof-of-settlement.
              </p>
            </div>

            <div className="rounded-3xl border border-neutral-800 overflow-hidden bg-neutral-900/50 shadow-2xl">
              <img
                src="/assets/dark-bento-panel.png"
                alt="Flow dark bento feature showcase"
                className="w-full object-cover"
              />
            </div>

            {/* Interactive Route Preview Embedded Inside Dark Showcase */}
            <div className="mt-8 max-w-3xl mx-auto">
              <MarketingRoutePreview />
            </div>
          </div>
        </section>

        {/* 7. Why Flow (3 Cards) */}
        <section className="py-16 sm:py-24 border-b border-[var(--border-subtle)]">
          <div className="mx-auto max-w-[1360px] px-4 sm:px-6 lg:px-8">
            <div className="text-center max-w-2xl mx-auto space-y-3">
              <span className="text-xs font-bold uppercase tracking-wider text-[#FF1A1A]">
                Why Flow
              </span>
              <h2 className="font-serif text-3xl sm:text-5xl font-normal tracking-tight text-neutral-950 dark:text-white">
                Simplicity without compromise.
              </h2>
              <p className="text-sm text-neutral-600 dark:text-neutral-400">
                Built from first principles to remove the complexity of bridges,
                swaps, and gas management.
              </p>
            </div>

            <div className="mt-12 grid grid-cols-1 md:grid-cols-3 gap-6">
              <div className="flow-card p-8 space-y-4">
                <div className="h-10 w-10 rounded-full bg-neutral-100 dark:bg-neutral-800 flex items-center justify-center text-neutral-900 dark:text-white">
                  <IconSwap size={20} />
                </div>
                <h3 className="font-serif text-xl font-normal text-neutral-950 dark:text-white">
                  Total Asset Flexibility
                </h3>
                <p className="text-xs text-neutral-600 dark:text-neutral-400 leading-relaxed">
                  Senders are never forced to buy a specific token or switch
                  chains. They pay with whatever they have in their wallet. You
                  receive clean, predictable settlement.
                </p>
              </div>

              <div className="flow-card p-8 space-y-4">
                <div className="h-10 w-10 rounded-full bg-neutral-100 dark:bg-neutral-800 flex items-center justify-center text-neutral-900 dark:text-white">
                  <IconQrCode size={20} />
                </div>
                <h3 className="font-serif text-xl font-normal text-neutral-950 dark:text-white">
                  A Cleaner Experience
                </h3>
                <p className="text-xs text-neutral-600 dark:text-neutral-400 leading-relaxed">
                  Public payment links load instantly on any mobile device or
                  desktop browser. Guest payers see clear quotes, deposit
                  instructions, and real-time status.
                </p>
              </div>

              <div className="flow-card p-8 space-y-4">
                <div className="h-10 w-10 rounded-full bg-neutral-100 dark:bg-neutral-800 flex items-center justify-center text-neutral-900 dark:text-white">
                  <IconBuilding size={20} />
                </div>
                <h3 className="font-serif text-xl font-normal text-neutral-950 dark:text-white">
                  For You &amp; Your Business
                </h3>
                <p className="text-xs text-neutral-600 dark:text-neutral-400 leading-relaxed">
                  Personal accounts for individual creators and freelancers.
                  Multi-member Business accounts with role-based governance,
                  activity audit trails, and treasury tools.
                </p>
              </div>
            </div>
          </div>
        </section>

        {/* 8. Get Paid Anywhere: QR Standee Showcase */}
        <section className="py-16 sm:py-24 border-b border-[var(--border-subtle)] bg-[var(--surface-subtle)]/40">
          <div className="mx-auto max-w-[1360px] px-4 sm:px-6 lg:px-8">
            <div className="grid grid-cols-1 items-center gap-12 lg:grid-cols-12">
              <div className="lg:col-span-6 flex justify-center">
                <div className="relative max-w-md w-full">
                  <img
                    src="/assets/qr-standee.png"
                    alt="Get Paid Anywhere with Flow QR"
                    className="w-full object-contain drop-shadow-xl rounded-2xl"
                  />
                </div>
              </div>

              <div className="lg:col-span-6 space-y-6">
                <div className="inline-flex items-center gap-2 text-xs font-bold uppercase tracking-wider text-[#FF1A1A]">
                  <span>Omnichannel Payments</span>
                </div>

                <h2 className="font-serif text-3xl sm:text-5xl font-normal tracking-tight text-neutral-950 dark:text-white leading-[1.15]">
                  Turn any payment into a simple link or QR.
                </h2>

                <p className="text-base text-neutral-600 dark:text-neutral-300 leading-relaxed">
                  Whether displayed at a physical checkout counter, sent over
                  chat, or embedded into a client proposal, Flow payment links
                  and QR codes let anyone pay you in seconds without manual
                  wallet configuration.
                </p>

                <div className="space-y-3.5 pt-2">
                  <div className="p-3.5 rounded-xl border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 flex items-center justify-between">
                    <div className="flex items-center gap-3">
                      <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-neutral-100 dark:bg-neutral-800 text-neutral-900 dark:text-white">
                        <IconExternalLink size={16} />
                      </span>
                      <div>
                        <div className="text-xs font-semibold text-neutral-900 dark:text-white">
                          Shareable Payment Link
                        </div>
                        <div className="text-[11px] text-neutral-500">
                          One click to open in any web browser
                        </div>
                      </div>
                    </div>
                    <span className="text-xs font-mono font-medium text-neutral-500">
                      flow.app/pay/...
                    </span>
                  </div>

                  <div className="p-3.5 rounded-xl border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 flex items-center justify-between">
                    <div className="flex items-center gap-3">
                      <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-neutral-100 dark:bg-neutral-800 text-neutral-900 dark:text-white">
                        <IconQrCode size={16} />
                      </span>
                      <div>
                        <div className="text-xs font-semibold text-neutral-900 dark:text-white">
                          Dynamic QR Code
                        </div>
                        <div className="text-[11px] text-neutral-500">
                          Scan to pay with mobile wallets or exchange apps
                        </div>
                      </div>
                    </div>
                    <span className="text-xs font-mono font-medium text-neutral-500">
                      Instant scan
                    </span>
                  </div>
                </div>

                <div className="pt-2">
                  <Link
                    href="/sign-in"
                    className="flow-btn-primary inline-flex items-center gap-2 px-6 py-2.5 text-xs font-semibold"
                  >
                    Generate your first link
                    <span aria-hidden="true">&rarr;</span>
                  </Link>
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* 9. Supported Ecosystems */}
        <section
          id="ecosystems"
          className="border-b border-[var(--border-subtle)] py-16 sm:py-24"
        >
          <div className="mx-auto max-w-[1360px] px-4 sm:px-6 lg:px-8">
            <div className="flex flex-wrap items-end justify-between gap-4">
              <div>
                <span className="text-xs font-bold uppercase tracking-wider text-[#FF1A1A]">
                  Verified Multi-Chain Asset Registry
                </span>
                <h2 className="mt-1 font-serif text-3xl sm:text-4xl font-normal text-neutral-950 dark:text-white">
                  Three Primary Ecosystems. Curated Token Coverage.
                </h2>
                <p className="mt-2 max-w-2xl text-xs sm:text-sm text-neutral-600 dark:text-neutral-400">
                  Every asset is uniquely identified by chain ID, token standard
                  (NATIVE, ERC-20, SPL, NEP-141), and verified contract address.
                </p>
              </div>
              <span className="rounded-full border border-neutral-200 dark:border-neutral-800 bg-neutral-100 dark:bg-neutral-900 px-3.5 py-1 text-xs font-semibold text-neutral-700 dark:text-neutral-300">
                {CURATED_SUPPORTED_DEPLOYMENTS.length} Curated Network
                Deployments
              </span>
            </div>

            <div className="mt-10 grid grid-cols-1 gap-6 lg:grid-cols-3">
              {/* Ethereum & Base Card */}
              <div className="flow-card flex flex-col justify-between p-6">
                <div>
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2.5">
                      <ChainBadge chainKey="ethereum-mainnet" size={28} />
                      <ChainBadge chainKey="base-mainnet" size={28} />
                      <div>
                        <h3 className="font-serif text-base font-bold text-neutral-950 dark:text-white">
                          Ethereum &amp; Base (EVM)
                        </h3>
                        <p className="text-xs text-neutral-500">
                          Mainnet, Base L2 &amp; Sepolia
                        </p>
                      </div>
                    </div>
                    <span className="rounded-md bg-neutral-100 dark:bg-neutral-800 px-2 py-0.5 text-[11px] font-mono font-semibold text-neutral-800 dark:text-neutral-200">
                      EVM · 0x
                    </span>
                  </div>

                  <div className="mt-5 flex flex-wrap gap-2">
                    {evmAssets.map((symbol) => (
                      <span
                        key={symbol}
                        className="inline-flex items-center gap-1.5 rounded-lg border border-neutral-200 dark:border-neutral-800 bg-neutral-50 dark:bg-neutral-900 px-2.5 py-1.5 text-xs font-semibold text-neutral-800 dark:text-neutral-200"
                      >
                        <AssetAvatar symbol={symbol} size={20} />
                        {symbol}
                      </span>
                    ))}
                  </div>
                </div>
                <p className="mt-5 border-t border-[var(--border-subtle)] pt-3 text-xs text-neutral-500">
                  Standards: Native ETH &amp; verified ERC-20 contracts.
                </p>
              </div>

              {/* Solana Card */}
              <div className="flow-card flex flex-col justify-between p-6">
                <div>
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2.5">
                      <ChainBadge chainKey="solana-mainnet" size={28} />
                      <div>
                        <h3 className="font-serif text-base font-bold text-neutral-950 dark:text-white">
                          Solana
                        </h3>
                        <p className="text-xs text-neutral-500">
                          Solana Mainnet &amp; Devnet
                        </p>
                      </div>
                    </div>
                    <span className="rounded-md bg-neutral-100 dark:bg-neutral-800 px-2 py-0.5 text-[11px] font-mono font-semibold text-neutral-800 dark:text-neutral-200">
                      SVM · Base58
                    </span>
                  </div>

                  <div className="mt-5 flex flex-wrap gap-2">
                    {solanaAssets.map((symbol) => (
                      <span
                        key={symbol}
                        className="inline-flex items-center gap-1.5 rounded-lg border border-neutral-200 dark:border-neutral-800 bg-neutral-50 dark:bg-neutral-900 px-2.5 py-1.5 text-xs font-semibold text-neutral-800 dark:text-neutral-200"
                      >
                        <AssetAvatar symbol={symbol} size={20} />
                        {symbol}
                      </span>
                    ))}
                  </div>
                </div>
                <p className="mt-5 border-t border-[var(--border-subtle)] pt-3 text-xs text-neutral-500">
                  Standards: Native SOL &amp; verified SPL mints.
                </p>
              </div>

              {/* NEAR Card */}
              <div className="flow-card flex flex-col justify-between p-6">
                <div>
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2.5">
                      <ChainBadge chainKey="near-mainnet" size={28} />
                      <div>
                        <h3 className="font-serif text-base font-bold text-neutral-950 dark:text-white">
                          NEAR Protocol
                        </h3>
                        <p className="text-xs text-neutral-500">
                          NEAR Mainnet &amp; Testnet
                        </p>
                      </div>
                    </div>
                    <span className="rounded-md bg-neutral-100 dark:bg-neutral-800 px-2 py-0.5 text-[11px] font-mono font-semibold text-neutral-800 dark:text-neutral-200">
                      NEAR · NEP-141
                    </span>
                  </div>

                  <div className="mt-5 flex flex-wrap gap-2">
                    {nearAssets.map((symbol) => (
                      <span
                        key={symbol}
                        className="inline-flex items-center gap-1.5 rounded-lg border border-neutral-200 dark:border-neutral-800 bg-neutral-50 dark:bg-neutral-900 px-2.5 py-1.5 text-xs font-semibold text-neutral-800 dark:text-neutral-200"
                      >
                        <AssetAvatar symbol={symbol} size={20} />
                        {symbol}
                      </span>
                    ))}
                  </div>
                </div>
                <p className="mt-5 border-t border-[var(--border-subtle)] pt-3 text-xs text-neutral-500">
                  Standards: Native NEAR (24 decimals) &amp; verified NEP-141.
                </p>
              </div>
            </div>
          </div>
        </section>

        {/* 10. Testimonials */}
        <section className="py-16 sm:py-24 border-b border-[var(--border-subtle)] bg-[#f8f6f3] dark:bg-[#121212]">
          <div className="mx-auto max-w-[1360px] px-4 sm:px-6 lg:px-8">
            <div className="mx-auto max-w-3xl text-center space-y-6">
              <span className="text-xs font-bold uppercase tracking-wider text-[#FF1A1A]">
                Customer Stories
              </span>
              <blockquote className="font-serif text-2xl sm:text-3xl font-normal text-neutral-950 dark:text-white leading-relaxed">
                &ldquo;Flow eliminated our cross-chain friction completely. We
                send an invoice in USDC on Base, our clients pay with whatever
                is in their Solana or Ethereum wallet, and settlement is
                instant, transparent, and verified.&rdquo;
              </blockquote>
              <div className="pt-2">
                <div className="font-semibold text-sm text-neutral-900 dark:text-white">
                  Amara N.
                </div>
                <div className="text-xs text-neutral-500">
                  Founder &amp; Creative Director, Horizon Studio
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* 11. FAQ Accordion */}
        <section
          id="faq"
          className="py-16 sm:py-24 border-b border-[var(--border-subtle)]"
        >
          <div className="mx-auto max-w-3xl px-4 sm:px-6 lg:px-8 space-y-8">
            <div className="text-center space-y-2">
              <span className="text-xs font-bold uppercase tracking-wider text-[#FF1A1A]">
                Frequently Asked Questions
              </span>
              <h2 className="font-serif text-3xl font-normal text-neutral-950 dark:text-white">
                Everything you need to know.
              </h2>
            </div>

            <div className="divide-y divide-neutral-200 dark:divide-neutral-800">
              <details className="group py-5" open>
                <summary className="flex cursor-pointer items-center justify-between text-base font-medium text-neutral-900 dark:text-white">
                  <span>How does cross-chain settlement work?</span>
                  <span className="ml-4 shrink-0 transition-transform group-open:rotate-180">
                    <IconChevronDown size={18} />
                  </span>
                </summary>
                <p className="mt-3 text-xs sm:text-sm text-neutral-600 dark:text-neutral-400 leading-relaxed">
                  Flow decouples the payer&apos;s source token and chain from
                  the recipient&apos;s destination preference. When a payer
                  initiates checkout, certified 1click quote engines calculate
                  atomic execution rates. Once the deposit is detected on the
                  source network, multi-chain verifiers prove block finality
                  before crediting your account.
                </p>
              </details>

              <details className="group py-5">
                <summary className="flex cursor-pointer items-center justify-between text-base font-medium text-neutral-900 dark:text-white">
                  <span>Do payers need a Flow account to pay me?</span>
                  <span className="ml-4 shrink-0 transition-transform group-open:rotate-180">
                    <IconChevronDown size={18} />
                  </span>
                </summary>
                <p className="mt-3 text-xs sm:text-sm text-neutral-600 dark:text-neutral-400 leading-relaxed">
                  No. Guest checkout is 100% public and frictionless. Any payer
                  can scan a QR code or click your link and pay using their
                  existing self-custody wallet (MetaMask, Phantom, Rabby) or
                  exchange withdrawal (Coinbase, Binance, Kraken).
                </p>
              </details>

              <details className="group py-5">
                <summary className="flex cursor-pointer items-center justify-between text-base font-medium text-neutral-900 dark:text-white">
                  <span>Which blockchains and tokens are supported?</span>
                  <span className="ml-4 shrink-0 transition-transform group-open:rotate-180">
                    <IconChevronDown size={18} />
                  </span>
                </summary>
                <p className="mt-3 text-xs sm:text-sm text-neutral-600 dark:text-neutral-400 leading-relaxed">
                  Flow currently supports Ethereum mainnet, Base L2, Solana, and
                  NEAR Protocol. Verified assets include native coins (ETH, SOL,
                  NEAR) and verified tokens such as USDC, USDT, cbETH, WETH,
                  mSOL, and JUP.
                </p>
              </details>

              <details className="group py-5">
                <summary className="flex cursor-pointer items-center justify-between text-base font-medium text-neutral-900 dark:text-white">
                  <span>How is financial safety guaranteed?</span>
                  <span className="ml-4 shrink-0 transition-transform group-open:rotate-180">
                    <IconChevronDown size={18} />
                  </span>
                </summary>
                <p className="mt-3 text-xs sm:text-sm text-neutral-600 dark:text-neutral-400 leading-relaxed">
                  Flow implements strict double-entry ledger balancing with
                  per-currency balancing, cryptographic quote signature
                  verification, consensus block-depth confirmation checks, and
                  isolated role-based database security.
                </p>
              </details>
            </div>
          </div>
        </section>

        {/* 12. Final CTA Banner */}
        <section className="py-16 sm:py-24">
          <div className="mx-auto max-w-[1360px] px-4 sm:px-6 lg:px-8">
            <div className="relative rounded-3xl overflow-hidden bg-neutral-950 border border-neutral-800 p-8 sm:p-14 lg:p-16 text-white shadow-2xl">
              <div className="relative z-10 max-w-2xl space-y-6">
                <span className="inline-flex items-center gap-2 rounded-full border border-neutral-700 bg-neutral-900 px-3.5 py-1 text-xs font-semibold text-neutral-300">
                  <IconShield size={13} className="text-[#FF1A1A]" />
                  Multi-Chain Payment Workspace
                </span>

                <h2 className="font-serif text-3xl sm:text-5xl font-normal tracking-tight text-white leading-[1.1]">
                  Ready to get paid your way? Open your account in seconds.
                </h2>

                <p className="text-sm sm:text-base text-neutral-300 max-w-xl">
                  Sign in with Google or email verification code. No seed
                  phrases to lose, no complicated bridging software to download.
                </p>

                <div className="flex flex-wrap items-center gap-3.5 pt-2">
                  <Link
                    href="/sign-in"
                    className="flow-btn-primary inline-flex items-center gap-2 px-7 py-3 text-sm font-semibold !bg-white !text-neutral-950 hover:!bg-neutral-200"
                  >
                    Get started
                    <span aria-hidden="true">&rarr;</span>
                  </Link>
                  <Link
                    href="/accounts"
                    className="rounded-full border border-neutral-700 bg-neutral-900 px-6 py-3 text-sm font-semibold text-white hover:border-white transition-colors"
                  >
                    View accounts
                  </Link>
                </div>
              </div>

              {/* Background Glow */}
              <div className="pointer-events-none absolute -right-24 -bottom-24 h-96 w-96 rounded-full bg-[#FF1A1A]/20 blur-3xl" />
            </div>
          </div>
        </section>
      </main>

      {/* 13. Footer */}
      <footer className="border-t border-[var(--border-subtle)] bg-[var(--surface-card)] py-12">
        <div className="mx-auto max-w-[1360px] px-4 sm:px-6 lg:px-8 space-y-8">
          <div className="flex flex-wrap items-center justify-between gap-6">
            <div className="space-y-2">
              <FlowLogo size={28} />
              <p className="text-xs text-neutral-500 max-w-sm">
                The multi-chain payment engine across Ethereum, Base, Solana,
                and NEAR.
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-6 text-xs text-neutral-600 dark:text-neutral-400">
              <Link
                href="/sign-in"
                className="hover:text-black dark:hover:text-white"
              >
                Sign In
              </Link>
              <Link
                href="/accounts"
                className="hover:text-black dark:hover:text-white"
              >
                Accounts
              </Link>
              <a
                href="#ecosystems"
                className="hover:text-black dark:hover:text-white"
              >
                Assets
              </a>
              <a href="#faq" className="hover:text-black dark:hover:text-white">
                FAQ
              </a>
            </div>
          </div>

          <div className="border-t border-[var(--border-subtle)] pt-6 flex flex-wrap items-center justify-between gap-4 text-xs text-neutral-500">
            <div>
              &copy; {new Date().getFullYear()} FLOW Payments. All rights
              reserved.
            </div>
            <div className="inline-flex items-center gap-2">
              <span className="h-2 w-2 rounded-full bg-emerald-500" />
              <span>Multi-Chain Engine Active</span>
              <span className="text-neutral-400">·</span>
              <span className="font-mono text-[11px]">v0.1.0</span>
            </div>
          </div>
        </div>
      </footer>
    </div>
  );
}

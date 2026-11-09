import Link from "next/link";
import { FlowLogo, FlowWaveGraphic } from "../../components/flow-logo.tsx";
import {
  ChainBadge,
  IconCheck,
  IconLock,
  IconShield,
} from "../../components/icons.tsx";
import { ThemeToggle } from "../../components/theme-toggle.tsx";
import { SignIn } from "./sign-in.tsx";

export const metadata = { title: "Sign in | FLOW", robots: { index: false } };

export default async function SignInPage({
  searchParams,
}: {
  searchParams: Promise<{ issue?: string; notice?: string }>;
}) {
  const { issue, notice } = await searchParams;
  return (
    <div className="min-h-screen flex flex-col bg-[var(--surface-canvas)] text-[var(--text-primary)]">
      {/* Top Onboarding Header */}
      <header className="border-b border-[var(--border-subtle)] bg-[var(--surface-card)]">
        <div className="mx-auto flex max-w-[1280px] items-center justify-between gap-4 px-4 py-3.5 sm:px-6 lg:px-8">
          <Link href="/" aria-label="FLOW">
            <FlowLogo size={30} />
          </Link>

          <div className="hidden md:flex items-center gap-2 text-xs font-semibold">
            <span className="inline-flex items-center gap-1.5 rounded-full bg-[#2563FF] px-3 py-1 text-white">
              <span>1</span>
              <span>Sign In &amp; Verify</span>
            </span>
            <span className="text-[var(--text-muted)]">→</span>
            <span className="inline-flex items-center gap-1.5 rounded-full border border-[var(--border-subtle)] bg-[var(--surface-subtle)] px-3 py-1 text-[var(--text-muted)]">
              <span>2</span>
              <span>Personal Workspace</span>
            </span>
            <span className="text-[var(--text-muted)]">→</span>
            <span className="inline-flex items-center gap-1.5 rounded-full border border-[var(--border-subtle)] bg-[var(--surface-subtle)] px-3 py-1 text-[var(--text-muted)]">
              <span>3</span>
              <span>Business Accounts</span>
            </span>
          </div>

          <div className="flex items-center gap-2.5">
            <ThemeToggle />
            <Link href="/" className="flow-btn-secondary px-3 py-1.5 text-xs">
              Overview
            </Link>
          </div>
        </div>
      </header>

      <main className="mx-auto flex w-full max-w-[1280px] flex-1 items-center px-4 py-8 sm:px-6 lg:px-8">
        <div className="grid w-full grid-cols-1 gap-8 lg:grid-cols-12 items-stretch">
          {/* Left Column: Sign-In Card */}
          <section className="lg:col-span-7 flow-card p-6 sm:p-8 lg:p-10 flex flex-col justify-between space-y-6">
            <div className="space-y-4">
              <div className="inline-flex items-center gap-2 rounded-[4px] bg-[#2563FF]/10 px-2.5 py-1 text-[11px] font-bold uppercase tracking-wider text-[#2563FF]">
                <IconShield size={13} />
                Passwordless Authentication
              </div>

              <h1 className="font-display text-2xl font-extrabold tracking-tight text-[var(--text-primary)] sm:text-3xl">
                Sign in to FLOW
              </h1>
              <p className="text-sm text-[var(--text-secondary)]">
                Use Google or a one-time email code. Your personal account is
                set up on your first successful sign-in.
              </p>

              {issue === "authentication" && (
                <p
                  role="status"
                  className="rounded-[8px] border border-amber-200 bg-amber-50 px-4 py-3 text-xs font-semibold text-amber-900"
                >
                  Google sign-in could not be completed. If you already use
                  email, sign in with email and link Google from Security.
                </p>
              )}
              {notice === "linked" && (
                <p
                  role="status"
                  className="rounded-[8px] border border-emerald-200 bg-emerald-50 px-4 py-3 text-xs font-semibold text-emerald-900"
                >
                  Google is linked. Sign in again to continue.
                </p>
              )}
              {notice === "updated" && (
                <p
                  role="status"
                  className="rounded-[8px] border border-[#2563FF]/30 bg-[#2563FF]/5 px-4 py-3 text-xs font-semibold text-[var(--text-primary)]"
                >
                  Your security settings were updated. Sign in again.
                </p>
              )}

              <SignIn />
            </div>
          </section>

          {/* Right Column: Brand Artwork & Value Propositions */}
          <aside className="lg:col-span-5 flow-navy-banner relative overflow-hidden p-7 sm:p-9 flex flex-col justify-between">
            <FlowWaveGraphic className="absolute inset-x-0 bottom-0 h-52 w-full opacity-90" />

            <div className="relative z-10">
              <div className="flex items-center justify-between">
                <FlowLogo size={28} variant="inverse" />
                <span className="inline-flex items-center gap-1 rounded-[4px] border border-white/15 bg-white/10 px-2.5 py-1 text-[11px] font-semibold text-[#34D8B2]">
                  <IconLock size={12} />
                  PKCE + OTP Secured
                </span>
              </div>

              <h2 className="mt-8 font-display text-3xl font-extrabold tracking-tight text-white">
                Move value anywhere.
              </h2>
              <p className="mt-2.5 text-sm leading-relaxed text-slate-200">
                Pay with your preferred network and token while recipients
                settle in theirs across Ethereum, Base, Solana, and NEAR.
              </p>

              <div className="mt-6 flex flex-wrap gap-2">
                <span className="inline-flex items-center gap-1.5 rounded-[6px] border border-white/15 bg-white/10 px-2.5 py-1 text-xs font-semibold text-white">
                  <ChainBadge chainKey="ethereum-mainnet" size={16} />
                  Ethereum
                </span>
                <span className="inline-flex items-center gap-1.5 rounded-[6px] border border-white/15 bg-white/10 px-2.5 py-1 text-xs font-semibold text-white">
                  <ChainBadge chainKey="base-mainnet" size={16} />
                  Base
                </span>
                <span className="inline-flex items-center gap-1.5 rounded-[6px] border border-white/15 bg-white/10 px-2.5 py-1 text-xs font-semibold text-white">
                  <ChainBadge chainKey="solana-mainnet" size={16} />
                  Solana
                </span>
                <span className="inline-flex items-center gap-1.5 rounded-[6px] border border-white/15 bg-white/10 px-2.5 py-1 text-xs font-semibold text-white">
                  <ChainBadge chainKey="near-mainnet" size={16} />
                  NEAR
                </span>
              </div>
            </div>

            <div className="relative z-10 mt-10 space-y-3 rounded-[12px] border border-white/15 bg-[#0B1F4B]/80 backdrop-blur-md p-5">
              <div className="flex items-start gap-2.5 text-xs text-slate-100">
                <IconCheck
                  size={16}
                  className="mt-0.5 shrink-0 text-[#34D8B2]"
                />
                <span>
                  <strong>One-Time Issuance Tickets:</strong> Database sessions
                  require cryptographically verified issuance tickets bound to
                  your authentication intent.
                </span>
              </div>
              <div className="flex items-start gap-2.5 text-xs text-slate-100">
                <IconCheck
                  size={16}
                  className="mt-0.5 shrink-0 text-[#34D8B2]"
                />
                <span>
                  <strong>Tenant-Isolated Workspaces:</strong> Row-Level
                  Security prevents cross-account balance or membership
                  disclosure.
                </span>
              </div>
              <div className="flex items-start gap-2.5 text-xs text-slate-100">
                <IconCheck
                  size={16}
                  className="mt-0.5 shrink-0 text-[#34D8B2]"
                />
                <span>
                  <strong>Step-Up Verification:</strong> Sensitive team, role,
                  and session revocation actions require a fresh authentication
                  proof.
                </span>
              </div>
            </div>
          </aside>
        </div>
      </main>
    </div>
  );
}

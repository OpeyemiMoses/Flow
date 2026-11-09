import Link from "next/link";
import { FlowLogo } from "../../components/flow-logo.tsx";
import { IconLock, IconShield } from "../../components/icons.tsx";
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
      {/* Top Header */}
      <header className="border-b border-[var(--border-subtle)] bg-[var(--surface-card)]">
        <div className="mx-auto flex max-w-[1360px] items-center justify-between gap-4 px-4 py-4 sm:px-6 lg:px-8">
          <Link href="/" aria-label="FLOW">
            <FlowLogo size={30} />
          </Link>

          <div className="flex items-center gap-3">
            <ThemeToggle />
            <Link
              href="/"
              className="rounded-full border border-neutral-300 dark:border-neutral-700 px-4 py-1.5 text-xs font-semibold text-neutral-800 dark:text-neutral-200 hover:border-black dark:hover:border-white transition-colors"
            >
              Back to home
            </Link>
          </div>
        </div>
      </header>

      <main className="mx-auto flex w-full max-w-[1360px] flex-1 items-center px-4 py-10 sm:px-6 lg:px-8">
        <div className="grid w-full grid-cols-1 gap-10 lg:grid-cols-12 items-stretch">
          {/* Left Column: Sign-In Form */}
          <section className="lg:col-span-6 flow-card p-8 sm:p-12 flex flex-col justify-between space-y-8">
            <div className="space-y-6">
              <div className="space-y-2">
                <span className="text-[11px] font-bold uppercase tracking-wider text-[#FF1A1A]">
                  Get Started &mdash;
                </span>
                <h1 className="font-serif text-3xl sm:text-4xl font-normal tracking-tight text-neutral-950 dark:text-white">
                  Sign in to FLOW
                </h1>
                <p className="text-sm text-neutral-600 dark:text-neutral-400">
                  Access your Flow account with Google or a one-time email code.
                  No seed phrases to manage.
                </p>
              </div>

              {issue === "authentication" && (
                <p
                  role="status"
                  className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-xs font-semibold text-amber-900"
                >
                  Google sign-in could not be completed. If you already use
                  email, sign in with email and link Google from Security.
                </p>
              )}
              {notice === "linked" && (
                <p
                  role="status"
                  className="rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-xs font-semibold text-emerald-900"
                >
                  Google is linked. Sign in again to continue.
                </p>
              )}
              {notice === "updated" && (
                <p
                  role="status"
                  className="rounded-xl border border-neutral-200 bg-neutral-100 px-4 py-3 text-xs font-semibold text-neutral-900"
                >
                  Your security settings were updated. Sign in again.
                </p>
              )}

              <SignIn />
            </div>

            <div className="border-t border-[var(--border-subtle)] pt-6 text-xs text-neutral-500 flex items-center justify-between">
              <span className="inline-flex items-center gap-1.5">
                <IconShield size={13} className="text-[#FF1A1A]" />
                Non-custodial encryption
              </span>
              <span>Row-level tenant isolation</span>
            </div>
          </section>

          {/* Right Column: Visual Artwork & Product Mockup */}
          <aside className="lg:col-span-6 relative overflow-hidden rounded-3xl bg-neutral-950 border border-neutral-800 p-8 sm:p-12 flex flex-col justify-between text-white shadow-2xl">
            <div className="relative z-10 space-y-4">
              <div className="flex items-center justify-between">
                <FlowLogo size={28} variant="inverse" />
                <span className="inline-flex items-center gap-1 rounded-full border border-neutral-700 bg-neutral-900 px-3 py-1 text-[11px] font-semibold text-neutral-300">
                  <IconLock size={12} className="text-[#FF1A1A]" />
                  PKCE + OTP Secured
                </span>
              </div>

              <div className="pt-4">
                <h2 className="font-serif text-3xl sm:text-4xl font-normal tracking-tight text-white">
                  Move value anywhere on your terms.
                </h2>
                <p className="mt-2 text-sm text-neutral-400 max-w-md">
                  Pay from one network and settle in another across Ethereum,
                  Base, Solana, and NEAR.
                </p>
              </div>
            </div>

            {/* Pedestal Phone Art in Auth */}
            <div className="relative z-10 my-6 flex justify-center">
              <img
                src="/assets/auth-mockup.png"
                alt="Flow Mobile App Security"
                className="w-full max-w-sm rounded-2xl object-cover drop-shadow-2xl border border-neutral-800"
              />
            </div>

            <div className="relative z-10 border-t border-neutral-800 pt-5 text-xs text-neutral-400 flex items-center justify-between">
              <span>Personal &amp; Business workspaces</span>
              <span>4 Networks · Native + Tokens</span>
            </div>

            {/* Glowing Accent */}
            <div className="pointer-events-none absolute -bottom-20 -right-20 h-72 w-72 rounded-full bg-[#FF1A1A]/15 blur-3xl" />
          </aside>
        </div>
      </main>
    </div>
  );
}

import Link from "next/link";
import { FlowLogo } from "../../../components/flow-logo.tsx";
import {
  SidebarSignOutButton,
  ThemeToggle,
} from "../../../components/theme-toggle.tsx";
import { UserAvatar } from "../../../components/user-avatar.tsx";
import { runtime } from "../../../foundation/prisma.ts";
import { accessibleAccounts } from "../../../server/accounts.ts";
import { pageData, pagePrincipal } from "../../../server/pages.ts";
import { AccountNameForm } from "./forms.tsx";

const walletLabels: Record<string, string> = {
  setup_pending: "Wallet setup pending",
  provisioning: "Wallet provisioning in progress",
  active: "Wallet provisioned (execution disabled)",
  setup_failed: "Wallet setup failed",
  frozen: "Wallet frozen",
  recovery_pending: "Wallet recovery pending",
};

export default async function AccountsPage() {
  const actor = await pagePrincipal();
  const accounts = await pageData(() =>
    accessibleAccounts(runtime().db, actor),
  );

  const personalAccounts = accounts.filter((a) => a.kind === "PERSONAL");
  const businessAccounts = accounts.filter((a) => a.kind === "BUSINESS");
  const primaryAccount = personalAccounts[0] ?? accounts[0];

  return (
    <main className="min-h-screen bg-[#FAF8F5] dark:bg-[#0B0B0B] text-neutral-950 dark:text-white flex flex-col lg:flex-row">
      {/* Left Dark Sidebar */}
      <aside
        aria-label="Workspaces navigation"
        className="hidden lg:flex lg:fixed lg:inset-y-0 lg:left-0 lg:w-[250px] lg:shrink-0 lg:flex-col lg:justify-between bg-[#0B0B0B] text-white p-5 lg:z-30 lg:overflow-y-auto border-r border-neutral-900"
      >
        <div>
          <div className="px-2 pt-1 pb-7">
            <Link href="/" prefetch={false} aria-label="FLOW Home">
              <FlowLogo size={26} variant="inverse" />
            </Link>
          </div>

          <nav className="space-y-1">
            <Link
              prefetch={false}
              href={
                primaryAccount ? `/accounts/${primaryAccount.id}` : "/accounts"
              }
              className="flex w-full items-center gap-3 rounded-full px-4 py-2.5 text-[13px] font-medium text-neutral-400 hover:bg-white/5 hover:text-white transition-all"
            >
              <span>⌂</span>
              <span>Home</span>
            </Link>
            <Link
              prefetch={false}
              href="/accounts"
              className="flex w-full items-center gap-3 rounded-full px-4 py-2.5 text-[13px] font-medium bg-gradient-to-r from-[#450A0A] via-[#7F1D1D] to-[#991B1B] text-white border border-[#EF4444]/40 shadow-sm"
            >
              <span>▣</span>
              <span>Workspaces</span>
            </Link>
            <Link
              prefetch={false}
              href="/security"
              className="flex w-full items-center gap-3 rounded-full px-4 py-2.5 text-[13px] font-medium text-neutral-400 hover:bg-white/5 hover:text-white transition-all"
            >
              <span>⚙</span>
              <span>Settings</span>
            </Link>
          </nav>
        </div>

        <div className="flex items-center justify-between border-t border-white/10 pt-4">
          <div className="flex items-center gap-2.5 min-w-0">
            <UserAvatar className="h-9 w-9 rounded-full object-cover border border-white/20 shrink-0" />
            <div className="min-w-0">
              <p className="truncate text-xs font-semibold text-white">
                {primaryAccount?.name ?? "Flow Account"}
              </p>
              <p className="truncate text-[11px] text-neutral-400">
                {accounts.length} workspace{accounts.length === 1 ? "" : "s"}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-1.5 shrink-0">
            <ThemeToggle variant="sidebar" />
            <Link
              prefetch={false}
              href="/security"
              className="text-neutral-400 hover:text-white text-sm px-1"
            >
              •••
            </Link>
            <SidebarSignOutButton />
          </div>
        </div>
      </aside>

      {/* Main Content */}
      <div className="flex-1 min-w-0 pb-20 relative overflow-hidden lg:pl-[250px]">
        <div
          aria-hidden="true"
          className="pointer-events-none absolute -top-10 right-0 w-[340px] sm:w-[460px] h-[180px] z-0 overflow-hidden"
        >
          <svg viewBox="0 0 500 200" fill="none" className="w-full h-full">
            <path
              d="M120 -20 C240 80, 360 20, 520 150 L520 -20 Z"
              fill="url(#accWaveGrad)"
            />
            <defs>
              <linearGradient id="accWaveGrad" x1="0" y1="0" x2="1" y2="1">
                <stop offset="0%" stopColor="#FF2E2E" />
                <stop offset="65%" stopColor="#CC0000" />
                <stop offset="100%" stopColor="#1A0000" />
              </linearGradient>
            </defs>
          </svg>
        </div>

        <div className="relative z-10 mx-auto max-w-[1120px] px-4 sm:px-8 pt-7 space-y-8">
          <div className="flex items-center justify-between gap-4">
            <div>
              <p className="text-[11px] font-bold uppercase tracking-[0.14em] text-[#FF1A1A]">
                WORKSPACES
              </p>
              <h1 className="mt-1 font-serif text-3xl sm:text-[42px] font-normal tracking-[-0.02em] text-neutral-950 dark:text-white">
                Your FLOW accounts
              </h1>
              <p className="mt-1 text-sm text-neutral-600 dark:text-neutral-400">
                Switch between your personal account and your business
                workspaces, or create a new business organization.
              </p>
            </div>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-12 gap-7 items-start">
            {/* Left 7 Columns: Personal & Business Workspaces */}
            <div className="lg:col-span-7 space-y-6">
              <section className="space-y-3">
                <h2 className="text-xs font-bold uppercase tracking-wider text-neutral-400">
                  Personal Account ({personalAccounts.length})
                </h2>

                <ul className="space-y-3">
                  {personalAccounts.map((account) => (
                    <li key={account.id}>
                      <Link
                        prefetch={false}
                        href={`/accounts/${account.id}`}
                        className="block rounded-[22px] border border-neutral-200/90 dark:border-neutral-800 bg-white dark:bg-[#141414] p-5 shadow-2xs hover:border-neutral-900 dark:hover:border-neutral-700 transition-all"
                      >
                        <div className="flex flex-wrap items-center justify-between gap-4">
                          <div className="flex items-center gap-3.5">
                            <span className="inline-flex h-11 w-11 items-center justify-center rounded-[14px] bg-red-50 dark:bg-red-950/40 text-[#FF1A1A] font-bold">
                              👤
                            </span>
                            <div>
                              <div className="flex items-center gap-2">
                                <strong className="font-display text-base font-bold text-neutral-950 dark:text-white">
                                  {account.name}
                                </strong>
                                <span className="rounded-full bg-red-50 dark:bg-red-950/40 px-2.5 py-0.5 text-[10px] font-bold uppercase text-[#FF1A1A]">
                                  Personal account
                                </span>
                              </div>
                              <p className="mt-1 text-xs text-neutral-500 dark:text-neutral-400">
                                {walletLabels[account.walletStatus] ??
                                  "Wallet setup pending"}{" "}
                                · {account.role.toLowerCase()}
                              </p>
                            </div>
                          </div>

                          <span className="rounded-full bg-neutral-950 dark:bg-white px-4 py-1.5 text-xs font-semibold text-white dark:text-neutral-950">
                            Open →
                          </span>
                        </div>
                      </Link>
                    </li>
                  ))}
                </ul>
              </section>

              <section className="space-y-3 pt-2">
                <h2 className="text-xs font-bold uppercase tracking-wider text-neutral-400">
                  Business Accounts ({businessAccounts.length})
                </h2>

                {businessAccounts.length === 0 ? (
                  <div className="rounded-[22px] border border-neutral-200/80 dark:border-neutral-800 bg-white dark:bg-[#141414] p-6 text-center shadow-2xs">
                    <p className="font-display text-sm font-bold text-neutral-950 dark:text-white">
                      No business accounts yet
                    </p>
                    <p className="mt-1 text-xs text-neutral-500 dark:text-neutral-400">
                      Create a business workspace on the right to manage team
                      payments and invoices.
                    </p>
                  </div>
                ) : (
                  <ul className="space-y-3">
                    {businessAccounts.map((account) => (
                      <li key={account.id}>
                        <Link
                          prefetch={false}
                          href={`/accounts/${account.id}`}
                          className="block rounded-[22px] border border-neutral-200/90 dark:border-neutral-800 bg-white dark:bg-[#141414] p-5 shadow-2xs hover:border-neutral-900 dark:hover:border-neutral-700 transition-all"
                        >
                          <div className="flex flex-wrap items-center justify-between gap-4">
                            <div className="flex items-center gap-3.5">
                              <span className="inline-flex h-11 w-11 items-center justify-center rounded-[14px] bg-neutral-100 dark:bg-neutral-800 text-neutral-900 dark:text-neutral-100 font-bold">
                                🏢
                              </span>
                              <div>
                                <div className="flex items-center gap-2">
                                  <strong className="font-display text-base font-bold text-neutral-950 dark:text-white">
                                    {account.name}
                                  </strong>
                                  <span className="rounded-full bg-neutral-100 dark:bg-neutral-800 px-2.5 py-0.5 text-[10px] font-bold uppercase text-neutral-800 dark:text-neutral-200">
                                    Business account
                                  </span>
                                </div>
                                <p className="mt-1 text-xs text-neutral-500 dark:text-neutral-400">
                                  {walletLabels[account.walletStatus] ??
                                    "Wallet setup pending"}{" "}
                                  · {account.role.toLowerCase()}
                                </p>
                              </div>
                            </div>

                            <span className="rounded-full bg-neutral-950 dark:bg-white px-4 py-1.5 text-xs font-semibold text-white dark:text-neutral-950">
                              Open →
                            </span>
                          </div>
                        </Link>
                      </li>
                    ))}
                  </ul>
                )}
              </section>
            </div>

            {/* Right 5 Columns: Create Business Account Card */}
            <div className="lg:col-span-5">
              <section className="rounded-[26px] border border-neutral-200/90 dark:border-neutral-800 bg-white dark:bg-[#141414] p-6 sm:p-7 shadow-sm space-y-4">
                <span className="inline-block text-[10px] font-bold uppercase tracking-[0.14em] text-[#FF1A1A]">
                  FOR BUSINESS
                </span>
                <h2 className="font-serif text-2xl text-neutral-950 dark:text-white">
                  Create a business account
                </h2>
                <p className="text-xs leading-relaxed text-neutral-600 dark:text-neutral-400">
                  Accept payments from customers, send invoices, manage team
                  access, and track business activity in one place.
                </p>
                <AccountNameForm />
              </section>
            </div>
          </div>
        </div>
      </div>
    </main>
  );
}

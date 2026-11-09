import Link from "next/link";
import { FlowWaveGraphic } from "../../../components/flow-logo.tsx";
import {
  ChainBadge,
  IconBuilding,
  IconShield,
  IconUsers,
  IconWallet,
} from "../../../components/icons.tsx";
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

  return (
    <main className="space-y-8">
      {/* Top Banner */}
      <section className="flow-navy-banner relative overflow-hidden p-6 sm:p-8">
        <FlowWaveGraphic className="absolute inset-x-0 bottom-0 h-36 w-full opacity-75" />
        <div className="relative z-10 flex flex-wrap items-center justify-between gap-6">
          <div className="space-y-2">
            <span className="inline-flex items-center gap-1.5 rounded-[4px] bg-white/10 px-2.5 py-1 text-[11px] font-semibold text-[#34D8B2]">
              <IconShield size={13} />
              Tenant-Isolated Account Directory
            </span>
            <h1 className="font-display text-2xl font-extrabold text-white sm:text-3xl">
              Your FLOW accounts
            </h1>
            <p className="max-w-2xl text-xs sm:text-sm text-slate-200">
              Choose a personal or business account. Each workspace maintains
              separate custody records, multi-chain wallet addresses, and
              row-level database access controls.
            </p>
          </div>

          <div className="flex items-center gap-2">
            <ChainBadge chainKey="ethereum-mainnet" size={24} />
            <ChainBadge chainKey="base-mainnet" size={24} />
            <ChainBadge chainKey="solana-mainnet" size={24} />
            <ChainBadge chainKey="near-mainnet" size={24} />
          </div>
        </div>
      </section>

      <div className="grid grid-cols-1 gap-8 lg:grid-cols-12 items-start">
        {/* Left 7 Columns: Personal & Business Account Lists */}
        <div className="lg:col-span-7 space-y-6">
          {/* Personal Workspace Section */}
          <section className="space-y-3">
            <div className="flex items-center justify-between">
              <h2 className="font-display text-sm font-bold uppercase tracking-wider text-[var(--text-muted)]">
                Personal Account ({personalAccounts.length})
              </h2>
              <span className="text-xs text-[var(--text-muted)]">
                Individual Custody Boundary
              </span>
            </div>

            <ul className="space-y-3">
              {personalAccounts.map((account) => (
                <li key={account.id}>
                  <Link
                    prefetch={false}
                    href={`/accounts/${account.id}`}
                    className="flow-card-interactive block p-5"
                  >
                    <div className="flex flex-wrap items-center justify-between gap-4">
                      <div className="flex items-center gap-3.5">
                        <span className="inline-flex h-11 w-11 items-center justify-center rounded-[12px] bg-[#2563FF]/10 text-[#2563FF]">
                          <IconUsers size={20} />
                        </span>
                        <div>
                          <div className="flex items-center gap-2">
                            <strong className="font-display text-base font-bold text-[var(--text-primary)]">
                              {account.name}
                            </strong>
                            <span className="rounded-[4px] bg-[#2563FF]/10 px-2 py-0.5 text-[11px] font-bold text-[#2563FF]">
                              Personal
                            </span>
                          </div>
                          <p className="mt-1 flex items-center gap-1.5 text-xs text-[var(--text-secondary)]">
                            <IconWallet
                              size={13}
                              className="text-[var(--text-muted)]"
                            />
                            <span>
                              {walletLabels[account.walletStatus] ??
                                "Wallet setup pending"}
                            </span>
                          </p>
                        </div>
                      </div>

                      <div className="flex items-center gap-2">
                        <span className="rounded-[6px] border border-[var(--border-subtle)] bg-[var(--surface-subtle)] px-2.5 py-1 text-xs font-semibold text-[var(--text-secondary)]">
                          {account.role.toLowerCase()}
                        </span>
                        <span className="rounded-[6px] bg-[#0B1F4B] px-3 py-1.5 text-xs font-semibold text-white">
                          Open →
                        </span>
                      </div>
                    </div>
                  </Link>
                </li>
              ))}
            </ul>
          </section>

          {/* Business Workspaces Section */}
          <section className="space-y-3 pt-2">
            <div className="flex items-center justify-between">
              <h2 className="font-display text-sm font-bold uppercase tracking-wider text-[var(--text-muted)]">
                Business Accounts ({businessAccounts.length})
              </h2>
              <span className="text-xs text-[var(--text-muted)]">
                Organization Treasury &amp; Team Access
              </span>
            </div>

            {businessAccounts.length === 0 ? (
              <div className="flow-card p-6 text-center">
                <div className="mx-auto inline-flex h-10 w-10 items-center justify-center rounded-full bg-[var(--surface-subtle)] text-[var(--text-muted)]">
                  <IconBuilding size={18} />
                </div>
                <p className="mt-2.5 text-sm font-semibold text-[var(--text-primary)]">
                  No business accounts joined yet
                </p>
                <p className="mt-1 text-xs text-[var(--text-secondary)]">
                  Use the form on the right to create a new business
                  organization or accept an invitation link from an existing
                  team owner.
                </p>
              </div>
            ) : (
              <ul className="space-y-3">
                {businessAccounts.map((account) => (
                  <li key={account.id}>
                    <Link
                      prefetch={false}
                      href={`/accounts/${account.id}`}
                      className="flow-card-interactive block p-5"
                    >
                      <div className="flex flex-wrap items-center justify-between gap-4">
                        <div className="flex items-center gap-3.5">
                          <span className="inline-flex h-11 w-11 items-center justify-center rounded-[12px] bg-[#34D8B2]/15 text-[#0F9F80]">
                            <IconBuilding size={20} />
                          </span>
                          <div>
                            <div className="flex items-center gap-2">
                              <strong className="font-display text-base font-bold text-[var(--text-primary)]">
                                {account.name}
                              </strong>
                              <span className="rounded-[4px] bg-[#34D8B2]/15 px-2 py-0.5 text-[11px] font-bold text-[#0F9F80]">
                                Business
                              </span>
                            </div>
                            <p className="mt-1 flex items-center gap-1.5 text-xs text-[var(--text-secondary)]">
                              <IconWallet
                                size={13}
                                className="text-[var(--text-muted)]"
                              />
                              <span>
                                {walletLabels[account.walletStatus] ??
                                  "Wallet setup pending"}
                              </span>
                            </p>
                          </div>
                        </div>

                        <div className="flex items-center gap-2">
                          <span className="rounded-[6px] border border-[var(--border-subtle)] bg-[var(--surface-subtle)] px-2.5 py-1 text-xs font-semibold text-[var(--text-secondary)]">
                            {account.role.toLowerCase()}
                          </span>
                          <span className="rounded-[6px] bg-[#0B1F4B] px-3 py-1.5 text-xs font-semibold text-white">
                            Open →
                          </span>
                        </div>
                      </div>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>

        {/* Right 5 Columns: Create Business Form */}
        <div className="lg:col-span-5">
          <section className="flow-card p-6 sm:p-7 space-y-4">
            <div className="inline-flex items-center gap-2 rounded-[4px] bg-[#2563FF]/10 px-2.5 py-1 text-[11px] font-bold uppercase tracking-wider text-[#2563FF]">
              <IconBuilding size={13} />
              New Organization Workspace
            </div>
            <h2 className="font-display text-lg font-bold text-[var(--text-primary)]">
              Create a business account
            </h2>
            <p className="text-xs leading-relaxed text-[var(--text-secondary)]">
              Set up a separate account for your business and invite your team.
            </p>
            <AccountNameForm />
          </section>
        </div>
      </div>
    </main>
  );
}

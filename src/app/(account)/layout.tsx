import Link from "next/link";
import type { ReactNode } from "react";
import { FlowLogo } from "../../components/flow-logo.tsx";
import { IconLock, IconShield } from "../../components/icons.tsx";
import { ThemeToggle } from "../../components/theme-toggle.tsx";
import { SignOutButton } from "../controls.tsx";
import { RefreshSession } from "./accounts/forms.tsx";

export const dynamic = "force-dynamic";

export default function AccountLayout({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-screen flex flex-col bg-[var(--surface-canvas)] text-[var(--text-primary)]">
      <header className="sticky top-0 z-30 border-b border-[var(--border-subtle)] bg-[var(--surface-card)]/95 backdrop-blur-md">
        <div className="mx-auto flex max-w-[1440px] items-center justify-between gap-4 px-4 py-3 sm:px-6 lg:px-8">
          <div className="flex items-center gap-4 sm:gap-6">
            <Link
              prefetch={false}
              href="/accounts"
              aria-label="FLOW workspace home"
              className="flex items-center gap-2 focus:outline-none"
            >
              <FlowLogo size={30} />
            </Link>
            <nav
              aria-label="Account navigation"
              className="flex items-center gap-1 rounded-[8px] bg-[var(--surface-subtle)] p-1 border border-[var(--border-subtle)]"
            >
              <Link
                prefetch={false}
                href="/accounts"
                className="rounded-[6px] px-3 py-1.5 text-xs font-semibold text-[var(--text-primary)] hover:bg-[var(--surface-card)] transition-colors"
              >
                Accounts
              </Link>
              <Link
                prefetch={false}
                href="/security"
                className="inline-flex items-center gap-1.5 rounded-[6px] px-3 py-1.5 text-xs font-semibold text-[var(--text-secondary)] hover:bg-[var(--surface-card)] hover:text-[var(--text-primary)] transition-colors"
              >
                <IconShield size={14} className="text-[#2563FF]" />
                Security
              </Link>
            </nav>
          </div>

          <div className="flex items-center gap-2.5 sm:gap-3">
            <span
              className="hidden lg:inline-flex items-center gap-1.5 rounded-[4px] border border-amber-200/80 bg-amber-50/90 dark:bg-amber-950/40 dark:border-amber-800/60 px-2.5 py-1 text-[11px] font-semibold text-amber-800 dark:text-amber-300"
              title="FLOW_EXECUTION=disabled — Read-only custody and balance observation mode"
            >
              <IconLock size={12} />
              Execution Gate: Disabled
            </span>
            <ThemeToggle />
            <SignOutButton />
          </div>
        </div>
      </header>
      <RefreshSession />
      <div className="mx-auto w-full max-w-[1440px] flex-1 px-4 py-6 sm:px-6 lg:px-8">
        {children}
      </div>
    </div>
  );
}

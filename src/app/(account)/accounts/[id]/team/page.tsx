import { headers } from "next/headers";
import Link from "next/link";
import { FlowLogo } from "../../../../../components/flow-logo.tsx";
import {
  SidebarSignOutButton,
  ThemeToggle,
} from "../../../../../components/theme-toggle.tsx";
import { UserAvatar } from "../../../../../components/user-avatar.tsx";
import { accountId } from "../../../../../server/accounts.ts";
import { pageData } from "../../../../../server/pages.ts";
import { team } from "../../../../../server/team.ts";
import { TeamManager } from "./team-manager.tsx";

export default async function TeamPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const snapshot = await pageData(async () =>
    team(await headers(), accountId(id)),
  );
  return (
    <main className="min-h-screen bg-[#FAF8F5] dark:bg-[#0B0B0B] text-neutral-950 dark:text-white flex flex-col lg:flex-row">
      {/* Left Dark Sidebar */}
      <aside
        aria-label="Business team workspace navigation"
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
              href={`/accounts/${snapshot.account.id}`}
              className="flex w-full items-center gap-3 rounded-full px-4 py-2.5 text-[13px] font-medium text-neutral-400 hover:bg-white/5 hover:text-white transition-all"
            >
              <span>⌂</span>
              <span>Home</span>
            </Link>
            <Link
              prefetch={false}
              href={`/accounts/${snapshot.account.id}/team`}
              className="flex w-full items-center gap-3 rounded-full px-4 py-2.5 text-[13px] font-medium bg-gradient-to-r from-[#450A0A] via-[#7F1D1D] to-[#991B1B] text-white border border-[#EF4444]/40 shadow-sm"
            >
              <span>👥</span>
              <span>Team</span>
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
                {snapshot.account.name}
              </p>
              <p className="truncate text-[11px] text-neutral-400">
                Business · {snapshot.account.role.toLowerCase()}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-1.5 shrink-0">
            <ThemeToggle variant="sidebar" />
            <Link
              prefetch={false}
              href="/security"
              aria-label="Workspace settings"
              title="Security & Settings"
              className="text-neutral-400 hover:text-white text-sm px-1 transition-colors"
            >
              •••
            </Link>
            <SidebarSignOutButton />
          </div>
        </div>
      </aside>

      {/* Main Content */}
      <div className="flex-1 min-w-0 pb-20 relative overflow-hidden lg:pl-[250px]">
        <div className="relative z-10 mx-auto max-w-[1120px] px-4 sm:px-8 pt-7 space-y-6">
          <div className="flex flex-wrap items-end justify-between gap-4">
            <div>
              <p className="text-[11px] font-bold uppercase tracking-[0.14em] text-[#FF1A1A]">
                BUSINESS WORKSPACE · TEAM
              </p>
              <h1 className="mt-1 font-serif text-3xl sm:text-[42px] font-normal tracking-[-0.02em] text-neutral-950 dark:text-white">
                {snapshot.account.name} team
              </h1>
              <p className="mt-1 text-sm text-neutral-600 dark:text-neutral-400">
                Manage organization members, assign roles, and invite teammates.
              </p>
            </div>

            <div className="flex items-center gap-2">
              <Link
                prefetch={false}
                href={`/accounts/${snapshot.account.id}`}
                className="rounded-full border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-[#141414] px-4 py-2 text-xs font-semibold text-neutral-900 dark:text-white shadow-2xs hover:bg-neutral-50 dark:hover:bg-neutral-800"
              >
                ← Back to account
              </Link>
            </div>
          </div>

          <TeamManager {...snapshot} />
        </div>
      </div>
    </main>
  );
}

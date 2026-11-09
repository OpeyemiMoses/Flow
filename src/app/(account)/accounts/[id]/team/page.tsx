import { headers } from "next/headers";
import Link from "next/link";
import { FlowWaveGraphic } from "../../../../../components/flow-logo.tsx";
import { IconBuilding, IconUsers } from "../../../../../components/icons.tsx";
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
    <main className="space-y-6">
      <section className="flow-dark-banner relative overflow-hidden p-6 sm:p-8">
        <FlowWaveGraphic className="absolute inset-x-0 bottom-0 h-36 w-full opacity-80" />
        <div className="relative z-10 flex flex-wrap items-center justify-between gap-4">
          <div className="space-y-1.5">
            <span className="inline-flex items-center gap-1.5 rounded-[4px] bg-white/10 px-2.5 py-1 text-[11px] font-semibold text-emerald-400">
              <IconBuilding size={13} />
              Business Team &amp; Role Governance
            </span>
            <h1 className="font-display text-2xl font-extrabold text-white sm:text-3xl">
              {snapshot.account.name} team
            </h1>
            <p className="text-xs sm:text-sm text-slate-200">
              Manage organization members, assign `OWNER`, `ADMIN`, or `MEMBER`
              roles, and issue single-use email invitations.
            </p>
          </div>

          <Link
            prefetch={false}
            href={`/accounts/${snapshot.account.id}`}
            className="inline-flex items-center gap-1.5 rounded-[8px] border border-white/20 bg-white/10 px-4 py-2 text-xs font-semibold text-white hover:bg-white/15 transition-colors"
          >
            <IconUsers size={14} />
            Back to account
          </Link>
        </div>
      </section>

      <TeamManager {...snapshot} />
    </main>
  );
}

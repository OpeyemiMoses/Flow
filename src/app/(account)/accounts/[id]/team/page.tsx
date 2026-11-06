import Link from "next/link";
import { runtime } from "../../../../../foundation/prisma.ts";
import { accountId } from "../../../../../server/accounts.ts";
import { pageData, pagePrincipal } from "../../../../../server/pages.ts";
import { team } from "../../../../../server/team.ts";
import { TeamManager } from "./team-manager.tsx";

export default async function TeamPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const actor = await pagePrincipal();
  const { id } = await params;
  const snapshot = await pageData(() =>
    team(runtime().db, actor, accountId(id)),
  );
  return (
    <main className="flow-main flow-stack">
      <Link prefetch={false} href={`/accounts/${snapshot.account.id}`}>
        Back to account
      </Link>
      <h1>{snapshot.account.name} team</h1>
      <TeamManager {...snapshot} />
    </main>
  );
}

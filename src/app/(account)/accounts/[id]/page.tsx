import { runtime } from "../../../../foundation/prisma.ts";
import {
  access,
  accessibleAccounts,
  accountId,
} from "../../../../server/accounts.ts";
import { getAccountBalances } from "../../../../server/assets/asset-service.ts";
import { pageData, pagePrincipal } from "../../../../server/pages.ts";
import { serializePortfolio } from "../../../../server/portfolio.ts";
import { PortfolioView, type WorkspaceTab } from "./portfolio-view.tsx";

const VALID_VIEWS: ReadonlySet<WorkspaceTab> = new Set([
  "dashboard",
  "assets",
  "send",
  "receive",
  "request",
  "activity",
]);

export default async function AccountPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ view?: string }>;
}) {
  const actor = await pagePrincipal();
  const { id } = await params;
  const query = await searchParams;
  const account = await pageData(() =>
    access(runtime().db, actor, accountId(id)),
  );
  const allAccounts = await pageData(() =>
    accessibleAccounts(runtime().db, actor),
  );
  const initialPortfolio = await pageData(async () => {
    if (!actor.session.token) {
      throw new Error("Session token required to view portfolio.");
    }
    const projection = await getAccountBalances(runtime().db, account.id, {
      sessionToken: actor.session.token,
    });
    return serializePortfolio(projection);
  });

  const initialView: WorkspaceTab =
    query.view && VALID_VIEWS.has(query.view as WorkspaceTab)
      ? (query.view as WorkspaceTab)
      : "dashboard";

  return (
    <main>
      <PortfolioView
        accountId={account.id}
        initialPortfolio={initialPortfolio}
        account={account}
        allAccounts={allAccounts}
        initialView={initialView}
        userEmail={actor.email}
      />
    </main>
  );
}

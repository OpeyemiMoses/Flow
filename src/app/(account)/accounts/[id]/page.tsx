import Link from "next/link";
import { runtime } from "../../../../foundation/prisma.ts";
import { access, accountId } from "../../../../server/accounts.ts";
import { getAccountBalances } from "../../../../server/assets/asset-service.ts";
import { pageData, pagePrincipal } from "../../../../server/pages.ts";
import { serializePortfolio } from "../../../../server/portfolio.ts";
import { AccountNameForm } from "../forms.tsx";
import { PortfolioView } from "./portfolio-view.tsx";

export default async function AccountPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const actor = await pagePrincipal();
  const { id } = await params;
  const account = await pageData(() =>
    access(runtime().db, actor, accountId(id)),
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
  return (
    <main className="flow-main flow-stack">
      <Link prefetch={false} href="/accounts">
        All accounts
      </Link>
      <section className="flow-panel flow-stack">
        <h1>{account.name}</h1>
        <p>
          {account.kind === "PERSONAL"
            ? "Personal account"
            : "Business account"}{" "}
          · {account.role.toLowerCase()}
        </p>
        <p className="flow-tag">
          {account.walletStatus === "active"
            ? "Wallet provisioned (execution disabled)"
            : account.walletStatus === "provisioning"
              ? "Wallet provisioning in progress"
              : account.walletStatus === "setup_failed"
                ? "Wallet setup failed"
                : "Wallet setup pending"}
        </p>
        {account.kind === "BUSINESS" && account.role !== "MEMBER" && (
          <div>
            <Link prefetch={false} href={`/accounts/${account.id}/team`}>
              Manage team
            </Link>
          </div>
        )}
      </section>

      <PortfolioView
        accountId={account.id}
        initialPortfolio={initialPortfolio}
      />

      {account.role === "OWNER" && (
        <section className="flow-panel flow-stack">
          <h2>Account settings</h2>
          <AccountNameForm account={account} />
        </section>
      )}
    </main>
  );
}

import Link from "next/link";
import { runtime } from "../../../../foundation/prisma.ts";
import { access, accountId } from "../../../../server/accounts.ts";
import { pageData, pagePrincipal } from "../../../../server/pages.ts";
import { AccountNameForm } from "../forms.tsx";

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
      {account.role === "OWNER" && (
        <section className="flow-panel flow-stack">
          <h2>Account settings</h2>
          <AccountNameForm account={account} />
        </section>
      )}
    </main>
  );
}

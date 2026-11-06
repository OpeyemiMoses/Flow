import Link from "next/link";
import { runtime } from "../../../foundation/prisma.ts";
import { accessibleAccounts } from "../../../server/accounts.ts";
import { pageData, pagePrincipal } from "../../../server/pages.ts";
import { AccountNameForm } from "./forms.tsx";

export default async function AccountsPage() {
  const actor = await pagePrincipal();
  const accounts = await pageData(() =>
    accessibleAccounts(runtime().db, actor),
  );
  return (
    <main className="flow-main flow-stack">
      <h1>Your FLOW accounts</h1>
      <p>Choose a personal or business account.</p>
      <ul className="flow-grid">
        {accounts.map((account) => (
          <li className="flow-panel flow-stack" key={account.id}>
            <Link prefetch={false} href={`/accounts/${account.id}`}>
              <strong>{account.name}</strong>
            </Link>
            <p>
              {account.kind === "PERSONAL" ? "Personal" : "Business"} ·{" "}
              {account.role.toLowerCase()}
            </p>
          </li>
        ))}
      </ul>
      <section className="flow-panel flow-stack">
        <h2>Create a business account</h2>
        <p>Set up a separate account for your business and invite your team.</p>
        <AccountNameForm />
      </section>
    </main>
  );
}

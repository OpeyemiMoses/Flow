import { headers } from "next/headers";
import { runtime } from "../../../foundation/prisma.ts";
import { accessibleAccounts } from "../../../server/accounts.ts";
import { securitySnapshot } from "../../../server/auth/flows.ts";
import { pageData, pagePrincipal } from "../../../server/pages.ts";
import { SecurityPanel } from "./security-panel.tsx";

export default async function SecurityPage() {
  const actor = await pagePrincipal();
  const h = await headers();
  const [status, accounts] = await Promise.all([
    pageData(async () => securitySnapshot(h)),
    pageData(async () => accessibleAccounts(runtime().db, actor)),
  ]);
  return (
    <main>
      <SecurityPanel {...status} accounts={accounts} />
    </main>
  );
}

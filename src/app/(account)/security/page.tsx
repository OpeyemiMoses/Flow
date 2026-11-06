import { headers } from "next/headers";
import { securitySnapshot } from "../../../server/auth/flows.ts";
import { pageData, pagePrincipal } from "../../../server/pages.ts";
import { SecurityPanel } from "./security-panel.tsx";

export default async function SecurityPage() {
  await pagePrincipal();
  const status = await pageData(async () => securitySnapshot(await headers()));
  return (
    <main className="flow-main flow-stack">
      <h1>Security</h1>
      <SecurityPanel {...status} />
    </main>
  );
}

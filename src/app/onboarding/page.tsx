import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { runtime } from "../../foundation/prisma.ts";
import { readSession } from "../../server/auth/session.ts";
import { pageData } from "../../server/pages.ts";
import { CompleteOnboarding } from "./complete.tsx";

export const dynamic = "force-dynamic";

export default async function Onboarding() {
  const session = await pageData(async () =>
    readSession(runtime().db, await headers()),
  );
  if (!session) redirect("/sign-in");
  return (
    <main className="flow-main flow-narrow">
      <section className="flow-panel flow-stack">
        <h1>Setting up your FLOW account</h1>
        <CompleteOnboarding />
      </section>
    </main>
  );
}

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { FlowLogo, FlowWaveGraphic } from "../../components/flow-logo.tsx";
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
    <main className="mx-auto flex min-h-screen max-w-xl flex-col justify-center px-6 py-16">
      <section className="flow-card overflow-hidden">
        <div className="flow-dark-banner relative overflow-hidden p-8">
          <FlowWaveGraphic className="absolute inset-x-0 bottom-0 h-36 w-full opacity-80" />
          <div className="relative z-10">
            <FlowLogo size={30} variant="inverse" />
            <h1 className="mt-5 font-serif text-2xl font-normal text-white">
              Setting up your FLOW account
            </h1>
            <p className="mt-2 text-sm text-neutral-300">
              Provisioning your isolated personal account and initializing
              multi-chain custody status.
            </p>
          </div>
        </div>
        <div className="p-8">
          <CompleteOnboarding />
        </div>
      </section>
    </main>
  );
}

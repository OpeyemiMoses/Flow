import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { runtime } from "../../foundation/prisma.ts";
import { readSession } from "../../server/auth/session.ts";
import { pageData } from "../../server/pages.ts";
import { CompleteOnboarding } from "./complete.tsx";

export const dynamic = "force-dynamic";

export default async function Onboarding({
  searchParams,
}: {
  searchParams: Promise<{ step?: string }>;
}) {
  const session = await pageData(async () =>
    readSession(runtime().db, await headers()),
  );
  if (!session) redirect("/sign-in");

  const { step } = await searchParams;

  return (
    <CompleteOnboarding
      initialStep={step}
      userEmail="amara@flow.co"
      userName="Amara Nolan"
    />
  );
}

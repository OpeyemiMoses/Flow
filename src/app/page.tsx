import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { runtime } from "../foundation/prisma.ts";
import { accessibleAccounts, principal } from "../server/accounts.ts";
import { readSession } from "../server/auth/session.ts";
import { ApiFailure } from "../server/http.ts";
import { HomePageClient } from "./home-client.tsx";

export const dynamic = "force-dynamic";

export default async function HomePage() {
  const reqHeaders = await headers();
  let targetAccountId: string | null = null;
  let needsOnboarding = false;

  try {
    const session = await readSession(runtime().db, reqHeaders);
    if (session) {
      const actor = await principal(runtime().db, reqHeaders);
      const accounts = await accessibleAccounts(runtime().db, actor);
      if (accounts.length > 0 && accounts[0]?.id) {
        targetAccountId = accounts[0].id;
      }
    }
  } catch (error) {
    if (error instanceof ApiFailure && error.code === "ONBOARDING_REQUIRED") {
      needsOnboarding = true;
    }
  }

  if (targetAccountId) {
    redirect(`/accounts/${targetAccountId}`);
  }

  if (needsOnboarding) {
    redirect("/onboarding");
  }

  return <HomePageClient />;
}

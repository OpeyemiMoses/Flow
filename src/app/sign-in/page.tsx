import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { runtime } from "../../foundation/prisma.ts";
import { accessibleAccounts, principal } from "../../server/accounts.ts";
import { readSession } from "../../server/auth/session.ts";
import { ApiFailure } from "../../server/http.ts";
import { SignIn } from "./sign-in.tsx";

export const metadata = { title: "Sign in | FLOW", robots: { index: false } };
export const dynamic = "force-dynamic";

export default async function SignInPage({
  searchParams,
}: {
  searchParams: Promise<{ issue?: string; notice?: string }>;
}) {
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

  const { issue, notice } = await searchParams;
  return <SignIn issue={issue} notice={notice} />;
}

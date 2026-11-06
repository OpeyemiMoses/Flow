import "server-only";
import { headers } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { runtime } from "../foundation/prisma.ts";
import { principal } from "./accounts.ts";
import { ApiFailure } from "./http.ts";

export async function pageData<T>(query: () => Promise<T>): Promise<T> {
  try {
    return await query();
  } catch (error) {
    if (error instanceof ApiFailure) {
      if (error.status === 401) redirect("/sign-in");
      if (error.code === "ONBOARDING_REQUIRED") redirect("/onboarding");
      if (error.status === 403 || error.status === 404) notFound();
    }
    throw new Error("FLOW could not load this page.");
  }
}

export async function pagePrincipal() {
  return pageData(async () => principal(runtime().db, await headers()));
}

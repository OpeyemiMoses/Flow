import Link from "next/link";
import { SignIn } from "./sign-in.tsx";

export const metadata = { title: "Sign in | FLOW", robots: { index: false } };

export default async function SignInPage({
  searchParams,
}: {
  searchParams: Promise<{ issue?: string; notice?: string }>;
}) {
  const { issue, notice } = await searchParams;
  return (
    <main className="flow-main flow-narrow">
      <Link className="flow-brand" href="/">
        FLOW
      </Link>
      <section className="flow-panel flow-stack">
        <h1>Sign in to FLOW</h1>
        <p>
          Use Google or a one-time email code. Your personal account is set up
          on your first successful sign-in.
        </p>
        {issue === "authentication" && (
          <p role="status" className="flow-feedback">
            Google sign-in could not be completed. If you already use email,
            sign in with email and link Google from Security.
          </p>
        )}
        {notice === "linked" && (
          <p role="status" className="flow-feedback">
            Google is linked. Sign in again to continue.
          </p>
        )}
        {notice === "updated" && (
          <p role="status" className="flow-feedback">
            Your security settings were updated. Sign in again.
          </p>
        )}
        <SignIn />
      </section>
    </main>
  );
}

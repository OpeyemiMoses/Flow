import Link from "next/link";
import { AcceptInvitation } from "./accept.tsx";

export const metadata = {
  title: "Accept an invitation | FLOW",
  robots: { index: false },
};

export default function InvitePage() {
  return (
    <main className="flow-main flow-narrow">
      <section className="flow-panel flow-stack">
        <h1>Business invitation</h1>
        <p>
          Sign in with the email that received this invitation, then open the
          link and accept.
        </p>
        <AcceptInvitation />
        <Link href="/sign-in">Sign in with the invited email</Link>
      </section>
    </main>
  );
}

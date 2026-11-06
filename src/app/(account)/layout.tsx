import Link from "next/link";
import type { ReactNode } from "react";
import { SignOutButton } from "../controls.tsx";
import { RefreshSession } from "./accounts/forms.tsx";

export const dynamic = "force-dynamic";

export default function AccountLayout({ children }: { children: ReactNode }) {
  return (
    <>
      <header className="flow-topbar">
        <Link prefetch={false} href="/accounts" className="flow-brand">
          FLOW
        </Link>
        <nav className="flow-actions" aria-label="Account navigation">
          <Link prefetch={false} href="/accounts">
            Accounts
          </Link>
          <Link prefetch={false} href="/security">
            Security
          </Link>
          <SignOutButton />
        </nav>
      </header>
      <RefreshSession />
      {children}
    </>
  );
}

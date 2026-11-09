import Link from "next/link";
import { FlowLogo, FlowWaveGraphic } from "../../../components/flow-logo.tsx";
import { IconBuilding, IconShield } from "../../../components/icons.tsx";
import { AcceptInvitation } from "./accept.tsx";

export const metadata = {
  title: "Accept an invitation | FLOW",
  robots: { index: false },
};

export default function InvitePage() {
  return (
    <main className="mx-auto flex min-h-screen max-w-lg flex-col justify-center px-6 py-16">
      <section className="flow-card overflow-hidden">
        <div className="flow-dark-banner relative overflow-hidden p-7 sm:p-8">
          <FlowWaveGraphic className="absolute inset-x-0 bottom-0 h-32 w-full opacity-80" />
          <div className="relative z-10 space-y-2">
            <FlowLogo size={28} variant="inverse" />
            <div className="pt-2 inline-flex items-center gap-1.5 rounded-[4px] bg-white/10 px-2.5 py-1 text-[11px] font-semibold text-emerald-400">
              <IconBuilding size={13} />
              Business Workspace Invitation
            </div>
            <h1 className="font-display text-2xl font-extrabold text-white">
              Business invitation
            </h1>
            <p className="text-xs sm:text-sm text-slate-200">
              Sign in with the email that received this invitation, then open
              the link and accept.
            </p>
          </div>
        </div>

        <div className="p-7 sm:p-8 space-y-5">
          <div className="flex items-start gap-2.5 rounded-[10px] border border-[var(--border-subtle)] bg-[var(--surface-subtle)]/60 p-3.5 text-xs text-[var(--text-secondary)]">
            <IconShield size={16} className="mt-0.5 shrink-0 text-[#FF1A1A]" />
            <span>
              Invitation tokens are single-use and verified against your
              authenticated email address. Your personal account remains
              independent.
            </span>
          </div>

          <AcceptInvitation />

          <div className="border-t border-[var(--border-subtle)] pt-4 text-center">
            <Link
              href="/sign-in"
              className="text-xs font-semibold text-[#FF1A1A] hover:underline"
            >
              Sign in with the invited email
            </Link>
          </div>
        </div>
      </section>
    </main>
  );
}

"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { FlowWaveGraphic } from "../../../components/flow-logo.tsx";
import {
  IconCheck,
  IconLock,
  IconSettings,
  IconShield,
  IconUsers,
} from "../../../components/icons.tsx";
import { ThemeToggle } from "../../../components/theme-toggle.tsx";
import {
  describe,
  Feedback,
  FreshProof,
  googleNavigate,
  send,
} from "../../controls.tsx";

const actions = {
  "enroll-email": { label: "Enable email sign-in", path: "email/enroll" },
  "disable-email": { label: "Disable email sign-in", path: "email/disable" },
  "link-google": { label: "Link Google", path: "google/link" },
  "unlink-google": { label: "Disconnect Google", path: "google/unlink" },
  "revoke-all": { label: "Sign out all sessions", path: "sessions/revoke-all" },
} as const;

export function SecurityPanel({
  email,
  emailEnrolled,
  googleLinked,
  mailboxPaused,
  sessions,
}: {
  email: string;
  emailEnrolled: boolean;
  googleLinked: boolean;
  mailboxPaused: boolean;
  sessions: {
    id: string;
    createdAt: string;
    expiresAt: string;
    current: boolean;
  }[];
}) {
  const [action, setAction] = useState<keyof typeof actions>();
  const [message, setMessage] = useState("");
  const [revoking, setRevoking] = useState(false);
  const router = useRouter();

  async function revoke(id: string, current: boolean) {
    setRevoking(true);
    try {
      await send("/api/security/sessions/revoke", { id });
      if (current) window.location.replace("/sign-in");
      else {
        setMessage("Session signed out.");
        router.refresh();
      }
    } catch (error) {
      setMessage(describe(error));
    } finally {
      setRevoking(false);
    }
  }

  return (
    <div className="space-y-6">
      {/* Top Security & Settings Banner */}
      <section className="flow-dark-banner relative overflow-hidden p-6 sm:p-8">
        <FlowWaveGraphic className="absolute inset-x-0 bottom-0 h-36 w-full opacity-80" />
        <div className="relative z-10 flex flex-wrap items-center justify-between gap-4">
          <div className="space-y-2">
            <span className="inline-flex items-center gap-1.5 rounded-[4px] bg-white/10 px-2.5 py-1 text-[11px] font-semibold text-emerald-400">
              <IconShield size={13} />
              Profile, Security &amp; Account Preferences
            </span>
            <h1 className="font-display text-2xl font-extrabold text-white sm:text-3xl">
              Security
            </h1>
            <p className="max-w-2xl text-xs sm:text-sm text-slate-200">
              Manage connected passwordless login methods, step-up verification
              proofs, active browser sessions, and interface preferences.
            </p>
          </div>

          <div className="flex flex-wrap gap-2">
            <span className="rounded-[6px] border border-white/15 bg-white/10 px-3 py-1.5 text-xs font-semibold text-white">
              Scoped Custody Isolation
            </span>
            <span className="rounded-[6px] border border-white/15 bg-white/10 px-3 py-1.5 text-xs font-semibold text-white">
              Row-Level Tenant Isolation
            </span>
          </div>
        </div>
      </section>

      {action && (
        <FreshProof
          key={action}
          purpose={action}
          onCancel={() => setAction(undefined)}
          onConfirm={async () => {
            const response = await send<{ url: string } | undefined>(
              `/api/security/${actions[action].path}`,
            );
            if (action === "link-google" && response)
              googleNavigate(response.url);
            else window.location.replace("/sign-in?notice=updated");
          }}
        >
          {actions[action].label}.
        </FreshProof>
      )}

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-12 items-start">
        {/* Left 4 Columns: Profile, Appearance & Workspace Navigation */}
        <div className="lg:col-span-4 space-y-6">
          <section className="flow-card p-6 space-y-4">
            <div className="flex items-center gap-3">
              <span className="inline-flex h-11 w-11 items-center justify-center rounded-full bg-[#FF1A1A]/10 font-display text-base font-bold text-[#FF1A1A]">
                {email.slice(0, 2).toUpperCase()}
              </span>
              <div className="min-w-0 flex-1">
                <span className="text-[10px] font-bold uppercase tracking-wider text-[#FF1A1A]">
                  Authenticated Identity
                </span>
                <p className="truncate font-display text-sm font-bold text-[var(--text-primary)]">
                  {email}
                </p>
              </div>
            </div>

            <div className="border-t border-[var(--border-subtle)] pt-3 space-y-2 text-xs">
              <div className="flex items-center justify-between">
                <span className="text-[var(--text-muted)]">
                  Authentication Mode
                </span>
                <span className="inline-flex items-center gap-1 font-semibold text-[var(--text-primary)]">
                  <IconCheck size={13} className="text-[#0F9F80]" />
                  Passwordless (OAuth / OTP)
                </span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-[var(--text-muted)]">
                  Session Issuance
                </span>
                <span className="font-mono text-[11px] text-[var(--text-secondary)]">
                  One-time DB ticket bound
                </span>
              </div>
            </div>
          </section>

          <section className="flow-card p-6 space-y-3">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <IconSettings size={16} className="text-[#FF1A1A]" />
                <h2 className="font-display text-sm font-bold text-[var(--text-primary)]">
                  Interface Appearance
                </h2>
              </div>
              <ThemeToggle />
            </div>
            <p className="text-xs text-[var(--text-secondary)]">
              Toggle between the default light workspace theme and the deep navy
              dark theme.
            </p>
          </section>

          <section className="flow-card p-6 space-y-3">
            <div className="flex items-center justify-between">
              <span className="inline-flex items-center gap-2 font-display text-sm font-bold text-[var(--text-primary)]">
                <IconUsers size={16} className="text-[#0F9F80]" />
                Account Workspaces
              </span>
              <Link
                prefetch={false}
                href="/accounts"
                className="text-xs font-semibold text-[#FF1A1A] hover:underline"
              >
                Open Directory →
              </Link>
            </div>
            <p className="text-xs text-[var(--text-secondary)]">
              Switch between your Personal account and any Business accounts you
              own or collaborate on.
            </p>
          </section>
        </div>

        {/* Right 8 Columns: Connected Sign-In Methods + Active Sessions */}
        <div className="lg:col-span-8 space-y-6">
          <section className="flow-card p-6 space-y-4">
            <div className="flex flex-wrap items-start justify-between gap-4 border-b border-[var(--border-subtle)] pb-4">
              <div>
                <span className="text-[11px] font-bold uppercase tracking-wider text-[#FF1A1A]">
                  Connected Login Methods
                </span>
                <h2 className="font-display text-lg font-bold text-[var(--text-primary)]">
                  Sign-in methods
                </h2>
                <p className="mt-1 text-xs font-medium text-[var(--text-secondary)]">
                  Email code {emailEnrolled ? "enabled" : "disabled"} · Google{" "}
                  {googleLinked ? "linked" : "available to link"}
                </p>
              </div>
            </div>

            {mailboxPaused ? (
              <p
                role="status"
                className="rounded-[8px] border border-amber-200 bg-amber-50 px-4 py-3 text-xs font-semibold text-amber-900"
              >
                Email security changes are paused. Contact support if you need
                access.
              </p>
            ) : (
              <div className="flex flex-wrap items-center gap-2.5">
                {!emailEnrolled && (
                  <button
                    type="button"
                    className="flow-btn-primary px-4 py-2 text-xs"
                    onClick={() => setAction("enroll-email")}
                  >
                    Enable email sign-in
                  </button>
                )}
                {emailEnrolled && googleLinked && (
                  <>
                    <button
                      type="button"
                      className="flow-btn-secondary px-3.5 py-2 text-xs font-semibold"
                      onClick={() => setAction("disable-email")}
                    >
                      Disable email sign-in
                    </button>
                    <button
                      type="button"
                      className="flow-btn-secondary px-3.5 py-2 text-xs font-semibold"
                      onClick={() => setAction("unlink-google")}
                    >
                      Disconnect Google
                    </button>
                  </>
                )}
                {!googleLinked && (
                  <button
                    type="button"
                    className="flow-btn-primary px-4 py-2 text-xs"
                    onClick={() => setAction("link-google")}
                  >
                    Link Google
                  </button>
                )}
              </div>
            )}
          </section>

          <section className="flow-card p-6 space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[var(--border-subtle)] pb-4">
              <div>
                <h2 className="font-display text-lg font-bold text-[var(--text-primary)]">
                  Active sessions
                </h2>
                <p className="text-xs text-[var(--text-secondary)]">
                  Database-backed authentication sessions currently active for
                  your identity.
                </p>
              </div>

              {!mailboxPaused && (
                <div>
                  <button
                    type="button"
                    className="flow-btn-primary px-3.5 py-2 text-xs"
                    onClick={() => setAction("revoke-all")}
                  >
                    Sign out all sessions
                  </button>
                </div>
              )}
            </div>

            <ul className="space-y-3">
              {sessions.map((session) => (
                <li
                  key={session.id}
                  className="flex flex-wrap items-center justify-between gap-3 rounded-[10px] border border-[var(--border-subtle)] bg-[var(--surface-subtle)]/50 p-4 text-xs"
                >
                  <span className="inline-flex items-center gap-2.5 font-semibold text-[var(--text-primary)]">
                    <span
                      className={`h-2.5 w-2.5 rounded-full ${
                        session.current ? "bg-emerald-400" : "bg-slate-400"
                      }`}
                    />
                    <span>
                      {session.current ? "This session" : "Other session"} ·
                      Started{" "}
                      <time dateTime={session.createdAt}>
                        {session.createdAt.slice(0, 10)} UTC
                      </time>
                    </span>
                  </span>
                  <button
                    type="button"
                    className="flow-btn-secondary px-3 py-1.5 text-xs font-semibold"
                    disabled={revoking}
                    onClick={() => revoke(session.id, session.current)}
                  >
                    Sign out session
                  </button>
                </li>
              ))}
            </ul>

            <Feedback text={message} />
          </section>

          <section className="flow-card p-5 flex items-start gap-3 text-xs text-[var(--text-secondary)]">
            <IconLock size={16} className="mt-0.5 shrink-0 text-[#FF1A1A]" />
            <div>
              <p className="font-semibold text-[var(--text-primary)]">
                Platform Security Controls
              </p>
              <p className="mt-1 leading-relaxed">
                Session bearer tokens are protected by PostgreSQL Row-Level
                Security (`flow.auth_sessions`), one-time cryptographic issuance
                tickets (`flow.auth_issuance_tickets`), and{" "}
                <code className="font-mono">HttpOnly</code> /{" "}
                <code className="font-mono">SameSite=Lax</code> cookies.
              </p>
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}

"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { FlowLogo } from "../../../components/flow-logo.tsx";
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
  const [workspaceDropdownOpen, setWorkspaceDropdownOpen] = useState(true);
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
    <div className="min-h-screen bg-[#FAF8F5] dark:bg-neutral-950 text-neutral-950 dark:text-white flex flex-col lg:flex-row">
      {/* =====================================================================
          LEFT DARK SIDEBAR (Matches 08_26_23 PM-10.png)
         ===================================================================== */}
      <aside
        aria-label="Settings workspace navigation"
        className="hidden lg:flex lg:w-[250px] lg:shrink-0 lg:flex-col lg:justify-between bg-[#0B0B0B] text-white p-5 lg:min-h-screen lg:sticky lg:top-0"
      >
        <div>
          <div className="px-2 pt-1 pb-7">
            <Link href="/" prefetch={false} aria-label="FLOW Home">
              <FlowLogo size={26} variant="inverse" />
            </Link>
          </div>

          <nav className="space-y-1">
            <Link
              prefetch={false}
              href="/accounts"
              className="flex w-full items-center gap-3 rounded-full px-4 py-2.5 text-[13px] font-medium text-neutral-400 hover:bg-white/5 hover:text-white transition-all"
            >
              <span>⌂</span>
              <span>Home</span>
            </Link>
            <Link
              prefetch={false}
              href="/accounts"
              className="flex w-full items-center gap-3 rounded-full px-4 py-2.5 text-[13px] font-medium text-neutral-400 hover:bg-white/5 hover:text-white transition-all"
            >
              <span>↗</span>
              <span>Send</span>
            </Link>
            <Link
              prefetch={false}
              href="/accounts"
              className="flex w-full items-center gap-3 rounded-full px-4 py-2.5 text-[13px] font-medium text-neutral-400 hover:bg-white/5 hover:text-white transition-all"
            >
              <span>↙</span>
              <span>Receive</span>
            </Link>
            <Link
              prefetch={false}
              href="/accounts"
              className="flex w-full items-center gap-3 rounded-full px-4 py-2.5 text-[13px] font-medium text-neutral-400 hover:bg-white/5 hover:text-white transition-all"
            >
              <span>🔗</span>
              <span>Request</span>
            </Link>
            <Link
              prefetch={false}
              href="/accounts"
              className="flex w-full items-center gap-3 rounded-full px-4 py-2.5 text-[13px] font-medium text-neutral-400 hover:bg-white/5 hover:text-white transition-all"
            >
              <span>▣</span>
              <span>Wallets &amp; Assets</span>
            </Link>
            <Link
              prefetch={false}
              href="/accounts"
              className="flex w-full items-center gap-3 rounded-full px-4 py-2.5 text-[13px] font-medium text-neutral-400 hover:bg-white/5 hover:text-white transition-all"
            >
              <span>◷</span>
              <span>Activity</span>
            </Link>

            <div className="!my-4 border-t border-white/10" />

            <Link
              prefetch={false}
              href="/security"
              className="flex w-full items-center gap-3 rounded-full px-4 py-2.5 text-[13px] font-medium bg-gradient-to-r from-[#450A0A] via-[#7F1D1D] to-[#991B1B] text-white border border-[#EF4444]/40 shadow-sm"
            >
              <span>⚙</span>
              <span>Settings</span>
            </Link>
          </nav>
        </div>

        <div className="space-y-4 pt-6">
          <div className="relative overflow-hidden rounded-[18px] border border-white/10 bg-[#141414] p-4">
            <div className="pointer-events-none absolute -bottom-6 -right-6 h-24 w-24 rounded-full bg-[#FF1A1A]/25 blur-xl" />
            <p className="text-[13px] font-semibold text-white leading-snug">
              Get the Flow app on mobile.
            </p>
            <p className="mt-1 text-[11px] text-neutral-400 leading-relaxed">
              Manage payments, wallets, and activity anywhere.
            </p>
            <Link
              prefetch={false}
              href="/accounts"
              className="mt-3 inline-flex items-center gap-1.5 rounded-full border border-white/15 bg-white/10 px-3 py-1 text-[11px] font-medium text-white hover:bg-white/15"
            >
              Get the app <span>→</span>
            </Link>
          </div>

          <div className="flex items-center justify-between border-t border-white/10 pt-4">
            <div className="flex items-center gap-2.5 min-w-0">
              <img
                src="/assets/amara-avatar.png"
                alt="Profile"
                className="h-9 w-9 rounded-full object-cover border border-white/20 shrink-0"
              />
              <div className="min-w-0">
                <p className="truncate text-xs font-semibold text-white">
                  Amara Okafor
                </p>
                <p className="truncate text-[11px] text-neutral-400">{email}</p>
              </div>
            </div>
            <span className="text-neutral-400 text-sm px-1">•••</span>
          </div>
        </div>
      </aside>

      {/* =====================================================================
          MAIN SETTINGS WORKSPACE (Matches 08_26_23 PM-10.png)
         ===================================================================== */}
      <div className="flex-1 min-w-0 pb-20 relative overflow-hidden">
        {/* Top-Right Red Wave Accent */}
        <div
          aria-hidden="true"
          className="pointer-events-none absolute -top-10 right-0 w-[340px] sm:w-[460px] h-[180px] z-0 overflow-hidden"
        >
          <svg viewBox="0 0 500 200" fill="none" className="w-full h-full">
            <path
              d="M120 -20 C240 80, 360 20, 520 150 L520 -20 Z"
              fill="url(#secWaveGrad)"
            />
            <defs>
              <linearGradient id="secWaveGrad" x1="0" y1="0" x2="1" y2="1">
                <stop offset="0%" stopColor="#FF2E2E" />
                <stop offset="65%" stopColor="#CC0000" />
                <stop offset="100%" stopColor="#1A0000" />
              </linearGradient>
            </defs>
          </svg>
        </div>

        <div className="relative z-10 mx-auto max-w-[1180px] px-4 sm:px-8 pt-6">
          {/* Top Bar */}
          <div className="flex items-center justify-between gap-4 mb-6">
            <div>
              <div className="lg:hidden mb-3">
                <Link href="/" prefetch={false}>
                  <FlowLogo size={24} />
                </Link>
              </div>
              <p className="text-[11px] font-bold uppercase tracking-[0.14em] text-[#FF1A1A]">
                ACCOUNT &amp; WORKSPACE
              </p>
              <h1 className="mt-1 font-serif text-3xl sm:text-[42px] font-normal tracking-[-0.02em] text-neutral-950 dark:text-white">
                Settings
              </h1>
              <p className="mt-1 text-sm text-neutral-600 dark:text-neutral-400">
                Manage your profile, security, notifications, and workspace
                preferences.
              </p>
            </div>

            {/* Right Top Bar with Workspace Switcher Dropdown (Matches 08_26_23 PM-10.png) */}
            <div className="flex items-center gap-3 self-start">
              <div className="relative">
                <button
                  type="button"
                  onClick={() => setWorkspaceDropdownOpen((prev) => !prev)}
                  className="inline-flex items-center gap-2.5 rounded-full border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 px-4 py-2 text-xs font-semibold text-neutral-900 dark:text-white shadow-sm"
                >
                  <img
                    src="/assets/amara-avatar.png"
                    alt=""
                    className="h-5 w-5 rounded-full object-cover"
                  />
                  <span>Amara Personal</span>
                  <span className="text-neutral-400 text-[10px]">▾</span>
                </button>

                {workspaceDropdownOpen && (
                  <div className="hidden xl:block absolute right-0 mt-2 w-64 rounded-[20px] border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 p-3 shadow-xl z-30">
                    <div className="space-y-1 text-xs">
                      <div className="flex items-center justify-between rounded-[12px] bg-neutral-100 dark:bg-neutral-800 px-3 py-2 font-semibold text-neutral-950 dark:text-white">
                        <div>
                          <p>Amara Personal</p>
                          <p className="text-[10px] font-normal text-neutral-500">
                            Personal · 3 wallets
                          </p>
                        </div>
                        <span className="text-[#FF1A1A]">✓</span>
                      </div>
                      <Link
                        prefetch={false}
                        href="/accounts"
                        className="flex items-center justify-between rounded-[12px] px-3 py-2 text-neutral-700 dark:text-neutral-300 hover:bg-neutral-50 dark:hover:bg-neutral-800"
                      >
                        <div>
                          <p className="font-semibold">Studio Kora</p>
                          <p className="text-[10px] text-neutral-500">
                            Business · 5 members
                          </p>
                        </div>
                      </Link>
                    </div>
                    <div className="mt-2 border-t border-neutral-100 dark:border-neutral-800 pt-2">
                      <Link
                        prefetch={false}
                        href="/accounts"
                        className="block rounded-[10px] px-3 py-1.5 text-xs font-semibold text-neutral-800 dark:text-neutral-200 hover:bg-neutral-50"
                      >
                        + Create workspace
                      </Link>
                    </div>
                  </div>
                )}
              </div>

              <ThemeToggle />
            </div>
          </div>

          {action && (
            <div className="mb-6">
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
            </div>
          )}

          {message && (
            <div className="mb-5">
              <Feedback text={message} />
            </div>
          )}

          {/* Main Grid: Left Settings Sub-Nav (3 cols) + Right Cards (9 cols) */}
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
            {/* Left Sub-Navigation Card */}
            <div className="lg:col-span-3 rounded-[22px] border border-neutral-200/80 dark:border-neutral-800 bg-white dark:bg-neutral-900 p-3 shadow-2xs space-y-1">
              <div className="flex items-center justify-between rounded-[14px] bg-neutral-950 text-white px-3.5 py-2.5 text-xs font-semibold">
                <span>Account &amp; Profile</span>
                <span className="h-1.5 w-1.5 rounded-full bg-[#FF1A1A]" />
              </div>
              <div className="rounded-[14px] px-3.5 py-2.5 text-xs font-medium text-neutral-600 dark:text-neutral-400">
                Notifications
              </div>
              <div className="rounded-[14px] px-3.5 py-2.5 text-xs font-medium text-neutral-600 dark:text-neutral-400">
                Connected Accounts
              </div>
              <div className="rounded-[14px] px-3.5 py-2.5 text-xs font-medium text-neutral-600 dark:text-neutral-400">
                Security &amp; Sessions
              </div>
              <div className="rounded-[14px] px-3.5 py-2.5 text-xs font-medium text-neutral-600 dark:text-neutral-400">
                Billing &amp; Plan
              </div>
              <Link
                prefetch={false}
                href="/accounts"
                className="block rounded-[14px] px-3.5 py-2.5 text-xs font-medium text-neutral-600 dark:text-neutral-400 hover:bg-neutral-50 dark:hover:bg-neutral-800"
              >
                Workspaces →
              </Link>
            </div>

            {/* Right 9 Columns */}
            <div className="lg:col-span-9 space-y-5">
              {/* Top Dark Red-Wave Security Banner */}
              <div className="relative overflow-hidden rounded-[22px] bg-[#0B0B0B] p-6 text-white shadow-md">
                <div
                  aria-hidden="true"
                  className="pointer-events-none absolute inset-y-0 right-0 w-1/2 bg-gradient-to-l from-[#FF1A1A]/35 via-[#991B1B]/20 to-transparent"
                />
                <div className="relative z-10 max-w-lg">
                  <span className="text-[10px] font-bold uppercase tracking-[0.14em] text-[#FF1A1A]">
                    SECURITY STATUS · PROTECTED
                  </span>
                  <h2 className="mt-1 font-serif text-2xl text-white">
                    Keep your Flow account secure and working for you.
                  </h2>
                  <p className="mt-1 text-xs text-neutral-300">
                    Email code {emailEnrolled ? "enabled" : "disabled"} · Google{" "}
                    {googleLinked ? "linked" : "available to link"}
                  </p>
                </div>
              </div>

              {/* 2x2 Cards Grid */}
              <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
                {/* Card 1: Profile Settings */}
                <section className="rounded-[22px] border border-neutral-200/80 dark:border-neutral-800 bg-white dark:bg-neutral-900 p-6 shadow-2xs space-y-4">
                  <div className="flex items-center justify-between">
                    <div>
                      <h2 className="font-display text-base font-bold text-neutral-950 dark:text-white">
                        Profile Settings
                      </h2>
                      <p className="text-xs text-neutral-500">
                        Update your personal details and public handle.
                      </p>
                    </div>
                  </div>

                  <div className="flex items-center gap-3 pt-1">
                    <img
                      src="/assets/amara-avatar.png"
                      alt="Avatar"
                      className="h-12 w-12 rounded-full object-cover border border-neutral-200"
                    />
                    <div className="min-w-0">
                      <p className="font-display text-sm font-bold text-neutral-950 dark:text-white">
                        Amara Okafor
                      </p>
                      <p className="truncate text-xs text-neutral-500">
                        {email}
                      </p>
                    </div>
                  </div>

                  <div className="space-y-2.5 pt-2 text-xs">
                    <div className="flex items-center justify-between rounded-[12px] bg-neutral-50 dark:bg-neutral-800/60 px-3.5 py-2.5">
                      <span className="text-neutral-500">Handle</span>
                      <span className="font-mono font-semibold text-neutral-900 dark:text-white">
                        @amara
                      </span>
                    </div>
                    <div className="flex items-center justify-between rounded-[12px] bg-neutral-50 dark:bg-neutral-800/60 px-3.5 py-2.5">
                      <span className="text-neutral-500">Default currency</span>
                      <span className="font-semibold text-neutral-900 dark:text-white">
                        USD ($)
                      </span>
                    </div>
                  </div>
                </section>

                {/* Card 2: Notifications */}
                <section className="rounded-[22px] border border-neutral-200/80 dark:border-neutral-800 bg-white dark:bg-neutral-900 p-6 shadow-2xs space-y-4">
                  <div>
                    <h2 className="font-display text-base font-bold text-neutral-950 dark:text-white">
                      Notifications
                    </h2>
                    <p className="text-xs text-neutral-500">
                      Choose how you want to be notified about payments.
                    </p>
                  </div>

                  <div className="space-y-3 text-xs">
                    {[
                      {
                        title: "Incoming payments",
                        desc: "Instant alert when a link or invoice is settled",
                        on: true,
                      },
                      {
                        title: "Payment link activity",
                        desc: "Notify when a customer opens or quotes your link",
                        on: true,
                      },
                      {
                        title: "Security & sign-in alerts",
                        desc: "New browser sessions and verification codes",
                        on: true,
                      },
                    ].map((item) => (
                      <div
                        key={item.title}
                        className="flex items-center justify-between gap-3 rounded-[12px] bg-neutral-50 dark:bg-neutral-800/60 px-3.5 py-2.5"
                      >
                        <div>
                          <p className="font-semibold text-neutral-900 dark:text-white">
                            {item.title}
                          </p>
                          <p className="text-[11px] text-neutral-500">
                            {item.desc}
                          </p>
                        </div>
                        <span className="inline-flex h-5 w-9 shrink-0 items-center rounded-full bg-[#FF1A1A] p-0.5 justify-end">
                          <span className="h-4 w-4 rounded-full bg-white" />
                        </span>
                      </div>
                    ))}
                  </div>
                </section>

                {/* Card 3: Connected Accounts / Sign-in methods */}
                <section className="rounded-[22px] border border-neutral-200/80 dark:border-neutral-800 bg-white dark:bg-neutral-900 p-6 shadow-2xs space-y-4">
                  <div>
                    <h2 className="font-display text-base font-bold text-neutral-950 dark:text-white">
                      Sign-in methods
                    </h2>
                    <p className="text-xs text-neutral-500">
                      Manage passwordless Google and email verification methods.
                    </p>
                  </div>

                  <div className="space-y-2.5 text-xs">
                    <div className="flex items-center justify-between rounded-[12px] border border-neutral-200/70 dark:border-neutral-800 px-3.5 py-2.5">
                      <div>
                        <p className="font-semibold text-neutral-900 dark:text-white">
                          Google Account
                        </p>
                        <p className="text-[11px] text-neutral-500">
                          {googleLinked ? email : "Not linked"}
                        </p>
                      </div>
                      <span
                        className={`rounded-full px-2.5 py-0.5 text-[10px] font-bold uppercase ${
                          googleLinked
                            ? "bg-emerald-50 text-emerald-700"
                            : "bg-neutral-100 text-neutral-600"
                        }`}
                      >
                        {googleLinked ? "Connected" : "Available"}
                      </span>
                    </div>

                    <div className="flex items-center justify-between rounded-[12px] border border-neutral-200/70 dark:border-neutral-800 px-3.5 py-2.5">
                      <div>
                        <p className="font-semibold text-neutral-900 dark:text-white">
                          Email Verification (OTP)
                        </p>
                        <p className="text-[11px] text-neutral-500">{email}</p>
                      </div>
                      <span
                        className={`rounded-full px-2.5 py-0.5 text-[10px] font-bold uppercase ${
                          emailEnrolled
                            ? "bg-emerald-50 text-emerald-700"
                            : "bg-neutral-100 text-neutral-600"
                        }`}
                      >
                        {emailEnrolled ? "Enabled" : "Disabled"}
                      </span>
                    </div>
                  </div>

                  {mailboxPaused ? (
                    <p
                      role="status"
                      className="rounded-[12px] border border-amber-200 bg-amber-50 px-3.5 py-2.5 text-xs font-semibold text-amber-900"
                    >
                      Email security changes are paused. Contact support if you
                      need access.
                    </p>
                  ) : (
                    <div className="flex flex-wrap items-center gap-2 pt-1">
                      {!emailEnrolled && (
                        <button
                          type="button"
                          onClick={() => setAction("enroll-email")}
                          className="rounded-full bg-neutral-950 px-4 py-2 text-xs font-semibold text-white hover:bg-neutral-800"
                        >
                          Enable email sign-in
                        </button>
                      )}
                      {emailEnrolled && googleLinked && (
                        <>
                          <button
                            type="button"
                            onClick={() => setAction("disable-email")}
                            className="rounded-full border border-neutral-200 bg-white px-3.5 py-2 text-xs font-semibold text-neutral-800 hover:bg-neutral-50"
                          >
                            Disable email sign-in
                          </button>
                          <button
                            type="button"
                            onClick={() => setAction("unlink-google")}
                            className="rounded-full border border-neutral-200 bg-white px-3.5 py-2 text-xs font-semibold text-neutral-800 hover:bg-neutral-50"
                          >
                            Disconnect Google
                          </button>
                        </>
                      )}
                      {!googleLinked && (
                        <button
                          type="button"
                          onClick={() => setAction("link-google")}
                          className="rounded-full bg-neutral-950 px-4 py-2 text-xs font-semibold text-white hover:bg-neutral-800"
                        >
                          Link Google
                        </button>
                      )}
                    </div>
                  )}
                </section>

                {/* Card 4: Security & Active Sessions */}
                <section className="rounded-[22px] border border-neutral-200/80 dark:border-neutral-800 bg-white dark:bg-neutral-900 p-6 shadow-2xs space-y-4">
                  <div className="flex items-center justify-between gap-2">
                    <div>
                      <h2 className="font-display text-base font-bold text-neutral-950 dark:text-white">
                        Active sessions
                      </h2>
                      <p className="text-xs text-neutral-500">
                        Manage devices signed in to your Flow account.
                      </p>
                    </div>
                    {!mailboxPaused && (
                      <button
                        type="button"
                        onClick={() => setAction("revoke-all")}
                        className="rounded-full bg-[#FF1A1A] px-3.5 py-1.5 text-xs font-semibold text-white hover:bg-[#E01515]"
                      >
                        Sign out all sessions
                      </button>
                    )}
                  </div>

                  <ul className="space-y-2.5 text-xs">
                    {sessions.map((session) => (
                      <li
                        key={session.id}
                        className="flex items-center justify-between gap-2 rounded-[12px] border border-neutral-200/70 dark:border-neutral-800 px-3.5 py-2.5"
                      >
                        <div className="flex items-center gap-2">
                          <span
                            className={`h-2 w-2 rounded-full ${
                              session.current
                                ? "bg-emerald-500"
                                : "bg-neutral-400"
                            }`}
                          />
                          <div>
                            <p className="font-semibold text-neutral-900 dark:text-white">
                              {session.current
                                ? "This session"
                                : "Other session"}
                            </p>
                            <p className="text-[11px] text-neutral-500">
                              Started{" "}
                              <time dateTime={session.createdAt}>
                                {session.createdAt.slice(0, 10)} UTC
                              </time>
                            </p>
                          </div>
                        </div>

                        <button
                          type="button"
                          disabled={revoking}
                          onClick={() => revoke(session.id, session.current)}
                          className="rounded-full border border-neutral-200 bg-white px-3 py-1 text-xs font-semibold text-neutral-800 hover:bg-neutral-50"
                        >
                          Sign out session
                        </button>
                      </li>
                    ))}
                  </ul>
                </section>
              </div>

              {/* Bottom Account Management Bar */}
              <div className="flex flex-wrap items-center justify-between gap-4 rounded-[22px] border border-neutral-200/80 dark:border-neutral-800 bg-white dark:bg-neutral-900 p-5 shadow-2xs">
                <div>
                  <h3 className="font-display text-sm font-bold text-neutral-950 dark:text-white">
                    Account Management
                  </h3>
                  <p className="text-xs text-neutral-500">
                    Switch between personal and business workspaces or export
                    your account data.
                  </p>
                </div>
                <div className="flex items-center gap-2.5">
                  <Link
                    prefetch={false}
                    href="/accounts"
                    className="rounded-full bg-neutral-950 px-4 py-2 text-xs font-semibold text-white hover:bg-neutral-800"
                  >
                    Manage Workspaces →
                  </Link>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

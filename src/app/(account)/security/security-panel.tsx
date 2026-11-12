"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useState } from "react";
import { FlowLogo } from "../../../components/flow-logo.tsx";
import { ThemeToggle } from "../../../components/theme-toggle.tsx";
import { UserAvatar } from "../../../components/user-avatar.tsx";
import { describe, Feedback, send } from "../../controls.tsx";

export interface SessionRecord {
  readonly id: string;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly current: boolean;
}

export interface SecurityPanelProps {
  readonly email: string;
  readonly emailEnrolled: boolean;
  readonly mailboxPaused: boolean;
  readonly googleLinked: boolean;
  readonly sessions: readonly SessionRecord[];
  readonly accounts: readonly {
    readonly id: string;
    readonly name: string;
    readonly kind: string;
    readonly role: string;
    readonly walletStatus: string;
  }[];
}

type SettingsTab = "notifications" | "security" | "preferences" | "profile";

export function SecurityPanel({
  email,
  emailEnrolled,
  googleLinked,
  sessions: initialSessions,
  accounts,
}: SecurityPanelProps) {
  const searchParams = useSearchParams();
  const initialTab =
    (searchParams?.get("tab") as SettingsTab) || "notifications";
  const [activeTab, setActiveTab] = useState<SettingsTab>(initialTab);

  // Notifications state
  const [incomingPayments, setIncomingPayments] = useState(true);
  const [paymentLinkActivity, setPaymentLinkActivity] = useState(true);
  const [securityAlerts, setSecurityAlerts] = useState(true);

  // Sessions state
  const [sessions, setSessions] =
    useState<readonly SessionRecord[]>(initialSessions);
  const [revokingId, setRevokingId] = useState<string | null>(null);
  const [message, setMessage] = useState("");

  const primaryAccount = accounts[0];
  const backHref = primaryAccount ? `/accounts/${primaryAccount.id}` : "/";

  // Revoke session
  async function handleRevoke(sessionId: string) {
    setRevokingId(sessionId);
    setMessage("");
    try {
      await send("/api/security/sessions/revoke", { id: sessionId }, "POST");
      setSessions((prev) => prev.filter((s) => s.id !== sessionId));
      setMessage("Session revoked successfully.");
    } catch (err) {
      setMessage(describe(err));
    } finally {
      setRevokingId(null);
    }
  }

  // Revoke all other sessions
  async function handleRevokeAll() {
    setRevokingId("all");
    setMessage("");
    try {
      await send("/api/security/sessions/revoke-all", {}, "POST");
      setSessions((prev) => prev.filter((s) => s.current));
      setMessage("All other sessions have been signed out.");
    } catch (err) {
      setMessage(describe(err));
    } finally {
      setRevokingId(null);
    }
  }

  return (
    <div className="min-h-screen bg-[#FAF8F5] dark:bg-[#0B0B0B] text-neutral-950 dark:text-white pb-20 selection:bg-red-100 selection:text-red-900">
      {/* Top Navigation Bar matching media_1794481849606_6993ee54.jpg */}
      <header className="sticky top-0 z-40 w-full px-4 sm:px-8 pt-4 pb-3">
        <div className="mx-auto flex max-w-7xl items-center justify-between gap-4">
          <Link
            href={backHref}
            aria-label="FLOW Home"
            className="flex items-center gap-2"
          >
            <FlowLogo size={28} />
          </Link>

          <nav
            aria-label="Primary navigation"
            className="hidden md:flex items-center p-1 rounded-full bg-white/90 dark:bg-[#141414]/90 backdrop-blur-md border border-neutral-200/80 dark:border-neutral-800/80 shadow-xs"
          >
            <Link
              href={backHref}
              className="flex items-center gap-2 px-3.5 py-1.5 rounded-full text-xs font-semibold text-neutral-600 dark:text-neutral-400 hover:text-neutral-950 dark:hover:text-white hover:bg-neutral-100/70 dark:hover:bg-neutral-800/50 transition-colors"
            >
              <span>⌂</span>
              <span>Home</span>
            </Link>
            <Link
              href={`${backHref}?view=send`}
              className="flex items-center gap-2 px-3.5 py-1.5 rounded-full text-xs font-semibold text-neutral-600 dark:text-neutral-400 hover:text-neutral-950 dark:hover:text-white hover:bg-neutral-100/70 dark:hover:bg-neutral-800/50 transition-colors"
            >
              <span>↗</span>
              <span>Send</span>
            </Link>
            <Link
              href={`${backHref}?view=receive`}
              className="flex items-center gap-2 px-3.5 py-1.5 rounded-full text-xs font-semibold text-neutral-600 dark:text-neutral-400 hover:text-neutral-950 dark:hover:text-white hover:bg-neutral-100/70 dark:hover:bg-neutral-800/50 transition-colors"
            >
              <span>+</span>
              <span>Add Money</span>
            </Link>
            <Link
              href={`${backHref}?view=request`}
              className="flex items-center gap-2 px-3.5 py-1.5 rounded-full text-xs font-semibold text-neutral-600 dark:text-neutral-400 hover:text-neutral-950 dark:hover:text-white hover:bg-neutral-100/70 dark:hover:bg-neutral-800/50 transition-colors"
            >
              <span>⚲</span>
              <span>Payment Links</span>
            </Link>
            <Link
              href={`${backHref}?view=activity`}
              className="flex items-center gap-2 px-3.5 py-1.5 rounded-full text-xs font-semibold text-neutral-600 dark:text-neutral-400 hover:text-neutral-950 dark:hover:text-white hover:bg-neutral-100/70 dark:hover:bg-neutral-800/50 transition-colors"
            >
              <span>◷</span>
              <span>Activity</span>
            </Link>
          </nav>

          <div className="flex items-center gap-2">
            <Link
              href="/security"
              aria-label="Settings"
              className="p-2 rounded-full text-neutral-950 dark:text-white bg-neutral-200/60 dark:bg-neutral-800 transition-colors"
            >
              <svg
                width="18"
                height="18"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <circle cx="12" cy="12" r="3" />
                <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
              </svg>
            </Link>
          </div>
        </div>
      </header>

      {/* Main Settings Page Container */}
      <main className="mx-auto max-w-5xl px-4 sm:px-8 pt-6">
        {/* Back Link */}
        <Link
          href={backHref}
          className="inline-flex items-center gap-1.5 text-xs font-semibold text-neutral-600 dark:text-neutral-400 hover:text-neutral-950 dark:hover:text-white transition-colors mb-4"
        >
          <span>←</span>
          <span>Back</span>
        </Link>

        {/* Settings Header */}
        <div className="mb-8">
          <h1 className="font-serif text-3xl sm:text-4xl font-normal tracking-tight text-neutral-950 dark:text-white">
            Settings
          </h1>
          <p className="mt-1 text-xs sm:text-sm text-neutral-600 dark:text-neutral-400">
            Manage your profile, security, notifications, and preferences.
          </p>
        </div>

        {message && (
          <div className="mb-6">
            <Feedback text={message} />
          </div>
        )}

        {/* 2-Column Layout matching media_1794481849606_6993ee54.jpg */}
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-8 items-start">
          {/* Left Subnav Card (4 cols) */}
          <div className="lg:col-span-4 rounded-3xl border border-neutral-200/80 dark:border-neutral-800 bg-white dark:bg-[#141414] p-3 shadow-sm space-y-1">
            <button
              type="button"
              onClick={() => setActiveTab("profile")}
              className={`w-full flex items-center gap-3 px-4 py-3 rounded-2xl text-xs font-semibold transition-all text-left cursor-pointer ${
                activeTab === "profile"
                  ? "bg-red-50/70 dark:bg-red-950/30 text-neutral-950 dark:text-white border border-red-200/60 dark:border-red-900/40"
                  : "text-neutral-600 dark:text-neutral-400 hover:bg-neutral-50 dark:hover:bg-neutral-800/50"
              }`}
            >
              <svg
                width="16"
                height="16"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                className={activeTab === "profile" ? "text-[#FF1A1A]" : ""}
              >
                <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
                <circle cx="12" cy="7" r="4" />
              </svg>
              <span>Account &amp; Profile</span>
            </button>

            <button
              type="button"
              onClick={() => setActiveTab("notifications")}
              className={`w-full flex items-center justify-between px-4 py-3 rounded-2xl text-xs font-semibold transition-all text-left cursor-pointer ${
                activeTab === "notifications"
                  ? "bg-red-50/70 dark:bg-red-950/30 text-neutral-950 dark:text-white border border-red-200/60 dark:border-red-900/40"
                  : "text-neutral-600 dark:text-neutral-400 hover:bg-neutral-50 dark:hover:bg-neutral-800/50"
              }`}
            >
              <div className="flex items-center gap-3">
                <svg
                  width="16"
                  height="16"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  className={
                    activeTab === "notifications" ? "text-[#FF1A1A]" : ""
                  }
                >
                  <path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9" />
                  <path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" />
                </svg>
                <span>Notifications</span>
              </div>
              <span className="h-2 w-2 rounded-full bg-[#FF1A1A]" />
            </button>

            <button
              type="button"
              onClick={() => setActiveTab("security")}
              className={`w-full flex items-center gap-3 px-4 py-3 rounded-2xl text-xs font-semibold transition-all text-left cursor-pointer ${
                activeTab === "security"
                  ? "bg-red-50/70 dark:bg-red-950/30 text-neutral-950 dark:text-white border border-red-200/60 dark:border-red-900/40"
                  : "text-neutral-600 dark:text-neutral-400 hover:bg-neutral-50 dark:hover:bg-neutral-800/50"
              }`}
            >
              <svg
                width="16"
                height="16"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                className={activeTab === "security" ? "text-[#FF1A1A]" : ""}
              >
                <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
              </svg>
              <span>Security &amp; Sessions</span>
            </button>

            <button
              type="button"
              onClick={() => setActiveTab("preferences")}
              className={`w-full flex items-center gap-3 px-4 py-3 rounded-2xl text-xs font-semibold transition-all text-left cursor-pointer ${
                activeTab === "preferences"
                  ? "bg-red-50/70 dark:bg-red-950/30 text-neutral-950 dark:text-white border border-red-200/60 dark:border-red-900/40"
                  : "text-neutral-600 dark:text-neutral-400 hover:bg-neutral-50 dark:hover:bg-neutral-800/50"
              }`}
            >
              <svg
                width="16"
                height="16"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                className={activeTab === "preferences" ? "text-[#FF1A1A]" : ""}
              >
                <line x1="4" y1="21" x2="4" y2="14" />
                <line x1="4" y1="10" x2="4" y2="3" />
                <line x1="12" y1="21" x2="12" y2="12" />
                <line x1="12" y1="8" x2="12" y2="3" />
                <line x1="20" y1="21" x2="20" y2="16" />
                <line x1="20" y1="12" x2="20" y2="3" />
                <line x1="1" y1="14" x2="7" y2="14" />
                <line x1="9" y1="8" x2="15" y2="8" />
                <line x1="17" y1="16" x2="23" y2="16" />
              </svg>
              <span>Preferences</span>
            </button>
          </div>

          {/* Right Content Panels (8 cols) */}
          <div className="lg:col-span-8 space-y-4">
            {/* TAB 1: NOTIFICATIONS (Matches Reference Screenshot) */}
            {activeTab === "notifications" && (
              <div className="space-y-4">
                <div className="rounded-3xl border border-neutral-200/80 dark:border-neutral-800 bg-white dark:bg-[#141414] p-6 sm:p-7 shadow-sm">
                  {/* Panel Header */}
                  <div className="flex items-start gap-4 mb-6">
                    <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl bg-red-50 dark:bg-red-950/40 text-[#FF1A1A]">
                      <svg
                        width="22"
                        height="22"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      >
                        <path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9" />
                        <path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" />
                      </svg>
                    </div>
                    <div>
                      <h2 className="font-display text-base font-bold text-neutral-950 dark:text-white">
                        Notifications
                      </h2>
                      <p className="text-xs text-neutral-500 dark:text-neutral-400">
                        Choose how you want to be notified about payments and
                        account activity.
                      </p>
                    </div>
                  </div>

                  {/* Toggle 1: Incoming payments */}
                  <div className="flex items-center justify-between p-4 rounded-2xl border border-neutral-100 dark:border-neutral-800 hover:bg-neutral-50/50 dark:hover:bg-neutral-800/30 transition-colors mb-3">
                    <div>
                      <p className="font-display font-semibold text-xs text-neutral-950 dark:text-white">
                        Incoming payments
                      </p>
                      <p className="text-[11px] text-neutral-500 dark:text-neutral-400">
                        Instant alert when a payment is received.
                      </p>
                    </div>
                    <button
                      type="button"
                      role="switch"
                      aria-checked={incomingPayments}
                      onClick={() => setIncomingPayments((prev) => !prev)}
                      className={`relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-hidden ${
                        incomingPayments
                          ? "bg-[#FF1A1A]"
                          : "bg-neutral-200 dark:bg-neutral-700"
                      }`}
                    >
                      <span
                        className={`pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow-sm ring-0 transition duration-200 ease-in-out ${
                          incomingPayments ? "translate-x-5" : "translate-x-0"
                        }`}
                      />
                    </button>
                  </div>

                  {/* Toggle 2: Payment link activity */}
                  <div className="flex items-center justify-between p-4 rounded-2xl border border-neutral-100 dark:border-neutral-800 hover:bg-neutral-50/50 dark:hover:bg-neutral-800/30 transition-colors mb-3">
                    <div>
                      <p className="font-display font-semibold text-xs text-neutral-950 dark:text-white">
                        Payment link activity
                      </p>
                      <p className="text-[11px] text-neutral-500 dark:text-neutral-400">
                        Notify when a customer opens or pays a payment link.
                      </p>
                    </div>
                    <button
                      type="button"
                      role="switch"
                      aria-checked={paymentLinkActivity}
                      onClick={() => setPaymentLinkActivity((prev) => !prev)}
                      className={`relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-hidden ${
                        paymentLinkActivity
                          ? "bg-[#FF1A1A]"
                          : "bg-neutral-200 dark:bg-neutral-700"
                      }`}
                    >
                      <span
                        className={`pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow-sm ring-0 transition duration-200 ease-in-out ${
                          paymentLinkActivity
                            ? "translate-x-5"
                            : "translate-x-0"
                        }`}
                      />
                    </button>
                  </div>

                  {/* Toggle 3: Security alerts */}
                  <div className="flex items-center justify-between p-4 rounded-2xl border border-neutral-100 dark:border-neutral-800 hover:bg-neutral-50/50 dark:hover:bg-neutral-800/30 transition-colors">
                    <div>
                      <p className="font-display font-semibold text-xs text-neutral-950 dark:text-white">
                        Security alerts
                      </p>
                      <p className="text-[11px] text-neutral-500 dark:text-neutral-400">
                        New sign-ins, verification codes, and important security
                        updates.
                      </p>
                    </div>
                    <button
                      type="button"
                      role="switch"
                      aria-checked={securityAlerts}
                      onClick={() => setSecurityAlerts((prev) => !prev)}
                      className={`relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-hidden ${
                        securityAlerts
                          ? "bg-[#FF1A1A]"
                          : "bg-neutral-200 dark:bg-neutral-700"
                      }`}
                    >
                      <span
                        className={`pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow-sm ring-0 transition duration-200 ease-in-out ${
                          securityAlerts ? "translate-x-5" : "translate-x-0"
                        }`}
                      />
                    </button>
                  </div>
                </div>

                {/* Secondary Navigation Strips matching reference screenshot */}
                <button
                  type="button"
                  onClick={() => setActiveTab("security")}
                  className="w-full flex items-center justify-between p-5 rounded-3xl border border-neutral-200/80 dark:border-neutral-800 bg-white dark:bg-[#141414] shadow-sm hover:border-neutral-300 transition-all text-left cursor-pointer"
                >
                  <div className="flex items-center gap-3.5">
                    <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl bg-neutral-100 dark:bg-neutral-800 text-neutral-700 dark:text-neutral-300">
                      <svg
                        width="18"
                        height="18"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      >
                        <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
                      </svg>
                    </div>
                    <div>
                      <p className="font-display font-bold text-xs text-neutral-950 dark:text-white">
                        Security &amp; Sessions
                      </p>
                      <p className="text-[11px] text-neutral-500 dark:text-neutral-400">
                        Keep your account secure and manage your active
                        sessions.
                      </p>
                    </div>
                  </div>
                  <span className="text-neutral-400 font-bold">&gt;</span>
                </button>

                <button
                  type="button"
                  onClick={() => setActiveTab("preferences")}
                  className="w-full flex items-center justify-between p-5 rounded-3xl border border-neutral-200/80 dark:border-neutral-800 bg-white dark:bg-[#141414] shadow-sm hover:border-neutral-300 transition-all text-left cursor-pointer"
                >
                  <div className="flex items-center gap-3.5">
                    <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl bg-neutral-100 dark:bg-neutral-800 text-neutral-700 dark:text-neutral-300">
                      <svg
                        width="18"
                        height="18"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      >
                        <line x1="4" y1="21" x2="4" y2="14" />
                        <line x1="4" y1="10" x2="4" y2="3" />
                        <line x1="12" y1="21" x2="12" y2="12" />
                        <line x1="12" y1="8" x2="12" y2="3" />
                        <line x1="20" y1="21" x2="20" y2="16" />
                        <line x1="20" y1="12" x2="20" y2="3" />
                        <line x1="1" y1="14" x2="7" y2="14" />
                        <line x1="9" y1="8" x2="15" y2="8" />
                        <line x1="17" y1="16" x2="23" y2="16" />
                      </svg>
                    </div>
                    <div>
                      <p className="font-display font-bold text-xs text-neutral-950 dark:text-white">
                        Preferences
                      </p>
                      <p className="text-[11px] text-neutral-500 dark:text-neutral-400">
                        Customize the look and feel of Flow.
                      </p>
                    </div>
                  </div>
                  <span className="text-neutral-400 font-bold">&gt;</span>
                </button>

                <button
                  type="button"
                  onClick={() => setActiveTab("profile")}
                  className="w-full flex items-center justify-between p-5 rounded-3xl border border-neutral-200/80 dark:border-neutral-800 bg-white dark:bg-[#141414] shadow-sm hover:border-neutral-300 transition-all text-left cursor-pointer"
                >
                  <div className="flex items-center gap-3.5">
                    <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl bg-neutral-100 dark:bg-neutral-800 text-neutral-700 dark:text-neutral-300">
                      <svg
                        width="18"
                        height="18"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      >
                        <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
                        <circle cx="12" cy="7" r="4" />
                      </svg>
                    </div>
                    <div>
                      <p className="font-display font-bold text-xs text-neutral-950 dark:text-white">
                        Account &amp; Profile
                      </p>
                      <p className="text-[11px] text-neutral-500 dark:text-neutral-400">
                        Update your personal details and profile picture.
                      </p>
                    </div>
                  </div>
                  <span className="text-neutral-400 font-bold">&gt;</span>
                </button>
              </div>
            )}

            {/* TAB 2: SECURITY & SESSIONS */}
            {activeTab === "security" && (
              <div className="space-y-4">
                <div className="rounded-3xl border border-neutral-200/80 dark:border-neutral-800 bg-white dark:bg-[#141414] p-6 sm:p-7 shadow-sm space-y-6">
                  <div>
                    <h2 className="font-display text-base font-bold text-neutral-950 dark:text-white">
                      Security &amp; Authentication
                    </h2>
                    <p className="text-xs text-neutral-500 dark:text-neutral-400 mt-1">
                      Manage authentication credentials and active sessions for{" "}
                      <span className="font-mono font-semibold text-neutral-900 dark:text-neutral-200">
                        {email}
                      </span>
                    </p>
                  </div>

                  {/* Authentication Methods */}
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <div className="p-4 rounded-2xl border border-neutral-100 dark:border-neutral-800 bg-neutral-50/50 dark:bg-neutral-900/30">
                      <div className="flex items-center justify-between mb-2">
                        <span className="text-xs font-bold text-neutral-950 dark:text-white">
                          Email OTP
                        </span>
                        <span className="px-2 py-0.5 rounded-full text-[10px] font-bold bg-emerald-50 text-emerald-700 border border-emerald-200/60">
                          {emailEnrolled ? "Enrolled" : "Available"}
                        </span>
                      </div>
                      <p className="text-[11px] text-neutral-500">
                        Passwordless one-time verification codes sent to {email}
                        .
                      </p>
                    </div>

                    <div className="p-4 rounded-2xl border border-neutral-100 dark:border-neutral-800 bg-neutral-50/50 dark:bg-neutral-900/30">
                      <div className="flex items-center justify-between mb-2">
                        <span className="text-xs font-bold text-neutral-950 dark:text-white">
                          Google SSO
                        </span>
                        <span
                          className={`px-2 py-0.5 rounded-full text-[10px] font-bold ${
                            googleLinked
                              ? "bg-emerald-50 text-emerald-700"
                              : "bg-neutral-100 text-neutral-600"
                          }`}
                        >
                          {googleLinked ? "Connected" : "Not connected"}
                        </span>
                      </div>
                      <p className="text-[11px] text-neutral-500">
                        Sign in directly using your verified Google account.
                      </p>
                    </div>
                  </div>

                  {/* Active Sessions */}
                  <div className="pt-4 border-t border-neutral-100 dark:border-neutral-800">
                    <div className="flex items-center justify-between mb-3">
                      <div>
                        <h3 className="font-display text-xs font-bold text-neutral-950 dark:text-white">
                          Active Sessions ({sessions.length})
                        </h3>
                        <p className="text-[11px] text-neutral-500">
                          Devices currently authorized to access this account.
                        </p>
                      </div>
                      {sessions.length > 1 && (
                        <button
                          type="button"
                          onClick={handleRevokeAll}
                          disabled={revokingId === "all"}
                          className="px-3 py-1.5 rounded-xl text-xs font-semibold text-red-600 hover:bg-red-50 dark:text-red-400 dark:hover:bg-red-950/40 transition-colors"
                        >
                          {revokingId === "all"
                            ? "Signing out..."
                            : "Sign out other sessions"}
                        </button>
                      )}
                    </div>

                    <div className="space-y-2">
                      {sessions.map((sess) => (
                        <div
                          key={sess.id}
                          className="flex items-center justify-between p-3.5 rounded-2xl border border-neutral-100 dark:border-neutral-800 bg-neutral-50/40 dark:bg-neutral-900/20"
                        >
                          <div className="flex items-center gap-3">
                            <span className="text-lg">💻</span>
                            <div>
                              <div className="flex items-center gap-2">
                                <span className="font-display font-semibold text-xs text-neutral-950 dark:text-white">
                                  Authorized Browser Session
                                </span>
                                {sess.current && (
                                  <span className="px-2 py-0.5 rounded-full text-[10px] font-bold bg-emerald-50 text-emerald-700 border border-emerald-200/60">
                                    Current
                                  </span>
                                )}
                              </div>
                              <p className="text-[10px] text-neutral-500">
                                Created:{" "}
                                {new Date(sess.createdAt).toLocaleString()}
                              </p>
                            </div>
                          </div>

                          {!sess.current && (
                            <button
                              type="button"
                              onClick={() => handleRevoke(sess.id)}
                              disabled={revokingId === sess.id}
                              className="px-2.5 py-1 rounded-lg text-xs font-semibold text-neutral-600 hover:text-red-600 hover:bg-red-50 transition-colors"
                            >
                              {revokingId === sess.id
                                ? "Revoking..."
                                : "Revoke"}
                            </button>
                          )}
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
              </div>
            )}

            {/* TAB 3: PREFERENCES */}
            {activeTab === "preferences" && (
              <div className="rounded-3xl border border-neutral-200/80 dark:border-neutral-800 bg-white dark:bg-[#141414] p-6 sm:p-7 shadow-sm space-y-6">
                <div>
                  <h2 className="font-display text-base font-bold text-neutral-950 dark:text-white">
                    Preferences
                  </h2>
                  <p className="text-xs text-neutral-500 dark:text-neutral-400 mt-1">
                    Customize your display settings and theme preferences.
                  </p>
                </div>

                <div className="flex items-center justify-between p-4 rounded-2xl border border-neutral-100 dark:border-neutral-800">
                  <div>
                    <p className="font-display font-semibold text-xs text-neutral-950 dark:text-white">
                      Appearance Theme
                    </p>
                    <p className="text-[11px] text-neutral-500 dark:text-neutral-400">
                      Toggle between clean light and deep dark visual styles.
                    </p>
                  </div>
                  <ThemeToggle />
                </div>
              </div>
            )}

            {/* TAB 4: ACCOUNT & PROFILE */}
            {activeTab === "profile" && (
              <div className="rounded-3xl border border-neutral-200/80 dark:border-neutral-800 bg-white dark:bg-[#141414] p-6 sm:p-7 shadow-sm space-y-6">
                <div>
                  <h2 className="font-display text-base font-bold text-neutral-950 dark:text-white">
                    Account &amp; Profile
                  </h2>
                  <p className="text-xs text-neutral-500 dark:text-neutral-400 mt-1">
                    Your personal Flow account identity.
                  </p>
                </div>

                <div className="flex items-center gap-4 p-4 rounded-2xl border border-neutral-100 dark:border-neutral-800 bg-neutral-50/50 dark:bg-neutral-900/30">
                  <UserAvatar
                    size={48}
                    className="rounded-full border border-neutral-200 dark:border-neutral-700"
                  />
                  <div>
                    <p className="font-display font-bold text-sm text-neutral-950 dark:text-white">
                      {primaryAccount?.name ?? "Personal Workspace"}
                    </p>
                    <p className="text-xs font-mono text-neutral-600 dark:text-neutral-400">
                      {email}
                    </p>
                    <div className="mt-1 inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold bg-emerald-50 text-emerald-700">
                      <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
                      Verified Owner
                    </div>
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>
      </main>
    </div>
  );
}

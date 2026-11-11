"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useRef, useState, type ChangeEvent } from "react";
import { FlowLogo } from "../../../components/flow-logo.tsx";
import {
  SidebarSignOutButton,
  ThemeToggle,
} from "../../../components/theme-toggle.tsx";
import {
  UserAvatar,
  setUserAvatar,
  resetUserAvatar,
} from "../../../components/user-avatar.tsx";
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

function WorkspaceDisplayNameCard({
  account,
}: {
  account: { id: string; name: string };
}) {
  const [isEditing, setIsEditing] = useState(false);
  const [name, setName] = useState(account.name);
  const [savedName, setSavedName] = useState(account.name);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const router = useRouter();

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;
    setBusy(true);
    setMessage("");
    try {
      await send(`/api/accounts/${account.id}`, { name: name.trim() }, "PATCH");
      setSavedName(name.trim());
      setIsEditing(false); // Automatically collapses once saved!
      setMessage("Workspace display name saved.");
      router.refresh();
    } catch (err) {
      setMessage(describe(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="rounded-[16px] border border-neutral-200/90 dark:border-neutral-800 bg-neutral-50/70 dark:bg-neutral-800/40 p-4 space-y-3">
      {!isEditing ? (
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <span className="text-[10px] font-bold uppercase tracking-wider text-neutral-400">
              Workspace display name
            </span>
            <p className="font-display text-sm sm:text-base font-bold text-neutral-950 dark:text-white truncate mt-0.5">
              {savedName}
            </p>
            <p className="text-[11px] text-neutral-500 dark:text-neutral-400">
              Shown on payment links and checkout receipts.
            </p>
          </div>
          <button
            type="button"
            onClick={() => {
              setName(savedName);
              setIsEditing(true);
            }}
            title="Edit workspace display name"
            aria-label="Edit workspace display name"
            className="flex items-center gap-1.5 rounded-full border border-neutral-200 dark:border-neutral-700 bg-white dark:bg-[#1f1f1f] px-3 py-1.5 text-xs font-semibold text-neutral-800 dark:text-neutral-200 hover:border-neutral-400 dark:hover:border-neutral-500 shadow-2xs transition-colors shrink-0"
          >
            <svg
              width="13"
              height="13"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z" />
            </svg>
            <span>Edit</span>
          </button>
        </div>
      ) : (
        <form onSubmit={handleSubmit} className="space-y-3">
          <div className="flex items-center justify-between">
            <label
              htmlFor="ws-name-input"
              className="block text-xs font-semibold text-neutral-800 dark:text-neutral-200"
            >
              Workspace display name
            </label>
            <button
              type="button"
              onClick={() => {
                setName(savedName);
                setIsEditing(false);
              }}
              className="text-xs text-neutral-500 hover:text-neutral-800 dark:hover:text-neutral-200"
            >
              Cancel
            </button>
          </div>
          <input
            id="ws-name-input"
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={80}
            required
            placeholder="Workspace name"
            className="flow-input w-full px-3.5 py-2 text-sm"
          />
          <div className="flex items-center gap-2">
            <button
              type="submit"
              disabled={busy || !name.trim()}
              className="flow-btn-primary px-4 py-1.5 text-xs font-semibold disabled:opacity-50"
            >
              {busy ? "Saving..." : "Save name"}
            </button>
            <button
              type="button"
              onClick={() => {
                setName(savedName);
                setIsEditing(false);
              }}
              className="rounded-full border border-neutral-200 dark:border-neutral-700 bg-white dark:bg-[#141414] px-3 py-1.5 text-xs font-semibold text-neutral-700 dark:text-neutral-300 hover:bg-neutral-50"
            >
              Cancel
            </button>
          </div>
        </form>
      )}
      {message && <Feedback text={message} />}
    </div>
  );
}

export function SecurityPanel({
  email,
  emailEnrolled,
  googleLinked,
  mailboxPaused,
  sessions,
  accounts = [],
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
  accounts?: {
    id: string;
    kind: "PERSONAL" | "BUSINESS" | "personal" | "business";
    name: string;
    role: string;
    walletStatus: string;
  }[];
}) {
  const [action, setAction] = useState<keyof typeof actions>();
  const [message, setMessage] = useState("");
  const [revoking, setRevoking] = useState(false);
  const [workspaceDropdownOpen, setWorkspaceDropdownOpen] = useState(true);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [avatarNotice, setAvatarNotice] = useState("");
  const router = useRouter();

  function handleAvatarChange(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    if (file.size > 5 * 1024 * 1024) {
      setAvatarNotice("Photo must be smaller than 5MB.");
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === "string") {
        setUserAvatar(reader.result);
        setAvatarNotice("Profile photo updated globally.");
        setTimeout(() => setAvatarNotice(""), 3500);
      }
    };
    reader.readAsDataURL(file);
  }

  const personalAccount = accounts.find(
    (a) => a.kind.toLowerCase() === "personal",
  );
  const primaryAccount = personalAccount ?? accounts[0];
  const emailPrefix = email.split("@")[0] || "user";
  const displayName =
    personalAccount?.name &&
    personalAccount.name.toLowerCase() !== "personal account"
      ? personalAccount.name
      : emailPrefix
          .split(/[._-]+/)
          .filter(Boolean)
          .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
          .join(" ") || email;
  const userHandle = `@${emailPrefix.toLowerCase().replace(/[^a-z0-9_]/g, "") || "user"}`;

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
        className="hidden lg:flex lg:fixed lg:inset-y-0 lg:left-0 lg:w-[250px] lg:shrink-0 lg:flex-col lg:justify-between bg-[#0B0B0B] text-white p-5 lg:z-30 lg:overflow-y-auto border-r border-neutral-900"
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
              <UserAvatar
                className="h-9 w-9 rounded-full object-cover border border-white/20 shrink-0"
              />
              <div className="min-w-0">
                <p className="truncate text-xs font-semibold text-white">
                  {displayName}
                </p>
                <p className="truncate text-[11px] text-neutral-400">{email}</p>
              </div>
            </div>
            <div className="flex items-center gap-1.5 shrink-0">
              <ThemeToggle variant="sidebar" />
              <span className="text-neutral-400 text-sm px-1">•••</span>
              <SidebarSignOutButton />
            </div>
          </div>
        </div>
      </aside>

      {/* =====================================================================
          MAIN SETTINGS WORKSPACE (Matches 08_26_23 PM-10.png)
         ===================================================================== */}
      <div className="flex-1 min-w-0 pb-20 relative overflow-hidden lg:pl-[250px]">
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
                  <UserAvatar
                    className="h-5 w-5 rounded-full object-cover shrink-0"
                    alt=""
                  />
                  <span>{primaryAccount?.name ?? "Personal account"}</span>
                  <span className="text-neutral-400 text-[10px]">▾</span>
                </button>

                {workspaceDropdownOpen && (
                  <div className="hidden xl:block absolute right-0 mt-2 w-64 rounded-[20px] border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 p-3 shadow-xl z-30">
                    <div className="space-y-1 text-xs">
                      {accounts.map((acc, idx) => (
                        <Link
                          key={acc.id}
                          prefetch={false}
                          href={`/accounts/${acc.id}`}
                          className={`flex items-center justify-between rounded-[12px] px-3 py-2 ${
                            idx === 0
                              ? "bg-neutral-100 dark:bg-neutral-800 font-semibold text-neutral-950 dark:text-white"
                              : "text-neutral-700 dark:text-neutral-300 hover:bg-neutral-50 dark:hover:bg-neutral-800"
                          }`}
                        >
                          <div>
                            <p className="font-semibold">{acc.name}</p>
                            <p className="text-[10px] font-normal text-neutral-500">
                              {acc.kind.toLowerCase() === "business"
                                ? `Business · ${acc.role}`
                                : `Personal · ${acc.walletStatus.replace(/_/g, " ")}`}
                            </p>
                          </div>
                          {idx === 0 && (
                            <span className="text-[#FF1A1A]">✓</span>
                          )}
                        </Link>
                      ))}
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
                        Update your personal details, profile picture, and workspace name.
                      </p>
                    </div>
                  </div>

                  <div className="flex items-center gap-4 pt-1">
                    <div className="relative group shrink-0">
                      <UserAvatar
                        className="h-14 w-14 rounded-full object-cover border-2 border-neutral-200 dark:border-neutral-700 shadow-xs"
                      />
                      <button
                        type="button"
                        onClick={() => fileInputRef.current?.click()}
                        title="Upload new profile picture"
                        aria-label="Upload new profile picture"
                        className="absolute inset-0 flex items-center justify-center rounded-full bg-black/60 text-white opacity-0 group-hover:opacity-100 transition-opacity"
                      >
                        <svg
                          width="16"
                          height="16"
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="2"
                        >
                          <path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z" />
                          <circle cx="12" cy="13" r="4" />
                        </svg>
                      </button>
                      <input
                        ref={fileInputRef}
                        type="file"
                        accept="image/*"
                        onChange={handleAvatarChange}
                        className="hidden"
                      />
                    </div>
                    <div className="min-w-0">
                      <p className="font-display text-sm font-bold text-neutral-950 dark:text-white">
                        {displayName}
                      </p>
                      <p className="truncate text-xs text-neutral-500">
                        {email}
                      </p>
                      <div className="flex items-center gap-2 mt-1.5">
                        <button
                          type="button"
                          onClick={() => fileInputRef.current?.click()}
                          className="text-[11px] font-semibold text-[#FF1A1A] hover:underline"
                        >
                          Change photo
                        </button>
                        <span className="text-neutral-300 dark:text-neutral-700">·</span>
                        <button
                          type="button"
                          onClick={() => {
                            resetUserAvatar();
                            setAvatarNotice("Profile photo reset to default.");
                            setTimeout(() => setAvatarNotice(""), 3000);
                          }}
                          className="text-[11px] font-semibold text-neutral-500 hover:text-neutral-800 dark:hover:text-neutral-200"
                        >
                          Reset
                        </button>
                      </div>
                    </div>
                  </div>

                  {avatarNotice && (
                    <p className="text-xs font-semibold text-[#0F9F80] bg-emerald-50 dark:bg-emerald-950/30 border border-emerald-200 dark:border-emerald-800/60 rounded-xl px-3 py-1.5">
                      {avatarNotice}
                    </p>
                  )}

                  {/* Collapsible Workspace Display Name Section */}
                  {primaryAccount && (
                    <div className="pt-2">
                      <WorkspaceDisplayNameCard account={primaryAccount} />
                    </div>
                  )}

                  <div className="space-y-2.5 pt-1 text-xs">
                    <div className="flex items-center justify-between rounded-[12px] bg-neutral-50 dark:bg-neutral-800/60 px-3.5 py-2.5">
                      <span className="text-neutral-500">Handle</span>
                      <span className="font-mono font-semibold text-neutral-900 dark:text-white">
                        {userHandle}
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

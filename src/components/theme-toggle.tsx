"use client";

import { useEffect, useState } from "react";
import { IconMoon, IconSun } from "./icons.tsx";

export function ThemeToggle({
  className = "",
  variant = "default",
}: {
  className?: string;
  variant?: "default" | "sidebar";
}) {
  const [dark, setDark] = useState(false);

  useEffect(() => {
    const sync = () => {
      const isDark =
        document.documentElement.classList.contains("dark") ||
        window.localStorage.getItem("flow-theme") === "dark";
      document.documentElement.classList.toggle("dark", isDark);
      setDark(isDark);
    };
    sync();
    window.addEventListener("flow-theme-change", sync);
    return () => window.removeEventListener("flow-theme-change", sync);
  }, []);

  function toggleTheme() {
    const next = !dark;
    setDark(next);
    document.documentElement.classList.toggle("dark", next);
    try {
      window.localStorage.setItem("flow-theme", next ? "dark" : "light");
    } catch {
      // ignore storage errors
    }
    window.dispatchEvent(new Event("flow-theme-change"));
  }

  if (variant === "sidebar") {
    return (
      <button
        type="button"
        onClick={toggleTheme}
        aria-label={dark ? "Switch to light theme" : "Switch to dark theme"}
        title={dark ? "Switch to light theme" : "Switch to dark theme"}
        className={`text-neutral-400 hover:text-amber-300 p-1 transition-colors ${className}`}
      >
        {dark ? <IconSun size={15} /> : <IconMoon size={15} />}
      </button>
    );
  }

  return (
    <button
      type="button"
      onClick={toggleTheme}
      aria-label={dark ? "Switch to light theme" : "Switch to dark theme"}
      title={dark ? "Switch to light theme" : "Switch to dark theme"}
      className={`inline-flex items-center gap-1.5 rounded-[8px] border border-[var(--border-subtle)] bg-[var(--surface-card)] px-2.5 py-1.5 text-xs font-medium text-[var(--text-secondary)] hover:bg-[var(--surface-subtle)] transition-colors ${className}`}
    >
      {dark ? <IconSun size={15} /> : <IconMoon size={15} />}
      <span className="hidden sm:inline">{dark ? "Light" : "Dark"}</span>
    </button>
  );
}

export function SidebarSignOutButton({
  className = "",
}: {
  className?: string;
}) {
  const [busy, setBusy] = useState(false);

  async function handleSignOut() {
    setBusy(true);
    try {
      await fetch("/api/auth/sign-out", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({}),
      });
    } catch {
      // ignore network errors
    } finally {
      window.location.replace("/sign-in");
    }
  }

  return (
    <button
      type="button"
      onClick={handleSignOut}
      disabled={busy}
      title="Sign out"
      aria-label="Sign out"
      className={`text-neutral-400 hover:text-rose-400 p-1 transition-colors disabled:opacity-40 ${className}`}
    >
      <svg
        width="15"
        height="15"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
        <polyline points="16 17 21 12 16 7" />
        <line x1="21" y1="12" x2="9" y2="12" />
      </svg>
    </button>
  );
}

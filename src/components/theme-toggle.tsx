"use client";

import { useEffect, useState } from "react";
import { IconMoon, IconSun } from "./icons.tsx";

export function ThemeToggle({ className = "" }: { className?: string }) {
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

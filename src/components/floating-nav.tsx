"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import Link from "next/link";
import { FlowLogo } from "./flow-logo.tsx";
import { UserAvatar } from "./user-avatar.tsx";
import { ThemeToggle } from "./theme-toggle.tsx";

export type NavTabId =
  "dashboard" | "send" | "receive" | "request" | "activity";

export interface FloatingNavProps {
  activeTab: NavTabId;
  onTabChange: (tab: NavTabId) => void;
  unreadCount?: number;
  onOpenNotifications?: () => void;
  onOpenAssistant?: () => void;
  userEmail?: string;
  userName?: string;
  onSignOut?: () => void;
}

interface NavTabItem {
  id: NavTabId;
  label: string;
  icon: ReactNode;
}

const TABS: NavTabItem[] = [
  {
    id: "dashboard",
    label: "Home",
    icon: (
      <svg
        width="14"
        height="14"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M3 9.5L12 3l9 6.5V20a1 1 0 0 1-1 1h-5v-6h-6v6H4a1 1 0 0 1-1-1V9.5z" />
      </svg>
    ),
  },
  {
    id: "send",
    label: "Send",
    icon: (
      <svg
        width="14"
        height="14"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <line x1="22" y1="2" x2="11" y2="13" />
        <polygon points="22 2 15 22 11 13 2 9 22 2" />
      </svg>
    ),
  },
  {
    id: "receive",
    label: "Add Money",
    icon: (
      <svg
        width="14"
        height="14"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <line x1="12" y1="5" x2="12" y2="19" />
        <line x1="5" y1="12" x2="19" y2="12" />
      </svg>
    ),
  },
  {
    id: "request",
    label: "Payment Links",
    icon: (
      <svg
        width="14"
        height="14"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
        <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
      </svg>
    ),
  },
  {
    id: "activity",
    label: "Activity",
    icon: (
      <svg
        width="14"
        height="14"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <line x1="18" y1="20" x2="18" y2="10" />
        <line x1="12" y1="20" x2="12" y2="4" />
        <line x1="6" y1="20" x2="6" y2="14" />
      </svg>
    ),
  },
];

export function FloatingNav({
  activeTab,
  onTabChange,
  unreadCount = 0,
  onOpenNotifications,
  onOpenAssistant,
  userEmail = "user@flow.xyz",
  userName = "Personal",
  onSignOut,
}: FloatingNavProps) {
  const [profileOpen, setProfileOpen] = useState(false);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const profileRef = useRef<HTMLDivElement>(null);

  // Close dropdown on outside click
  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (
        profileRef.current &&
        !profileRef.current.contains(e.target as Node)
      ) {
        setProfileOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  return (
    <header className="sticky top-0 z-40 w-full px-4 sm:px-6 lg:px-8 py-3 transition-all">
      <div className="max-w-7xl mx-auto flex items-center justify-between gap-4">
        {/* Left: FLOW Brand Logo */}
        <div className="flex items-center gap-3 shrink-0">
          <Link
            href="/"
            className="flex items-center gap-2 group transition-opacity hover:opacity-90"
            aria-label="FLOW Home"
          >
            <FlowLogo size={28} />
            <span className="font-bold tracking-tight text-lg text-neutral-950 dark:text-white">
              FLOW
            </span>
          </Link>
          <span className="hidden sm:inline-block px-2 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wider bg-neutral-100 text-neutral-600 dark:bg-neutral-800 dark:text-neutral-400 border border-neutral-200/60 dark:border-neutral-700/60">
            Personal
          </span>
        </div>

        {/* Center: Desktop Floating Pill Navigation (Matches FLOW Dashboard Overview-2.png) */}
        <nav
          aria-label="Primary navigation"
          className="hidden md:flex items-center rounded-full bg-white/90 dark:bg-[#141414]/90 backdrop-blur-md p-1 border border-neutral-200/80 dark:border-neutral-800/80 shadow-[0_2px_12px_rgba(0,0,0,0.04)] dark:shadow-[0_2px_12px_rgba(0,0,0,0.4)]"
        >
          {TABS.map((tab) => {
            const isActive = activeTab === tab.id;
            return (
              <button
                key={tab.id}
                type="button"
                onClick={() => onTabChange(tab.id)}
                className={`relative flex items-center gap-1.5 px-4 sm:px-5 py-2 text-xs font-semibold rounded-full transition-all duration-200 select-none ${
                  isActive
                    ? "bg-neutral-950 text-white dark:bg-white dark:text-neutral-950 shadow-xs scale-[1.02]"
                    : "text-neutral-600 hover:text-neutral-950 dark:text-neutral-400 dark:hover:text-white hover:bg-neutral-100/60 dark:hover:bg-neutral-800/60"
                }`}
              >
                <span>{tab.icon}</span>
                <span>{tab.label}</span>
              </button>
            );
          })}
        </nav>

        {/* Right: Actions, Notifications & Profile */}
        <div className="flex items-center gap-2 sm:gap-3 shrink-0">
          {/* AI Assistant Quick Trigger */}
          {onOpenAssistant && (
            <button
              type="button"
              onClick={onOpenAssistant}
              aria-label="Open Flow AI Assistant"
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-semibold bg-neutral-100 hover:bg-neutral-200/80 text-neutral-900 dark:bg-neutral-800 dark:hover:bg-neutral-700 dark:text-neutral-100 border border-neutral-200/60 dark:border-neutral-700/60 transition-all hover:scale-[1.02]"
            >
              <svg
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                className="text-amber-500"
              >
                <path d="m12 3-1.9 5.8a2 2 0 0 1-1.3 1.3L3 12l5.8 1.9a2 2 0 0 1 1.3 1.3L12 21l1.9-5.8a2 2 0 0 1 1.3-1.3L21 12l-5.8-1.9a2 2 0 0 1-1.3-1.3Z" />
              </svg>
              <span className="hidden sm:inline">AI</span>
            </button>
          )}

          {/* Notifications Bell */}
          {onOpenNotifications && (
            <button
              type="button"
              onClick={onOpenNotifications}
              aria-label="Notifications"
              className="relative p-2 rounded-full text-neutral-600 hover:text-neutral-950 dark:text-neutral-400 dark:hover:text-white hover:bg-neutral-100 dark:hover:bg-neutral-800 transition-colors"
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
                <path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9" />
                <path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" />
              </svg>
              {unreadCount > 0 && (
                <span className="absolute top-1 right-1 flex h-4 w-4 items-center justify-center rounded-full bg-[#FF1A1A] text-[9px] font-bold text-white shadow-xs animate-pulse">
                  {unreadCount > 9 ? "9+" : unreadCount}
                </span>
              )}
            </button>
          )}

          {/* User Profile Dropdown */}
          <div className="relative" ref={profileRef}>
            <button
              type="button"
              onClick={() => setProfileOpen((prev) => !prev)}
              aria-expanded={profileOpen}
              className="flex items-center gap-2 pl-1.5 pr-2.5 py-1 rounded-full bg-white dark:bg-[#141414] border border-neutral-200/80 dark:border-neutral-800/80 shadow-xs hover:border-neutral-300 dark:hover:border-neutral-700 transition-all select-none"
            >
              <UserAvatar alt={userName} size={28} />
              <span className="hidden sm:inline text-xs font-semibold text-neutral-900 dark:text-neutral-100">
                Personal
              </span>
              <svg
                width="12"
                height="12"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.5"
                strokeLinecap="round"
                strokeLinejoin="round"
                className={`text-neutral-500 transition-transform ${profileOpen ? "rotate-180" : ""}`}
              >
                <polyline points="6 9 12 15 18 9" />
              </svg>
            </button>

            {/* Profile Dropdown Menu */}
            {profileOpen && (
              <div className="absolute right-0 mt-2 w-64 rounded-2xl bg-white dark:bg-[#141414] border border-neutral-200/90 dark:border-neutral-800 shadow-xl p-2 z-50 animate-in fade-in slide-in-from-top-2 duration-150">
                <div className="px-3 py-2 border-b border-neutral-100 dark:border-neutral-800 mb-1">
                  <p className="text-xs font-bold text-neutral-900 dark:text-neutral-100 truncate">
                    {userName}
                  </p>
                  <p className="text-[11px] text-neutral-500 dark:text-neutral-400 truncate">
                    {userEmail}
                  </p>
                  <div className="mt-1.5 inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold bg-emerald-50 dark:bg-emerald-950/40 text-emerald-700 dark:text-emerald-400 border border-emerald-200/60 dark:border-emerald-800/40">
                    <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
                    Personal Account
                  </div>
                </div>

                <div className="space-y-0.5 text-xs font-medium text-neutral-700 dark:text-neutral-300">
                  <button
                    type="button"
                    onClick={() => {
                      onTabChange("dashboard");
                      setProfileOpen(false);
                    }}
                    className="w-full flex items-center gap-2 px-3 py-2 rounded-xl hover:bg-neutral-100 dark:hover:bg-neutral-800/70 transition-colors text-left"
                  >
                    <span>⌂</span>
                    <span>Dashboard</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      onTabChange("receive");
                      setProfileOpen(false);
                    }}
                    className="w-full flex items-center gap-2 px-3 py-2 rounded-xl hover:bg-neutral-100 dark:hover:bg-neutral-800/70 transition-colors text-left"
                  >
                    <span>↙</span>
                    <span>Deposit &amp; Receive</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      onTabChange("activity");
                      setProfileOpen(false);
                    }}
                    className="w-full flex items-center gap-2 px-3 py-2 rounded-xl hover:bg-neutral-100 dark:hover:bg-neutral-800/70 transition-colors text-left"
                  >
                    <span>◷</span>
                    <span>Transaction History</span>
                  </button>
                </div>

                <div className="my-1 border-t border-neutral-100 dark:border-neutral-800" />

                <div className="flex items-center justify-between px-3 py-1.5">
                  <span className="text-xs text-neutral-600 dark:text-neutral-400">
                    Theme
                  </span>
                  <ThemeToggle />
                </div>

                <div className="my-1 border-t border-neutral-100 dark:border-neutral-800" />

                {onSignOut ? (
                  <button
                    type="button"
                    onClick={() => {
                      setProfileOpen(false);
                      onSignOut();
                    }}
                    className="w-full flex items-center gap-2 px-3 py-2 rounded-xl text-xs font-semibold text-red-600 hover:bg-red-50 dark:text-red-400 dark:hover:bg-red-950/40 transition-colors text-left"
                  >
                    <span>⎋</span>
                    <span>Sign out</span>
                  </button>
                ) : (
                  <form
                    action="/api/auth/sign-out"
                    method="POST"
                    className="w-full"
                  >
                    <button
                      type="submit"
                      className="w-full flex items-center gap-2 px-3 py-2 rounded-xl text-xs font-semibold text-red-600 hover:bg-red-50 dark:text-red-400 dark:hover:bg-red-950/40 transition-colors text-left"
                    >
                      <span>⎋</span>
                      <span>Sign out</span>
                    </button>
                  </form>
                )}
              </div>
            )}
          </div>

          {/* Settings Gear Icon */}
          <Link
            href="/security"
            aria-label="Settings & Security"
            className="p-2 rounded-full text-neutral-600 hover:text-neutral-950 dark:text-neutral-400 dark:hover:text-white hover:bg-neutral-100 dark:hover:bg-neutral-800 transition-colors"
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

          {/* Mobile Menu Hamburger */}
          <button
            type="button"
            onClick={() => setMobileMenuOpen((prev) => !prev)}
            aria-label="Toggle mobile menu"
            className="md:hidden p-2 rounded-full text-neutral-700 dark:text-neutral-300 hover:bg-neutral-100 dark:hover:bg-neutral-800 transition-colors"
          >
            <svg
              width="20"
              height="20"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              {mobileMenuOpen ? (
                <>
                  <line x1="18" y1="6" x2="6" y2="18" />
                  <line x1="6" y1="6" x2="18" y2="18" />
                </>
              ) : (
                <>
                  <line x1="4" y1="12" x2="20" y2="12" />
                  <line x1="4" y1="6" x2="20" y2="6" />
                  <line x1="4" y1="18" x2="20" y2="18" />
                </>
              )}
            </svg>
          </button>
        </div>
      </div>

      {/* Mobile Dropdown Navigation */}
      {mobileMenuOpen && (
        <div className="md:hidden mt-2 p-3 rounded-2xl bg-white dark:bg-[#141414] border border-neutral-200/90 dark:border-neutral-800 shadow-xl space-y-1 z-50">
          {TABS.map((tab) => {
            const isActive = activeTab === tab.id;
            return (
              <button
                key={tab.id}
                type="button"
                onClick={() => {
                  onTabChange(tab.id);
                  setMobileMenuOpen(false);
                }}
                className={`w-full flex items-center justify-between px-4 py-2.5 rounded-xl text-xs font-semibold transition-colors ${
                  isActive
                    ? "bg-neutral-950 text-white dark:bg-white dark:text-neutral-950 shadow-xs"
                    : "text-neutral-700 dark:text-neutral-300 hover:bg-neutral-100 dark:hover:bg-neutral-800"
                }`}
              >
                <div className="flex items-center gap-2">
                  <span>{tab.icon}</span>
                  <span>{tab.label}</span>
                </div>
                {isActive && <span className="text-[10px]">●</span>}
              </button>
            );
          })}
        </div>
      )}
    </header>
  );
}

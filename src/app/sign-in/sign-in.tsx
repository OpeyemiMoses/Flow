"use client";

import { useState, type FormEvent } from "react";
import {
  IconBuilding,
  IconShield,
  IconUsers,
} from "../../components/icons.tsx";
import {
  describe,
  Feedback,
  googleNavigate,
  send,
  useResendClock,
} from "../controls.tsx";

export function SignIn() {
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [codeSent, setCodeSent] = useState(false);
  const [recovery, setRecovery] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const { seconds, startClock } = useResendClock();

  async function google() {
    setBusy(true);
    setMessage("");
    try {
      const response = await send<{ url: string }>("/api/auth/google/start", {
        recovery,
      });
      googleNavigate(response.url);
    } catch (error) {
      setMessage(describe(error));
      setBusy(false);
    }
  }

  async function start() {
    setBusy(true);
    setMessage("");
    try {
      await send("/api/auth/email/start", { email, recovery });
      startClock();
      setCodeSent(true);
      setMessage(
        "If this address can sign in by email, a code will arrive shortly.",
      );
    } catch (error) {
      setMessage(describe(error));
    } finally {
      setBusy(false);
    }
  }

  async function verify(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setMessage("");
    try {
      await send("/api/auth/email/verify", { code });
      window.location.replace("/onboarding");
    } catch (error) {
      setMessage(describe(error));
      setBusy(false);
    }
  }

  return (
    <div className="space-y-6">
      <div className="space-y-4">
        <label className="flex items-start gap-2.5 rounded-[8px] border border-[var(--border-subtle)] bg-[var(--surface-subtle)]/60 p-3 text-xs text-[var(--text-secondary)] cursor-pointer">
          <input
            type="checkbox"
            checked={recovery}
            onChange={(event) => setRecovery(event.target.checked)}
            disabled={busy || codeSent}
            className="mt-0.5 rounded border-slate-300 text-[#2563FF] focus:ring-[#2563FF]"
          />
          <span>Recover access and sign out other sessions</span>
        </label>

        <button
          type="button"
          className="flow-btn-primary flex w-full items-center justify-center gap-2.5 px-4 py-3 text-sm"
          onClick={google}
          disabled={busy}
        >
          <svg
            width="18"
            height="18"
            viewBox="0 0 24 24"
            fill="currentColor"
            aria-hidden="true"
          >
            <path d="M21.35 11.1h-9.17v2.73h6.51c-.33 3.81-3.5 5.44-6.5 5.44C8.36 19.27 5 15.65 5 12c0-3.65 3.36-7.27 7.2-7.27 3.09 0 4.9 1.97 4.9 1.97L19 4.72S16.56 2 12.1 2C6.42 2 2.03 6.8 2.03 12c0 5.05 4.13 10 10.22 10 5.35 0 9.25-3.67 9.25-9.09 0-1.15-.15-1.81-.15-1.81Z" />
          </svg>
          Continue with Google
        </button>

        <div className="my-4 flex items-center gap-3 text-xs font-semibold uppercase tracking-wider text-[var(--text-muted)]">
          <span className="h-px flex-1 bg-[var(--border-subtle)]" />
          <span>Or verify with one-time email code</span>
          <span className="h-px flex-1 bg-[var(--border-subtle)]" />
        </div>

        {!codeSent ? (
          <form
            className="space-y-4"
            onSubmit={(event) => {
              event.preventDefault();
              void start();
            }}
          >
            <label className="block text-sm font-semibold text-[var(--text-primary)]">
              Email address
              <input
                type="email"
                autoComplete="email"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                required
                maxLength={254}
                placeholder="you@company.com"
                className="flow-input mt-1.5 w-full px-3.5 py-2.5 text-sm font-normal"
              />
            </label>
            <button
              disabled={busy}
              className="flow-btn-secondary w-full px-4 py-2.5 text-sm font-semibold"
            >
              Send email code
            </button>
          </form>
        ) : (
          <form className="space-y-4" onSubmit={verify}>
            <label className="block text-sm font-semibold text-[var(--text-primary)]">
              Email code
              <input
                value={code}
                onChange={(event) => setCode(event.target.value)}
                required
                autoComplete="one-time-code"
                inputMode="numeric"
                pattern="[0-9]{8}"
                maxLength={8}
                placeholder="8-digit verification code"
                className="flow-input mt-1.5 w-full px-3.5 py-2.5 font-mono text-base tracking-[0.25em]"
              />
            </label>
            <button
              disabled={busy}
              className="flow-btn-primary w-full px-4 py-2.5 text-sm"
            >
              Verify and sign in
            </button>
            <div className="flex flex-wrap items-center gap-2.5">
              <button
                type="button"
                className="flow-btn-secondary flex-1 px-3 py-2 text-xs font-semibold"
                disabled={busy || seconds > 0}
                onClick={start}
              >
                {seconds ? `Resend in ${seconds}s` : "Resend code"}
              </button>
              <button
                type="button"
                className="flow-btn-secondary flex-1 px-3 py-2 text-xs font-semibold"
                disabled={busy}
                onClick={() => {
                  setCodeSent(false);
                  setCode("");
                  setMessage("");
                }}
              >
                Use a different address
              </button>
            </div>
          </form>
        )}

        <Feedback text={message} />
      </div>

      {/* Account Type Architecture Preview Cards (Reference #3) */}
      <div className="border-t border-[var(--border-subtle)] pt-6">
        <div className="flex items-center gap-2 text-xs font-bold uppercase tracking-wider text-[var(--text-muted)]">
          <IconShield size={13} className="text-[#2563FF]" />
          <span>Workspace Account Architecture</span>
        </div>
        <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div className="rounded-[10px] border border-[var(--border-subtle)] bg-[var(--surface-subtle)]/60 p-3.5">
            <div className="flex items-center gap-2 text-xs font-bold text-[var(--text-primary)]">
              <IconUsers size={15} className="text-[#2563FF]" />
              Personal Account
            </div>
            <p className="mt-1 text-[11px] leading-relaxed text-[var(--text-secondary)]">
              Automatically provisioned on first sign-in for individual
              multi-chain wallets and portfolio tracking.
            </p>
          </div>
          <div className="rounded-[10px] border border-[var(--border-subtle)] bg-[var(--surface-subtle)]/60 p-3.5">
            <div className="flex items-center gap-2 text-xs font-bold text-[var(--text-primary)]">
              <IconBuilding size={15} className="text-[#0F9F80]" />
              Business Account
            </div>
            <p className="mt-1 text-[11px] leading-relaxed text-[var(--text-secondary)]">
              Create dedicated organizations with isolated custody, team
              invitations, and `OWNER` / `ADMIN` / `MEMBER` roles.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}

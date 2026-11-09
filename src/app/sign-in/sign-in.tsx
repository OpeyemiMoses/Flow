"use client";

import { useState, type FormEvent } from "react";
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
        {/* Google OAuth Button */}
        <button
          type="button"
          className="flex w-full items-center justify-center gap-3 rounded-full border border-neutral-300 dark:border-neutral-700 bg-white dark:bg-neutral-900 px-4 py-3 text-sm font-semibold text-neutral-900 dark:text-white shadow-xs hover:border-black dark:hover:border-white transition-all disabled:opacity-50"
          onClick={google}
          disabled={busy}
        >
          <svg
            width="18"
            height="18"
            viewBox="0 0 24 24"
            fill="none"
            aria-hidden="true"
          >
            <path
              d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"
              fill="#4285F4"
            />
            <path
              d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
              fill="#34A853"
            />
            <path
              d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.06H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.94l2.85-2.22.81-.63z"
              fill="#FBBC05"
            />
            <path
              d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.06l3.66 2.84c.87-2.6 3.3-4.52 6.16-4.52z"
              fill="#EA4335"
            />
          </svg>
          Continue with Google
        </button>

        <div className="relative my-4 flex items-center justify-center">
          <div className="h-px w-full bg-[var(--border-subtle)]" />
          <span className="absolute bg-[var(--surface-card)] px-3 text-xs uppercase tracking-wider text-neutral-400">
            or
          </span>
        </div>

        {!codeSent ? (
          <form
            className="space-y-4"
            onSubmit={(event) => {
              event.preventDefault();
              void start();
            }}
          >
            <div>
              <label
                htmlFor="email-input"
                className="block text-xs font-semibold text-neutral-700 dark:text-neutral-300"
              >
                Email address
              </label>
              <input
                id="email-input"
                type="email"
                autoComplete="email"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                required
                maxLength={254}
                placeholder="name@domain.com"
                className="flow-input mt-1.5 w-full rounded-xl px-4 py-3 text-sm font-normal"
              />
            </div>

            <label className="flex items-start gap-2.5 text-xs text-neutral-600 dark:text-neutral-400 cursor-pointer pt-1">
              <input
                type="checkbox"
                checked={recovery}
                onChange={(event) => setRecovery(event.target.checked)}
                disabled={busy}
                className="mt-0.5 rounded border-neutral-300 text-[#FF1A1A] focus:ring-[#FF1A1A]"
              />
              <span>Recover access and sign out other sessions</span>
            </label>

            <button
              disabled={busy || !email.trim()}
              className="flow-btn-primary w-full py-3 text-sm font-semibold inline-flex items-center justify-center gap-2"
            >
              Send email code
              <span aria-hidden="true">&rarr;</span>
            </button>
          </form>
        ) : (
          <form className="space-y-5" onSubmit={verify}>
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <label
                  htmlFor="code-input"
                  className="block text-xs font-semibold text-neutral-700 dark:text-neutral-300"
                >
                  Email code
                </label>
                <span className="text-xs font-mono text-neutral-500">
                  {seconds > 0
                    ? `00:${seconds.toString().padStart(2, "0")}`
                    : "Expired"}
                </span>
              </div>
              <input
                id="code-input"
                value={code}
                onChange={(event) => setCode(event.target.value)}
                required
                autoComplete="one-time-code"
                inputMode="numeric"
                pattern="[0-9]{8}"
                maxLength={8}
                placeholder="00000000"
                className="flow-input w-full rounded-xl px-4 py-3 font-mono text-xl tracking-[0.3em] text-center"
              />
              <p className="text-[11px] text-neutral-500">
                Check your inbox at{" "}
                <span className="font-semibold text-neutral-700 dark:text-neutral-300">
                  {email}
                </span>
              </p>
            </div>

            <button
              disabled={busy || code.length !== 8}
              className="flow-btn-red w-full py-3 text-sm font-semibold inline-flex items-center justify-center gap-2"
            >
              Verify and sign in
              <span aria-hidden="true">&rarr;</span>
            </button>

            <div className="flex items-center justify-between pt-1 text-xs">
              <button
                type="button"
                className="font-medium text-neutral-600 dark:text-neutral-400 hover:text-black dark:hover:text-white transition-colors"
                disabled={busy || seconds > 0}
                onClick={start}
              >
                {seconds > 0 ? `Resend in ${seconds}s` : "Resend code"}
              </button>
              <button
                type="button"
                className="text-neutral-500 hover:text-neutral-800 dark:hover:text-neutral-200 transition-colors"
                disabled={busy}
                onClick={() => {
                  setCodeSent(false);
                  setCode("");
                  setMessage("");
                }}
              >
                Use different email
              </button>
            </div>
          </form>
        )}

        <Feedback text={message} />
      </div>
    </div>
  );
}

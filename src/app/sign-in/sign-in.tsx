/* eslint-disable @next/next/no-img-element */
"use client";

import { useState, useRef, type FormEvent } from "react";
import Link from "next/link";
import { FlowLogo } from "../../components/flow-logo.tsx";
import {
  describe,
  Feedback,
  googleNavigate,
  send,
  useResendClock,
} from "../controls.tsx";

export function SignIn({ issue, notice }: { issue?: string; notice?: string }) {
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [codeSent, setCodeSent] = useState(false);
  const [recovery, setRecovery] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const { seconds, startClock } = useResendClock();
  const codeInputRef = useRef<HTMLInputElement>(null);

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

  const digits = Array.from({ length: 8 }, (_, idx) => code[idx] ?? "");
  const activeDigitIdx = Math.min(code.length, 7);

  if (codeSent) {
    return (
      <div className="relative h-screen max-h-screen w-full overflow-hidden bg-white text-[#0B0B0B] lg:grid lg:grid-cols-12">
        {/* Mobile Red Diagonal Wave Accent (Matches 08_56_15 PM-1.png) */}
        <div
          aria-hidden="true"
          className="pointer-events-none absolute -right-24 top-0 h-[360px] w-[320px] rounded-bl-full bg-gradient-to-bl from-[#FF1A1A] via-[#FF1A1A]/75 to-transparent opacity-95 lg:hidden"
        />

        {/* Left Column: Verification Code Form */}
        <main className="relative z-10 flex h-full flex-col justify-center px-6 py-6 sm:px-12 lg:col-span-6 lg:px-16 overflow-y-auto">
          <div className="mx-auto w-full max-w-[460px]">
            <Link href="/" aria-label="FLOW Home" className="inline-block">
              <FlowLogo className="h-8 w-auto sm:h-9" />
            </Link>

            <h1 className="mt-6 font-serif text-[34px] sm:text-[44px] font-normal leading-[1.08] tracking-[-0.025em] text-[#0B0B0B]">
              Enter the <br />
              verification code
            </h1>

            <p className="mt-3 max-w-[400px] text-[14px] leading-[1.5] text-[#5A5A5A] sm:text-[15px]">
              We sent an 8-digit code to your email{" "}
              <span className="font-medium text-[#1F1F1F]">
                {email || "hello@flow.com"}
              </span>
              . Enter it below to continue.
            </p>

            <form className="mt-6" onSubmit={verify}>
              {/* 8-Digit Boxes with Overlaid Accessible Input */}
              <div
                className="relative"
                onClick={() => codeInputRef.current?.focus()}
              >
                <label htmlFor="code-input" className="sr-only">
                  Email code
                </label>
                <input
                  ref={codeInputRef}
                  id="code-input"
                  aria-label="Email code"
                  value={code}
                  onChange={(event) => {
                    const sanitized = event.target.value
                      .replace(/\D/g, "")
                      .slice(0, 8);
                    setCode(sanitized);
                  }}
                  required
                  autoFocus
                  autoComplete="one-time-code"
                  inputMode="numeric"
                  pattern="[0-9]{8}"
                  maxLength={8}
                  className="absolute inset-0 z-10 h-full w-full cursor-text opacity-0"
                />
                <div className="grid grid-cols-8 gap-2 sm:gap-2.5">
                  {digits.map((digit, idx) => {
                    const isActive = idx === activeDigitIdx;
                    return (
                      <div
                        key={idx}
                        className={`flex h-14 items-center justify-center rounded-2xl bg-white text-[20px] font-semibold text-[#0B0B0B] shadow-2xs transition sm:h-16 sm:text-[22px] ${
                          isActive
                            ? "border-2 border-[#FF1A1A]"
                            : "border border-[#DCDCDC]"
                        }`}
                      >
                        {digit}
                      </div>
                    );
                  })}
                </div>
              </div>

              {/* Resend Countdown */}
              <div className="mt-6 flex items-center justify-between text-[15px] text-[#5A5A5A]">
                {seconds > 0 ? (
                  <span>
                    Resend code in{" "}
                    <span className="font-semibold text-[#FF1A1A]">
                      00:{seconds.toString().padStart(2, "0")}
                    </span>
                  </span>
                ) : (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={start}
                    className="font-semibold text-[#FF1A1A] hover:underline"
                  >
                    Resend code
                  </button>
                )}

                <button
                  type="button"
                  disabled={busy}
                  onClick={() => {
                    setCodeSent(false);
                    setCode("");
                    setMessage("");
                  }}
                  className="text-[13px] text-[#777777] hover:text-[#0B0B0B]"
                >
                  Change email
                </button>
              </div>

              <button
                type="submit"
                disabled={busy || code.length !== 8}
                className="mt-6 flex h-12 sm:h-13 w-full items-center justify-center gap-2.5 rounded-full bg-[#0B0B0B] text-[15px] font-semibold text-white transition hover:bg-[#1F1F1F] disabled:opacity-50"
              >
                <span>Verify and continue</span>
                <span aria-hidden="true">→</span>
              </button>

              {message && (
                <div className="mt-3">
                  <Feedback text={message} />
                </div>
              )}
            </form>
          </div>
        </main>

        {/* Right Column: 3D Smartphone on Rock with Red Arc (Matches 08_26_06 PM-1.png) */}
        <aside className="relative hidden h-screen max-h-screen overflow-hidden bg-white lg:col-span-6 lg:flex lg:items-center lg:justify-center p-3 xl:p-6">
          <img
            src="/assets/otp-phone-rock.png"
            alt="FLOW mobile dashboard on smartphone"
            className="max-h-full max-w-full object-contain"
          />
        </aside>
      </div>
    );
  }

  return (
    <div className="h-screen max-h-screen w-full overflow-hidden bg-white text-[#0B0B0B] lg:grid lg:grid-cols-12">
      {/* Left Column: Access Your Flow Account (Matches Flow Passwordless Authentication Mockup.png) */}
      <main className="flex h-full flex-col justify-center px-6 py-6 sm:px-12 lg:col-span-6 lg:px-16 overflow-y-auto">
        <div className="mx-auto w-full max-w-[440px]">
          <Link href="/" aria-label="FLOW Home" className="inline-block">
            <FlowLogo className="h-8 w-auto sm:h-9" />
          </Link>

          <div className="mt-6 flex items-center gap-2 text-[11px] sm:text-[12px] font-semibold uppercase tracking-[0.16em] text-[#555555]">
            <span>GET STARTED</span>
            <span className="h-[2px] w-4 bg-[#FF1A1A]" />
          </div>

          <h1 className="mt-2 font-serif text-[32px] sm:text-[42px] font-normal leading-[1.08] tracking-[-0.025em] text-[#0B0B0B]">
            Access your <br />
            Flow account
          </h1>

          <p className="mt-2 text-[14px] leading-[1.5] text-[#5A5A5A] sm:text-[15px]">
            Continue with Google or enter your email to receive a verification
            code.
          </p>

          {issue === "authentication" && (
            <p
              role="status"
              className="mt-3 rounded-xl border border-amber-200 bg-amber-50 px-4 py-2.5 text-xs font-semibold text-amber-900"
            >
              Google sign-in could not be completed. If you already use email,
              sign in with email and link Google from Security.
            </p>
          )}
          {notice === "linked" && (
            <p
              role="status"
              className="mt-3 rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-2.5 text-xs font-semibold text-emerald-900"
            >
              Google is linked. Sign in again to continue.
            </p>
          )}
          {notice === "updated" && (
            <p
              role="status"
              className="mt-3 rounded-xl border border-neutral-200 bg-neutral-100 px-4 py-2.5 text-xs font-semibold text-neutral-900"
            >
              Your security settings were updated. Sign in again.
            </p>
          )}

          {/* Google Button */}
          <button
            type="button"
            onClick={google}
            disabled={busy}
            className="mt-4 flex h-12 sm:h-13 w-full items-center justify-center gap-3 rounded-2xl border border-[#E2E2E2] bg-white px-5 text-[14px] sm:text-[15px] font-semibold text-[#0B0B0B] shadow-2xs transition hover:border-[#0B0B0B] disabled:opacity-50"
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
            <span>Continue with Google</span>
          </button>

          {/* Divider */}
          <div className="my-3.5 flex items-center gap-4">
            <div className="h-px flex-1 bg-[#EAEAEA]" />
            <span className="text-[12px] text-[#777777]">or</span>
            <div className="h-px flex-1 bg-[#EAEAEA]" />
          </div>

          {/* Email Form */}
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void start();
            }}
          >
            <label
              htmlFor="email-input"
              className="block text-[13px] sm:text-[14px] font-semibold text-[#0B0B0B]"
            >
              Email address
            </label>
            <div className="relative mt-1.5">
              <span className="pointer-events-none absolute inset-y-0 left-0 flex items-center pl-4 text-[#666666]">
                <svg
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.8"
                  className="h-4.5 w-4.5"
                >
                  <rect x="2" y="4" width="20" height="16" rx="3" />
                  <path d="m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7" />
                </svg>
              </span>
              <input
                id="email-input"
                type="email"
                autoComplete="email"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                required
                maxLength={254}
                placeholder="Enter your email address"
                className="h-12 sm:h-13 w-full rounded-2xl border border-[#E2E2E2] bg-white pl-11 pr-4 text-[14px] sm:text-[15px] text-[#0B0B0B] placeholder:text-[#888888] focus:border-[#0B0B0B] focus:outline-none"
              />
            </div>

            <label className="mt-2.5 flex cursor-pointer items-center gap-2 text-[11px] sm:text-[12px] text-[#666666]">
              <input
                type="checkbox"
                checked={recovery}
                onChange={(event) => setRecovery(event.target.checked)}
                disabled={busy}
                className="rounded border-neutral-300 text-[#FF1A1A] focus:ring-[#FF1A1A]"
              />
              <span>Recover access and sign out other sessions</span>
            </label>

            <button
              type="submit"
              disabled={busy || !email.trim()}
              className="mt-4 flex h-12 sm:h-13 w-full items-center justify-center gap-2.5 rounded-full bg-[#0B0B0B] text-[14px] sm:text-[15px] font-semibold text-white transition hover:bg-[#1F1F1F] disabled:opacity-50"
            >
              <span>Send verification code</span>
              <span aria-hidden="true">→</span>
            </button>
          </form>

          {message && (
            <div className="mt-3">
              <Feedback text={message} />
            </div>
          )}

          <p className="mt-4 text-center text-[13px] sm:text-[14px] text-[#5A5A5A]">
            Already have an account?{" "}
            <button
              type="button"
              onClick={() => document.getElementById("email-input")?.focus()}
              className="font-semibold text-[#FF1A1A] hover:underline"
            >
              Sign in
            </button>
          </p>
        </div>
      </main>

      {/* Right Column: Full-bleed Dark & Red 3D Phone on Rock (Matches Flow Passwordless Authentication Mockup.png) */}
      <aside className="relative hidden h-screen max-h-screen overflow-hidden bg-[#070505] lg:col-span-6 lg:flex lg:items-center lg:justify-center p-3 xl:p-6">
        <img
          src="/assets/auth-wallet-phone.png"
          alt="FLOW Crypto Wallet on Smartphone"
          className="max-h-full max-w-full object-contain"
        />
      </aside>
    </div>
  );
}

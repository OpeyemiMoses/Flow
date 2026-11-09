"use client";

import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { IconShield } from "../components/icons.tsx";

const messages: Record<string, string> = {
  AUTH_REQUIRED: "Sign in again to continue.",
  INVALID_PROOF:
    "The code is incorrect or expired. Try again or request a new code.",
  MAILBOX_UNAVAILABLE:
    "This mailbox cannot be used for security changes. Contact support.",
  LAST_LOGIN_METHOD: "Keep at least one usable sign-in method.",
  FRESH_PROOF_REQUIRED: "Request a new security code and try again.",
  INVITE_UNAVAILABLE:
    "This invitation is unavailable for your signed-in email.",
  ALREADY_MEMBER: "This email already belongs to the team.",
  FORBIDDEN: "Your role does not allow this change.",
  NOT_FOUND: "This account or record is unavailable.",
  INVALID_INPUT: "Check the information you entered and try again.",
  TRY_LATER: "Too many requests. Try again later.",
};

export async function send<T>(
  path: string,
  data: object = {},
  method = "POST",
  headers: Record<string, string> = {},
): Promise<T> {
  const response = await fetch(path, {
    method,
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(data),
  });
  const text = await response.text();
  let result: { error?: string } | undefined;
  try {
    result = text ? (JSON.parse(text) as { error?: string }) : undefined;
  } catch {
    throw new Error("FLOW returned an unexpected response. Try again.");
  }
  if (!response.ok) {
    throw new Error(
      (result?.error ? messages[result.error] : undefined) ??
        "FLOW could not complete the request. Try again.",
    );
  }
  return result as T;
}

export function describe(error: unknown): string {
  return error instanceof Error
    ? error.message
    : "Something went wrong. Try again.";
}

export function googleNavigate(url: string) {
  const destination = new URL(url);
  if (
    destination.origin !== "https://accounts.google.com" ||
    destination.pathname !== "/o/oauth2/v2/auth"
  ) {
    throw new Error("The Google sign-in URL is unavailable.");
  }
  window.location.assign(destination.href);
}

export function Feedback({ text }: { text: string }) {
  return text ? (
    <p
      className="rounded-[8px] border border-[#2563FF]/30 bg-[#2563FF]/5 px-4 py-2.5 text-xs font-semibold text-[var(--text-primary)]"
      role="status"
    >
      {text}
    </p>
  ) : null;
}

export function useResendClock() {
  const [seconds, setSeconds] = useState(0);
  const waiting = seconds > 0;
  useEffect(() => {
    if (!waiting) return;
    const timer = setInterval(
      () => setSeconds((remaining) => Math.max(0, remaining - 1)),
      1_000,
    );
    return () => clearInterval(timer);
  }, [waiting]);
  return { seconds, startClock: () => setSeconds(60) };
}

export function SignOutButton() {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  async function signOut() {
    setBusy(true);
    try {
      await send("/api/auth/sign-out");
      window.location.replace("/sign-in");
    } catch (error) {
      setMessage(describe(error));
      setBusy(false);
    }
  }
  return (
    <div className="inline-flex items-center gap-2">
      <button
        className="flow-btn-secondary px-3 py-1.5 text-xs font-semibold"
        type="button"
        disabled={busy}
        onClick={signOut}
      >
        Sign out
      </button>
      <Feedback text={message} />
    </div>
  );
}

export type ProofPurpose =
  | "enroll-email"
  | "link-google"
  | "unlink-google"
  | "disable-email"
  | "revoke-all"
  | "team-change";

export function FreshProof({
  purpose,
  target,
  children,
  onConfirm,
  onCancel,
}: {
  purpose: ProofPurpose;
  target?: string;
  children: ReactNode;
  onConfirm: () => Promise<void>;
  onCancel: () => void;
}) {
  const [stage, setStage] = useState<"start" | "code">("start");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const { seconds, startClock } = useResendClock();

  async function requestCode() {
    setBusy(true);
    setMessage("");
    try {
      await send("/api/security/code/start", { purpose, target });
      setStage("code");
      startClock();
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
      await send("/api/security/code/verify", { purpose, target, code });
      await onConfirm();
    } catch (error) {
      setMessage(describe(error));
      setBusy(false);
    }
  }

  return (
    <section
      className="flow-card p-6 space-y-4 border-l-4 border-l-[#2563FF]"
      aria-label="Security confirmation"
    >
      <div className="flex items-start gap-3">
        <span className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-[8px] bg-[#2563FF]/10 text-[#2563FF]">
          <IconShield size={18} />
        </span>
        <div>
          <h2 className="font-display text-base font-bold text-[var(--text-primary)]">
            Confirm with a fresh email code
          </h2>
          <p className="mt-0.5 text-xs text-[var(--text-secondary)]">
            {children}
          </p>
        </div>
      </div>

      {stage === "start" ? (
        <div className="flex flex-wrap items-center gap-2.5">
          <button
            type="button"
            disabled={busy}
            onClick={requestCode}
            className="flow-btn-primary px-4 py-2 text-xs"
          >
            Send security code
          </button>
          <button
            type="button"
            className="flow-btn-secondary px-4 py-2 text-xs"
            disabled={busy}
            onClick={onCancel}
          >
            Cancel
          </button>
        </div>
      ) : (
        <form className="space-y-3" onSubmit={verify}>
          <label className="block text-xs font-semibold text-[var(--text-primary)]">
            Security code
            <input
              value={code}
              onChange={(event) => setCode(event.target.value)}
              required
              autoComplete="one-time-code"
              inputMode="numeric"
              pattern="[0-9]{8}"
              maxLength={8}
              className="flow-input mt-1.5 w-full max-w-xs px-3.5 py-2 font-mono text-sm tracking-widest block"
            />
          </label>
          <div className="flex flex-wrap items-center gap-2.5">
            <button
              disabled={busy}
              className="flow-btn-primary px-4 py-2 text-xs"
            >
              Confirm change
            </button>
            <button
              type="button"
              className="flow-btn-secondary px-3.5 py-2 text-xs"
              disabled={busy || seconds > 0}
              onClick={requestCode}
            >
              {seconds ? `Resend in ${seconds}s` : "Resend code"}
            </button>
            <button
              type="button"
              className="flow-btn-secondary px-3.5 py-2 text-xs"
              disabled={busy}
              onClick={onCancel}
            >
              Cancel
            </button>
          </div>
        </form>
      )}
      <Feedback text={message} />
    </section>
  );
}

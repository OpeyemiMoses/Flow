"use client";

import { useEffect, useState, type FormEvent, type ReactNode } from "react";

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
  let result;
  try {
    result = text ? JSON.parse(text) : undefined;
  } catch {
    throw new Error("FLOW returned an unexpected response. Try again.");
  }
  if (!response.ok) {
    throw new Error(
      messages[result?.error] ??
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
    <p className="flow-feedback" role="status">
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
    <div>
      <button
        className="flow-secondary"
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

type ProofPurpose =
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
  async function confirm(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setMessage("");
    try {
      await send("/api/security/code/verify", { code });
      await onConfirm();
    } catch (error) {
      setMessage(describe(error));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="flow-panel flow-stack">
      <h2>Confirm this change</h2>
      <p>{children}</p>
      {stage === "start" ? (
        <button type="button" onClick={requestCode} disabled={busy}>
          Send security code
        </button>
      ) : (
        <form className="flow-stack" onSubmit={confirm}>
          <label>
            Security code
            <input
              value={code}
              onChange={(event) => setCode(event.target.value)}
              required
              inputMode="numeric"
              autoComplete="one-time-code"
              pattern="[0-9]{8}"
              maxLength={8}
            />
          </label>
          <div className="flow-actions">
            <button disabled={busy}>Confirm change</button>
            <button
              type="button"
              className="flow-secondary"
              onClick={requestCode}
              disabled={busy || seconds > 0}
            >
              {seconds ? `Resend in ${seconds}s` : "Resend code"}
            </button>
          </div>
        </form>
      )}
      <div>
        <button
          type="button"
          className="flow-secondary"
          onClick={onCancel}
          disabled={busy}
        >
          Cancel
        </button>
      </div>
      <Feedback text={message} />
    </section>
  );
}

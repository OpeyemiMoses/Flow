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
    <div className="flow-stack">
      <label className="flow-check">
        <input
          type="checkbox"
          checked={recovery}
          onChange={(event) => setRecovery(event.target.checked)}
          disabled={busy || codeSent}
        />{" "}
        Recover access and sign out other sessions
      </label>
      <button
        type="button"
        className="flow-secondary"
        onClick={google}
        disabled={busy}
      >
        Continue with Google
      </button>
      {!codeSent ? (
        <form
          className="flow-stack"
          onSubmit={(event) => {
            event.preventDefault();
            void start();
          }}
        >
          <label>
            Email address
            <input
              type="email"
              autoComplete="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              required
              maxLength={254}
            />
          </label>
          <button disabled={busy}>Send email code</button>
        </form>
      ) : (
        <form className="flow-stack" onSubmit={verify}>
          <label>
            Email code
            <input
              value={code}
              onChange={(event) => setCode(event.target.value)}
              required
              autoComplete="one-time-code"
              inputMode="numeric"
              pattern="[0-9]{8}"
              maxLength={8}
            />
          </label>
          <button disabled={busy}>Verify and sign in</button>
          <div className="flow-actions">
            <button
              type="button"
              className="flow-secondary"
              disabled={busy || seconds > 0}
              onClick={start}
            >
              {seconds ? `Resend in ${seconds}s` : "Resend code"}
            </button>
            <button
              type="button"
              className="flow-secondary"
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
  );
}

"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
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

export function SecurityPanel({
  email,
  emailEnrolled,
  googleLinked,
  mailboxPaused,
  sessions,
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
}) {
  const [action, setAction] = useState<keyof typeof actions>();
  const [message, setMessage] = useState("");
  const [revoking, setRevoking] = useState(false);
  const router = useRouter();

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
    <>
      <section className="flow-panel flow-stack">
        <h2>Sign-in methods</h2>
        <p>{email}</p>
        <p>
          Email code {emailEnrolled ? "enabled" : "disabled"} · Google{" "}
          {googleLinked ? "linked" : "available to link"}
        </p>
        {mailboxPaused ? (
          <p role="status">
            Email security changes are paused. Contact support if you need
            access.
          </p>
        ) : (
          <div className="flow-actions">
            {!emailEnrolled && (
              <button type="button" onClick={() => setAction("enroll-email")}>
                Enable email sign-in
              </button>
            )}
            {emailEnrolled && googleLinked && (
              <>
                <button
                  type="button"
                  className="flow-secondary"
                  onClick={() => setAction("disable-email")}
                >
                  Disable email sign-in
                </button>
                <button
                  type="button"
                  className="flow-secondary"
                  onClick={() => setAction("unlink-google")}
                >
                  Disconnect Google
                </button>
              </>
            )}
            {!googleLinked && (
              <button type="button" onClick={() => setAction("link-google")}>
                Link Google
              </button>
            )}
          </div>
        )}
      </section>
      {action && (
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
      )}
      <section className="flow-panel flow-stack">
        <h2>Active sessions</h2>
        <ul className="flow-list">
          {sessions.map((session) => (
            <li key={session.id}>
              <span>
                {session.current ? "This session" : "Other session"} · Started{" "}
                <time dateTime={session.createdAt}>
                  {session.createdAt.slice(0, 10)} UTC
                </time>
              </span>
              <button
                type="button"
                className="flow-secondary"
                disabled={revoking}
                onClick={() => revoke(session.id, session.current)}
              >
                Sign out session
              </button>
            </li>
          ))}
        </ul>
        {!mailboxPaused && (
          <div>
            <button type="button" onClick={() => setAction("revoke-all")}>
              Sign out all sessions
            </button>
          </div>
        )}
        <Feedback text={message} />
      </section>
    </>
  );
}

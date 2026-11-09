"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { IconCheck, IconShield } from "../../components/icons.tsx";
import { describe, Feedback, send } from "../controls.tsx";

export function CompleteOnboarding() {
  const router = useRouter();
  const [attempt, setAttempt] = useState(0);
  const [message, setMessage] = useState("");

  useEffect(() => {
    let active = true;
    send<{ account: { id: string } }>("/api/onboarding/complete")
      .then(({ account }) => {
        if (active) router.replace(`/accounts/${account.id}`);
      })
      .catch((error) => {
        if (active) setMessage(describe(error));
      });
    return () => {
      active = false;
    };
  }, [attempt, router]);

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3 text-sm font-medium text-[var(--text-primary)]">
        <span className="inline-flex h-6 w-6 items-center justify-center rounded-full bg-[#34D8B2]/20 text-[#0F9F80]">
          <IconCheck size={14} />
        </span>
        <span>Authenticated identity verified</span>
      </div>
      <div className="flex items-center gap-3 text-sm font-medium text-[var(--text-primary)]">
        <span className="inline-flex h-6 w-6 items-center justify-center rounded-full bg-[#2563FF]/15 text-[#2563FF]">
          <IconShield size={14} />
        </span>
        <span>
          Provisioning personal account boundary &amp; queuing wallet setup
        </span>
      </div>

      {message ? (
        <div className="space-y-3 pt-2">
          <Feedback text={message} />
          <button
            type="button"
            className="flow-btn-primary px-4 py-2 text-xs"
            onClick={() => {
              setMessage("");
              setAttempt(attempt + 1);
            }}
          >
            Try again
          </button>
        </div>
      ) : (
        <p role="status" className="pt-2 text-xs text-[var(--text-muted)]">
          Opening your personal account…
        </p>
      )}
    </div>
  );
}

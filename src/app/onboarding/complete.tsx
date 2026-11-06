"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
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

  return message ? (
    <>
      <Feedback text={message} />
      <button
        type="button"
        onClick={() => {
          setMessage("");
          setAttempt(attempt + 1);
        }}
      >
        Try again
      </button>
    </>
  ) : (
    <p role="status">Opening your personal account…</p>
  );
}

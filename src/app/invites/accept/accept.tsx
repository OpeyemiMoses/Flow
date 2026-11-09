"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { describe, Feedback, send } from "../../controls.tsx";

export function AcceptInvitation() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  async function accept() {
    const token = new URLSearchParams(window.location.hash.slice(1)).get(
      "token",
    );
    if (!token || !/^[a-f0-9]{64}$/.test(token)) {
      setMessage("Open the invitation link from your email.");
      return;
    }
    setBusy(true);
    try {
      const { account } = await send<{ account: { id: string } }>(
        "/api/invites/accept",
        { token },
      );
      window.history.replaceState(null, "", "/invites/accept");
      router.replace(`/accounts/${account.id}`);
    } catch (error) {
      setMessage(describe(error));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="space-y-4">
      <button
        type="button"
        disabled={busy}
        onClick={accept}
        className="flow-btn-primary w-full px-4 py-3 text-sm"
      >
        Accept invitation
      </button>
      <Feedback text={message} />
    </div>
  );
}

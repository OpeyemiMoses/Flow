"use client";

import { usePathname, useRouter } from "next/navigation";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { describe, Feedback, send } from "../../controls.tsx";

export function RefreshSession() {
  const path = usePathname();
  useEffect(() => {
    void fetch("/api/me", { cache: "no-store" }).catch(() => undefined);
  }, [path]);
  return null;
}

export function AccountNameForm({
  account,
}: {
  account?: { id: string; name: string };
}) {
  const [name, setName] = useState(account?.name ?? "");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const pending = useRef<{ key: string; name: string } | null>(null);
  const router = useRouter();

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setMessage("");
    try {
      if (account) {
        await send(`/api/accounts/${account.id}`, { name }, "PATCH");
        setMessage("Account name saved.");
        router.refresh();
      } else {
        if (pending.current?.name !== name)
          pending.current = { name, key: crypto.randomUUID() };
        const result = await send<{ account: { id: string } }>(
          "/api/accounts",
          { name },
          "POST",
          { "Idempotency-Key": pending.current.key },
        );
        router.push(`/accounts/${result.account.id}`);
      }
    } catch (error) {
      setMessage(describe(error));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="space-y-4" onSubmit={submit}>
      <label className="block text-sm font-semibold text-[var(--text-primary)]">
        {account ? "Account name" : "Business name"}
        <input
          value={name}
          onChange={(event) => setName(event.target.value)}
          maxLength={80}
          required
          placeholder={account ? "Workspace name" : "Acme Treasury LLC"}
          className="flow-input mt-1.5 w-full px-3.5 py-2.5 text-sm font-normal"
        />
      </label>
      <div>
        <button
          disabled={busy}
          className="flow-btn-primary px-4 py-2 text-xs sm:text-sm"
        >
          {account ? "Save name" : "Create business"}
        </button>
      </div>
      <Feedback text={message} />
    </form>
  );
}

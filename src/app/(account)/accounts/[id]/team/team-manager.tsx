"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import {
  IconBuilding,
  IconLock,
  IconUsers,
} from "../../../../../components/icons.tsx";
import { Feedback, FreshProof, send } from "../../../../controls.tsx";

type Role = "OWNER" | "ADMIN" | "MEMBER";
type Change = {
  path: string;
  method: "POST" | "PATCH" | "DELETE";
  data: object;
  label: string;
};

export function TeamManager({
  account,
  members,
  invitations,
}: {
  account: { id: string; role: Role };
  members: { id: string; role: Role; email: string }[];
  invitations: { id: string; role: Role; email: string }[];
}) {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<"ADMIN" | "MEMBER">("MEMBER");
  const [change, setChange] = useState<Change>();
  const [message, setMessage] = useState("");
  const prefix = `/api/accounts/${account.id}`;

  function prepareInvite(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setChange({
      path: `${prefix}/invites`,
      method: "POST",
      data: { email, role },
      label: "Send the invitation to this email.",
    });
  }

  return (
    <div className="space-y-6">
      {change && (
        <FreshProof
          purpose="team-change"
          target={account.id}
          onCancel={() => setChange(undefined)}
          onConfirm={async () => {
            await send(change.path, change.data, change.method);
            setMessage(
              change.method === "POST"
                ? "Invitation created. Delivery may take a moment."
                : "Team changes saved.",
            );
            setChange(undefined);
            router.refresh();
          }}
        >
          {change.label}
        </FreshProof>
      )}

      <Feedback text={message} />

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-12 items-start">
        {/* Left 5 Columns: Invite Form + Role Governance */}
        <div className="lg:col-span-5 space-y-6">
          <section className="flow-card p-6 space-y-4">
            <div className="flex items-center gap-2 text-xs font-bold uppercase tracking-wider text-[#FF1A1A]">
              <IconUsers size={15} />
              <span>Organization Access</span>
            </div>
            <h2 className="font-display text-lg font-bold text-[var(--text-primary)]">
              Invite a teammate
            </h2>
            <p className="text-xs text-[var(--text-secondary)]">
              Invitations are single-use cryptographic tokens bound to the
              recipient email address.
            </p>

            <form className="space-y-4" onSubmit={prepareInvite}>
              <label className="block text-xs font-semibold text-[var(--text-primary)]">
                Teammate email
                <input
                  type="email"
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                  maxLength={254}
                  required
                  placeholder="colleague@company.com"
                  className="flow-input mt-1.5 w-full px-3.5 py-2.5 text-sm font-normal"
                />
              </label>

              <label className="block text-xs font-semibold text-[var(--text-primary)]">
                Role
                <select
                  value={role}
                  onChange={(event) =>
                    setRole(event.target.value === "ADMIN" ? "ADMIN" : "MEMBER")
                  }
                  className="flow-input mt-1.5 w-full px-3.5 py-2.5 text-sm font-semibold"
                >
                  <option value="MEMBER">Member</option>
                  {account.role === "OWNER" && (
                    <option value="ADMIN">Admin</option>
                  )}
                </select>
              </label>

              <div>
                <button
                  disabled={!!change}
                  className="flow-btn-primary w-full py-2.5 text-xs sm:text-sm"
                >
                  Continue to invite
                </button>
              </div>
            </form>
          </section>

          <section className="flow-card p-5 space-y-3 text-xs">
            <div className="flex items-center gap-2 font-bold text-[var(--text-primary)]">
              <IconBuilding size={15} className="text-[#0F9F80]" />
              <span>Business Role Permissions</span>
            </div>
            <div className="space-y-2 text-[var(--text-secondary)]">
              <p>
                <strong className="text-[var(--text-primary)]">OWNER:</strong>{" "}
                Full governance over members, roles, invitations, and treasury
                custody settings.
              </p>
              <p>
                <strong className="text-[var(--text-primary)]">ADMIN:</strong>{" "}
                Can invite or remove `MEMBER` collaborators after step-up
                verification.
              </p>
              <p>
                <strong className="text-[var(--text-primary)]">MEMBER:</strong>{" "}
                Scoped access to the business portfolio without member directory
                or invitation visibility.
              </p>
            </div>
          </section>
        </div>

        {/* Right 7 Columns: Members + Pending Invitations */}
        <div className="lg:col-span-7 space-y-6">
          <section className="flow-card p-6 space-y-4">
            <div className="flex items-center justify-between border-b border-[var(--border-subtle)] pb-3">
              <h2 className="font-display text-base font-bold text-[var(--text-primary)]">
                Members
              </h2>
              <span className="rounded-[4px] bg-emerald-400/15 px-2.5 py-0.5 text-[11px] font-bold text-[#0F9F80]">
                {members.length} Active
              </span>
            </div>

            <ul className="space-y-3">
              {members.map((member) => (
                <li
                  key={member.id}
                  className="flex flex-wrap items-center justify-between gap-3 rounded-[10px] border border-[var(--border-subtle)] bg-[var(--surface-subtle)]/50 p-3.5 text-xs sm:text-sm"
                >
                  <span className="font-semibold text-[var(--text-primary)]">
                    {member.email} · {member.role.toLowerCase()}
                  </span>
                  <div className="flex flex-wrap items-center gap-2">
                    {account.role === "OWNER" && member.role !== "OWNER" && (
                      <button
                        className="flow-btn-secondary px-2.5 py-1 text-xs"
                        type="button"
                        disabled={!!change}
                        onClick={() =>
                          setChange({
                            path: `${prefix}/members/${member.id}`,
                            method: "PATCH",
                            data: {
                              role:
                                member.role === "ADMIN" ? "MEMBER" : "ADMIN",
                            },
                            label: "Change this teammate’s role.",
                          })
                        }
                      >
                        {member.role === "ADMIN" ? "Make member" : "Make admin"}
                      </button>
                    )}
                    {(member.role === "MEMBER" ||
                      (account.role === "OWNER" &&
                        member.role === "ADMIN")) && (
                      <button
                        className="flow-btn-secondary px-2.5 py-1 text-xs text-red-700 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-950/40"
                        type="button"
                        disabled={!!change}
                        onClick={() =>
                          setChange({
                            path: `${prefix}/members/${member.id}`,
                            method: "DELETE",
                            data: {},
                            label: "Remove this teammate’s access.",
                          })
                        }
                      >
                        Remove
                      </button>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          </section>

          <section className="flow-card p-6 space-y-4">
            <div className="flex items-center justify-between border-b border-[var(--border-subtle)] pb-3">
              <h2 className="font-display text-base font-bold text-[var(--text-primary)]">
                Pending invitations
              </h2>
              <span className="inline-flex items-center gap-1 text-xs text-[var(--text-muted)]">
                <IconLock size={12} />
                Single-Use Tokens
              </span>
            </div>

            {invitations.length === 0 ? (
              <p className="text-xs text-[var(--text-secondary)]">
                No pending invitations.
              </p>
            ) : (
              <ul className="space-y-2.5">
                {invitations.map((invite) => (
                  <li
                    key={invite.id}
                    className="flex flex-wrap items-center justify-between gap-3 rounded-[10px] border border-[var(--border-subtle)] bg-[var(--surface-subtle)]/50 p-3.5 text-xs sm:text-sm"
                  >
                    <span className="font-semibold text-[var(--text-primary)]">
                      {invite.email} · {invite.role.toLowerCase()}
                    </span>
                    {(account.role === "OWNER" || invite.role === "MEMBER") && (
                      <button
                        className="flow-btn-secondary px-2.5 py-1 text-xs"
                        type="button"
                        disabled={!!change}
                        onClick={() =>
                          setChange({
                            path: `${prefix}/invites/${invite.id}`,
                            method: "DELETE",
                            data: {},
                            label: "Revoke this invitation.",
                          })
                        }
                      >
                        Revoke
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}

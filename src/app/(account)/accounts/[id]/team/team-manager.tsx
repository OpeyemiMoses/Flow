"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
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
    <>
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
      <section className="flow-panel flow-stack">
        <h2>Invite a teammate</h2>
        <form className="flow-stack" onSubmit={prepareInvite}>
          <label>
            Teammate email
            <input
              type="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              maxLength={254}
              required
            />
          </label>
          <label>
            Role
            <select
              value={role}
              onChange={(event) =>
                setRole(event.target.value === "ADMIN" ? "ADMIN" : "MEMBER")
              }
            >
              <option value="MEMBER">Member</option>
              {account.role === "OWNER" && <option value="ADMIN">Admin</option>}
            </select>
          </label>
          <div>
            <button disabled={!!change}>Continue to invite</button>
          </div>
        </form>
      </section>
      <section className="flow-panel flow-stack">
        <h2>Members</h2>
        <ul className="flow-list">
          {members.map((member) => (
            <li key={member.id}>
              <span>
                {member.email} · {member.role.toLowerCase()}
              </span>
              <div className="flow-actions">
                {account.role === "OWNER" && member.role !== "OWNER" && (
                  <button
                    className="flow-secondary"
                    type="button"
                    disabled={!!change}
                    onClick={() =>
                      setChange({
                        path: `${prefix}/members/${member.id}`,
                        method: "PATCH",
                        data: {
                          role: member.role === "ADMIN" ? "MEMBER" : "ADMIN",
                        },
                        label: "Change this teammate’s role.",
                      })
                    }
                  >
                    {member.role === "ADMIN" ? "Make member" : "Make admin"}
                  </button>
                )}
                {(member.role === "MEMBER" ||
                  (account.role === "OWNER" && member.role === "ADMIN")) && (
                  <button
                    className="flow-secondary"
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
      <section className="flow-panel flow-stack">
        <h2>Pending invitations</h2>
        {invitations.length === 0 ? (
          <p>No pending invitations.</p>
        ) : (
          <ul className="flow-list">
            {invitations.map((invite) => (
              <li key={invite.id}>
                <span>
                  {invite.email} · {invite.role.toLowerCase()}
                </span>
                {(account.role === "OWNER" || invite.role === "MEMBER") && (
                  <button
                    className="flow-secondary"
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
    </>
  );
}

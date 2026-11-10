"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import Link from "next/link";
import { FlowLogo } from "../../components/flow-logo.tsx";
import { describe, Feedback, send } from "../controls.tsx";

type OnboardingStep = "type" | "profile" | "ready";

export function CompleteOnboarding({
  initialStep,
  userEmail,
  userName,
}: {
  initialStep?: string;
  userEmail: string;
  userName: string;
}) {
  const router = useRouter();
  const [step, setStep] = useState<OnboardingStep>(
    initialStep === "profile"
      ? "profile"
      : initialStep === "ready"
        ? "ready"
        : "type",
  );
  const [accountType, setAccountType] = useState<"personal" | "business">(
    "personal",
  );
  const [fullName, setFullName] = useState(userName || "Amara Nolan");
  const [username, setUsername] = useState(
    (userEmail.split("@")[0] || "amara").replace(/[^a-zA-Z0-9_]/g, ""),
  );
  const [accountId, setAccountId] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const isManualStep = Boolean(initialStep);

  useEffect(() => {
    let active = true;
    send<{ account: { id: string } }>("/api/onboarding/complete")
      .then(({ account }) => {
        if (!active) return;
        setAccountId(account.id);
        if (!isManualStep) {
          router.replace(`/accounts/${account.id}`);
        }
      })
      .catch((error) => {
        if (active) setMessage(describe(error));
      });
    return () => {
      active = false;
    };
  }, [isManualStep, router]);

  function goToDashboard() {
    if (accountId) {
      router.replace(`/accounts/${accountId}`);
    } else {
      router.replace("/accounts");
    }
  }

  // SCREEN 6: Account Ready ("You're all set.") — Matches 08_26_11 PM-4.png
  if (step === "ready") {
    return (
      <div className="relative min-h-screen w-full overflow-hidden bg-white text-[#0B0B0B] lg:grid lg:grid-cols-12">
        <main className="relative z-10 flex min-h-screen flex-col justify-between px-6 py-10 sm:px-14 lg:col-span-6 lg:px-20">
          <div>
            <Link href="/" aria-label="FLOW Home" className="inline-block">
              <FlowLogo className="h-8 w-auto sm:h-9" />
            </Link>
          </div>

          <div className="my-auto max-w-[440px] py-12 text-center sm:text-left">
            <div className="mx-auto flex h-24 w-24 items-center justify-center rounded-[28px] border border-[#F0EAE6] bg-[#FFFDFC] shadow-[0_18px_40px_rgba(255,26,26,0.12)] sm:mx-0">
              <div className="flex h-12 w-12 items-center justify-center rounded-full border-2 border-[#FF1A1A] text-[#FF1A1A]">
                <svg
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2.5"
                  className="h-6 w-6"
                >
                  <polyline points="20 6 9 17 4 12" />
                </svg>
              </div>
            </div>

            <h1 className="mt-8 font-serif text-[44px] font-normal leading-[1.06] tracking-[-0.025em] text-[#0B0B0B] sm:text-[56px]">
              You&apos;re all set.
            </h1>

            <p className="mt-4 text-[16px] leading-[1.6] text-[#5A5A5A]">
              Your account is ready. You can now send, receive, and manage
              payments with Flow.
            </p>

            <button
              type="button"
              onClick={goToDashboard}
              className="mt-8 inline-flex h-14 w-full max-w-[340px] items-center justify-center gap-2.5 rounded-full bg-[#0B0B0B] px-8 text-[15px] font-semibold text-white transition hover:bg-[#1F1F1F]"
            >
              <span>Go to dashboard</span>
              <span aria-hidden="true">→</span>
            </button>

            {message && (
              <div className="mt-4">
                <Feedback text={message} />
              </div>
            )}
          </div>

          <div />
        </main>

        <aside className="relative hidden min-h-screen overflow-hidden bg-white lg:col-span-6 lg:flex lg:items-end lg:justify-end">
          <img
            src="/assets/ready-phone-rock.png"
            alt="FLOW account ready on smartphone"
            className="h-full w-full object-cover object-right-bottom"
          />
        </aside>
      </div>
    );
  }

  // SCREEN 5: Complete Your Profile — Matches 08_26_10 PM-3.png & 08_56_21 PM-3.png
  if (step === "profile") {
    return (
      <div className="relative min-h-screen w-full overflow-hidden bg-[#FAF8F5] text-[#0B0B0B]">
        {/* Bottom-left red wave accent */}
        <div
          aria-hidden="true"
          className="pointer-events-none absolute -bottom-24 -left-24 h-[340px] w-[360px] rounded-tr-full bg-gradient-to-tr from-[#FF1A1A] via-[#FF1A1A]/75 to-transparent opacity-90"
        />

        {/* Header */}
        <header className="mx-auto flex max-w-[1240px] items-center justify-between px-6 py-6 sm:px-10">
          <Link href="/" aria-label="FLOW Home">
            <FlowLogo className="h-8 w-auto" />
          </Link>
          <nav className="hidden items-center gap-8 text-[14px] font-medium text-[#1F1F1F] md:flex">
            <span>Product</span>
            <span>Use Cases</span>
            <span>Resources</span>
            <span>Pricing</span>
          </nav>
          <div className="flex items-center gap-3">
            <span className="relative flex h-10 w-10 items-center justify-center rounded-full border border-[#E5E2DC] bg-white text-[#0B0B0B]">
              <svg
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.8"
                className="h-5 w-5"
              >
                <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" />
                <path d="M13.73 21a2 2 0 0 1-3.46 0" />
              </svg>
              <span className="absolute right-2 top-2 h-2 w-2 rounded-full bg-[#FF1A1A]" />
            </span>
            <img
              src="/assets/amara-avatar.png"
              alt="Profile avatar"
              className="h-10 w-10 rounded-full object-cover"
            />
          </div>
        </header>

        <main className="relative z-10 mx-auto grid max-w-[1240px] items-start gap-10 px-6 pb-20 pt-4 sm:px-10 lg:grid-cols-12">
          {/* Left Column */}
          <div className="lg:col-span-5 lg:pt-8">
            <div className="text-[12px] font-bold uppercase tracking-[0.18em] text-[#FF1A1A]">
              GETTING STARTED
            </div>
            <h1 className="mt-3 font-serif text-[44px] font-normal leading-[1.06] tracking-[-0.025em] text-[#0B0B0B] sm:text-[54px]">
              Complete <br />
              <span className="relative inline-block">
                your profile.
                <svg
                  viewBox="0 0 240 12"
                  fill="none"
                  className="mt-1 w-full text-[#FF1A1A]"
                  preserveAspectRatio="none"
                >
                  <path
                    d="M3 9C70 3 165 3 237 9"
                    stroke="currentColor"
                    strokeWidth="3"
                    strokeLinecap="round"
                  />
                </svg>
              </span>
            </h1>
            <p className="mt-4 max-w-[380px] text-[15px] leading-[1.6] text-[#555555]">
              Help us personalize your Flow experience so you can get paid, your
              way.
            </p>

            <div className="mt-10 hidden space-y-6 lg:block">
              <div className="flex items-start gap-4">
                <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-[#EFECE6] text-[#0B0B0B]">
                  <svg
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.8"
                    className="h-5 w-5"
                  >
                    <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
                    <circle cx="12" cy="7" r="4" />
                  </svg>
                </span>
                <div>
                  <div className="text-[15px] font-semibold text-[#0B0B0B]">
                    Build your identity
                  </div>
                  <div className="text-[13px] text-[#666666]">
                    Set up your name and how you&apos;ll appear to others.
                  </div>
                </div>
              </div>

              <div className="flex items-start gap-4">
                <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-[#EFECE6] text-[#0B0B0B]">
                  <svg
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.8"
                    className="h-5 w-5"
                  >
                    <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />
                  </svg>
                </span>
                <div>
                  <div className="text-[15px] font-semibold text-[#0B0B0B]">
                    Get paid faster
                  </div>
                  <div className="text-[13px] text-[#666666]">
                    Ensure your account details are accurate and secure.
                  </div>
                </div>
              </div>

              <div className="flex items-start gap-4">
                <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-[#EFECE6] text-[#0B0B0B]">
                  <svg
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.8"
                    className="h-5 w-5"
                  >
                    <polygon points="12 2 2 7 12 12 22 7 12 2" />
                    <polyline points="2 12 12 17 22 12" />
                    <polyline points="2 17 12 22 22 17" />
                  </svg>
                </span>
                <div>
                  <div className="text-[15px] font-semibold text-[#0B0B0B]">
                    Unlock more features
                  </div>
                  <div className="text-[13px] text-[#666666]">
                    Access all of Flow with a complete profile.
                  </div>
                </div>
              </div>
            </div>
          </div>

          {/* Right Form Card */}
          <div className="rounded-[28px] border border-[#E8E4DC] bg-white p-6 shadow-sm sm:p-10 lg:col-span-7">
            {/* Stepper Header */}
            <div className="flex items-center justify-between border-b border-[#F0EDE6] pb-6">
              <span className="text-[14px] font-semibold text-[#0B0B0B]">
                Step 1 of 3
              </span>
              <div className="flex items-center gap-6 text-[12px]">
                <div className="flex flex-col items-center gap-1">
                  <span className="flex h-6 w-6 items-center justify-center rounded-full bg-[#FF1A1A] text-white">
                    ✓
                  </span>
                  <span className="font-semibold text-[#0B0B0B]">Profile</span>
                </div>
                <div className="h-px w-10 bg-[#E0DCD4]" />
                <div className="flex flex-col items-center gap-1">
                  <span className="h-6 w-6 rounded-full border border-[#CCCCCC]" />
                  <span className="text-[#666666]">Account</span>
                </div>
                <div className="h-px w-10 bg-[#E0DCD4]" />
                <div className="flex flex-col items-center gap-1">
                  <span className="h-6 w-6 rounded-full border border-[#CCCCCC]" />
                  <span className="text-[#666666]">Finish</span>
                </div>
              </div>
            </div>

            {/* Profile Preview Banner */}
            <div className="mt-6 flex flex-wrap items-center justify-between gap-4 rounded-2xl bg-[#F7F5F1] p-4 sm:p-5">
              <div className="flex items-center gap-4">
                <img
                  src="/assets/amara-avatar.png"
                  alt={fullName}
                  className="h-16 w-16 rounded-full object-cover"
                />
                <div>
                  <div className="text-[11px] text-[#666666]">
                    Profile preview
                  </div>
                  <div className="font-serif text-[22px] text-[#0B0B0B]">
                    {fullName}
                  </div>
                  <div className="text-[13px] text-[#666666]">@{username}</div>
                </div>
              </div>
              <span className="inline-flex items-center gap-1.5 rounded-full border border-[#E2DED6] bg-white px-3.5 py-1.5 text-[12px] font-medium text-[#1F1F1F]">
                <span>👁</span>
                <span>How others see you</span>
              </span>
            </div>

            {/* Inputs */}
            <div className="mt-6 space-y-5">
              <div>
                <label className="block text-[13px] font-semibold text-[#0B0B0B]">
                  Full name <span className="text-[#FF1A1A]">*</span>
                </label>
                <div className="mt-1.5 flex h-12 items-center rounded-xl border border-[#E2DED6] bg-white px-4">
                  <span className="mr-3 text-[#666666]">👤</span>
                  <input
                    type="text"
                    value={fullName}
                    onChange={(e) => setFullName(e.target.value)}
                    className="w-full bg-transparent text-[14px] text-[#0B0B0B] focus:outline-none"
                  />
                </div>
              </div>

              <div>
                <label className="block text-[13px] font-semibold text-[#0B0B0B]">
                  Display name / Username{" "}
                  <span className="text-[#FF1A1A]">*</span>
                </label>
                <div className="mt-1.5 flex h-12 items-center justify-between rounded-xl border border-[#E2DED6] bg-white px-4">
                  <div className="flex flex-1 items-center">
                    <span className="mr-3 font-semibold text-[#666666]">@</span>
                    <input
                      type="text"
                      value={username}
                      onChange={(e) => setUsername(e.target.value)}
                      className="w-full bg-transparent text-[14px] text-[#0B0B0B] focus:outline-none"
                    />
                  </div>
                  <span className="rounded-full bg-[#E8F8F0] px-2.5 py-1 text-[11px] font-semibold text-[#0D9458]">
                    ✓ Available
                  </span>
                </div>
              </div>

              <div>
                <label className="block text-[13px] font-semibold text-[#0B0B0B]">
                  Email
                </label>
                <div className="mt-1.5 flex h-12 items-center justify-between rounded-xl border border-[#E2DED6] bg-[#F7F5F1] px-4">
                  <div className="flex items-center text-[14px] text-[#4A4A4A]">
                    <span className="mr-3">✉️</span>
                    <span>{userEmail}</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="rounded-full bg-[#E8F8F0] px-2.5 py-1 text-[11px] font-semibold text-[#0D9458]">
                      ✓ Verified
                    </span>
                    <span className="text-[#666666]">🔒</span>
                  </div>
                </div>
              </div>

              <div>
                <div className="font-serif text-[20px] text-[#0B0B0B]">
                  Account details
                </div>
                <div className="mt-2.5 grid grid-cols-3 divide-x divide-[#E6E2DA] rounded-2xl bg-[#F7F5F1] p-4 text-[12px]">
                  <div className="pr-3">
                    <div className="text-[#666666]">Account type</div>
                    <div className="mt-0.5 font-semibold capitalize text-[#0B0B0B]">
                      {accountType}
                    </div>
                  </div>
                  <div className="px-3">
                    <div className="text-[#666666]">Country / Region</div>
                    <div className="mt-0.5 font-semibold text-[#0B0B0B]">
                      United States
                    </div>
                  </div>
                  <div className="pl-3">
                    <div className="text-[#666666]">Currency</div>
                    <div className="mt-0.5 font-semibold text-[#0B0B0B]">
                      USD (US Dollar)
                    </div>
                  </div>
                </div>
              </div>

              <button
                type="button"
                onClick={() => setStep("ready")}
                className="mt-4 flex h-14 w-full items-center justify-center gap-2 rounded-full bg-[#0B0B0B] text-[15px] font-semibold text-white transition hover:bg-[#1F1F1F]"
              >
                <span>Continue</span>
                <span aria-hidden="true">→</span>
              </button>
            </div>
          </div>
        </main>
      </div>
    );
  }

  // SCREEN 4: Choose Account Type ("How will you use Flow?") — Matches 08_26_08 PM-2.png & 08_56_19 PM-2.png
  return (
    <div className="relative min-h-screen w-full overflow-hidden bg-white text-[#0B0B0B]">
      {/* Top-right and bottom-left red wave accents */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute -right-24 -top-12 h-[380px] w-[380px] rounded-bl-full bg-gradient-to-bl from-[#FF1A1A] via-[#FF1A1A]/75 to-transparent opacity-90"
      />
      <div
        aria-hidden="true"
        className="pointer-events-none absolute -bottom-24 -left-24 h-[260px] w-[280px] rounded-tr-full bg-gradient-to-tr from-[#FF1A1A]/70 via-[#FF1A1A]/30 to-transparent"
      />

      <header className="relative z-10 mx-auto flex max-w-[1200px] items-center justify-between px-6 py-8 sm:px-10">
        <Link href="/" aria-label="FLOW Home">
          <FlowLogo className="h-8 w-auto sm:h-9" />
        </Link>
      </header>

      <main className="relative z-10 mx-auto flex max-w-[880px] flex-col items-center px-6 pb-20 pt-4 text-center">
        {/* 3-Dot Stepper */}
        <div className="flex items-center gap-3">
          <span className="flex h-7 w-7 items-center justify-center rounded-full bg-[#0B0B0B] text-[12px] text-white">
            ✓
          </span>
          <div className="h-[2px] w-14 bg-[#0B0B0B]" />
          <span className="flex h-7 w-7 items-center justify-center rounded-full border-2 border-[#FF1A1A] p-1">
            <span className="h-full w-full rounded-full bg-[#FF1A1A]" />
          </span>
          <div className="h-[2px] w-14 bg-[#E0E0E0]" />
          <span className="h-7 w-7 rounded-full border border-[#CCCCCC]" />
        </div>

        <h1 className="mt-8 font-serif text-[42px] font-normal leading-[1.08] tracking-[-0.025em] text-[#0B0B0B] sm:text-[56px]">
          How will you{" "}
          <span className="relative inline-block">
            use Flow?
            <svg
              viewBox="0 0 240 12"
              fill="none"
              className="mt-1 w-full text-[#FF1A1A]"
              preserveAspectRatio="none"
            >
              <path
                d="M3 9C75 3 165 3 237 9"
                stroke="currentColor"
                strokeWidth="3"
                strokeLinecap="round"
              />
            </svg>
          </span>
        </h1>

        <p className="mt-4 text-[16px] text-[#5A5A5A]">
          Choose the account type that best fits your needs.
        </p>

        {/* Two Selection Cards */}
        <div className="mt-10 grid w-full gap-5 sm:grid-cols-2">
          {/* Personal Card */}
          <button
            type="button"
            onClick={() => setAccountType("personal")}
            className={`relative overflow-hidden rounded-[26px] bg-white p-7 text-left transition sm:p-8 ${
              accountType === "personal"
                ? "border-2 border-[#FF1A1A] shadow-[0_16px_40px_rgba(255,26,26,0.08)]"
                : "border border-[#E5E5E5]"
            }`}
          >
            <div className="flex items-start justify-between">
              <span className="flex h-14 w-14 items-center justify-center rounded-2xl bg-[#F6F4F0] text-[#0B0B0B]">
                <svg
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.8"
                  className="h-7 w-7"
                >
                  <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
                  <circle cx="12" cy="7" r="4" />
                </svg>
              </span>
              {accountType === "personal" ? (
                <span className="flex h-7 w-7 items-center justify-center rounded-full bg-[#FF1A1A] text-xs text-white">
                  ✓
                </span>
              ) : (
                <span className="h-7 w-7 rounded-full border border-[#CCCCCC]" />
              )}
            </div>

            <div className="mt-6 font-serif text-[28px] text-[#0B0B0B]">
              Personal
            </div>
            <p className="mt-2 max-w-[260px] text-[14px] leading-[1.55] text-[#555555]">
              Send, receive, and manage payments for your personal needs.
            </p>

            {/* Bottom-right red wave inside card */}
            <div
              aria-hidden="true"
              className="pointer-events-none absolute -bottom-10 -right-10 h-28 w-36 rounded-tl-full bg-gradient-to-tl from-[#8B0000] via-[#FF1A1A] to-transparent opacity-90"
            />
          </button>

          {/* Business Card */}
          <button
            type="button"
            onClick={() => setAccountType("business")}
            className={`relative overflow-hidden rounded-[26px] bg-[#FAF9F7] p-7 text-left transition sm:p-8 ${
              accountType === "business"
                ? "border-2 border-[#FF1A1A] bg-white shadow-[0_16px_40px_rgba(255,26,26,0.08)]"
                : "border border-[#E5E5E5]"
            }`}
          >
            <div className="flex items-start justify-between">
              <span className="flex h-14 w-14 items-center justify-center rounded-2xl bg-[#F0EEEA] text-[#0B0B0B]">
                <svg
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.8"
                  className="h-7 w-7"
                >
                  <rect x="2" y="7" width="20" height="14" rx="2" />
                  <path d="M16 7V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v2" />
                  <line x1="2" y1="13" x2="22" y2="13" />
                </svg>
              </span>
              {accountType === "business" ? (
                <span className="flex h-7 w-7 items-center justify-center rounded-full bg-[#FF1A1A] text-xs text-white">
                  ✓
                </span>
              ) : (
                <span className="h-7 w-7 rounded-full border border-[#CCCCCC]" />
              )}
            </div>

            <div className="mt-6 font-serif text-[28px] text-[#0B0B0B]">
              Business
            </div>
            <p className="mt-2 max-w-[260px] text-[14px] leading-[1.55] text-[#555555]">
              Accept payments, send payouts, and manage money for your business.
            </p>
          </button>
        </div>

        <button
          type="button"
          onClick={() => setStep("profile")}
          className="mt-10 inline-flex h-14 w-full max-w-[380px] items-center justify-center gap-2.5 rounded-full bg-[#0B0B0B] text-[15px] font-semibold text-white transition hover:bg-[#1F1F1F]"
        >
          <span>Continue</span>
          <span aria-hidden="true">→</span>
        </button>

        {message && (
          <div className="mt-4">
            <Feedback text={message} />
          </div>
        )}
      </main>
    </div>
  );
}

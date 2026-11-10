"use client";

import { useState } from "react";
import Link from "next/link";
import { FlowLogo } from "../components/flow-logo";

const FAQS = [
  {
    q: "What is FLOW?",
    a: "FLOW is a flexible payment platform that lets individuals and businesses get paid in the asset and network they prefer, while payers use the wallet or asset they already hold.",
  },
  {
    q: "Who can use FLOW?",
    a: "Creators, freelancers, consultants, and global businesses use FLOW to accept payments via shareable links, QR codes, and invoices across Ethereum, Base, Solana, and NEAR.",
  },
  {
    q: "How can I get paid?",
    a: "Choose your preferred settlement asset—such as USDC, ETH, SOL, or NEAR—and generate a payment link or QR code in seconds. Share it anywhere and receive funds directly in your workspace.",
  },
  {
    q: "Can I use FLOW for my business?",
    a: "Yes. FLOW supports dedicated business accounts with multi-member team access, role permissions, invoice tracking, and unified multi-chain activity reporting.",
  },
  {
    q: "Which payment methods are supported?",
    a: "FLOW supports major digital assets and stablecoins across Ethereum, Base, Solana, and NEAR, with both direct wallet payments and exchange withdrawals.",
  },
];

const TESTIMONIALS = [
  {
    quote:
      "FLOW makes it incredibly easy to get paid by clients around the world. It just works, and it's beautifully simple.",
    name: "Amara N.",
    role: "Creator & Consultant",
  },
  {
    quote:
      "We send one payment link and our clients pay from whatever network they use. Our treasury receives USDC on Base every time.",
    name: "David K.",
    role: "Founder, Horizon Studio",
  },
];

export function HomePageClient() {
  const [openFaq, setOpenFaq] = useState<number | null>(null);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [testimonialIdx, setTestimonialIdx] = useState(0);

  const activeTestimonial = TESTIMONIALS[testimonialIdx] ?? TESTIMONIALS[0]!;

  return (
    <div className="min-h-screen bg-[#F8F6F3] text-[#0B0B0B] selection:bg-[#FF1A1A] selection:text-white">
      {/* 1. NAVBAR */}
      <header className="sticky top-0 z-50 bg-[#F8F6F3]/95 backdrop-blur-md">
        <div className="mx-auto flex h-20 max-w-[1200px] items-center justify-between px-5 sm:px-8">
          <Link href="/" aria-label="FLOW Home" className="shrink-0">
            <FlowLogo className="h-7 w-auto sm:h-8" />
          </Link>

          <nav className="hidden items-center gap-9 text-[14px] font-medium text-[#1F1F1F] md:flex">
            <a
              href="#experience"
              className="transition-colors hover:text-[#FF1A1A]"
            >
              Product
            </a>
            <a
              href="#real-life"
              className="transition-colors hover:text-[#FF1A1A]"
            >
              Use Cases
            </a>
            <a
              href="#get-paid-anywhere"
              className="transition-colors hover:text-[#FF1A1A]"
            >
              Resources
            </a>
            <a href="#faq" className="transition-colors hover:text-[#FF1A1A]">
              Pricing
            </a>
          </nav>

          <div className="hidden items-center gap-3 md:flex">
            <Link
              href="/sign-in"
              className="inline-flex h-10 items-center justify-center rounded-full bg-[#0B0B0B] px-5 text-[13px] font-semibold text-white transition hover:bg-[#1F1F1F]"
            >
              Get Started
            </Link>
            <Link
              href="/sign-in"
              className="inline-flex h-10 items-center justify-center rounded-full border border-[#DCD8D0] bg-white px-5 text-[13px] font-semibold text-[#0B0B0B] transition hover:border-[#0B0B0B]"
            >
              Sign In
            </Link>
          </div>

          {/* Mobile Hamburger Button */}
          <button
            type="button"
            onClick={() => setMobileMenuOpen((v) => !v)}
            aria-label="Toggle navigation menu"
            className="inline-flex h-10 w-10 items-center justify-center rounded-xl text-[#0B0B0B] md:hidden"
          >
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              className="h-6 w-6"
            >
              <line x1="3" y1="6" x2="21" y2="6" />
              <line x1="3" y1="12" x2="21" y2="12" />
              <line x1="3" y1="18" x2="21" y2="18" />
            </svg>
          </button>
        </div>

        {mobileMenuOpen && (
          <div className="border-b border-[#E6E2DA] bg-[#F8F6F3] px-5 pb-6 pt-2 md:hidden">
            <div className="flex flex-col gap-3 text-[15px] font-medium text-[#1F1F1F]">
              <a
                href="#experience"
                onClick={() => setMobileMenuOpen(false)}
                className="py-1.5"
              >
                Product
              </a>
              <a
                href="#real-life"
                onClick={() => setMobileMenuOpen(false)}
                className="py-1.5"
              >
                Use Cases
              </a>
              <a
                href="#get-paid-anywhere"
                onClick={() => setMobileMenuOpen(false)}
                className="py-1.5"
              >
                Resources
              </a>
              <a
                href="#faq"
                onClick={() => setMobileMenuOpen(false)}
                className="py-1.5"
              >
                Pricing
              </a>
              <div className="mt-2 flex flex-col gap-2.5">
                <Link
                  href="/sign-in"
                  className="inline-flex h-11 items-center justify-center rounded-full bg-[#0B0B0B] text-[14px] font-semibold text-white"
                >
                  Get Started
                </Link>
                <Link
                  href="/sign-in"
                  className="inline-flex h-11 items-center justify-center rounded-full border border-[#DCD8D0] bg-white text-[14px] font-semibold text-[#0B0B0B]"
                >
                  Sign In
                </Link>
              </div>
            </div>
          </div>
        )}
      </header>

      <main>
        {/* 2. HERO SECTION */}
        <section className="mx-auto max-w-[1200px] px-5 pb-14 pt-6 sm:px-8 lg:pb-20 lg:pt-12">
          <div className="grid items-center gap-10 lg:grid-cols-12 lg:gap-6">
            <div className="lg:col-span-5">
              <h1 className="font-serif text-[44px] font-normal leading-[1.06] tracking-[-0.025em] text-[#0B0B0B] sm:text-[54px] lg:text-[60px]">
                Get paid in
                <br />
                what you want
                <br />
                while others pay
                <br />
                <span className="relative inline-block">
                  with what they have.
                  <svg
                    viewBox="0 0 340 14"
                    fill="none"
                    className="mt-1 w-full text-[#FF1A1A]"
                    preserveAspectRatio="none"
                  >
                    <path
                      d="M3 9.5C82 3.5 235 2.5 337 10.5"
                      stroke="currentColor"
                      strokeWidth="3.5"
                      strokeLinecap="round"
                    />
                  </svg>
                </span>
              </h1>

              <p className="mt-5 max-w-[420px] text-[15px] leading-[1.6] text-[#4A4A4A] sm:text-[16px]">
                A more flexible way to receive payments, so you can get paid on
                your terms, from anyone, anywhere.
              </p>

              <div className="mt-8 flex flex-col gap-3 sm:flex-row sm:items-center">
                <Link
                  href="/sign-in"
                  className="inline-flex h-12 items-center justify-center gap-2 rounded-full bg-[#0B0B0B] px-7 text-[14px] font-semibold text-white transition hover:bg-[#1F1F1F]"
                >
                  <span>Get Started</span>
                  <span aria-hidden="true">→</span>
                </Link>
                <a
                  href="#experience"
                  className="inline-flex h-12 items-center justify-center rounded-full border border-[#D8D4CC] bg-white px-7 text-[14px] font-semibold text-[#0B0B0B] transition hover:border-[#0B0B0B]"
                >
                  See How It Works
                </a>
              </div>
            </div>

            <div className="lg:col-span-7">
              <div className="mx-auto max-w-[680px]">
                <img
                  src="/assets/hero-phones.png"
                  alt="FLOW payment received, brand screen, and QR code scan on three smartphones"
                  className="h-auto w-full object-contain"
                />
              </div>
            </div>
          </div>
        </section>

        {/* 3. STATS STRIP */}
        <section className="border-y border-[#E6E2DA] bg-[#FAF8F5]">
          <div className="mx-auto grid max-w-[1200px] grid-cols-2 divide-x divide-y divide-[#E6E2DA] px-5 sm:px-8 lg:grid-cols-4 lg:divide-y-0">
            <div className="py-6 pr-4 text-center sm:py-8">
              <div className="text-[22px] font-bold tracking-tight text-[#0B0B0B] sm:text-[26px]">
                500K+
              </div>
              <div className="mt-1 text-[12px] text-[#666666] sm:text-[13px]">
                People and businesses
              </div>
            </div>
            <div className="px-4 py-6 text-center sm:py-8">
              <div className="text-[22px] font-bold tracking-tight text-[#0B0B0B] sm:text-[26px]">
                100+
              </div>
              <div className="mt-1 text-[12px] text-[#666666] sm:text-[13px]">
                Countries
              </div>
            </div>
            <div className="px-4 py-6 text-center sm:py-8">
              <div className="text-[16px] font-semibold tracking-tight text-[#0B0B0B] sm:text-[20px]">
                Multiple ways to pay
              </div>
              <div className="mt-1 text-[12px] text-[#666666] sm:text-[13px]">
                Cards, wallets, and more
              </div>
            </div>
            <div className="py-6 pl-4 text-center sm:py-8">
              <div className="text-[16px] font-semibold tracking-tight text-[#0B0B0B] sm:text-[20px]">
                Get paid your way
              </div>
              <div className="mt-1 text-[12px] text-[#666666] sm:text-[13px]">
                In the value you prefer
              </div>
            </div>
          </div>
        </section>

        {/* 4. THE FLOW EXPERIENCE */}
        <section
          id="experience"
          className="mx-auto max-w-[1200px] px-5 py-16 text-center sm:px-8 lg:py-24"
        >
          <div className="text-[11px] font-bold uppercase tracking-[0.18em] text-[#FF1A1A]">
            THE FLOW EXPERIENCE
          </div>
          <h2 className="mx-auto mt-3 max-w-[540px] font-serif text-[36px] font-normal leading-[1.1] tracking-[-0.02em] text-[#0B0B0B] sm:text-[48px]">
            Payments that work
            <br />
            on your terms.
          </h2>
          <p className="mx-auto mt-4 max-w-[500px] text-[15px] leading-[1.6] text-[#555555] sm:text-[16px]">
            Receive money the way you want, from the people, platforms, and
            markets you work with.
          </p>

          <div className="mx-auto mt-10 max-w-[520px]">
            <img
              src="/assets/phone-pedestal.png"
              alt="FLOW mobile screen showing You're getting paid $249.00 and Receive in USDC"
              className="h-auto w-full object-contain"
            />
          </div>
        </section>

        {/* 5. BUILT FOR REAL LIFE */}
        <section
          id="real-life"
          className="mx-auto max-w-[1200px] px-5 pb-16 pt-4 sm:px-8 lg:pb-24"
        >
          <div className="grid items-center gap-10 lg:grid-cols-12 lg:gap-12">
            <div className="lg:col-span-6">
              <div className="mx-auto max-w-[500px]">
                <img
                  src="/assets/phone-hand.png"
                  alt="Hand holding smartphone running FLOW app"
                  className="h-auto w-full object-contain"
                />
              </div>
            </div>

            <div className="lg:col-span-6">
              <div className="text-[11px] font-bold uppercase tracking-[0.18em] text-[#FF1A1A]">
                BUILT FOR REAL LIFE
              </div>
              <h2 className="mt-3 font-serif text-[34px] font-normal leading-[1.1] tracking-[-0.02em] text-[#0B0B0B] sm:text-[44px]">
                A simpler, more
                <br />
                flexible way to get paid.
              </h2>
              <p className="mt-4 max-w-[460px] text-[15px] leading-[1.65] text-[#555555]">
                Whether you&apos;re a creator, freelancer, business, or a global
                team, FLOW makes it easy to receive payments and use your money,
                your way.
              </p>

              <ul className="mt-8 space-y-4">
                <li className="flex items-center gap-3.5 text-[15px] font-medium text-[#1F1F1F]">
                  <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-[#EFECE6] text-[#0B0B0B]">
                    <svg
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.8"
                      className="h-4 w-4"
                    >
                      <polygon points="12 2 2 7 12 12 22 7 12 2" />
                      <polyline points="2 12 12 17 22 12" />
                      <polyline points="2 17 12 22 22 17" />
                    </svg>
                  </span>
                  <span>Receive in the value you prefer</span>
                </li>
                <li className="flex items-center gap-3.5 text-[15px] font-medium text-[#1F1F1F]">
                  <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-[#EFECE6] text-[#0B0B0B]">
                    <svg
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.8"
                      className="h-4 w-4"
                    >
                      <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />
                    </svg>
                  </span>
                  <span>A smooth, modern payment experience</span>
                </li>
                <li className="flex items-center gap-3.5 text-[15px] font-medium text-[#1F1F1F]">
                  <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-[#EFECE6] text-[#0B0B0B]">
                    <svg
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.8"
                      className="h-4 w-4"
                    >
                      <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
                      <circle cx="9" cy="7" r="4" />
                      <path d="M22 21v-2a4 4 0 0 0-3-3.87" />
                      <path d="M16 3.13a4 4 0 0 1 0 7.75" />
                    </svg>
                  </span>
                  <span>For individuals and businesses alike</span>
                </li>
              </ul>
            </div>
          </div>
        </section>

        {/* 6. DARK FEATURE PANELS */}
        <section className="bg-[#0B0B0B] px-5 py-16 text-white sm:px-8 lg:py-20">
          <div className="mx-auto max-w-[1120px] space-y-5">
            {/* Panel 1 */}
            <div className="grid items-center overflow-hidden rounded-[26px] border border-white/10 bg-[#121212] md:grid-cols-12">
              <div className="p-7 sm:p-10 md:col-span-6">
                <div className="text-[10px] font-bold uppercase tracking-[0.18em] text-[#FF1A1A]">
                  RECEIVE PAYMENTS
                </div>
                <h3 className="mt-2.5 font-serif text-[28px] font-normal leading-[1.15] text-white sm:text-[34px]">
                  Get paid, your way.
                </h3>
                <p className="mt-3 max-w-[360px] text-[14px] leading-[1.6] text-white/65">
                  Accept payments from anyone and receive them in the value that
                  works for you.
                </p>
              </div>
              <div className="flex items-end justify-end md:col-span-6">
                <img
                  src="/assets/bento-visual-1.png"
                  alt="Payment received $249.00 in USDC"
                  className="h-auto w-full max-w-[460px] object-cover"
                />
              </div>
            </div>

            {/* Panel 2 */}
            <div className="grid items-center overflow-hidden rounded-[26px] border border-white/10 bg-[#121212] md:grid-cols-12">
              <div className="p-7 sm:p-10 md:col-span-6">
                <div className="text-[10px] font-bold uppercase tracking-[0.18em] text-[#FF1A1A]">
                  CHECKOUT
                </div>
                <h3 className="mt-2.5 font-serif text-[28px] font-normal leading-[1.15] text-white sm:text-[34px]">
                  A smoother way to pay.
                </h3>
                <p className="mt-3 max-w-[360px] text-[14px] leading-[1.6] text-white/65">
                  Give your customers a fast, reliable, and beautiful way to pay
                  you.
                </p>
              </div>
              <div className="flex items-center justify-end md:col-span-6">
                <img
                  src="/assets/bento-visual-2.png"
                  alt="Pay with FLOW checkout options"
                  className="h-auto w-full max-w-[460px] object-cover"
                />
              </div>
            </div>

            {/* Panel 3 */}
            <div className="grid items-center overflow-hidden rounded-[26px] border border-white/10 bg-[#121212] md:grid-cols-12">
              <div className="p-7 sm:p-10 md:col-span-6">
                <div className="text-[10px] font-bold uppercase tracking-[0.18em] text-[#FF1A1A]">
                  MOVE VALUE
                </div>
                <h3 className="mt-2.5 font-serif text-[28px] font-normal leading-[1.15] text-white sm:text-[34px]">
                  Move across ecosystems,
                  <br />
                  without the friction.
                </h3>
                <p className="mt-3 max-w-[360px] text-[14px] leading-[1.6] text-white/65">
                  Send, receive, and use your money across different platforms
                  and markets with ease.
                </p>
              </div>
              <div className="flex items-end justify-end md:col-span-6">
                <img
                  src="/assets/bento-visual-3.png"
                  alt="FLOW symbol on hardware tile"
                  className="h-auto w-full max-w-[460px] object-cover"
                />
              </div>
            </div>
          </div>
        </section>

        {/* 7. WHY FLOW */}
        <section className="mx-auto max-w-[1200px] px-5 py-16 sm:px-8 lg:py-24">
          <div className="grid items-start gap-8 lg:grid-cols-12">
            <div className="lg:col-span-4">
              <div className="text-[11px] font-bold uppercase tracking-[0.18em] text-[#FF1A1A]">
                WHY FLOW
              </div>
              <h2 className="mt-2.5 font-serif text-[32px] font-normal leading-[1.12] tracking-[-0.02em] text-[#0B0B0B] sm:text-[40px]">
                More freedom
                <br />
                for the way you work.
              </h2>
            </div>

            <div className="grid gap-4 sm:grid-cols-3 lg:col-span-8">
              <div className="rounded-[24px] bg-[#F1EEE8] p-6">
                <div className="text-[#FF1A1A]">
                  <svg
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    className="h-5 w-5"
                  >
                    <polygon points="12 2 2 7 12 12 22 7 12 2" />
                    <polyline points="2 12 12 17 22 12" />
                    <polyline points="2 17 12 22 22 17" />
                  </svg>
                </div>
                <h3 className="mt-5 text-[16px] font-semibold text-[#0B0B0B]">
                  Flexibility
                </h3>
                <p className="mt-1.5 text-[13px] leading-[1.55] text-[#5A5A5A]">
                  Get paid in the value that suits you.
                </p>
              </div>

              <div className="rounded-[24px] bg-[#F1EEE8] p-6">
                <div className="text-[#FF1A1A]">
                  <svg
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    className="h-5 w-5"
                  >
                    <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />
                  </svg>
                </div>
                <h3 className="mt-5 text-[16px] font-semibold text-[#0B0B0B]">
                  A cleaner experience
                </h3>
                <p className="mt-1.5 text-[13px] leading-[1.55] text-[#5A5A5A]">
                  Simple, fast, and frictionless payments.
                </p>
              </div>

              <div className="rounded-[24px] bg-[#F1EEE8] p-6">
                <div className="text-[#FF1A1A]">
                  <svg
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    className="h-5 w-5"
                  >
                    <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
                    <circle cx="9" cy="7" r="4" />
                    <path d="M22 21v-2a4 4 0 0 0-3-3.87" />
                    <path d="M16 3.13a4 4 0 0 1 0 7.75" />
                  </svg>
                </div>
                <h3 className="mt-5 text-[16px] font-semibold text-[#0B0B0B]">
                  For you and your business
                </h3>
                <p className="mt-1.5 text-[13px] leading-[1.55] text-[#5A5A5A]">
                  Built for individuals, creators, and growing businesses.
                </p>
              </div>
            </div>
          </div>
        </section>

        {/* 8. GET PAID ANYWHERE */}
        <section
          id="get-paid-anywhere"
          className="mx-auto max-w-[1200px] px-5 pb-16 sm:px-8"
        >
          <div className="grid items-center gap-8 rounded-[32px] bg-[#F1EEE8] p-7 sm:p-12 lg:grid-cols-12">
            <div className="lg:col-span-4">
              <div className="text-[11px] font-bold uppercase tracking-[0.18em] text-[#FF1A1A]">
                GET PAID ANYWHERE
              </div>
              <h2 className="mt-2.5 font-serif text-[32px] font-normal leading-[1.12] tracking-[-0.02em] text-[#0B0B0B] sm:text-[38px]">
                Turn any payment
                <br />
                into a simple link
                <br />
                or QR.
              </h2>
              <p className="mt-4 text-[14px] leading-[1.6] text-[#5A5A5A]">
                Share a link, show your QR, or send an invoice — and get paid in
                the value you prefer.
              </p>
            </div>

            <div className="flex justify-center lg:col-span-4">
              <img
                src="/assets/qr-standee.png"
                alt="FLOW Scan to pay QR standee"
                className="h-auto w-full max-w-[250px] object-contain"
              />
            </div>

            <div className="space-y-3 lg:col-span-4">
              <div className="flex items-center gap-4 rounded-2xl bg-white p-4 shadow-2xs">
                <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-[#F8F6F3] text-[#0B0B0B]">
                  <svg
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    className="h-4 w-4"
                  >
                    <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
                    <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
                  </svg>
                </span>
                <div>
                  <div className="text-[14px] font-semibold text-[#0B0B0B]">
                    Payment link
                  </div>
                  <div className="text-[12px] text-[#666666]">
                    Share and get paid instantly.
                  </div>
                </div>
              </div>

              <div className="flex items-center gap-4 rounded-2xl bg-white p-4 shadow-2xs">
                <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-[#F8F6F3] text-[#0B0B0B]">
                  <svg
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    className="h-4 w-4"
                  >
                    <rect x="3" y="3" width="7" height="7" rx="1" />
                    <rect x="14" y="3" width="7" height="7" rx="1" />
                    <rect x="3" y="14" width="7" height="7" rx="1" />
                    <rect x="14" y="14" width="3" height="3" />
                    <path d="M19 14h2v2M14 19h2v2M19 19h2v2" />
                  </svg>
                </span>
                <div>
                  <div className="text-[14px] font-semibold text-[#0B0B0B]">
                    QR payment
                  </div>
                  <div className="text-[12px] text-[#666666]">
                    Accept in person or online.
                  </div>
                </div>
              </div>

              <div className="flex items-center gap-4 rounded-2xl bg-white p-4 shadow-2xs">
                <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-[#F8F6F3] text-[#0B0B0B]">
                  <svg
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    className="h-4 w-4"
                  >
                    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                    <polyline points="14 2 14 8 20 8" />
                    <line x1="8" y1="13" x2="16" y2="13" />
                    <line x1="8" y1="17" x2="13" y2="17" />
                  </svg>
                </span>
                <div>
                  <div className="text-[14px] font-semibold text-[#0B0B0B]">
                    Invoice
                  </div>
                  <div className="text-[12px] text-[#666666]">
                    Send a professional invoice in seconds.
                  </div>
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* 9. LOVED BY PEOPLE LIKE YOU */}
        <section className="mx-auto max-w-[1200px] px-5 py-12 sm:px-8 lg:py-16">
          <div className="grid items-center gap-8 border-b border-[#E6E2DA] pb-14 lg:grid-cols-12">
            <div className="lg:col-span-5">
              <div className="text-[11px] font-bold uppercase tracking-[0.18em] text-[#FF1A1A]">
                LOVED BY PEOPLE LIKE YOU
              </div>
              <h2 className="mt-2.5 font-serif text-[30px] font-normal leading-[1.15] tracking-[-0.02em] text-[#0B0B0B] sm:text-[36px]">
                Trusted by creators,
                <br />
                freelancers, and
                <br />
                businesses worldwide.
              </h2>
            </div>

            <div className="flex flex-col justify-between gap-6 sm:flex-row sm:items-center lg:col-span-7">
              <div className="max-w-[460px]">
                <p className="text-[16px] leading-[1.6] text-[#1F1F1F] sm:text-[18px]">
                  &ldquo;{activeTestimonial.quote}&rdquo;
                </p>
                <div className="mt-5 flex items-center gap-3">
                  <img
                    src="/assets/amara-avatar.png"
                    alt={activeTestimonial.name}
                    className="h-10 w-10 rounded-full object-cover"
                  />
                  <div>
                    <div className="text-[14px] font-semibold text-[#0B0B0B]">
                      {activeTestimonial.name}
                    </div>
                    <div className="text-[12px] text-[#666666]">
                      {activeTestimonial.role}
                    </div>
                  </div>
                </div>
              </div>

              <div className="flex items-center gap-2.5 self-start sm:self-center">
                <button
                  type="button"
                  aria-label="Previous testimonial"
                  onClick={() =>
                    setTestimonialIdx(
                      (i) =>
                        (i - 1 + TESTIMONIALS.length) % TESTIMONIALS.length,
                    )
                  }
                  className="flex h-10 w-10 items-center justify-center rounded-full border border-[#DCD8D0] bg-white text-[#0B0B0B] transition hover:border-[#0B0B0B]"
                >
                  ←
                </button>
                <button
                  type="button"
                  aria-label="Next testimonial"
                  onClick={() =>
                    setTestimonialIdx((i) => (i + 1) % TESTIMONIALS.length)
                  }
                  className="flex h-10 w-10 items-center justify-center rounded-full bg-[#0B0B0B] text-white transition hover:bg-[#1F1F1F]"
                >
                  →
                </button>
              </div>
            </div>
          </div>
        </section>

        {/* 10. FAQ */}
        <section
          id="faq"
          className="mx-auto max-w-[1200px] px-5 pb-16 pt-2 sm:px-8 lg:pb-20"
        >
          <div className="flex items-end justify-between pb-6">
            <div>
              <div className="text-[11px] font-bold uppercase tracking-[0.18em] text-[#FF1A1A]">
                FAQ
              </div>
              <h2 className="mt-2 font-serif text-[30px] font-normal leading-[1.15] text-[#0B0B0B] sm:text-[36px]">
                Frequently asked questions.
              </h2>
            </div>
            <a
              href="#faq"
              className="hidden items-center gap-1.5 text-[13px] font-semibold text-[#0B0B0B] hover:text-[#FF1A1A] sm:inline-flex"
            >
              <span>View all FAQs</span>
              <span aria-hidden="true">→</span>
            </a>
          </div>

          <div className="divide-y divide-[#E4E0D8] border-y border-[#E4E0D8]">
            {FAQS.map((item, idx) => {
              const isOpen = openFaq === idx;
              return (
                <div key={item.q}>
                  <button
                    type="button"
                    onClick={() => setOpenFaq(isOpen ? null : idx)}
                    className="flex w-full items-center justify-between py-4 text-left text-[14px] font-semibold text-[#0B0B0B] transition hover:text-[#FF1A1A] sm:text-[15px]"
                  >
                    <span>{item.q}</span>
                    <span className="ml-4 text-[18px] font-normal text-[#555555]">
                      {isOpen ? "−" : "+"}
                    </span>
                  </button>
                  {isOpen && (
                    <div className="pb-4 pr-8 text-[14px] leading-[1.6] text-[#555555]">
                      {item.a}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </section>

        {/* 11. FINAL CTA BANNER */}
        <section className="mx-auto max-w-[1200px] px-5 pb-16 sm:px-8">
          <div className="grid items-center overflow-hidden rounded-[28px] bg-[#0B0B0B] text-white md:grid-cols-12">
            <div className="p-8 sm:p-12 md:col-span-6">
              <h2 className="font-serif text-[32px] font-normal leading-[1.1] text-white sm:text-[40px]">
                Start getting paid
                <br />
                with FLOW.
              </h2>
              <p className="mt-3 max-w-[340px] text-[13px] leading-[1.6] text-white/65 sm:text-[14px]">
                Join individuals and businesses around the world who get paid on
                their terms.
              </p>
              <div className="mt-6 flex flex-wrap items-center gap-3">
                <Link
                  href="/sign-in"
                  className="inline-flex h-11 items-center justify-center gap-2 rounded-full bg-white px-6 text-[13px] font-semibold text-[#0B0B0B] transition hover:bg-white/90"
                >
                  <span>Get Started</span>
                  <span aria-hidden="true">→</span>
                </Link>
                <Link
                  href="/sign-in"
                  className="inline-flex h-11 items-center justify-center rounded-full border border-white/25 px-6 text-[13px] font-semibold text-white transition hover:border-white"
                >
                  Sign In
                </Link>
              </div>
            </div>

            <div className="flex h-full items-end justify-end md:col-span-6">
              <img
                src="/assets/cta-phone-angled.png"
                alt="FLOW smartphone preview"
                className="h-auto w-full max-w-[520px] object-cover"
              />
            </div>
          </div>
        </section>
      </main>

      {/* 12. FOOTER */}
      <footer className="border-t border-[#E6E2DA] bg-[#F8F6F3] py-12">
        <div className="mx-auto flex max-w-[1200px] flex-col justify-between gap-8 px-5 sm:flex-row sm:items-start sm:px-8">
          <div>
            <FlowLogo className="h-6 w-auto" />
          </div>

          <div className="grid grid-cols-3 gap-10 text-[12px] sm:gap-16">
            <div>
              <div className="font-semibold text-[#0B0B0B]">Product</div>
              <ul className="mt-2.5 space-y-1.5 text-[#666666]">
                <li>
                  <a href="#experience" className="hover:text-[#0B0B0B]">
                    Overview
                  </a>
                </li>
                <li>
                  <a href="#real-life" className="hover:text-[#0B0B0B]">
                    Use Cases
                  </a>
                </li>
                <li>
                  <a href="#faq" className="hover:text-[#0B0B0B]">
                    Pricing
                  </a>
                </li>
              </ul>
            </div>
            <div>
              <div className="font-semibold text-[#0B0B0B]">Resources</div>
              <ul className="mt-2.5 space-y-1.5 text-[#666666]">
                <li>
                  <a href="#get-paid-anywhere" className="hover:text-[#0B0B0B]">
                    Blog
                  </a>
                </li>
                <li>
                  <a href="#get-paid-anywhere" className="hover:text-[#0B0B0B]">
                    Guides
                  </a>
                </li>
                <li>
                  <a href="#faq" className="hover:text-[#0B0B0B]">
                    Help
                  </a>
                </li>
              </ul>
            </div>
            <div>
              <div className="font-semibold text-[#0B0B0B]">Company</div>
              <ul className="mt-2.5 space-y-1.5 text-[#666666]">
                <li>
                  <a href="#experience" className="hover:text-[#0B0B0B]">
                    About
                  </a>
                </li>
                <li>
                  <a href="#real-life" className="hover:text-[#0B0B0B]">
                    Careers
                  </a>
                </li>
                <li>
                  <Link href="/sign-in" className="hover:text-[#0B0B0B]">
                    Contact
                  </Link>
                </li>
              </ul>
            </div>
          </div>

          <div className="flex items-center gap-4 text-[#0B0B0B]">
            <a
              href="#top"
              aria-label="X"
              className="text-[13px] font-bold hover:text-[#FF1A1A]"
            >
              𝕏
            </a>
            <a
              href="#top"
              aria-label="Instagram"
              className="hover:text-[#FF1A1A]"
            >
              <svg
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                className="h-4 w-4"
              >
                <rect x="2" y="2" width="20" height="20" rx="5" />
                <circle cx="12" cy="12" r="4" />
                <circle cx="17.5" cy="6.5" r="1" fill="currentColor" />
              </svg>
            </a>
            <a
              href="#top"
              aria-label="LinkedIn"
              className="text-[12px] font-bold hover:text-[#FF1A1A]"
            >
              in
            </a>
          </div>
        </div>
      </footer>
    </div>
  );
}

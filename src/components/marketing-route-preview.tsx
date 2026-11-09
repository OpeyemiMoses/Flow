"use client";

import { useState } from "react";
import {
  AssetAvatar,
  ChainBadge,
  IconLock,
  IconShield,
  IconSwap,
} from "./icons.tsx";

interface RouteOption {
  readonly id: string;
  readonly symbol: string;
  readonly name: string;
  readonly networkKey: string;
  readonly networkLabel: string;
  readonly standard: string;
}

const SOURCE_OPTIONS: readonly [RouteOption, ...RouteOption[]] = [
  {
    id: "base-usdc",
    symbol: "USDC",
    name: "USD Coin",
    networkKey: "base-mainnet",
    networkLabel: "Base (EVM)",
    standard: "ERC-20",
  },
  {
    id: "eth-eth",
    symbol: "ETH",
    name: "Ether",
    networkKey: "ethereum-mainnet",
    networkLabel: "Ethereum",
    standard: "Native",
  },
  {
    id: "sol-sol",
    symbol: "SOL",
    name: "Solana",
    networkKey: "solana-mainnet",
    networkLabel: "Solana",
    standard: "Native",
  },
  {
    id: "near-near",
    symbol: "NEAR",
    name: "NEAR Protocol",
    networkKey: "near-mainnet",
    networkLabel: "NEAR",
    standard: "Native",
  },
];

const DESTINATION_OPTIONS: readonly [RouteOption, ...RouteOption[]] = [
  {
    id: "sol-usdc",
    symbol: "USDC",
    name: "USD Coin",
    networkKey: "solana-mainnet",
    networkLabel: "Solana",
    standard: "SPL",
  },
  {
    id: "near-usdc",
    symbol: "USDC",
    name: "USD Coin",
    networkKey: "near-mainnet",
    networkLabel: "NEAR",
    standard: "NEP-141",
  },
  {
    id: "base-eth",
    symbol: "ETH",
    name: "Ether",
    networkKey: "base-mainnet",
    networkLabel: "Base (EVM)",
    standard: "Native",
  },
  {
    id: "eth-usdt",
    symbol: "USDT",
    name: "Tether USD",
    networkKey: "ethereum-mainnet",
    networkLabel: "Ethereum",
    standard: "ERC-20",
  },
];

export function MarketingRoutePreview() {
  const [sourceId, setSourceId] = useState<string>(SOURCE_OPTIONS[0].id);
  const [destId, setDestId] = useState<string>(DESTINATION_OPTIONS[0].id);

  const source: RouteOption =
    SOURCE_OPTIONS.find((item) => item.id === sourceId) ?? SOURCE_OPTIONS[0];
  const dest: RouteOption =
    DESTINATION_OPTIONS.find((item) => item.id === destId) ??
    DESTINATION_OPTIONS[0];

  return (
    <div className="flow-card relative overflow-hidden p-6 sm:p-7">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[var(--border-subtle)] pb-4">
        <div>
          <span className="text-[11px] font-bold uppercase tracking-wider text-[#FF1A1A]">
            Cross-Chain Routing Model
          </span>
          <h2 className="mt-0.5 text-lg font-bold text-[var(--text-primary)]">
            Sender &amp; Recipient Asset Decoupling
          </h2>
        </div>
        <span className="inline-flex items-center gap-1.5 rounded-[4px] border border-neutral-200 bg-neutral-50 dark:bg-neutral-900 dark:border-neutral-800 px-2.5 py-1 text-[11px] font-semibold text-neutral-800 dark:text-neutral-300">
          <IconLock size={12} />
          Interactive Preview · Execution Disabled
        </span>
      </div>

      <div className="mt-5 space-y-3">
        {/* Sender Source Box */}
        <div className="rounded-[12px] border border-[var(--border-subtle)] bg-[var(--surface-subtle)]/70 p-4">
          <div className="flex items-center justify-between text-xs font-semibold text-[var(--text-muted)]">
            <span>1. Sender Chooses Source Network &amp; Asset</span>
            <span className="rounded-[4px] bg-[var(--surface-card)] px-2 py-0.5 text-[11px] font-mono text-[var(--text-secondary)] border border-[var(--border-subtle)]">
              {source.standard}
            </span>
          </div>
          <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-3">
              <AssetAvatar symbol={source.symbol} size={38} />
              <div>
                <div className="flex items-center gap-2">
                  <span className="font-display text-base font-bold text-[var(--text-primary)]">
                    {source.symbol}
                  </span>
                  <span className="inline-flex items-center gap-1 rounded-full bg-[var(--surface-card)] px-2 py-0.5 text-xs font-medium text-[var(--text-secondary)] border border-[var(--border-subtle)]">
                    <ChainBadge chainKey={source.networkKey} size={14} />
                    {source.networkLabel}
                  </span>
                </div>
                <p className="text-xs text-[var(--text-muted)]">
                  {source.name} · Source debited from sender wallet
                </p>
              </div>
            </div>

            <label className="sr-only" htmlFor="preview-source-select">
              Select sender source asset and network
            </label>
            <select
              id="preview-source-select"
              value={sourceId}
              onChange={(e) => setSourceId(e.target.value)}
              className="flow-input px-3 py-2 text-xs font-semibold"
            >
              {SOURCE_OPTIONS.map((opt) => (
                <option key={opt.id} value={opt.id}>
                  {opt.symbol} on {opt.networkLabel}
                </option>
              ))}
            </select>
          </div>
        </div>

        {/* Center Route Connector */}
        <div className="relative flex items-center justify-center py-0.5">
          <div className="h-px w-full bg-[var(--border-subtle)]" />
          <div className="absolute inline-flex items-center gap-1.5 rounded-full border border-neutral-300 bg-[var(--surface-card)] px-3 py-1 text-[11px] font-semibold text-[#0B0B0B] dark:text-white shadow-xs">
            <IconSwap size={13} className="text-[#FF1A1A]" />
            {source.networkLabel} ({source.symbol}) → {dest.networkLabel} (
            {dest.symbol})
          </div>
        </div>

        {/* Recipient Destination Box */}
        <div className="rounded-[12px] border border-[var(--border-subtle)] bg-[var(--surface-subtle)]/70 p-4">
          <div className="flex items-center justify-between text-xs font-semibold text-[var(--text-muted)]">
            <span>
              2. Recipient Chooses Destination Network &amp; Settlement Asset
            </span>
            <span className="rounded-[4px] bg-[var(--surface-card)] px-2 py-0.5 text-[11px] font-mono text-[var(--text-secondary)] border border-[var(--border-subtle)]">
              {dest.standard}
            </span>
          </div>
          <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-3">
              <AssetAvatar symbol={dest.symbol} size={38} />
              <div>
                <div className="flex items-center gap-2">
                  <span className="font-display text-base font-bold text-[var(--text-primary)]">
                    {dest.symbol}
                  </span>
                  <span className="inline-flex items-center gap-1 rounded-full bg-[var(--surface-card)] px-2 py-0.5 text-xs font-medium text-[var(--text-secondary)] border border-[var(--border-subtle)]">
                    <ChainBadge chainKey={dest.networkKey} size={14} />
                    {dest.networkLabel}
                  </span>
                </div>
                <p className="text-xs text-[var(--text-muted)]">
                  {dest.name} · Target settlement preference
                </p>
              </div>
            </div>

            <label className="sr-only" htmlFor="preview-dest-select">
              Select recipient destination asset and network
            </label>
            <select
              id="preview-dest-select"
              value={destId}
              onChange={(e) => setDestId(e.target.value)}
              className="flow-input px-3 py-2 text-xs font-semibold"
            >
              {DESTINATION_OPTIONS.map((opt) => (
                <option key={opt.id} value={opt.id}>
                  {opt.symbol} on {opt.networkLabel}
                </option>
              ))}
            </select>
          </div>
        </div>
      </div>

      {/* Truthful Route Status Strip */}
      <div className="mt-4 rounded-[10px] border border-[var(--border-subtle)] bg-[var(--surface-card)] p-3.5 text-xs">
        <div className="flex items-center justify-between py-1">
          <span className="text-[var(--text-muted)]">Selected Route Path</span>
          <span className="font-semibold text-[var(--text-primary)]">
            {source.symbol} ({source.networkLabel}) → {dest.symbol} (
            {dest.networkLabel})
          </span>
        </div>
        <div className="flex items-center justify-between py-1 border-t border-[var(--border-subtle)]">
          <span className="text-[var(--text-muted)]">
            Settlement Foundation
          </span>
          <span className="font-mono text-[11px] text-[#FF1A1A] font-semibold">
            Double-entry ledger &amp; guest checkout
          </span>
        </div>
        <div className="flex items-center justify-between py-1 border-t border-[var(--border-subtle)]">
          <span className="text-[var(--text-muted)]">
            Deposit Issuance &amp; Lifecycle
          </span>
          <span className="inline-flex items-center gap-1 font-semibold text-[#0B0B0B] dark:text-neutral-200">
            <IconShield size={13} className="text-[#FF1A1A]" />
            Deterministic Staged Instructions
          </span>
        </div>
      </div>
    </div>
  );
}

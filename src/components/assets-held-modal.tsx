"use client";

import { useState } from "react";
import type { CatalogTokenDeployment } from "../domain/supported-assets-catalog.ts";
import type { SerializedWalletBalanceRecord } from "../server/portfolio.ts";
import { AssetAvatar, ChainBadge } from "./icons.tsx";

export interface HeldAssetItem {
  deployment: CatalogTokenDeployment;
  balanceRecord?: SerializedWalletBalanceRecord;
  displayBalance: string;
  usdValue: string;
}

export interface AssetsHeldModalProps {
  isOpen: boolean;
  onClose: () => void;
  heldAssets: HeldAssetItem[];
  totalBalanceUsd: string;
  onSelectAction: (
    action: "receive" | "send" | "swap_near",
    deployment: CatalogTokenDeployment,
  ) => void;
}

export function AssetsHeldModal({
  isOpen,
  onClose,
  heldAssets,
  totalBalanceUsd,
  onSelectAction,
}: AssetsHeldModalProps) {
  const [expandedAssetId, setExpandedAssetId] = useState<string | null>(
    heldAssets.length > 0 ? (heldAssets[0]?.deployment.id ?? null) : null,
  );

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 overflow-y-auto">
      {/* Backdrop */}
      <div
        className="fixed inset-0 bg-neutral-950/40 backdrop-blur-xs transition-opacity animate-in fade-in"
        onClick={onClose}
      />

      <div className="flex min-h-full items-center justify-center p-4">
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="assets-held-title"
          className="relative w-full max-w-md rounded-[28px] bg-white dark:bg-[#141414] border border-neutral-200/90 dark:border-neutral-800 shadow-2xl p-6 overflow-hidden animate-in zoom-in-95 duration-150"
        >
          {/* Header (Matches ChatGPT Image Nov 12, 2026, 05_23_23 AM-2.png) */}
          <div className="flex items-start justify-between pb-4">
            <div>
              <h2
                id="assets-held-title"
                className="text-xl font-bold tracking-tight text-neutral-950 dark:text-white"
              >
                Your assets
              </h2>
              <p className="text-xs text-neutral-500 dark:text-neutral-400 mt-1">
                Only assets currently held in Flow are shown here.
              </p>
            </div>
            <button
              type="button"
              onClick={onClose}
              aria-label="Close assets modal"
              className="p-1.5 rounded-full text-neutral-400 hover:text-neutral-950 dark:hover:text-white hover:bg-neutral-100 dark:hover:bg-neutral-800 transition-colors"
            >
              <svg
                width="18"
                height="18"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <line x1="18" y1="6" x2="6" y2="18" />
                <line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            </button>
          </div>

          {/* Assets List */}
          <div className="space-y-3 my-2">
            {heldAssets.length === 0 ? (
              <div className="py-8 text-center text-xs text-neutral-400">
                No positive balances currently held in Flow.
              </div>
            ) : (
              heldAssets.map((item) => {
                const isExpanded = expandedAssetId === item.deployment.id;
                return (
                  <div
                    key={item.deployment.id}
                    className="rounded-[22px] border border-neutral-200/80 dark:border-neutral-800 bg-[#FAFAFA] dark:bg-[#181818] p-4 transition-all"
                  >
                    <div
                      className="flex items-center justify-between cursor-pointer select-none"
                      onClick={() =>
                        setExpandedAssetId(
                          isExpanded ? null : item.deployment.id,
                        )
                      }
                    >
                      <div className="flex items-center gap-3">
                        <div className="relative">
                          <AssetAvatar
                            symbol={item.deployment.symbol}
                            size={36}
                          />
                          <div className="absolute -bottom-1 -right-1">
                            <ChainBadge
                              chainKey={item.deployment.networkKey}
                              size={14}
                            />
                          </div>
                        </div>
                        <div>
                          <p className="text-sm font-bold text-neutral-950 dark:text-white">
                            {item.deployment.symbol}
                          </p>
                          <p className="text-[11px] text-neutral-500 dark:text-neutral-400">
                            {item.deployment.networkName}
                          </p>
                        </div>
                      </div>

                      <div className="flex items-center gap-2">
                        <div className="text-right">
                          <p className="text-sm font-bold font-mono text-neutral-950 dark:text-white">
                            {item.displayBalance} {item.deployment.symbol}
                          </p>
                          <p className="text-[11px] text-neutral-500 dark:text-neutral-400">
                            {item.usdValue}
                          </p>
                        </div>
                        <svg
                          width="14"
                          height="14"
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="2.5"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          className={`text-neutral-400 transition-transform ${isExpanded ? "rotate-180" : ""}`}
                        >
                          <polyline points="6 9 12 15 18 9" />
                        </svg>
                      </div>
                    </div>

                    {/* Action Buttons (Matches ChatGPT Image Nov 12, 2026, 05_23_23 AM-2.png) */}
                    {isExpanded && (
                      <div className="mt-4 pt-3 border-t border-neutral-200/60 dark:border-neutral-800 grid grid-cols-3 gap-2">
                        <button
                          type="button"
                          onClick={() => {
                            onSelectAction("receive", item.deployment);
                            onClose();
                          }}
                          className="flex items-center justify-center gap-1.5 py-2 px-2.5 rounded-full text-xs font-semibold bg-white hover:bg-neutral-100 text-neutral-900 border border-neutral-200/80 dark:bg-neutral-800 dark:text-white dark:border-neutral-700 shadow-2xs transition-colors"
                        >
                          <span>↓</span>
                          <span>Receive</span>
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            onSelectAction("send", item.deployment);
                            onClose();
                          }}
                          className="flex items-center justify-center gap-1.5 py-2 px-2.5 rounded-full text-xs font-semibold bg-white hover:bg-neutral-100 text-neutral-900 border border-neutral-200/80 dark:bg-neutral-800 dark:text-white dark:border-neutral-700 shadow-2xs transition-colors"
                        >
                          <span>↗</span>
                          <span>Send</span>
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            onSelectAction("swap_near", item.deployment);
                            onClose();
                          }}
                          className="flex items-center justify-center gap-1.5 py-2 px-2 rounded-full text-xs font-semibold bg-neutral-950 text-white dark:bg-white dark:text-neutral-950 shadow-xs hover:opacity-90 transition-opacity whitespace-nowrap"
                        >
                          <span>⇄</span>
                          <span>Swap to NEAR</span>
                        </button>
                      </div>
                    )}
                  </div>
                );
              })
            )}
          </div>

          {/* Footer Note */}
          <div className="pt-3 border-t border-neutral-100 dark:border-neutral-800 flex items-center justify-between text-[11px] text-neutral-400">
            <span className="flex items-center gap-1">
              <span>ⓘ</span>
              <span>Wrapped assets are not shown.</span>
            </span>
            <span className="font-semibold text-neutral-600 dark:text-neutral-300">
              Total: {totalBalanceUsd}
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}

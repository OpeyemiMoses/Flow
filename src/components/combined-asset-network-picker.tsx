"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { AssetAvatar, ChainBadge } from "./icons.tsx";
import {
  type CatalogTokenDeployment,
  MAINNET_SUPPORTED_DEPLOYMENTS,
} from "../domain/supported-assets-catalog.ts";

export interface CombinedAssetNetworkPickerProps {
  readonly options?: readonly CatalogTokenDeployment[];
  readonly selectedId: string;
  readonly onSelect: (deployment: CatalogTokenDeployment) => void;
  readonly label?: string;
  readonly placeholder?: string;
  readonly disabled?: boolean;
  readonly className?: string;
  readonly id?: string;
  readonly ariaLabel?: string;
}

export function CombinedAssetNetworkPicker({
  options = MAINNET_SUPPORTED_DEPLOYMENTS,
  selectedId,
  onSelect,
  label,
  placeholder = "Select asset and network",
  disabled = false,
  className = "",
  id,
  ariaLabel,
}: CombinedAssetNetworkPickerProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const containerRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);

  const selectedDeployment = useMemo(() => {
    return options.find((opt) => opt.id === selectedId) ?? null;
  }, [options, selectedId]);

  const filteredOptions = useMemo(() => {
    const q = searchQuery.toLowerCase().trim();
    if (!q) return options;
    return options.filter(
      (opt) =>
        opt.symbol.toLowerCase().includes(q) ||
        opt.name.toLowerCase().includes(q) ||
        opt.networkName.toLowerCase().includes(q) ||
        opt.networkKey.toLowerCase().includes(q),
    );
  }, [options, searchQuery]);

  // Handle click outside to close dropdown
  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (
        containerRef.current &&
        !containerRef.current.contains(event.target as Node)
      ) {
        setIsOpen(false);
      }
    }
    if (isOpen) {
      document.addEventListener("mousedown", handleClickOutside);
      // Auto focus search input when opened
      setTimeout(() => searchInputRef.current?.focus(), 50);
    }
    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
    };
  }, [isOpen]);

  // Handle escape key
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape" && isOpen) {
        setIsOpen(false);
      }
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isOpen]);

  return (
    <div ref={containerRef} className={`relative ${className}`}>
      {label && (
        <label
          htmlFor={id}
          className="block text-xs font-semibold text-neutral-800 dark:text-neutral-200 mb-1.5"
        >
          {label}
        </label>
      )}

      {/* Trigger Button */}
      <button
        id={id}
        type="button"
        disabled={disabled}
        onClick={() => setIsOpen((prev) => !prev)}
        aria-label={
          ariaLabel ??
          (selectedDeployment
            ? `${selectedDeployment.symbol} on ${selectedDeployment.networkName}`
            : placeholder)
        }
        aria-expanded={isOpen}
        className={`w-full flex items-center justify-between gap-3 px-4 py-3 rounded-2xl border text-left transition-all ${
          isOpen
            ? "border-neutral-950 dark:border-white ring-2 ring-neutral-950/10 dark:ring-white/10 bg-white dark:bg-[#1a1a1a]"
            : "border-neutral-200/90 dark:border-neutral-800 bg-white dark:bg-[#141414] hover:border-neutral-300 dark:hover:border-neutral-700 shadow-2xs"
        } ${disabled ? "opacity-50 cursor-not-allowed" : "cursor-pointer"}`}
      >
        {selectedDeployment ? (
          <div className="flex items-center gap-3 min-w-0">
            <div className="relative shrink-0">
              <AssetAvatar symbol={selectedDeployment.symbol} size={32} />
              <div className="absolute -bottom-1 -right-1">
                <ChainBadge
                  chainKey={selectedDeployment.networkKey}
                  size={14}
                />
              </div>
            </div>
            <div className="min-w-0">
              <div className="font-display font-bold text-sm text-neutral-950 dark:text-white leading-tight">
                {selectedDeployment.symbol}
              </div>
              <div className="text-[11px] text-neutral-500 dark:text-neutral-400 truncate">
                {selectedDeployment.networkName}
              </div>
            </div>
          </div>
        ) : (
          <span className="text-xs text-neutral-400 dark:text-neutral-500">
            {placeholder}
          </span>
        )}

        <div className="shrink-0 text-neutral-400 dark:text-neutral-500">
          <svg
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.5"
            strokeLinecap="round"
            strokeLinejoin="round"
            className={`transition-transform duration-200 ${isOpen ? "rotate-180" : ""}`}
          >
            <polyline points="6 9 12 15 18 9" />
          </svg>
        </div>
      </button>

      {/* Popover Dropdown */}
      {isOpen && (
        <div className="absolute left-0 top-full mt-2 w-full z-50 rounded-2xl border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-[#141414] shadow-xl overflow-hidden animate-in fade-in duration-150">
          {/* Search Box */}
          <div className="p-2.5 border-b border-neutral-100 dark:border-neutral-800 bg-neutral-50/50 dark:bg-neutral-900/50">
            <div className="relative flex items-center">
              <svg
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                className="absolute left-3 text-neutral-400"
              >
                <circle cx="11" cy="11" r="8" />
                <line x1="21" y1="21" x2="16.65" y2="16.65" />
              </svg>
              <input
                ref={searchInputRef}
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Search token or network..."
                className="w-full pl-9 pr-3 py-2 rounded-xl text-xs bg-white dark:bg-[#1c1c1c] border border-neutral-200 dark:border-neutral-700 text-neutral-950 dark:text-white placeholder:text-neutral-400 focus:outline-hidden focus:border-neutral-900 dark:focus:border-neutral-400"
              />
            </div>
          </div>

          {/* Options List */}
          <div className="max-h-64 overflow-y-auto p-1.5 space-y-0.5">
            {filteredOptions.length === 0 ? (
              <div className="p-4 text-center text-xs text-neutral-500">
                No matching tokens or networks found.
              </div>
            ) : (
              filteredOptions.map((opt) => {
                const isSelected = opt.id === selectedId;
                return (
                  <button
                    key={opt.id}
                    type="button"
                    onClick={() => {
                      onSelect(opt);
                      setIsOpen(false);
                      setSearchQuery("");
                    }}
                    className={`w-full flex items-center justify-between p-2.5 rounded-xl text-left transition-colors cursor-pointer ${
                      isSelected
                        ? "bg-neutral-100 dark:bg-neutral-800 text-neutral-950 dark:text-white"
                        : "hover:bg-neutral-50 dark:hover:bg-neutral-800/60 text-neutral-800 dark:text-neutral-200"
                    }`}
                  >
                    <div className="flex items-center gap-3 min-w-0">
                      <div className="relative shrink-0">
                        <AssetAvatar symbol={opt.symbol} size={28} />
                        <div className="absolute -bottom-1 -right-1">
                          <ChainBadge chainKey={opt.networkKey} size={12} />
                        </div>
                      </div>
                      <div className="min-w-0">
                        <div className="font-display font-semibold text-xs text-neutral-950 dark:text-white leading-tight">
                          {opt.symbol}{" "}
                          <span className="font-normal text-[11px] text-neutral-500 dark:text-neutral-400">
                            · {opt.name}
                          </span>
                        </div>
                        <div className="text-[10px] text-neutral-500 dark:text-neutral-400 truncate">
                          {opt.networkName}
                        </div>
                      </div>
                    </div>

                    {isSelected && (
                      <span className="text-[#FF1A1A] font-bold text-xs shrink-0">
                        ✓
                      </span>
                    )}
                  </button>
                );
              })
            )}
          </div>
        </div>
      )}
    </div>
  );
}

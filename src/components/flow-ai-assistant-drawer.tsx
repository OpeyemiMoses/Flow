"use client";

import { useEffect, useRef, useState } from "react";
import type { AssistantMessage } from "../server/ai-assistant-service.ts";

export interface FlowAIAssistantDrawerProps {
  isOpen: boolean;
  onClose: () => void;
  accountId: string;
  onNavigateToTab?: (
    tab: "dashboard" | "send" | "receive" | "request" | "activity",
  ) => void;
  onCreatePaymentLinkDraft?: (draft: {
    title?: string;
    amount?: string;
    assetSymbol?: string;
    network?: string;
  }) => void;
}

export function FlowAIAssistantDrawer({
  isOpen,
  onClose,
  accountId,
  onNavigateToTab,
  onCreatePaymentLinkDraft,
}: FlowAIAssistantDrawerProps) {
  const [messages, setMessages] = useState<AssistantMessage[]>([
    {
      id: "welcome",
      role: "assistant",
      content:
        "Hello! I am your Flow Assistant. I can check your genuine on-chain balances, discover token routes across 35+ chains via NEAR Intents, look up payment status, or draft payment links for you.",
      timestamp: new Date().toISOString(),
    },
  ]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  };

  useEffect(() => {
    if (isOpen) {
      scrollToBottom();
    }
  }, [isOpen, messages]);

  const handleSend = async (queryText?: string) => {
    const text = queryText ?? input.trim();
    if (!text || loading) return;

    const userMsg: AssistantMessage = {
      id: `user-${Date.now()}`,
      role: "user",
      content: text,
      timestamp: new Date().toISOString(),
    };

    setMessages((prev) => [...prev, userMsg]);
    if (!queryText) setInput("");
    setLoading(true);

    try {
      const res = await fetch(`/api/accounts/${accountId}/ai-assistant`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt: text }),
      });

      const data = await res.json();
      if (data.ok && data.message) {
        setMessages((prev) => [...prev, data.message]);
      } else {
        setMessages((prev) => [
          ...prev,
          {
            id: `err-${Date.now()}`,
            role: "assistant",
            content:
              data.error ||
              "Sorry, I could not complete your request. Please try again.",
            timestamp: new Date().toISOString(),
          },
        ]);
      }
    } catch {
      setMessages((prev) => [
        ...prev,
        {
          id: `err-${Date.now()}`,
          role: "assistant",
          content: "Network connection error. Please try again in a moment.",
          timestamp: new Date().toISOString(),
        },
      ]);
    } finally {
      setLoading(false);
    }
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 overflow-hidden">
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-neutral-950/40 backdrop-blur-xs transition-opacity animate-in fade-in"
        onClick={onClose}
      />

      <div className="fixed inset-y-0 right-0 max-w-full flex pl-10">
        <aside
          aria-label="Flow AI assistant drawer"
          className="w-screen max-w-md bg-white dark:bg-[#141414] border-l border-neutral-200 dark:border-neutral-800 shadow-2xl flex flex-col animate-in slide-in-from-right duration-200"
        >
          {/* Header */}
          <div className="p-5 border-b border-neutral-100 dark:border-neutral-800 flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="h-9 w-9 rounded-2xl bg-gradient-to-tr from-amber-500 to-rose-500 text-white flex items-center justify-center font-bold shadow-xs">
                ✨
              </div>
              <div>
                <div className="flex items-center gap-2">
                  <h2 className="text-sm font-bold text-neutral-950 dark:text-white">
                    Flow AI Assistant
                  </h2>
                  <span className="flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold bg-emerald-50 dark:bg-emerald-950/40 text-emerald-700 dark:text-emerald-400 border border-emerald-200/60 dark:border-emerald-800/40">
                    <span className="h-1.5 w-1.5 rounded-full bg-emerald-500 animate-pulse" />
                    Online
                  </span>
                </div>
                <p className="text-[11px] text-neutral-500 dark:text-neutral-400">
                  NEAR Intents &amp; Read-Only Assistant
                </p>
              </div>
            </div>
            <button
              type="button"
              onClick={onClose}
              aria-label="Close assistant drawer"
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

          {/* Messages Container */}
          <div className="flex-1 overflow-y-auto p-4 space-y-4">
            {messages.map((msg, idx) => (
              <div
                key={msg.id ?? idx}
                className={`flex flex-col ${
                  msg.role === "user" ? "items-end" : "items-start"
                }`}
              >
                <div
                  className={`max-w-[88%] rounded-2xl p-3.5 text-xs leading-relaxed ${
                    msg.role === "user"
                      ? "bg-neutral-950 text-white dark:bg-white dark:text-neutral-950 rounded-br-xs shadow-xs"
                      : "bg-neutral-100 dark:bg-neutral-800/80 text-neutral-900 dark:text-neutral-100 rounded-bl-xs"
                  }`}
                >
                  <p className="whitespace-pre-wrap">{msg.content}</p>

                  {/* Structured Action Card */}
                  {msg.card && (
                    <div className="mt-3 p-3 rounded-xl bg-white dark:bg-[#1a1a1a] border border-neutral-200/80 dark:border-neutral-700/80 text-neutral-900 dark:text-white shadow-xs">
                      {msg.card.type === "BALANCE_SUMMARY" && (
                        <div>
                          <p className="font-bold text-[11px] uppercase tracking-wider text-neutral-400 mb-2">
                            Verified Balances
                          </p>
                          <div className="space-y-1.5">
                            {Array.isArray(msg.card.data?.balances) &&
                              msg.card.data.balances.map(
                                (
                                  b: {
                                    asset?: string;
                                    balance?: string;
                                    usd?: string;
                                  },
                                  bIdx: number,
                                ) => (
                                  <div
                                    key={bIdx}
                                    className="flex items-center justify-between text-xs py-1 border-b border-neutral-100 dark:border-neutral-800 last:border-0"
                                  >
                                    <span className="font-semibold">
                                      {b.asset}
                                    </span>
                                    <span className="font-mono">
                                      {b.balance}
                                    </span>
                                  </div>
                                ),
                              )}
                          </div>
                          {onNavigateToTab && (
                            <button
                              type="button"
                              onClick={() => {
                                onNavigateToTab("receive");
                                onClose();
                              }}
                              className="mt-2.5 w-full py-1.5 text-center text-xs font-semibold rounded-lg bg-neutral-900 text-white dark:bg-neutral-100 dark:text-neutral-900"
                            >
                              + Add Money
                            </button>
                          )}
                        </div>
                      )}

                      {msg.card.type === "PREVIEW_SWAP" && (
                        <div>
                          <p className="font-bold text-[11px] uppercase tracking-wider text-neutral-400 mb-1">
                            Quote Preview
                          </p>
                          <p className="text-xs font-mono mb-2">
                            {String(msg.card.data?.route || "")}
                          </p>
                          <div className="p-2 rounded-lg bg-neutral-50 dark:bg-neutral-900 text-[11px] text-neutral-500">
                            {String(msg.card.data?.safetyNotice || "")}
                          </div>
                          {onNavigateToTab && (
                            <button
                              type="button"
                              onClick={() => {
                                onNavigateToTab("send");
                                onClose();
                              }}
                              className="mt-2 w-full py-1.5 text-center text-xs font-semibold rounded-lg bg-neutral-900 text-white dark:bg-neutral-100 dark:text-neutral-900"
                            >
                              Go to Send &amp; Transfer
                            </button>
                          )}
                        </div>
                      )}

                      {msg.card.type === "DRAFT_PAYMENT_LINK" && (
                        <div>
                          <p className="font-bold text-[11px] uppercase tracking-wider text-amber-500 mb-1">
                            Draft Payment Link
                          </p>
                          <p className="text-xs font-semibold">
                            {String(msg.card.data?.title || "")}
                          </p>
                          <p className="text-sm font-bold font-mono text-emerald-600 dark:text-emerald-400 my-1">
                            {String(msg.card.data?.amount || "")}{" "}
                            {String(msg.card.data?.assetSymbol || "")}
                          </p>
                          {onCreatePaymentLinkDraft && (
                            <button
                              type="button"
                              onClick={() => {
                                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                                onCreatePaymentLinkDraft(msg.card?.data as any);
                                onClose();
                              }}
                              className="mt-2 w-full py-1.5 text-center text-xs font-semibold rounded-lg bg-neutral-900 text-white dark:bg-neutral-100 dark:text-neutral-900"
                            >
                              Open in Payment Links
                            </button>
                          )}
                        </div>
                      )}

                      {msg.card.type === "PAYMENT_STATUS" && (
                        <div>
                          <p className="font-bold text-[11px] uppercase tracking-wider text-neutral-400 mb-1">
                            Payment Details
                          </p>
                          <div className="space-y-1 text-xs">
                            <p>
                              Status:{" "}
                              <span className="font-bold text-emerald-600">
                                {String(msg.card.data?.status || "")}
                              </span>
                            </p>
                            <p className="font-mono text-[11px] truncate">
                              ID: {String(msg.card.data?.publicId || "")}
                            </p>
                            <p className="font-mono text-[11px] truncate">
                              Tx:{" "}
                              {String(msg.card.data?.settlementTxHash || "")}
                            </p>
                          </div>
                        </div>
                      )}
                    </div>
                  )}
                </div>
                <span className="text-[10px] text-neutral-400 mt-1 px-1">
                  {new Date(msg.timestamp).toLocaleTimeString([], {
                    hour: "2-digit",
                    minute: "2-digit",
                  })}
                </span>
              </div>
            ))}

            {loading && (
              <div className="flex items-center gap-2 p-3 text-xs text-neutral-400 animate-pulse">
                <span className="h-2 w-2 rounded-full bg-amber-500" />
                Flow Assistant is researching...
              </div>
            )}
            <div ref={messagesEndRef} />
          </div>

          {/* Quick Prompts */}
          <div className="px-4 py-2 border-t border-neutral-100 dark:border-neutral-800 bg-neutral-50/50 dark:bg-neutral-900/50 flex items-center gap-1.5 overflow-x-auto no-scrollbar">
            {[
              "What is my balance?",
              "Can I pay with USDC on Base?",
              "Draft payment link for $10",
              "Check recent settlement",
            ].map((prompt, idx) => (
              <button
                key={idx}
                type="button"
                onClick={() => handleSend(prompt)}
                className="shrink-0 px-2.5 py-1 rounded-full text-[11px] font-medium bg-white dark:bg-[#1a1a1a] text-neutral-700 dark:text-neutral-300 border border-neutral-200/80 dark:border-neutral-700/80 hover:bg-neutral-100 dark:hover:bg-neutral-800 transition-colors"
              >
                {prompt}
              </button>
            ))}
          </div>

          {/* Input Bar */}
          <form
            onSubmit={(e) => {
              e.preventDefault();
              handleSend();
            }}
            className="p-4 border-t border-neutral-100 dark:border-neutral-800 flex items-center gap-2"
          >
            <input
              type="text"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder="Ask about balances, routes, tokens..."
              className="flex-1 px-4 py-2.5 rounded-full text-xs bg-neutral-100 dark:bg-neutral-800 text-neutral-950 dark:text-white border border-transparent focus:border-neutral-300 dark:focus:border-neutral-700 focus:outline-hidden transition-all"
            />
            <button
              type="submit"
              disabled={!input.trim() || loading}
              aria-label="Send query"
              className="p-2.5 rounded-full bg-neutral-950 text-white dark:bg-white dark:text-neutral-950 disabled:opacity-30 disabled:cursor-not-allowed transition-all"
            >
              <svg
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.5"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <line x1="22" y1="2" x2="11" y2="13" />
                <polygon points="22 2 15 22 11 13 2 9 22 2" />
              </svg>
            </button>
          </form>
        </aside>
      </div>
    </div>
  );
}

import type { Metadata } from "next";
import type { ReactNode } from "react";
import "./globals.css";

export const metadata: Metadata = {
  title: "FLOW",
  description: "The FLOW multi-chain payment foundation.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen bg-[var(--surface-canvas)] font-sans text-[var(--text-primary)] antialiased">
        {children}
      </body>
    </html>
  );
}

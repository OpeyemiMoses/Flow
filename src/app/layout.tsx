import type { Metadata } from "next";
import type { ReactNode } from "react";
import "./globals.css";

export const metadata: Metadata = {
  title: "FLOW",
  description: "The FLOW multi-chain payment foundation.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script
          dangerouslySetInnerHTML={{
            __html: `(function(){try{var t=localStorage.getItem("flow-theme");if(t==="dark"||(!t&&window.matchMedia("(prefers-color-scheme: dark)").matches)){document.documentElement.classList.add("dark")}else{document.documentElement.classList.remove("dark")}}catch(e){}})()`,
          }}
        />
      </head>
      <body className="min-h-screen bg-[var(--surface-canvas)] font-sans text-[var(--text-primary)] antialiased">
        {children}
      </body>
    </html>
  );
}

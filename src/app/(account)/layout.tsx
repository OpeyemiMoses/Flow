import type { ReactNode } from "react";
import { RefreshSession } from "./accounts/forms.tsx";

export const dynamic = "force-dynamic";

export default function AccountLayout({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-screen bg-[#FAF8F5] text-[#0B0B0B] dark:bg-[#0B0B0B] dark:text-white">
      <RefreshSession />
      {children}
    </div>
  );
}

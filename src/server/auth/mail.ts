import "server-only";
import type { AuthConfig } from "../../foundation/auth-environment.ts";
import { log } from "../../foundation/logger.ts";

export async function sendMail(
  config: AuthConfig,
  to: string,
  subject: string,
  text: string,
): Promise<boolean> {
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      redirect: "error",
      cache: "no-store",
      signal: AbortSignal.timeout(4_000),
      headers: {
        Authorization: `Bearer ${config.mailKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ from: config.mailFrom, to: [to], subject, text }),
    });
    await res.body?.cancel();
    if (res.ok) return true;
  } catch {
    // Delivery responses can contain email addresses or provider credentials.
  }
  log("error", "mail_delivery_failed", { code: "DELIVERY_UNAVAILABLE" });
  return false;
}

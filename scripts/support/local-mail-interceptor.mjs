import { appendFile } from "node:fs/promises";

const mailFile =
  process.env.FLOW_LOCAL_MAIL_FILE || "/tmp/flow-local-mail.jsonl";
const originalFetch = globalThis.fetch;

globalThis.fetch = async function (input, init) {
  try {
    const url = new URL(
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url,
    );
    if (url.href === "https://api.resend.com/emails") {
      const request = new Request(input, init);
      const body = await request.json();
      await appendFile(mailFile, `${JSON.stringify(body)}\n`, { mode: 0o600 });
      return Response.json({ id: "local-rehearsal-delivery" }, { status: 200 });
    }
  } catch {
    // Pass-through to original fetch if url parsing fails
  }
  return originalFetch.call(this, input, init);
};

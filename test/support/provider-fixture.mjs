import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { appendFile, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

if (
  process.env.FLOW_ENV !== "test" ||
  process.env.FLOW_GOOGLE_CLIENT_ID !==
    "000000-flow-fixture.apps.googleusercontent.com" ||
  !process.env.FLOW_PROVIDER_FIXTURE_DIR
)
  throw new Error("Provider fixture requires isolated test configuration.");

const directory = process.env.FLOW_PROVIDER_FIXTURE_DIR;
const fetchThrough = globalThis.fetch;

globalThis.fetch = async (input, init) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  if (url.href === "https://www.googleapis.com/oauth2/v3/certs") {
    return Response.json(
      JSON.parse(await readFile(path.join(directory, "jwks.json"), "utf8")),
    );
  }
  if (url.href === "https://oauth2.googleapis.com/token") {
    const request = new Request(input, init);
    const body = new URLSearchParams(await request.text());
    const code = body.get("code");
    if (!code || !/^[a-f0-9]{32}$/.test(code))
      return Response.json({ error: "invalid_grant" }, { status: 400 });
    const recordPath = path.join(directory, `code-${code}.json`);
    const spentPath = path.join(directory, `spent-${code}.json`);
    try {
      await rename(recordPath, spentPath);
      const expected = JSON.parse(await readFile(spentPath, "utf8"));
      const challenge = createHash("sha256")
        .update(body.get("code_verifier") ?? "")
        .digest("base64url");
      if (
        body.get("grant_type") !== "authorization_code" ||
        body.get("client_id") !== process.env.FLOW_GOOGLE_CLIENT_ID ||
        body.get("client_secret") !== process.env.FLOW_GOOGLE_CLIENT_SECRET ||
        body.get("redirect_uri") !== expected.redirect ||
        challenge !== expected.challenge
      )
        return Response.json({ error: "invalid_grant" }, { status: 400 });
      if (expected.pauseExchange) {
        const release = path.join(directory, `exchange-${code}.release`);
        await writeFile(path.join(directory, `exchange-${code}.waiting`), "");
        const deadline = Date.now() + 7_000;
        while (!existsSync(release) && Date.now() < deadline) await delay(10);
        if (!existsSync(release))
          return Response.json(
            { error: "temporarily_unavailable" },
            { status: 503 },
          );
      }
      return Response.json({
        access_token: expected.access,
        refresh_token: expected.refresh,
        id_token: expected.idToken,
        token_type: "Bearer",
        scope: "openid email profile",
        expires_in: 3600,
      });
    } catch {
      return Response.json({ error: "invalid_grant" }, { status: 400 });
    }
  }
  if (url.href === "https://api.resend.com/emails") {
    const request = new Request(input, init);
    if (
      request.headers.get("authorization") !==
      `Bearer ${process.env.FLOW_MAIL_API_KEY}`
    ) {
      return Response.json({ error: "invalid_credentials" }, { status: 401 });
    }
    await appendFile(
      path.join(directory, "mail.jsonl"),
      `${JSON.stringify(await request.json())}\n`,
      { mode: 0o600 },
    );
    return Response.json({ id: "fixture-delivery" });
  }
  if (["127.0.0.1", "localhost", "[::1]"].includes(url.hostname))
    return fetchThrough(input, init);
  throw new Error("Unexpected external fetch in provider fixture.");
};

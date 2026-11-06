import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import https from "node:https";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import pg from "pg";
import { chromium, request } from "playwright";

const googleId = "000000-flow-fixture.apps.googleusercontent.com";
const listen = (server) =>
  new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve(server.address().port));
  });
const close = (server) => new Promise((resolve) => server.close(resolve));

export async function securityServer() {
  assert.equal(process.env.FLOW_ENV, "test");
  assert.ok(process.env.FLOW_DATABASE_URL);
  for (const key of [
    "FLOW_MIGRATION_DATABASE_URL",
    "FLOW_POSTGRES_ADMIN_PASSWORD",
    "PGPASSWORD",
  ]) {
    assert.ok(
      !(key in process.env),
      "Test server requires the runtime credential alone",
    );
  }
  const dir = await mkdtemp(path.join(os.tmpdir(), "flow-security-"));
  const secrets = new Set();
  const observed = [];
  let serverLogs = "";
  let child;
  let browser;
  let gateway;
  let attacker;
  const clients = [];
  const db = new pg.Pool({
    connectionString: process.env.FLOW_DATABASE_URL,
    max: 4,
  });
  async function stop() {
    for (const client of clients) await client.dispose();
    if (browser) await browser.close();
    if (child && child.exitCode === null && child.signalCode === null) {
      child.kill("SIGTERM");
      await new Promise((resolve) => child.once("exit", resolve));
    }
    if (gateway) await close(gateway);
    if (attacker) await close(attacker);
    await db.end();
    await rm(dir, { recursive: true, force: true });
  }
  try {
    const key = path.join(dir, "test.key");
    const certificate = path.join(dir, "test.pem");
    execFileSync(
      "openssl",
      [
        "req",
        "-x509",
        "-newkey",
        "rsa:2048",
        "-nodes",
        "-subj",
        "/CN=localhost",
        "-days",
        "1",
        "-keyout",
        key,
        "-out",
        certificate,
      ],
      { stdio: "ignore" },
    );
    const tls = { key: await readFile(key), cert: await readFile(certificate) };
    const reservation = http.createServer();
    const appPort = await listen(reservation);
    await close(reservation);
    gateway = https.createServer(tls, (incoming, outgoing) => {
      const proxy = http.request(
        {
          hostname: "127.0.0.1",
          port: appPort,
          method: incoming.method,
          path: incoming.url,
          headers: { ...incoming.headers, "x-forwarded-proto": "https" },
        },
        (response) => {
          outgoing.writeHead(response.statusCode, response.headers);
          response.pipe(outgoing);
        },
      );
      proxy.on("error", () => {
        outgoing.writeHead(503);
        outgoing.end();
      });
      incoming.pipe(proxy);
    });
    const origin = `https://127.0.0.1:${await listen(gateway)}`;
    attacker = https.createServer(tls, (_request, response) => {
      response.writeHead(200, { "Content-Type": "text/html" });
      response.end(
        "<!doctype html><title>Cross-origin security fixture</title>",
      );
    });
    const attackOrigin = `https://127.0.0.1:${await listen(attacker)}`;
    const signing = await generateKeyPair("RS256", { extractable: true });
    const rogue = await generateKeyPair("RS256");
    const jwk = await exportJWK(signing.publicKey);
    await writeFile(
      path.join(dir, "jwks.json"),
      JSON.stringify({ keys: [{ ...jwk, kid: "fixture", alg: "RS256" }] }),
      { mode: 0o600 },
    );
    const authSecret = randomBytes(32).toString("hex");
    const otpKey = randomBytes(32).toString("hex");
    const googleSecret = `flow-fixture-${randomBytes(16).toString("hex")}`;
    const mailKey = `re_flow_fixture_${randomBytes(16).toString("hex")}`;
    for (const value of [
      authSecret,
      otpKey,
      googleSecret,
      mailKey,
      process.env.FLOW_DATABASE_URL,
    ])
      secrets.add(value);

    child = spawn(
      process.execPath,
      [
        "--import",
        path.resolve("test/support/provider-fixture.mjs"),
        path.resolve("node_modules/next/dist/bin/next"),
        "start",
        "--hostname",
        "127.0.0.1",
        "--port",
        String(appPort),
      ],
      {
        env: {
          PATH: process.env.PATH,
          TMPDIR: process.env.TMPDIR,
          NEXT_TELEMETRY_DISABLED: "1",
          FLOW_ENV: "test",
          FLOW_EXECUTION: "disabled",
          FLOW_DATABASE_URL: process.env.FLOW_DATABASE_URL,
          FLOW_APP_ORIGIN: origin,
          FLOW_AUTH_SECRET: authSecret,
          FLOW_OTP_KEY: otpKey,
          FLOW_GOOGLE_CLIENT_ID: googleId,
          FLOW_GOOGLE_CLIENT_SECRET: googleSecret,
          FLOW_MAIL_API_KEY: mailKey,
          FLOW_MAIL_FROM: "auth@flow.test",
          FLOW_PROVIDER_FIXTURE_DIR: dir,
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    for (const output of [child.stdout, child.stderr])
      output.on("data", (data) => {
        serverLogs += data.toString();
      });
    const createClient = async (options = {}) => {
      const client = await request.newContext({
        baseURL: origin,
        ignoreHTTPSErrors: true,
        extraHTTPHeaders: { origin },
        ...options,
      });
      clients.push(client);
      return client;
    };
    const health = await createClient();
    let ready = false;
    for (let attempt = 0; attempt < 60 && child.exitCode === null; attempt++) {
      if ((await health.get("/api/health/ready")).ok()) {
        ready = true;
        break;
      }
      await delay(100);
    }
    assert.ok(ready, "Production Next.js server did not become ready");
    browser = await chromium.launch({
      executablePath: process.env.FLOW_TEST_CHROME_PATH || undefined,
      headless: true,
    });

    return {
      origin,
      attackOrigin,
      browser,
      db,
      otpKey,
      secrets,
      observed,
      stop,
      createClient,
      async inspect(response) {
        const text = await response.text();
        observed.push(text);
        for (const header of response.headersArray()) {
          if (header.name.toLowerCase() !== "set-cookie")
            observed.push(header.value);
        }
        return text;
      },
      async authorize(url, claims, flags = {}) {
        const start = new URL(url);
        assert.equal(start.origin, "https://accounts.google.com");
        assert.equal(start.searchParams.get("code_challenge_method"), "S256");
        assert.ok(start.searchParams.get("nonce"));
        const redirect = start.searchParams.get("redirect_uri");
        assert.equal(redirect, `${origin}/api/auth/callback/google`);
        const code = randomBytes(16).toString("hex");
        const access = `access-fixture-${randomBytes(18).toString("hex")}`;
        const refresh = `refresh-fixture-${randomBytes(18).toString("hex")}`;
        const idToken = await new SignJWT({
          nonce: start.searchParams.get("nonce"),
          ...claims,
        })
          .setProtectedHeader({ alg: "RS256", kid: "fixture" })
          .setIssuer(flags.issuer ?? "https://accounts.google.com")
          .setAudience(flags.audience ?? googleId)
          .setIssuedAt()
          .setExpirationTime(
            flags.expired ? Math.floor(Date.now() / 1000) - 2 : "3m",
          )
          .sign(flags.badSignature ? rogue.privateKey : signing.privateKey);
        for (const value of [code, access, refresh, idToken])
          secrets.add(value);
        await writeFile(
          path.join(dir, `code-${code}.json`),
          JSON.stringify({
            challenge: flags.badPkce
              ? "mismatched"
              : start.searchParams.get("code_challenge"),
            redirect,
            access,
            refresh,
            idToken,
            pauseExchange: flags.pauseExchange,
          }),
          { mode: 0o600 },
        );
        const callback = new URL(redirect);
        callback.searchParams.set("code", code);
        callback.searchParams.set("state", start.searchParams.get("state"));
        return callback.href;
      },
      async waitForTokenExchange(callback) {
        const code = new URL(callback).searchParams.get("code");
        assert.ok(/^[a-f0-9]{32}$/.test(code));
        const waiting = path.join(dir, `exchange-${code}.waiting`);
        const deadline = Date.now() + 4_000;
        while (!existsSync(waiting) && Date.now() < deadline) await delay(10);
        assert.ok(
          existsSync(waiting),
          "Google token exchange did not reach the barrier",
        );
      },
      async releaseTokenExchange(callback) {
        const code = new URL(callback).searchParams.get("code");
        assert.ok(/^[a-f0-9]{32}$/.test(code));
        await writeFile(path.join(dir, `exchange-${code}.release`), "");
      },
      async mail() {
        return await readFile(path.join(dir, "mail.jsonl"), "utf8")
          .then((rows) =>
            rows
              .trim()
              .split("\n")
              .filter(Boolean)
              .map((row) => JSON.parse(row)),
          )
          .catch((error) => {
            if (error.code === "ENOENT") return [];
            throw error;
          });
      },
      assertNoCredentialLeaks() {
        const outputs = observed.join("\n") + serverLogs;
        for (const value of secrets)
          assert.ok(
            !outputs.includes(value),
            "Credential appeared in a response body, an unrelated header, or server logs",
          );
      },
    };
  } catch (error) {
    await stop();
    throw error;
  }
}

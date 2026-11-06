import assert from "node:assert/strict";
import { createHmac, randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { securityServer } from "./support/security-server.mjs";

let app;
const sessionCookie = "__Host-flow-test-session";

before(async () => {
  app = await securityServer();
});

after(async () => {
  if (!app) return;
  try {
    const { rows } = await app.db.query("SELECT token FROM flow.auth_sessions");
    for (const row of rows) app.secrets.add(row.token);
    app.assertNoCredentialLeaks();
  } finally {
    await app.stop();
  }
});

async function result(response, status) {
  const body = await app.inspect(response);
  assert.equal(
    response.status(),
    status,
    `Unexpected HTTP status from ${new URL(response.url()).pathname}`,
  );
  return body ? JSON.parse(body) : undefined;
}

async function post(client, route, data = {}, status = 204) {
  return result(await client.post(route, { data }), status);
}

async function status(client, code = 200) {
  return result(await client.get("/api/security/status"), code);
}

async function completeGoogle(
  client,
  claims,
  { link = false, recovery = false, flags = {}, accepted = true } = {},
) {
  const start = await post(
    client,
    link ? "/api/security/google/link" : "/api/auth/google/start",
    link ? {} : { recovery },
    200,
  );
  const callback = await app.authorize(start.url, claims, flags);
  const res = await client.get(callback, { maxRedirects: 0 });
  await result(res, 303);
  assert.equal(
    res.headers()["location"],
    accepted
      ? link
        ? "/sign-in?notice=linked"
        : "/onboarding"
      : link
        ? "/security?issue=authentication"
        : "/sign-in?issue=authentication",
  );
  if (accepted && !link) await cookieValue(client);
  return callback;
}

function google(email, sub, overrides = {}) {
  return {
    email,
    sub,
    email_verified: true,
    name: "Fixture User",
    ...overrides,
  };
}

async function clearCooldown(email) {
  const keys = ["email-code", "security-code"].map((channel) =>
    createHmac("sha256", app.otpKey)
      .update("rate-limit\0")
      .update(`${channel}:cooldown:${email}`)
      .digest("hex"),
  );
  await app.db.query(
    "UPDATE flow.auth_throttles SET expires_at = timestamp '2000-01-01' WHERE key = ANY($1::text[])",
    [keys],
  );
}

async function codeFor(email, request) {
  await clearCooldown(email);
  const count = (await app.mail()).length;
  await request();
  const mail = await newMail(count);
  assert.equal(mail.length, 1, "Expected one captured test email");
  assert.equal(mail[0].to[0], email);
  const code = mail[0].text.match(/\b[0-9]{8}\b/)?.[0];
  assert.ok(code, "Expected an eight digit code in the captured email");
  app.secrets.add(code);
  return code;
}

async function newMail(count) {
  for (let attempt = 0; attempt < 60; attempt++) {
    const batch = (await app.mail()).slice(count);
    if (batch.length) return batch;
    await delay(50);
  }
  return [];
}

async function emailLogin(client, email, recovery = false) {
  const code = await codeFor(email, () =>
    post(client, "/api/auth/email/start", { email, recovery }, 202),
  );
  await post(client, "/api/auth/email/verify", { code });
  await cookieValue(client);
}

async function prove(client, email, purpose, target) {
  const code = await codeFor(email, () =>
    post(client, "/api/security/code/start", { purpose, target }, 202),
  );
  await post(client, "/api/security/code/verify", { code });
}

async function cookieValue(client) {
  const cookies = (await client.storageState()).cookies;
  const record = cookies.find(({ name }) => name === sessionCookie);
  assert.ok(record);
  app.secrets.add(record.value);
  app.secrets.add(decodeURIComponent(record.value).split(".")[0]);
  return record;
}

async function replay(record) {
  return app.createClient({
    extraHTTPHeaders: {
      origin: app.origin,
      cookie: `${record.name}=${record.value}`,
    },
  });
}

test("Google authorization code, signed identity, nonce and PKCE establish one database session", async () => {
  const client = await app.createClient();
  const email = "google-first@gmail.com";
  const callback = await completeGoogle(
    client,
    google(email, "google-first-subject"),
  );
  const self = await status(client);
  assert.equal(self.email, email);
  assert.equal(self.emailEnrolled, false);
  assert.equal(self.googleLinked, true);
  assert.equal(self.sessions.length, 1);
  await cookieValue(client);
  const res = await client.get(callback, { maxRedirects: 0 });
  await result(res, 303);
  assert.equal(res.headers().location, "/sign-in?issue=authentication");
  assert.equal((await status(client)).sessions.length, 1);
  const { rows } = await app.db.query(
    "SELECT access_token IS NULL AND refresh_token IS NULL AND id_token IS NULL AS empty FROM flow.auth_identities WHERE provider_subject = $1",
    ["google-first-subject"],
  );
  assert.deepEqual(rows, [{ empty: true }]);
});

test("Google rejects forged claims, non-authoritative email and cross-browser state", async () => {
  const client = await app.createClient();
  const identity = google("forged@gmail.com", "forged-subject");
  for (const flags of [
    { badSignature: true },
    { issuer: "https://invalid.example" },
    { audience: "wrong-client" },
    { expired: true },
    { badPkce: true },
  ]) {
    await completeGoogle(client, identity, { accepted: false, flags });
  }
  await completeGoogle(
    client,
    { ...identity, nonce: "wrong" },
    { accepted: false },
  );
  await completeGoogle(
    client,
    google("not-hosted@example.test", "outside-google"),
    { accepted: false },
  );
  await completeGoogle(
    client,
    { ...identity, email_verified: "false" },
    { accepted: false },
  );
  const start = await post(client, "/api/auth/google/start", {}, 200);
  const callback = await app.authorize(start.url, identity);
  const other = await app.createClient();
  const rejected = await other.get(callback, { maxRedirects: 0 });
  await result(rejected, 303);
  assert.equal(rejected.headers().location, "/sign-in?issue=authentication");
  await status(client, 401);
  const { rows } = await app.db.query(
    "SELECT count(*)::int AS total FROM flow.auth_users WHERE email = $1",
    [identity.email],
  );
  assert.equal(rows[0].total, 0);
});

test("matching email cannot use an OTP for a Google-only identity without enrollment", async () => {
  const client = await app.createClient();
  const email = "enroll@gmail.com";
  await completeGoogle(client, google(email, "enroll-subject"));
  const guest = await app.createClient();
  await post(guest, "/api/auth/email/start", { email }, 202);
  assert.ok(!(await app.mail()).some((mail) => mail.to.includes(email)));
  await post(guest, "/api/auth/email/verify", { code: "00000000" }, 401);
  await status(guest, 401);
  const old = await cookieValue(client);
  await prove(client, email, "enroll-email");
  await post(client, "/api/security/email/enroll");
  await status(await replay(old), 401);
  await emailLogin(guest, email);
  assert.equal((await status(guest)).googleLinked, true);
  assert.equal((await status(guest)).emailEnrolled, true);
});

test("a pending email registration cannot enter a Google identity created during the race", async () => {
  const email = "registration-race@gmail.com";
  const first = await app.createClient();
  const code = await codeFor(email, () =>
    post(first, "/api/auth/email/start", { email }, 202),
  );
  const googleUser = await app.createClient();
  await completeGoogle(googleUser, google(email, "raced-subject"));
  await post(first, "/api/auth/email/verify", { code }, 401);
  await status(first, 401);
  assert.equal((await status(googleUser)).emailEnrolled, false);
});

test("explicit Google linking requires fresh scoped proof and revokes prior sessions", async () => {
  const email = "linking@gmail.com";
  const member = await app.createClient();
  await emailLogin(member, email);
  const { rows: prior } = await app.db.query(
    "SELECT id FROM flow.auth_users WHERE email = $1",
    [email],
  );
  const stolen = await replay(await cookieValue(member));
  const stranger = await app.createClient();
  await completeGoogle(stranger, google(email, "linked-subject"), {
    accepted: false,
  });
  await status(stranger, 401);
  await post(member, "/api/security/google/link", {}, 403);
  await prove(member, email, "link-google");
  await post(member, "/api/security/email/disable", {}, 403);
  await completeGoogle(member, google(email, "linked-subject"), { link: true });
  await status(stolen, 401);
  await status(member, 401);
  await completeGoogle(stranger, google(email, "linked-subject"));
  assert.equal((await status(stranger)).emailEnrolled, true);
  const { rows: later } = await app.db.query(
    "SELECT u.id FROM flow.auth_users u JOIN flow.auth_identities i ON i.user_id = u.id WHERE u.email = $1 AND i.provider_subject = $2",
    [email, "linked-subject"],
  );
  assert.deepEqual(later, prior);
  await prove(stranger, email, "unlink-google");
  await post(stranger, "/api/security/google/unlink");
  await completeGoogle(
    stranger,
    google("other-mailbox@gmail.com", "linked-subject"),
    { accepted: false },
  );
  await status(stranger, 401);
  const { rows: binding } = await app.db.query(
    "SELECT user_id AS id FROM flow.google_subject_bindings WHERE subject = $1",
    ["linked-subject"],
  );
  assert.deepEqual(binding, prior);
});

test("revoking the linking session invalidates an outstanding Google callback", async () => {
  const email = "revoked-link@gmail.com";
  const client = await app.createClient();
  await emailLogin(client, email);
  await prove(client, email, "link-google");
  const start = await post(client, "/api/security/google/link", {}, 200);
  const pending = await app.createClient({
    storageState: await client.storageState(),
  });
  const callback = await app.authorize(
    start.url,
    google(email, "revoked-link-subject"),
  );
  await post(client, "/api/auth/sign-out");
  const res = await pending.get(callback, { maxRedirects: 0 });
  await result(res, 303);
  assert.equal(res.headers().location, "/security?issue=authentication");
  const { rows } = await app.db.query(
    "SELECT count(*)::int AS total FROM flow.auth_identities WHERE provider_subject = $1",
    ["revoked-link-subject"],
  );
  assert.equal(rows[0].total, 0);
});

test("OTP is browser-bound, hashed at rest, limited to five guesses and consumed once", async () => {
  const email = "one-time@example.test";
  const client = await app.createClient();
  const other = await app.createClient();
  const code = await codeFor(email, () =>
    post(client, "/api/auth/email/start", { email }, 202),
  );
  await post(other, "/api/auth/email/verify", { code }, 401);
  const { rows } = await app.db.query(
    "SELECT value FROM flow.auth_verifications WHERE value ~ '^[a-f0-9]{64}:[0-9]+$'",
  );
  const expected = createHmac("sha256", app.otpKey)
    .update("email-otp\0")
    .update(code)
    .digest("hex");
  assert.ok(
    rows.some(({ value }) => value.startsWith(`${expected}:`)),
    "Stored code should be a keyed digest",
  );
  const wrong = code === "00000000" ? "00000001" : "00000000";
  const guesses = await Promise.all(
    Array.from({ length: 5 }, () =>
      client.post("/api/auth/email/verify", { data: { code: wrong } }),
    ),
  );
  for (const guess of guesses) await result(guess, 401);
  await post(client, "/api/auth/email/verify", { code }, 401);
  const next = await codeFor(email, () =>
    post(client, "/api/auth/email/start", { email }, 202),
  );
  const duplicate = await app.createClient({
    storageState: await client.storageState(),
  });
  const replies = await Promise.all(
    [client, duplicate].map((jar) =>
      jar.post("/api/auth/email/verify", { data: { code: next } }),
    ),
  );
  assert.deepEqual(replies.map((reply) => reply.status()).sort(), [204, 401]);
  for (const reply of replies) await app.inspect(reply);
});

test("session recovery and explicit revocation deny copied cookies", async () => {
  const email = "recovery@example.test";
  const client = await app.createClient();
  const recovering = await app.createClient();
  await emailLogin(client, email);
  const prior = await replay(await cookieValue(client));
  await emailLogin(recovering, email, true);
  await status(prior, 401);
  const current = await replay(await cookieValue(recovering));
  await prove(recovering, email, "revoke-all");
  await post(recovering, "/api/security/sessions/revoke-all");
  await status(current, 401);
});

test("a suppressed resend preserves the browser challenge, and an expired code cannot sign in", async () => {
  const email = "expired-code@example.test";
  const client = await app.createClient();
  const code = await codeFor(email, () =>
    post(client, "/api/auth/email/start", { email }, 202),
  );
  const count = (await app.mail()).length;
  const challenge = (await client.storageState()).cookies.find(
    ({ name }) => name === "__Host-flow-test-email",
  );
  assert.ok(challenge);
  await post(client, "/api/auth/email/start", { email }, 202);
  const kept = (await client.storageState()).cookies.find(
    ({ name }) => name === challenge.name,
  );
  assert.ok(kept?.value === challenge.value);
  assert.equal((await app.mail()).length, count);
  await app.db.query(
    "UPDATE flow.auth_intents SET expires_at = timestamp '2000-01-01' WHERE email = $1",
    [email],
  );
  await post(client, "/api/auth/email/verify", { code }, 401);
  await status(client, 401);
});

test("public HTTP surface rejects provider endpoints, mass assignment and forged origins", async () => {
  const client = await app.createClient();
  for (const route of [
    "/api/auth/get-session",
    "/api/auth/sign-in/social",
    "/api/auth/sign-in/email-otp",
    "/api/auth/link-social",
    "/api/auth/token",
    "/api/auth/list-sessions",
  ]) {
    await result(await client.get(route), 404);
    await post(client, route, {}, 404);
  }
  await post(
    client,
    "/api/auth/google/start",
    { callbackURL: "https://invalid.example" },
    422,
  );
  await post(
    client,
    "/api/auth/email/start",
    { email: "forged@example.test", emailEnrolled: true },
    422,
  );
  await result(
    await client.post("/api/auth/sign-out", {
      headers: { origin: app.attackOrigin },
      data: {},
    }),
    403,
  );
});

async function onboard(client) {
  const response = await post(client, "/api/onboarding/complete", {}, 200);
  return response.account;
}

async function person(email) {
  const client = await app.createClient();
  await emailLogin(client, email);
  return { client, email, account: await onboard(client) };
}

async function business(client, name, key = randomUUID()) {
  const res = await client.post("/api/accounts", {
    headers: { "Idempotency-Key": key },
    data: { name },
  });
  return (await result(res, 201)).account;
}

async function issueInvite(actor, account, email, role) {
  await prove(actor.client, actor.email, "team-change", account.id);
  const count = (await app.mail()).length;
  const { invitation } = await post(
    actor.client,
    `/api/accounts/${account.id}/invites`,
    { email, role },
    201,
  );
  const messages = await newMail(count);
  assert.equal(messages.length, 1);
  assert.equal(messages[0].to[0], email);
  const token = messages[0].text.match(/#token=([a-f0-9]{64})/)?.[1];
  assert.ok(token);
  app.secrets.add(token);
  return { invitation, token };
}

test("transactional onboarding and business idempotency converge on one account across concurrent requests", async () => {
  const email = "parallel@example.test";
  const first = await app.createClient();
  await emailLogin(first, email);
  const second = await app.createClient();
  await emailLogin(second, email);
  await result(await first.get("/api/me"), 409);
  const personals = await Promise.all(
    [first, second, first, second].map(onboard),
  );
  const personalId = personals[0].id;
  assert.ok(
    personals.every(({ id, kind }) => id === personalId && kind === "PERSONAL"),
  );
  const key = randomUUID();
  const accounts = await Promise.all(
    [first, second, first].map((client) =>
      business(client, "Parallel Company", key),
    ),
  );
  assert.ok(
    accounts.every(
      ({ id, kind, role }) =>
        id === accounts[0].id && kind === "BUSINESS" && role === "OWNER",
    ),
  );
  assert.notEqual(accounts[0].id, personalId);
  await result(
    await first.post("/api/accounts", {
      headers: { "Idempotency-Key": key },
      data: { name: "Changed payload" },
    }),
    409,
  );
  const { rows } = await app.db.query(
    "SELECT count(*)::int AS total FROM flow.accounts WHERE personal_owner_id = (SELECT u.id FROM flow.users u JOIN flow.auth_users a ON a.id=u.auth_user_id WHERE a.email=$1)",
    [email],
  );
  assert.deepEqual(rows, [{ total: 1 }]);
});

test("invites are single-use, bound to the verified recipient and denied across tenants", async () => {
  const owner = await person("team-owner@example.test");
  const member = await person("team-member@example.test");
  const outsider = await person("other-tenant@example.test");
  const account = await business(owner.client, "Private Team");
  const otherAccount = await business(outsider.client, "Other Team");
  const teamPath = `/api/accounts/${account.id}`;
  await result(await outsider.client.get(teamPath), 404);
  await result(
    await owner.client.get(`/api/accounts/${outsider.account.id}`),
    404,
  );
  await result(
    await outsider.client.patch(teamPath, { data: { name: "Stolen" } }),
    404,
  );
  await result(await outsider.client.get(`${teamPath}/members`), 404);
  await post(
    owner.client,
    `${teamPath}/invites`,
    { email: member.email, role: "MEMBER" },
    403,
  );
  const { invitation, token } = await issueInvite(
    owner,
    account,
    member.email,
    "MEMBER",
  );
  await post(outsider.client, "/api/invites/accept", { token }, 404);
  await result(
    await outsider.client.delete(
      `/api/accounts/${otherAccount.id}/invites/${invitation.id}`,
      { data: {} },
    ),
    404,
  );
  const cloned = await app.createClient({
    storageState: await member.client.storageState(),
  });
  const responses = await Promise.all(
    [member.client, cloned].map((client) =>
      client.post("/api/invites/accept", { data: { token } }),
    ),
  );
  assert.deepEqual(responses.map((res) => res.status()).sort(), [200, 404]);
  for (const res of responses) await app.inspect(res);
  assert.equal(
    (await result(await member.client.get(teamPath), 200)).account.role,
    "MEMBER",
  );
  await result(await member.client.get(`${teamPath}/members`), 403);
  await post(
    member.client,
    `${teamPath}/invites`,
    { email: outsider.email, role: "MEMBER" },
    403,
  );
  const roster = await result(
    await owner.client.get(`${teamPath}/members`),
    200,
  );
  const record = roster.members.find(({ email }) => email === member.email);
  assert.ok(record);
  await result(
    await outsider.client.patch(
      `/api/accounts/${otherAccount.id}/members/${record.id}`,
      { data: { role: "ADMIN" } },
    ),
    404,
  );
  await prove(owner.client, owner.email, "team-change", account.id);
  await result(
    await owner.client.delete(`${teamPath}/members/${record.id}`, { data: {} }),
    204,
  );
  await result(await cloned.get(teamPath), 404);
  await result(
    await member.client.get(`/api/accounts/${member.account.id}`),
    200,
  );
});

test("admins cannot escalate, and a downgrade invalidates their unaccepted invitations", async () => {
  const owner = await person("priv-owner@example.test");
  const admin = await person("priv-admin@example.test");
  const invitee = await person("priv-recipient@example.test");
  const account = await business(owner.client, "Privilege Test");
  const route = `/api/accounts/${account.id}`;
  const adminInvite = await issueInvite(owner, account, admin.email, "ADMIN");
  await post(
    admin.client,
    "/api/invites/accept",
    { token: adminInvite.token },
    200,
  );
  const roster = await result(await admin.client.get(`${route}/members`), 200);
  const adminId = roster.members.find(({ role }) => role === "ADMIN").id;
  const ownerId = roster.members.find(({ role }) => role === "OWNER").id;
  await result(
    await admin.client.patch(`${route}/members/${adminId}`, {
      data: { role: "OWNER" },
    }),
    422,
  );
  await result(
    await admin.client.delete(`${route}/members/${ownerId}`, { data: {} }),
    403,
  );
  await result(
    await owner.client.delete(`${route}/members/${ownerId}`, { data: {} }),
    403,
  );
  await post(
    admin.client,
    `${route}/invites`,
    { email: invitee.email, role: "ADMIN" },
    403,
  );
  const invitation = await issueInvite(admin, account, invitee.email, "MEMBER");
  await prove(owner.client, owner.email, "team-change", account.id);
  await result(
    await owner.client.patch(`${route}/members/${adminId}`, {
      data: { role: "MEMBER" },
    }),
    204,
  );
  await post(
    invitee.client,
    "/api/invites/accept",
    { token: invitation.token },
    404,
  );
  await result(await admin.client.get(`${route}/members`), 403);
});

test("expired sessions and attempts to revoke another user's session cannot authorize tenant access", async () => {
  const alice = await person("expiry-a@example.test");
  const bob = await person("expiry-b@example.test");
  const { sessions } = await status(bob.client);
  const bobSession = sessions.find(({ current }) => current).id;
  await post(alice.client, "/api/security/sessions/revoke", { id: bobSession });
  await result(await bob.client.get("/api/me"), 200);
  await app.db.query(
    "UPDATE flow.auth_sessions SET created_at = timestamp '2000-01-01' WHERE id = $1",
    [bobSession],
  );
  await result(await bob.client.get(`/api/accounts/${bob.account.id}`), 401);
  const { sessions: other } = await status(alice.client);
  await app.db.query(
    "UPDATE flow.auth_sessions SET expires_at = timestamp '2000-01-01' WHERE id = $1",
    [other.find(({ current }) => current).id],
  );
  await result(await alice.client.get("/api/me"), 401);
});

test("Chromium enforces host-only HttpOnly cookies, resists fixation and blocks cross-origin sign-out", async () => {
  const context = await app.browser.newContext({ ignoreHTTPSErrors: true });
  try {
    const page = await context.newPage();
    const email = "browser@example.test";
    const fixed = "fixture-session-fixed-before-authentication";
    await context.addCookies([
      {
        name: sessionCookie,
        value: fixed,
        url: app.origin,
        httpOnly: true,
        secure: true,
        sameSite: "Lax",
      },
    ]);
    await page.goto(app.origin);
    const send = (url, data) =>
      page.evaluate(
        async ({ url, data }) => {
          const res = await fetch(url, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(data),
          });
          return { status: res.status, body: await res.text() };
        },
        { url, data },
      );
    const code = await codeFor(email, async () =>
      assert.equal(
        (await send("/api/auth/email/start", { email })).status,
        202,
      ),
    );
    const verify = await send("/api/auth/email/verify", { code });
    assert.deepEqual(verify, { status: 204, body: "" });
    const signed = (await context.cookies(app.origin)).find(
      ({ name }) => name === sessionCookie,
    );
    assert.ok(
      signed && signed.value !== fixed && signed.secure && signed.httpOnly,
    );
    assert.equal(signed.sameSite, "Lax");
    assert.equal(signed.path, "/");
    assert.equal(signed.domain, "127.0.0.1");
    app.secrets.add(signed.value);
    assert.ok(
      !(await page.evaluate(() => document.cookie)).includes(sessionCookie),
    );
    await status(await replay({ name: sessionCookie, value: fixed }), 401);

    await page.goto(app.attackOrigin);
    const signOutUrl = `${app.origin}/api/auth/sign-out`;
    const blocked = page.waitForResponse((res) => res.url() === signOutUrl);
    const arrived = page.waitForURL(signOutUrl, { waitUntil: "load" });
    await page.evaluate((target) => {
      const form = document.createElement("form");
      form.method = "POST";
      form.action = target;
      form.target = "_self";
      document.body.append(form);
      form.submit();
    }, signOutUrl);
    assert.equal((await blocked).status(), 403);
    await arrived;
    await status(await replay(signed));
    await page.goto(app.origin);
    assert.equal((await send("/api/auth/sign-out", {})).status, 204);
    await status(await replay(signed), 401);
  } finally {
    await context.close();
  }
});

test("Chromium follows the Google redirect, onboards accounts and enforces tenant access through the screens", async () => {
  const owner = await app.browser.newContext({ ignoreHTTPSErrors: true });
  const payer = await app.browser.newContext({ ignoreHTTPSErrors: true });
  const ownerEmail = "browser-owner@gmail.com";
  const inviteeEmail = "browser-invitee@example.test";
  const businessName = "Browser Private Workspace";
  try {
    await owner.route(
      "https://accounts.google.com/o/oauth2/v2/auth?**",
      async (route) => {
        const location = await app.authorize(
          route.request().url(),
          google(ownerEmail, "browser-owner"),
        );
        await route.fulfill({ status: 302, headers: { location } });
      },
    );
    const page = await owner.newPage();
    await page.goto(`${app.origin}/sign-in`);
    await page.getByRole("button", { name: "Continue with Google" }).click();
    await page.getByRole("heading", { name: "Fixture User" }).waitFor();
    assert.ok(page.url().includes("/accounts/"));
    assert.ok(await page.getByText("Wallet setup pending").isVisible());
    await page.getByRole("link", { name: "Accounts", exact: true }).click();
    await page.getByLabel("Business name").fill(businessName);
    await page.getByRole("button", { name: "Create business" }).click();
    await page.getByRole("heading", { name: businessName }).waitFor();
    const id = new URL(page.url()).pathname.split("/").at(-1);
    const privateUrl = `${app.origin}/accounts/${id}`;

    const visitor = await payer.newPage();
    await visitor.goto(privateUrl);
    await visitor.getByRole("heading", { name: "Sign in to FLOW" }).waitFor();
    await visitor.getByLabel("Email address").fill(inviteeEmail);
    const code = await codeFor(inviteeEmail, () =>
      visitor.getByRole("button", { name: "Send email code" }).click(),
    );
    await visitor.getByLabel("Email code").fill(code);
    await visitor.getByRole("button", { name: "Verify and sign in" }).click();
    await visitor
      .getByRole("heading", { name: "Personal", exact: true })
      .waitFor();
    const inaccessible = await visitor.goto(privateUrl);
    assert.equal(inaccessible.status(), 404);
    assert.equal(
      await visitor.getByText(businessName, { exact: true }).count(),
      0,
    );
    assert.equal(
      await visitor.evaluate(
        async (id) => (await fetch(`/api/accounts/${id}`)).status,
        id,
      ),
      404,
    );

    const client = await app.createClient({
      storageState: await owner.storageState(),
    });
    const { token } = await issueInvite(
      { client, email: ownerEmail },
      { id },
      inviteeEmail,
      "MEMBER",
    );
    await visitor.goto(`${app.origin}/invites/accept#token=${token}`);
    await visitor.getByRole("button", { name: "Accept invitation" }).click();
    await visitor.getByRole("heading", { name: businessName }).waitFor();
    assert.equal(new URL(visitor.url()).hash, "");
    assert.equal(
      await visitor.getByRole("link", { name: "Manage team" }).count(),
      0,
    );
    assert.equal(
      await visitor.evaluate(
        async (id) => (await fetch(`/api/accounts/${id}/members`)).status,
        id,
      ),
      403,
    );
  } finally {
    await owner.close();
    await payer.close();
  }
});

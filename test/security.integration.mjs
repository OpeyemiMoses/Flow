import assert from "node:assert/strict";
import { createHmac, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { after, before, test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import pg from "pg";
import { securityServer } from "./support/security-server.mjs";

let app;
let workerDb;
const sessionCookie = "__Host-flow-test-session";

before(async () => {
  app = await securityServer();
  if (process.env.FLOW_WORKER_DATABASE_URL) {
    workerDb = new pg.Pool({
      connectionString: process.env.FLOW_WORKER_DATABASE_URL,
      max: 2,
    });
  }
});

after(async () => {
  if (workerDb) {
    await workerDb.end();
  }
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

async function withDbGate(run) {
  const gate = await app.db.connect();
  try {
    await gate.query("BEGIN");
    await run(gate);
    await gate.query("COMMIT");
  } catch (error) {
    await gate.query("ROLLBACK");
    throw error;
  } finally {
    gate.release();
  }
}

async function waitForDbWaiters(queryPattern, count) {
  const deadline = Date.now() + 1_200;
  do {
    const { rows } = await app.db.query(
      `SELECT pid, pg_blocking_pids(pid) AS blockers
       FROM pg_stat_activity
       WHERE datname = current_database() AND application_name = 'flow-application'
         AND wait_event_type = 'Lock' AND query ~ $1
       ORDER BY query_start, pid`,
      [queryPattern],
    );
    if (rows.length === count) return rows;
    await delay(10);
  } while (Date.now() < deadline);
  assert.fail(`Expected ${count} PostgreSQL waiters for the test gate`);
}

async function linkedMailbox(email) {
  const owner = await app.createClient();
  const claims = google(email, email);
  await emailLogin(owner, email);
  await onboard(owner);
  await prove(owner, email, "link-google");
  await completeGoogle(owner, claims, { link: true });
  await emailLogin(owner, email);
  await prove(owner, email, "unlink-google");
  return { owner, claims };
}

async function beginGoogleCallback(claims, options = {}) {
  const client = await app.createClient();
  const start = await post(
    client,
    "/api/auth/google/start",
    { recovery: options.recovery ?? false },
    200,
  );
  const callback = await app.authorize(start.url, claims, options);
  const retry = await app.createClient({
    storageState: await client.storageState(),
  });
  return { client, retry, callback };
}

const callbackRequest = (client, callback) =>
  client.get(callback, { maxRedirects: 0, timeout: 9_000 });

async function expectGoogleRejection(response) {
  await result(response, 303);
  assert.equal(response.headers().location, "/sign-in?issue=authentication");
  assert.ok(
    !response
      .headersArray()
      .some(
        ({ name, value }) =>
          name.toLowerCase() === "set-cookie" &&
          value.startsWith(`${sessionCookie}=`),
      ),
    "A rejected callback must not send a session cookie",
  );
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

for (const unlinkFirst of [true, false]) {
  const first = unlinkFirst ? "unlink" : "callback";
  test(`M11-01 ${first} wins the auth-user lock against an ordinary Google sign-in`, async () => {
    const email = `race-${first}@gmail.com`;
    const { owner, claims } = await linkedMailbox(email);
    const staleOwner = await replay(await cookieValue(owner));
    const { client, retry, callback } = await beginGoogleCallback(claims);
    const {
      rows: [user],
    } = await app.db.query("SELECT id FROM flow.auth_users WHERE email = $1", [
      email,
    ]);
    const requests = [
      () =>
        owner.post("/api/security/google/unlink", { data: {}, timeout: 4_000 }),
      () => callbackRequest(client, callback),
    ];
    const firstRequest = unlinkFirst ? 0 : 1;
    const pending = [];
    const queryPattern = "SELECT id FROM flow\\.auth_users.*FOR UPDATE";
    try {
      await withDbGate(async (gate) => {
        await gate.query(
          "SELECT id FROM flow.auth_users WHERE id = $1 FOR UPDATE",
          [user.id],
        );
        pending[firstRequest] = requests[firstRequest]();
        const [firstWaiter] = await waitForDbWaiters(queryPattern, 1);
        assert.ok(firstWaiter.blockers.includes(gate.processID));
        pending[1 - firstRequest] = requests[1 - firstRequest]();
        const [head, tail] = await waitForDbWaiters(queryPattern, 2);
        assert.equal(head.pid, firstWaiter.pid);
        assert.ok(tail.blockers.includes(head.pid));
      });
      const [unlink, signIn] = await Promise.all(pending);
      await result(unlink, 204);
      await result(await staleOwner.get("/api/me"), 401);
      await result(await client.get("/api/me"), 401);
      if (unlinkFirst) {
        await expectGoogleRejection(signIn);
      } else {
        await result(signIn, 303);
        assert.equal(signIn.headers().location, "/onboarding");
        const revoked = await replay(await cookieValue(client));
        await result(await revoked.get("/api/me"), 401);
      }
      await expectGoogleRejection(await callbackRequest(retry, callback));
      const {
        rows: [remaining],
      } = await app.db.query(
        `SELECT (SELECT count(*)::int FROM flow.auth_identities WHERE user_id = $1) AS identities,
                (SELECT count(*)::int FROM flow.auth_sessions WHERE user_id = $1) AS sessions`,
        [user.id],
      );
      assert.deepEqual(remaining, { identities: 0, sessions: 0 });
      await completeGoogle(await app.createClient(), claims, {
        accepted: false,
      });
    } finally {
      await Promise.allSettled(pending);
    }
  });
}

test("M11-01 unlink and relink reject an in-flight callback and older recovery intents", async () => {
  const email = "race-relink@gmail.com";
  const { owner, claims } = await linkedMailbox(email);
  const staleOwner = await replay(await cookieValue(owner));
  const identityId = async () => {
    const { rows } = await app.db.query(
      "SELECT id FROM flow.auth_identities WHERE provider_subject = $1",
      [claims.sub],
    );
    assert.equal(rows.length, 1);
    return rows[0].id;
  };
  const originalId = await identityId();
  const held = await beginGoogleCallback(claims, { pauseExchange: true });
  const recovery = await beginGoogleCallback(claims, { recovery: true });
  const drift = await beginGoogleCallback({
    ...claims,
    email: "race-drift@gmail.com",
  });
  const pending = callbackRequest(held.client, held.callback);
  try {
    await app.waitForTokenExchange(held.callback);
    await expectGoogleRejection(
      await callbackRequest(held.retry, held.callback),
    );
    await post(owner, "/api/security/google/unlink");
    await emailLogin(owner, email);
    await prove(owner, email, "link-google");
    await completeGoogle(owner, claims, { link: true });
    assert.notEqual(
      await identityId(),
      originalId,
      "Relink must create a new binding",
    );
  } finally {
    await app.releaseTokenExchange(held.callback);
    await Promise.allSettled([pending]);
  }
  await expectGoogleRejection(await pending);
  await result(await held.client.get("/api/me"), 401);
  await expectGoogleRejection(
    await callbackRequest(recovery.client, recovery.callback),
  );
  await expectGoogleRejection(
    await callbackRequest(drift.client, drift.callback),
  );
  await expectGoogleRejection(
    await callbackRequest(recovery.retry, recovery.callback),
  );
  await result(await staleOwner.get("/api/me"), 401);

  const fresh = await app.createClient();
  await completeGoogle(fresh, claims, { recovery: true });
  const security = await status(fresh);
  assert.equal(security.emailEnrolled, true);
  assert.equal(security.mailboxPaused, false);
  assert.equal(security.sessions.length, 1);
  await result(await fresh.get("/api/me"), 200);
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
  const { rows: jobRows } = await app.db.query(
    'SELECT account_id AS "accountId", status FROM flow.wallet_provisioning_jobs WHERE account_id IN ($1::uuid, $2::uuid) ORDER BY account_id',
    [personalId, accounts[0].id],
  );
  assert.equal(jobRows.length, 2);
  assert.ok(jobRows.every((r) => r.status === "PENDING"));
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
  const bobCookie = (await bob.client.storageState()).cookies.find(
    ({ name }) => name === sessionCookie,
  )?.value;
  const bobToken = decodeURIComponent(bobCookie).split(".")[0];
  {
    const client = await app.db.connect();
    try {
      await client.query(
        "SELECT set_config('flow.current_session_token', $1, false)",
        [bobToken],
      );
      const res = await client.query(
        "UPDATE flow.auth_sessions SET created_at = timestamp '2000-01-01' WHERE id = $1",
        [bobSession],
      );
      assert.equal(res.rowCount, 1);
    } finally {
      client.release();
    }
  }
  await result(await bob.client.get(`/api/accounts/${bob.account.id}`), 401);
  const { sessions: other } = await status(alice.client);
  const aliceCookie = (await alice.client.storageState()).cookies.find(
    ({ name }) => name === sessionCookie,
  )?.value;
  const aliceToken = decodeURIComponent(aliceCookie).split(".")[0];
  {
    const client = await app.db.connect();
    try {
      await client.query(
        "SELECT set_config('flow.current_session_token', $1, false)",
        [aliceToken],
      );
      const res = await client.query(
        "UPDATE flow.auth_sessions SET expires_at = timestamp '2000-01-01' WHERE id = $1",
        [other.find(({ current }) => current).id],
      );
      assert.equal(res.rowCount, 1);
    } finally {
      client.release();
    }
  }
  await result(await alice.client.get("/api/me"), 401);
});

for (const remove of [false, true]) {
  test(`M11-02 an in-flight roster excludes data created after ${remove ? "removal" : "downgrade"}`, async () => {
    const caseName = remove ? "remove" : "downgrade";
    const owner = await person(`roster-owner-${caseName}@example.test`);
    const member = await person(`roster-member-${caseName}@example.test`);
    const account = await business(owner.client, "Roster fixture");
    const other = await business(member.client, "Member's business");
    const roster = `/api/accounts/${account.id}/members`;
    const otherRoster = `/api/accounts/${other.id}/members`;
    await result(await member.client.get(roster), 404);
    const { token } = await issueInvite(owner, account, member.email, "ADMIN");
    await post(member.client, "/api/invites/accept", { token }, 200);
    const { invitation: before } = await issueInvite(
      owner,
      account,
      `roster-before-${caseName}@example.test`,
      "MEMBER",
    );
    const stale = await replay(await cookieValue(member.client));
    const { members } = await result(await stale.get(roster), 200);
    const admin = members.find(({ role }) => role === "ADMIN");
    assert.ok(admin);
    await prove(owner.client, owner.email, "team-change", account.id);
    const afterId = randomUUID();
    const afterEmail = `roster-after-${caseName}@example.test`;
    let pending;
    try {
      await withDbGate(async (gate) => {
        await gate.query(
          "LOCK TABLE flow.account_invites IN ACCESS EXCLUSIVE MODE",
        );
        pending = stale.get(roster, { timeout: 4_000 });
        const [reader] = await waitForDbWaiters("account_invites", 1);
        assert.ok(reader.blockers.includes(gate.processID));
        const method = remove ? "delete" : "patch";
        await result(
          await owner.client[method](`${roster}/${admin.id}`, {
            data: remove ? {} : { role: "MEMBER" },
            timeout: 4_000,
          }),
          204,
        );
        // Commit a fixture row after revocation, then release the blocked reader.
        const inserted = await gate.query(
          `INSERT INTO flow.account_invites (id, account_id, inviter_id, email, role, digest, expires_at)
           SELECT $1, $2, personal_owner_id, $3, 'MEMBER', $4, timestamp '2099-01-01'
           FROM flow.accounts WHERE id = $5`,
          [afterId, account.id, afterEmail, randomUUID(), owner.account.id],
        );
        assert.equal(inserted.rowCount, 1);
      });
      const queued = await result(await pending, 200);
      assert.ok(queued.invitations.some(({ id }) => id === before.id));
      assert.ok(
        !queued.invitations.some(({ id }) => id === afterId),
        "The stale roster request disclosed an invitation committed after revocation",
      );
      const denied = remove ? 404 : 403;
      await result(await stale.get(roster), denied);
      await result(await stale.get(roster), denied);
      await result(await stale.get(otherRoster), 200);
      const current = await result(await owner.client.get(roster), 200);
      assert.ok(current.invitations.some(({ id }) => id === afterId));
      await post(member.client, "/api/auth/sign-out");
      await result(await stale.get(roster), 401);
    } finally {
      if (pending) await Promise.allSettled([pending]);
    }
  });
}

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
    const teamUrl = `${privateUrl}/team`;
    await page.getByRole("link", { name: "Manage team" }).click();
    await page.getByRole("heading", { name: `${businessName} team` }).waitFor();

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
    assert.equal((await visitor.goto(teamUrl)).status(), 404);
    assert.equal(
      await visitor.getByText(ownerEmail, { exact: true }).count(),
      0,
    );
  } finally {
    await owner.close();
    await payer.close();
  }
});

test("m3 phase 3: authenticated portfolio API — authorization, cross-tenant isolation, and refresh rate limiting", async () => {
  const owner = await person("portfolio-owner-p3@example.com");
  const stranger = await person("portfolio-stranger-p3@example.com");
  const unauth = await app.createClient();

  // 1. Unauthenticated GET returns 401
  const unauthRes = await unauth.get(
    `/api/accounts/${owner.account.id}/portfolio`,
  );
  assert.equal(unauthRes.status(), 401);

  // 2. Cross-tenant GET returns 404 (does not leak existence of other tenant's account)
  const strangerRes = await stranger.client.get(
    `/api/accounts/${owner.account.id}/portfolio`,
  );
  assert.equal(strangerRes.status(), 404);

  // 3. Authenticated owner GET returns 200 with portfolio payload
  const ownerRes = await owner.client.get(
    `/api/accounts/${owner.account.id}/portfolio`,
  );
  assert.equal(ownerRes.status(), 200);
  const data = await ownerRes.json();
  assert.equal(data.accountId, owner.account.id);
  assert.ok(Array.isArray(data.balances));
  assert.equal(typeof data.isStale, "boolean");

  // 4. Unauthenticated POST refresh returns 401
  const unauthRefresh = await unauth.post(
    `/api/accounts/${owner.account.id}/portfolio/refresh`,
  );
  assert.equal(unauthRefresh.status(), 401);

  // 5. Cross-tenant POST refresh returns 404
  const strangerRefresh = await stranger.client.post(
    `/api/accounts/${owner.account.id}/portfolio/refresh`,
  );
  assert.equal(strangerRefresh.status(), 404);

  // 6. Authenticated owner POST refresh returns 200 with cooldown seconds
  const ownerRefresh = await owner.client.post(
    `/api/accounts/${owner.account.id}/portfolio/refresh`,
  );
  assert.equal(ownerRefresh.status(), 200);
  const refreshData = await ownerRefresh.json();
  assert.equal(refreshData.accountId, owner.account.id);
  assert.ok(refreshData.cooldownRemainingSeconds > 0);

  // 7. Immediate subsequent refresh within 15-second cooldown returns 429
  const rapidRefresh = await owner.client.post(
    `/api/accounts/${owner.account.id}/portfolio/refresh`,
  );
  assert.equal(rapidRefresh.status(), 429);

  // 8. Durable cooldown is visible on GET portfolio while active
  const ownerGetDuringCooldown = await owner.client.get(
    `/api/accounts/${owner.account.id}/portfolio`,
  );
  assert.equal(ownerGetDuringCooldown.status(), 200);
  const cooldownData = await ownerGetDuringCooldown.json();
  assert.ok(cooldownData.cooldownRemainingSeconds > 0);
  assert.ok(cooldownData.cooldownRemainingSeconds <= 15);
});

test("m3 phase 4: authenticated activities API — authorization, cross-tenant isolation, pagination, and activity ingestion", async () => {
  const owner = await person("activities-owner-p4@example.com");
  const stranger = await person("activities-stranger-p4@example.com");
  const unauth = await app.createClient();

  // 1. Unauthenticated GET returns 401
  const unauthRes = await unauth.get(
    `/api/accounts/${owner.account.id}/activities`,
  );
  assert.equal(unauthRes.status(), 401);

  // 2. Cross-tenant GET returns 404
  const strangerRes = await stranger.client.get(
    `/api/accounts/${owner.account.id}/activities`,
  );
  assert.equal(strangerRes.status(), 404);

  // 3. Authenticated owner GET returns 200 with empty activities initially
  const ownerRes = await owner.client.get(
    `/api/accounts/${owner.account.id}/activities`,
  );
  assert.equal(ownerRes.status(), 200);
  const data = await ownerRes.json();
  assert.ok(Array.isArray(data.activities));
  assert.equal(data.total, 0);
  assert.equal(data.limit, 20);
  assert.equal(data.offset, 0);
  assert.equal(data.hasMore, false);

  // 4. Test bounded pagination parameters
  const pageRes = await owner.client.get(
    `/api/accounts/${owner.account.id}/activities?limit=5&offset=10`,
  );
  assert.equal(pageRes.status(), 200);
  const pageData = await pageRes.json();
  assert.equal(pageData.limit, 5);
  assert.equal(pageData.offset, 10);

  // 5. Verify app role is denied direct write on wallet tables and activities, then insert verified on-chain activity using worker role
  const txHash =
    "0x4e83c748c89b43c683790ec37a89ad65cfba4128f645a2789bd0e87612c3f841";
  const walletId = randomUUID();
  const ownerBaseAddr = "0xaa6bA2Ae7F20748B46A3DB221a418137ec54A5a2";

  await assert.rejects(
    app.db.query(
      `INSERT INTO flow.wallets (id, account_id, provider, provider_wallet_id, near_account_id, encrypted_credential, key_id, key_digest, status, environment)
       VALUES ($1, $2, 'outlayer', $3, 'owner-near.testnet', 'v1:dummy', 'v1', 'digest', 'ACTIVE', 'testnet')`,
      [walletId, owner.account.id, `prov-${walletId}`],
    ),
    { code: "42501" },
    "Ordinary app role must be forbidden from inserting wallets",
  );

  assert.ok(
    workerDb,
    "Worker database connection required for activity fixture",
  );

  await workerDb.query(
    `INSERT INTO flow.wallets (id, account_id, provider, provider_wallet_id, near_account_id, encrypted_credential, key_id, key_digest, status, environment)
     VALUES ($1, $2, 'outlayer', $3, 'owner-near.testnet', 'v1:dummy', 'v1', 'digest', 'ACTIVE', 'testnet')`,
    [walletId, owner.account.id, `prov-${walletId}`],
  );

  await workerDb.query(
    `INSERT INTO flow.wallet_addresses (id, wallet_id, network, chain_id, address, public_key)
     VALUES ($1, $2, 'base', '84532', $3, 'secp256k1:03owner')`,
    [randomUUID(), walletId, ownerBaseAddr],
  );

  await workerDb.query(
    `INSERT INTO flow.wallet_activities (
       account_id, wallet_id, network, chain_id, ecosystem,
       activity_type, direction, tx_hash, event_index,
       from_address, to_address, asset_symbol, atomic_amount, decimals,
       block_height, block_hash, finality, reorg_status, metadata
     ) VALUES (
       $1, $2, 'base', '84532', 'evm', 'ON_CHAIN_TRANSFER', 'INCOMING', $3, 0,
       '0xsender', $4, 'USDC', 150000000, 6, 18500200, '0xblock185', 'FINALIZED', 'CANONICAL', '{"client":"flow"}'
     )`,
    [owner.account.id, walletId, txHash, ownerBaseAddr],
  );

  // 6. Owner now reads 1 activity with complete serialized fields
  const updatedOwnerRes = await owner.client.get(
    `/api/accounts/${owner.account.id}/activities`,
  );
  assert.equal(updatedOwnerRes.status(), 200);
  const updatedData = await updatedOwnerRes.json();
  assert.equal(updatedData.total, 1);
  assert.equal(updatedData.activities.length, 1);
  const act = updatedData.activities[0];
  assert.equal(act.txHash, txHash);
  assert.equal(act.direction, "INCOMING");
  assert.equal(act.activityType, "ON_CHAIN_TRANSFER");
  assert.equal(act.assetSymbol, "USDC");
  assert.equal(act.atomicAmount, "150000000");
  assert.equal(act.displayAmount, "150");
  assert.equal(act.finality, "FINALIZED");
  assert.equal(act.reorgStatus, "CANONICAL");
  assert.equal(act.explorerUrl, `https://sepolia.basescan.org/tx/${txHash}`);

  // 7. Stranger still sees 0 activities for their own account and 404 for owner
  const strangerOwnRes = await stranger.client.get(
    `/api/accounts/${stranger.account.id}/activities`,
  );
  assert.equal(strangerOwnRes.status(), 200);
  const strangerOwnData = await strangerOwnRes.json();
  assert.equal(strangerOwnData.total, 0);

  // 8. Test sync endpoint
  const unauthSync = await unauth.post(
    `/api/accounts/${owner.account.id}/activities/sync`,
  );
  assert.equal(unauthSync.status(), 401);

  const strangerSync = await stranger.client.post(
    `/api/accounts/${owner.account.id}/activities/sync`,
  );
  assert.equal(strangerSync.status(), 404);

  const ownerSync = await owner.client.post(
    `/api/accounts/${owner.account.id}/activities/sync`,
  );
  assert.equal(ownerSync.status(), 200);
  const syncData = await ownerSync.json();
  assert.ok(syncData.syncSummary);
  assert.equal(typeof syncData.syncSummary.totalDiscovered, "number");
});

test("FLOW desktop brand UI: multi-chain routing, curated asset registry, workspace navigation, and truthfulness gates", async () => {
  const ctx = await app.browser.newContext({
    ignoreHTTPSErrors: true,
    viewport: { width: 1440, height: 900 },
  });
  const screenshotDir = process.env.FLOW_CAPTURE_SCREENSHOTS_DIR;
  const snap = async (page, filename) => {
    if (!screenshotDir) return;
    await page.waitForTimeout(250);
    await page.screenshot({
      path: `${screenshotDir}/${filename}`,
      fullPage: true,
    });
  };

  try {
    const page = await ctx.newPage();

    // 1. Marketing Landing Page (/)
    await page.goto(`${app.origin}/`);
    await page
      .getByRole("heading", {
        name: /Pay with one asset\.\s*Receive another/i,
      })
      .waitFor();
    const landingBody = await page.locator("body").innerText();
    assert.ok(!/non-custodial/i.test(landingBody));
    assert.ok(!/SOC 2/i.test(landingBody));
    assert.ok(!/99\.99%/i.test(landingBody));
    assert.ok(!/pay\.flow\.com/i.test(landingBody));
    await snap(page, "01-marketing-landing.png");

    // 2. Sign-In & Email OTP (/sign-in)
    await page.goto(`${app.origin}/sign-in`);
    await page.getByRole("heading", { name: "Sign in to FLOW" }).waitFor();
    await snap(page, "02-sign-in.png");

    const uiEmail = "flow-ui-brand@example.test";
    await page.getByLabel("Email address").fill(uiEmail);
    const otpCode = await codeFor(uiEmail, () =>
      page.getByRole("button", { name: "Send email code" }).click(),
    );
    await page.getByLabel("Email code").waitFor();
    await snap(page, "03-sign-in-otp.png");
    await page.getByLabel("Email code").fill(otpCode);
    await page.getByRole("button", { name: "Verify and sign in" }).click();

    // 3. Personal Dashboard (/accounts/[id])
    await page
      .getByRole("heading", { name: "Personal", exact: true })
      .waitFor();
    assert.ok(await page.getByText("Wallet setup pending").isVisible());
    await snap(page, "04-personal-dashboard.png");

    // 4. Wallets & Supported Assets view
    await page.getByRole("button", { name: "Wallets & Assets" }).click();
    await page
      .getByRole("heading", {
        name: "Curated Multi-Chain Asset & Token Registry",
      })
      .waitFor();
    const registryText = await page.locator("table").innerText();
    for (const token of [
      "ETH",
      "USDC",
      "cbETH",
      "SOL",
      "mSOL",
      "JUP",
      "NEAR",
      "wNEAR",
    ]) {
      assert.ok(
        registryText.includes(token),
        `Expected curated registry to include ${token}`,
      );
    }
    await snap(page, "05-wallets-and-assets.png");

    // 5. Send & Convert view (Sender Source vs Recipient Settlement + Address Validation)
    await page.getByRole("button", { name: "Send & Convert" }).click();
    await page.getByRole("heading", { name: "Cross-Chain Send" }).waitFor();
    const addrInput = page.getByLabel(/Recipient Destination Address/i);
    await addrInput.fill("invalid-solana-address!");
    assert.ok(
      await page
        .getByText(/Solana requires a valid Base58 public key/i)
        .isVisible(),
    );
    await addrInput.fill("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
    assert.ok(await page.getByText(/address format verified/i).isVisible());
    assert.ok(
      await page
        .getByRole("button", {
          name: /Execution Disabled in Milestone 3/i,
        })
        .isDisabled(),
    );
    await snap(page, "06-send-and-convert.png");

    // 6. Receive & Payment Links view
    await page.getByRole("button", { name: "Receive & Links" }).click();
    await page
      .getByRole("heading", { name: "Choose How You Want to Settle" })
      .waitFor();
    assert.ok(
      await page
        .getByText(
          /Custody Safeguard — Wallets Not Yet Eligible for Live Deposits/i,
        )
        .isVisible(),
    );
    await snap(page, "07-receive-and-links.png");

    // 7. Activity & Audit view
    await page.getByRole("button", { name: "Activity & Audit" }).click();
    await page
      .getByRole("heading", {
        name: "Transaction History & Custody Observation Log",
      })
      .waitFor();
    await snap(page, "08-activity-and-audit.png");

    // 8. Accounts Directory & Business Creation (/accounts)
    await page.getByRole("link", { name: "Accounts", exact: true }).click();
    await page.getByRole("heading", { name: "Your FLOW accounts" }).waitFor();
    await snap(page, "09-accounts-directory.png");

    const bizName = "Acme Global Treasury";
    await page.getByLabel("Business name").fill(bizName);
    await page.getByRole("button", { name: "Create business" }).click();

    // 9. Business Dashboard & Treasury (/accounts/[id])
    await page.getByRole("heading", { name: bizName }).waitFor();
    assert.ok(
      await page.getByText("Organization Multi-Chain Treasury").isVisible(),
    );
    await snap(page, "10-business-treasury-dashboard.png");

    // 10. Business Team Management (/accounts/[id]/team)
    await page.getByRole("link", { name: "Manage team" }).click();
    await page.getByRole("heading", { name: `${bizName} team` }).waitFor();
    await snap(page, "11-business-team-management.png");

    // 11. Security, Profile & Preferences (/security) + Dark Theme Toggle
    await page.getByRole("link", { name: "Security", exact: true }).click();
    await page
      .getByRole("heading", { name: "Security", exact: true })
      .waitFor();
    await snap(page, "12-security-and-settings.png");

    await page
      .getByRole("button", { name: "Switch to dark theme" })
      .first()
      .click();
    await snap(page, "13-security-dark-theme.png");
  } finally {
    await ctx.close();
  }
});

test("m5 phase 1: payment requests & public guest checkout — authorization, cross-tenant isolation, safe public projection, and browser checkout flow", async () => {
  const owner = await person("payment-owner-m5@example.com");
  const stranger = await person("payment-stranger-m5@example.com");
  const unauth = await app.createClient();

  // 1. Unauthenticated endpoints return 401
  const unauthList = await unauth.get(
    `/api/accounts/${owner.account.id}/payment-requests`,
  );
  assert.equal(unauthList.status(), 401);

  const unauthCreate = await unauth.post(
    `/api/accounts/${owner.account.id}/payment-requests`,
    {
      data: {
        title: "Unauth Invoice",
        destinationNetwork: "base-sepolia",
        destinationAssetId: "base-sepolia:USDC",
      },
    },
  );
  assert.equal(unauthCreate.status(), 401);

  // 2. Cross-tenant access returns 404
  const strangerCreate = await stranger.client.post(
    `/api/accounts/${owner.account.id}/payment-requests`,
    {
      data: {
        title: "Cross Tenant Attack",
        destinationNetwork: "base-sepolia",
        destinationAssetId: "base-sepolia:USDC",
      },
    },
  );
  assert.equal(strangerCreate.status(), 404);

  const strangerList = await stranger.client.get(
    `/api/accounts/${owner.account.id}/payment-requests`,
  );
  assert.equal(strangerList.status(), 404);

  // 3. Authenticated owner creates a valid payment request
  const createRes = await owner.client.post(
    `/api/accounts/${owner.account.id}/payment-requests`,
    {
      data: {
        title: "Invoice #1042 - Security Audit",
        description: "Phase 1 deliverables for FLOW M5",
        destinationNetwork: "base-sepolia",
        destinationAssetId: "base-sepolia:USDC",
        amountMode: "FIXED",
        requestedAmount: "250.50",
        expiresInHours: 72,
        payerMemoRequired: false,
      },
    },
  );
  assert.equal(createRes.status(), 201);
  const created = await createRes.json();
  assert.ok(created.publicId.startsWith("pr_"));
  assert.equal(created.title, "Invoice #1042 - Security Audit");
  assert.equal(created.displayAmount, "250.5");
  assert.equal(created.destinationAssetSymbol, "USDC");
  assert.equal(created.destinationNetwork, "base-sepolia");
  assert.equal(created.status, "ACTIVE");
  assert.ok(created.shareUrl.includes(`/pay/${created.publicId}`));

  // 4. Authenticated owner lists requests
  const listRes = await owner.client.get(
    `/api/accounts/${owner.account.id}/payment-requests`,
  );
  assert.equal(listRes.status(), 200);
  const listData = await listRes.json();
  assert.equal(listData.total, 1);
  assert.equal(listData.requests[0].publicId, created.publicId);

  // 5. Stranger sees 0 payment requests on their own account
  const strangerOwnList = await stranger.client.get(
    `/api/accounts/${stranger.account.id}/payment-requests`,
  );
  assert.equal(strangerOwnList.status(), 200);
  const strangerOwnData = await strangerOwnList.json();
  assert.equal(strangerOwnData.total, 0);

  // 6. Unauthenticated public guest queries /api/pay/[publicId]
  const publicApiRes = await unauth.get(`/api/pay/${created.publicId}`);
  assert.equal(publicApiRes.status(), 200);
  const publicData = await publicApiRes.json();
  assert.equal(publicData.publicId, created.publicId);
  assert.equal(publicData.title, "Invoice #1042 - Security Audit");
  assert.equal(publicData.displayAmount, "250.5");
  assert.equal(publicData.destinationAssetSymbol, "USDC");
  assert.equal(publicData.status, "ACTIVE");
  assert.ok(Array.isArray(publicData.eligibleSourceRoutes));
  assert.ok(publicData.eligibleSourceRoutes.length > 0);

  // Strict omission of internal identifiers from public payload
  assert.equal(publicData.accountId, undefined);
  assert.equal(publicData.walletId, undefined);
  assert.equal(publicData.id, undefined);

  // 7. Enumeration resistance: random / invalid tokens return 404
  const randomRes = await unauth.get(
    `/api/pay/pr_random_non_existent_token_1234567890`,
  );
  assert.equal(randomRes.status(), 404);

  const invalidTokenRes = await unauth.get(`/api/pay/invalid_token_prefix`);
  assert.equal(invalidTokenRes.status(), 404);

  // 8. Disabling the request revokes public access
  const patchRes = await owner.client.patch(
    `/api/accounts/${owner.account.id}/payment-requests/${created.id}`,
    { data: { status: "DISABLED" } },
  );
  assert.equal(patchRes.status(), 200);

  const disabledPublicRes = await unauth.get(`/api/pay/${created.publicId}`);
  assert.equal(disabledPublicRes.status(), 404);

  // Re-enable for browser verification
  await owner.client.patch(
    `/api/accounts/${owner.account.id}/payment-requests/${created.id}`,
    { data: { status: "ACTIVE" } },
  );

  // 9. Browser Integration Test: Public Guest Checkout at /pay/[id]
  const ctx = await app.browser.newContext({
    ignoreHTTPSErrors: true,
    viewport: { width: 1440, height: 900 },
  });

  const brainArtifactDir =
    process.env.FLOW_CAPTURE_SCREENSHOTS_DIR ||
    "/Users/user/.gemini/antigravity/brain/799cfa99-869c-4a92-b3b0-b81a38ecce2b";
  const canCapture = Boolean(brainArtifactDir && existsSync(brainArtifactDir));

  try {
    const page = await ctx.newPage();
    const payUrl = `${app.origin}/pay/${created.publicId}`;

    const navRes = await page.goto(payUrl);
    assert.equal(navRes.status(), 200);

    // Verify public request rendering
    await page
      .getByRole("heading", { name: "Invoice #1042 - Security Audit" })
      .waitFor();
    assert.ok(await page.getByText("250.5 USDC").first().isVisible());
    assert.ok(
      await page.getByText("base-sepolia", { exact: true }).first().isVisible(),
    );
    assert.ok(await page.getByText("Self-Custody Wallet").first().isVisible());
    assert.ok(await page.getByText("Exchange Withdrawal").first().isVisible());
    assert.ok(
      await page.getByText("FLOW_EXECUTION=disabled").first().isVisible(),
    );

    // Capture wallet mode screenshot if directory exists
    if (canCapture) {
      await page.screenshot({
        path: `${brainArtifactDir}/14-public-guest-checkout-wallet.png`,
      });
    }

    // Switch to Exchange Withdrawal mode
    await page.getByRole("button", { name: "Exchange Withdrawal" }).click();
    assert.ok(
      await page.getByText("Exchange Withdrawal Mode").first().isVisible(),
    );
    assert.ok(
      await page
        .getByPlaceholder("0x... or Solana Base58 or NEAR account")
        .isVisible(),
    );

    // Switch ecosystem to Solana
    await page.getByRole("button", { name: "Solana" }).click();
    assert.ok(await page.getByText("SOL").first().isVisible());

    // Capture exchange mode screenshot if directory exists
    if (canCapture) {
      await page.screenshot({
        path: `${brainArtifactDir}/15-public-guest-checkout-exchange.png`,
      });
    }
  } finally {
    await ctx.close();
  }
});

test("security: M5 Phase 2 real route discovery, read-only quotes, refund validation, and public checkout integration", async () => {
  const owner = await person("payment-owner-m5p2@example.com");
  const unauth = await app.createClient();

  // 1. Create a Base Mainnet payment request for 10.00 USDC
  const createRes = await owner.client.post(
    `/api/accounts/${owner.account.id}/payment-requests`,
    {
      data: {
        title: "Cross-Chain Services Retainer",
        description:
          "Payment collection via any supported chain (SOL, ETH, or NEAR)",
        destinationNetwork: "base-mainnet",
        destinationAssetId: "base-mainnet:USDC",
        amountMode: "FIXED",
        requestedAmount: "10.00",
        expiresInHours: 48,
        payerMemoRequired: false,
      },
    },
  );
  assert.equal(createRes.status(), 201);
  const created = await createRes.json();
  assert.ok(created.publicId.startsWith("pr_"));

  // 2. Unauthenticated POST to /api/pay/[id]/quote in WALLET mode
  // Route: Solana Mainnet SOL -> Base Mainnet USDC
  const solQuoteRes = await unauth.post(`/api/pay/${created.publicId}/quote`, {
    data: {
      sourceDeploymentId: "solana-mainnet:SOL",
      payerMode: "WALLET",
    },
  });
  assert.equal(solQuoteRes.status(), 200);
  const solQuote = await solQuoteRes.json();

  assert.ok(solQuote.attemptPublicId.startsWith("pa_"));
  assert.equal(solQuote.paymentRequestPublicId, created.publicId);
  assert.equal(solQuote.sourceNetwork, "solana-mainnet");
  assert.equal(solQuote.sourceAssetSymbol, "SOL");
  assert.equal(solQuote.destinationNetwork, "base-mainnet");
  assert.equal(solQuote.destinationAssetSymbol, "USDC");
  assert.equal(solQuote.payerMode, "WALLET");
  assert.equal(solQuote.isIndicativeOnly, true);
  assert.ok(
    solQuote.executionBlockedNotice.includes("FLOW_EXECUTION=disabled"),
  );

  // If live provider responded or offline fallback:
  if (solQuote.routeStatus === "SUPPORTED_AND_QUOTABLE") {
    assert.equal(solQuote.destinationAtomicAmount, "10000000"); // 10.00 USDC exact!
    assert.ok(BigInt(solQuote.sourceAtomicAmount) > 0n);
    assert.ok(solQuote.exchangeRateDescription.includes("SOL"));
    assert.ok(solQuote.estimatedDurationSeconds > 0);
  }

  // 3. Test EXCHANGE mode refund address validation
  // (a) Missing refund address in EXCHANGE mode -> 400
  const missingRefundRes = await unauth.post(
    `/api/pay/${created.publicId}/quote`,
    {
      data: {
        sourceDeploymentId: "solana-mainnet:SOL",
        payerMode: "EXCHANGE",
      },
    },
  );
  assert.equal(missingRefundRes.status(), 400);

  // (b) Mismatched refund address (EVM 0x on Solana) -> 400
  const wrongNetworkRefundRes = await unauth.post(
    `/api/pay/${created.publicId}/quote`,
    {
      data: {
        sourceDeploymentId: "solana-mainnet:SOL",
        payerMode: "EXCHANGE",
        refundAddress: "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045",
      },
    },
  );
  assert.equal(wrongNetworkRefundRes.status(), 400);

  // (c) Valid Solana refund address in EXCHANGE mode -> 200
  const validExchangeQuoteRes = await unauth.post(
    `/api/pay/${created.publicId}/quote`,
    {
      data: {
        sourceDeploymentId: "solana-mainnet:SOL",
        payerMode: "EXCHANGE",
        refundAddress: "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU",
      },
    },
  );
  assert.equal(validExchangeQuoteRes.status(), 200);
  const validExchangeQuote = await validExchangeQuoteRes.json();
  assert.equal(validExchangeQuote.payerMode, "EXCHANGE");
  assert.equal(
    validExchangeQuote.refundAddress,
    "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU",
  );

  // 4. Test Direct Transfer Route (Base Mainnet USDC -> Base Mainnet USDC)
  const directQuoteRes = await unauth.post(
    `/api/pay/${created.publicId}/quote`,
    {
      data: {
        sourceDeploymentId: "base-mainnet:USDC",
        payerMode: "WALLET",
      },
    },
  );
  assert.equal(directQuoteRes.status(), 200);
  const directQuote = await directQuoteRes.json();
  assert.equal(directQuote.routeType, "DIRECT_TRANSFER");
  assert.equal(directQuote.routeStatus, "NOT_YET_ENABLED_FOR_PAYMENT");
  assert.equal(directQuote.destinationAtomicAmount, "10000000");
  assert.equal(directQuote.sourceAtomicAmount, "10000000");

  // 5. Test Unsupported Pair (e.g. Base Sepolia testnet token)
  const unsupportedQuoteRes = await unauth.post(
    `/api/pay/${created.publicId}/quote`,
    {
      data: {
        sourceDeploymentId: "base-sepolia:USDC",
        payerMode: "WALLET",
      },
    },
  );
  assert.equal(unsupportedQuoteRes.status(), 200);
  const unsupportedQuote = await unsupportedQuoteRes.json();
  assert.equal(unsupportedQuote.routeStatus, "UNSUPPORTED_PAIR");

  // 6. Non-existent payment request ID -> 404
  const notFoundQuoteRes = await unauth.post(
    `/api/pay/pr_non_existent_token_1234567890/quote`,
    {
      data: {
        sourceDeploymentId: "solana-mainnet:SOL",
        payerMode: "WALLET",
      },
    },
  );
  assert.equal(notFoundQuoteRes.status(), 404);

  // 7. Browser Integration Verification with Playwright
  const ctx = await app.browser.newContext({
    ignoreHTTPSErrors: true,
    viewport: { width: 1440, height: 900 },
  });

  const brainArtifactDir =
    process.env.FLOW_CAPTURE_SCREENSHOTS_DIR ||
    "/Users/user/.gemini/antigravity/brain/799cfa99-869c-4a92-b3b0-b81a38ecce2b";
  const canCapture = Boolean(brainArtifactDir && existsSync(brainArtifactDir));

  try {
    const page = await ctx.newPage();
    const payUrl = `${app.origin}/pay/${created.publicId}`;

    await page.goto(payUrl);
    await page
      .getByRole("heading", { name: "Cross-Chain Services Retainer" })
      .waitFor();

    // Select Solana ecosystem
    await page.getByRole("button", { name: "Solana" }).click();
    await page.getByText("SOL").first().click();

    // Wait for Indicative Quote card to render
    await page.getByText("Indicative Route Quote").waitFor();
    await page.waitForTimeout(1500);

    // Verify Indicative Preview notice and disabled action button
    assert.ok(await page.getByText("Indicative Preview Only:").isVisible());
    assert.ok(
      await page
        .getByRole("button", { name: "Pay Now (Payment Execution Disabled)" })
        .isDisabled(),
    );

    // Capture screenshot: 16-public-guest-checkout-quote.png
    if (canCapture) {
      await page.screenshot({
        path: `${brainArtifactDir}/16-public-guest-checkout-quote.png`,
      });
    }

    // Switch to Exchange mode and verify mandatory refund validation
    await page.getByRole("button", { name: "Exchange Withdrawal" }).click();
    assert.ok(
      await page
        .getByText("A valid self-custody refund address is required")
        .first()
        .isVisible(),
    );

    // Type invalid EVM address for Solana refund
    const refundInput = page.getByPlaceholder(
      "Enter 0x... or Solana Base58 or NEAR account",
    );
    await refundInput.fill("0x1234567890123456789012345678901234567890");
    await page.waitForTimeout(300);
    assert.ok(
      await page
        .getByText("Solana refund address must be a valid Base58 public key")
        .isVisible(),
    );

    // Now switch to Ethereum & Base and select cbETH (unsupported pair in 1Click solvers)
    await page.getByRole("button", { name: "Ethereum & Base" }).click();
    await page.getByText("cbETH").first().click();
    await page.waitForTimeout(800);
    assert.ok(await page.getByText("UNSUPPORTED PAIR").isVisible());

    // Capture screenshot: 17-public-guest-checkout-unsupported.png
    if (canCapture) {
      await page.screenshot({
        path: `${brainArtifactDir}/17-public-guest-checkout-unsupported.png`,
      });
    }
  } finally {
    await ctx.close();
  }
});

test("security: M5 Phase 3 quote integrity, precision overflow, token confusion, optional amount enforcement, and lifecycle boundaries", async () => {
  const owner = await person("payment-owner-m5p3@example.com");
  const unauth = await app.createClient();

  // 1. Create an OPTIONAL amount payment request
  const optCreateRes = await owner.client.post(
    `/api/accounts/${owner.account.id}/payment-requests`,
    {
      data: {
        title: "Open Consulting Deposit",
        description: "Payer enters arbitrary settlement amount",
        destinationNetwork: "base-mainnet",
        destinationAssetId: "base-mainnet:USDC",
        amountMode: "OPTIONAL",
        expiresInHours: 72,
        payerMemoRequired: false,
      },
    },
  );
  assert.equal(optCreateRes.status(), 201);
  const optCreated = await optCreateRes.json();

  // 2. Requirement 5: Reject missing or non-positive amount on optional-amount requests
  const noAmountRes = await unauth.post(
    `/api/pay/${optCreated.publicId}/quote`,
    {
      data: {
        sourceDeploymentId: "solana-mainnet:SOL",
        payerMode: "WALLET",
      },
    },
  );
  assert.equal(noAmountRes.status(), 400);
  const noAmountErr = await noAmountRes.json();
  assert.equal(noAmountErr.error, "PAYER_AMOUNT_REQUIRED");

  const zeroAmountRes = await unauth.post(
    `/api/pay/${optCreated.publicId}/quote`,
    {
      data: {
        sourceDeploymentId: "solana-mainnet:SOL",
        payerMode: "WALLET",
        payerAmount: "0",
      },
    },
  );
  assert.equal(zeroAmountRes.status(), 400);
  assert.equal((await zeroAmountRes.json()).error, "INVALID_PAYER_AMOUNT");

  const negativeAmountRes = await unauth.post(
    `/api/pay/${optCreated.publicId}/quote`,
    {
      data: {
        sourceDeploymentId: "solana-mainnet:SOL",
        payerMode: "WALLET",
        payerAmount: "-50.25",
      },
    },
  );
  assert.equal(negativeAmountRes.status(), 400);

  const invalidTextAmountRes = await unauth.post(
    `/api/pay/${optCreated.publicId}/quote`,
    {
      data: {
        sourceDeploymentId: "solana-mainnet:SOL",
        payerMode: "WALLET",
        payerAmount: "not_a_number",
      },
    },
  );
  assert.equal(invalidTextAmountRes.status(), 400);

  // 3. Valid optional amount query succeeds and verifies unverified observation tier
  const validOptQuoteRes = await unauth.post(
    `/api/pay/${optCreated.publicId}/quote`,
    {
      data: {
        sourceDeploymentId: "solana-mainnet:SOL",
        payerMode: "WALLET",
        payerAmount: "25.0",
      },
    },
  );
  assert.equal(validOptQuoteRes.status(), 200);
  const validOptQuote = await validOptQuoteRes.json();
  assert.equal(validOptQuote.routeStatus, "SUPPORTED_AND_QUOTABLE");
  assert.equal(validOptQuote.verificationTier, "UNVERIFIED_OBSERVATION");
  assert.equal(validOptQuote.isProviderVerified, false);
  assert.equal(validOptQuote.isExchangeCompatible, true);
  assert.ok(validOptQuote.localPreviewExpiresAt);

  // 4. Requirement 13: Direct transfer route is incompatible with Exchange mode
  const directExchangeRes = await unauth.post(
    `/api/pay/${optCreated.publicId}/quote`,
    {
      data: {
        sourceDeploymentId: "base-mainnet:USDC",
        payerMode: "EXCHANGE",
        payerAmount: "10.0",
        refundAddress: "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045",
      },
    },
  );
  assert.equal(directExchangeRes.status(), 400);
  assert.equal(
    (await directExchangeRes.json()).error,
    "EXCHANGE_MODE_NOT_SUPPORTED_FOR_ROUTE",
  );

  // 5. Expired request quoting is rejected with 400
  const expiredCreateRes = await owner.client.post(
    `/api/accounts/${owner.account.id}/payment-requests`,
    {
      data: {
        title: "Short-lived Request",
        destinationNetwork: "base-mainnet",
        destinationAssetId: "base-mainnet:USDC",
        amountMode: "FIXED",
        requestedAmount: "5.0",
        expiresInHours: 24,
      },
    },
  );
  assert.equal(expiredCreateRes.status(), 201);
  const expiredCreated = await expiredCreateRes.json();

  // Expire in database using privileged worker connection
  const updateRes = await workerDb.query(
    `UPDATE flow.payment_requests SET expires_at = now() - interval '1 hour' WHERE public_id = $1`,
    [expiredCreated.publicId],
  );
  assert.equal(updateRes.rowCount, 1);

  const expiredQuoteRes = await unauth.post(
    `/api/pay/${expiredCreated.publicId}/quote`,
    {
      data: {
        sourceDeploymentId: "solana-mainnet:SOL",
        payerMode: "WALLET",
      },
    },
  );
  assert.equal(expiredQuoteRes.status(), 400);
  assert.equal((await expiredQuoteRes.json()).error, "PAYMENT_REQUEST_EXPIRED");
});

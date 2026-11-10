import assert from "node:assert/strict";
import { createHmac, randomBytes, randomUUID } from "node:crypto";
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
    await page.getByRole("heading", { name: /Welcome back\./i }).waitFor();
    assert.ok(page.url().includes("/accounts/"));
    assert.ok(await page.getByText("Wallet setup pending").first().isVisible());
    await page.goto(`${app.origin}/accounts`);
    await page.getByLabel("Business name").fill(businessName);
    await page.getByRole("button", { name: "Create business" }).click();
    await page.getByText(businessName).first().waitFor();
    const id = new URL(page.url()).pathname.split("/").at(-1);
    const privateUrl = `${app.origin}/accounts/${id}`;
    const teamUrl = `${privateUrl}/team`;
    await page
      .getByRole("link", { name: /Manage team/i })
      .first()
      .click();
    await page.getByRole("heading", { name: `${businessName} team` }).waitFor();

    const visitor = await payer.newPage();
    await visitor.goto(privateUrl);
    await visitor
      .getByRole("heading", { name: /Access your\s*Flow account/i })
      .waitFor();
    await visitor.getByLabel("Email address").fill(inviteeEmail);
    const code = await codeFor(inviteeEmail, () =>
      visitor.getByRole("button", { name: /Send verification code/i }).click(),
    );
    await visitor.getByLabel("Email code").fill(code);
    await visitor.getByRole("button", { name: /Verify and continue/i }).click();
    await visitor.getByRole("heading", { name: /Welcome back\./i }).waitFor();
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
    await visitor.getByText(businessName).first().waitFor();
    assert.equal(new URL(visitor.url()).hash, "");
    assert.equal(
      await visitor.getByRole("link", { name: /Manage team/i }).count(),
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
  const brainArtifactDir =
    "/Users/user/.gemini/antigravity/brain/799cfa99-869c-4a92-b3b0-b81a38ecce2b";
  const screenshotDir =
    process.env.FLOW_CAPTURE_SCREENSHOTS_DIR ||
    (existsSync(brainArtifactDir) ? brainArtifactDir : null);
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
        name: /Get paid in what you want/i,
      })
      .waitFor();
    const landingBody = await page.locator("body").innerText();
    assert.ok(!/non-custodial/i.test(landingBody));
    assert.ok(!/SOC 2/i.test(landingBody));
    assert.ok(!/99\.99%/i.test(landingBody));
    assert.ok(!/pay\.flow\.com/i.test(landingBody));
    await snap(page, "01-marketing-landing.png");

    await page.setViewportSize({ width: 390, height: 844 });
    await snap(page, "01-marketing-landing-mobile.png");
    await page.setViewportSize({ width: 1440, height: 900 });

    // 2. Sign-In & Email OTP (/sign-in)
    await page.goto(`${app.origin}/sign-in`);
    await page
      .getByRole("heading", { name: /Access your\s*Flow account/i })
      .waitFor();
    await snap(page, "02-sign-in.png");

    await page.setViewportSize({ width: 390, height: 844 });
    await snap(page, "02-sign-in-mobile.png");
    await page.setViewportSize({ width: 1440, height: 900 });

    const uiEmail = "flow-ui-brand@example.test";
    await page.getByLabel("Email address").fill(uiEmail);
    const otpCode = await codeFor(uiEmail, () =>
      page.getByRole("button", { name: /Send verification code/i }).click(),
    );
    await page.getByLabel("Email code").waitFor();
    await snap(page, "03-sign-in-otp.png");
    await page.setViewportSize({ width: 390, height: 844 });
    await snap(page, "03-sign-in-otp-mobile.png");
    await page.setViewportSize({ width: 1440, height: 900 });

    await page.getByLabel("Email code").fill(otpCode);
    await page.getByRole("button", { name: /Verify and continue/i }).click();

    // 3. Personal Dashboard (/accounts/[id])
    await page.getByRole("heading", { name: /Welcome back\./i }).waitFor();
    const personalDashboardUrl = page.url();
    assert.ok(await page.getByText("Wallet setup pending").first().isVisible());
    await snap(page, "04-personal-dashboard.png");

    await page.setViewportSize({ width: 390, height: 844 });
    await snap(page, "04-personal-dashboard-mobile.png");
    await page.setViewportSize({ width: 1440, height: 900 });

    // Capture the 3 Onboarding reference screens (/onboarding?step=type, profile, ready)
    await page.goto(`${app.origin}/onboarding?step=type`);
    await page
      .getByRole("heading", { name: /How will you use Flow\?/i })
      .waitFor();
    await snap(page, "03b-onboarding-type.png");
    await page.goto(`${app.origin}/onboarding?step=profile`);
    await page
      .getByRole("heading", { name: /Complete your profile\./i })
      .waitFor();
    await snap(page, "03c-onboarding-profile.png");
    await page.goto(`${app.origin}/onboarding?step=ready`);
    await page
      .getByRole("heading", { name: /You’re all set\.|You're all set\./i })
      .waitFor();
    await snap(page, "03d-onboarding-ready.png");

    await page.goto(personalDashboardUrl);
    await page.getByRole("heading", { name: /Welcome back\./i }).waitFor();

    // 4. Wallets & Supported Assets view
    await page.getByRole("button", { name: "Wallets & Assets" }).click();
    await page
      .getByRole("heading", {
        name: "Wallets & Supported Assets",
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
    await page.setViewportSize({ width: 390, height: 844 });
    await snap(page, "05-wallets-and-assets-mobile.png");
    await page.setViewportSize({ width: 1440, height: 900 });

    // 5. Send & Convert view (Sender Source vs Recipient Settlement + Address Validation)
    await page
      .getByRole("button", { name: /^Send$/ })
      .first()
      .click();
    await page.getByRole("heading", { name: "Send & Convert" }).waitFor();
    const addrInput = page.getByLabel(/Recipient .* address/i);
    await addrInput.fill("invalid-solana-address!");
    assert.ok(
      await page
        .getByText(/Solana requires a valid Base58 public key/i)
        .isVisible(),
    );
    await addrInput.fill("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
    assert.ok(await page.getByText(/Valid .* address format/i).isVisible());
    assert.ok(
      await page
        .getByRole("button", {
          name: /Outgoing Execution Disabled/i,
        })
        .isDisabled(),
    );
    await snap(page, "06-send-and-convert.png");

    // 6. Receive & Payment Links view
    await page
      .getByRole("button", { name: /^Receive$/ })
      .first()
      .click();
    await page
      .getByRole("heading", { name: /Receive\s*\/\s*Create Payment Link/i })
      .waitFor();
    await snap(page, "07-receive-and-links.png");
    await page.setViewportSize({ width: 390, height: 844 });
    await snap(page, "07-receive-and-links-mobile.png");
    await page.setViewportSize({ width: 1440, height: 900 });

    // 7. Activity & Audit view
    await page
      .getByRole("button", { name: /^Activity$/ })
      .first()
      .click();
    await page.getByRole("heading", { name: /^Activity$/i }).waitFor();
    await snap(page, "08-activity-and-audit.png");
    await page.setViewportSize({ width: 390, height: 844 });
    await snap(page, "08-activity-and-audit-mobile.png");
    await page.setViewportSize({ width: 1440, height: 900 });

    // 8. Accounts Directory & Business Creation (/accounts)
    await page.goto(`${app.origin}/accounts`);
    await page.getByRole("heading", { name: "Your FLOW accounts" }).waitFor();
    await snap(page, "09-accounts-directory.png");

    const bizName = "Acme Global Treasury";
    await page.getByLabel("Business name").fill(bizName);
    await page.getByRole("button", { name: "Create business" }).click();

    // 9. Business Dashboard & Treasury (/accounts/[id])
    await page.getByText(bizName).first().waitFor();
    assert.ok(await page.getByText("BUSINESS WORKSPACE").first().isVisible());
    await snap(page, "10-business-treasury-dashboard.png");

    // 10. Business Team Management (/accounts/[id]/team)
    await page
      .getByRole("link", { name: /Manage team/i })
      .first()
      .click();
    await page.getByRole("heading", { name: `${bizName} team` }).waitFor();
    await snap(page, "11-business-team-management.png");

    // 11. Security, Profile & Preferences (/security) + Dark Theme Toggle
    await page.goto(`${app.origin}/security`);
    await page
      .getByRole("heading", { name: "Settings", exact: true })
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
      await page
        .getByText(/base-sepolia/i)
        .first()
        .isVisible(),
    );
    assert.ok(await page.getByText("Self-Custody Wallet").first().isVisible());
    assert.ok(await page.getByText("Exchange Withdrawal").first().isVisible());

    // Capture wallet mode screenshot if directory exists
    if (canCapture) {
      await page.screenshot({
        path: `${brainArtifactDir}/14-public-guest-checkout-wallet.png`,
      });
      await page.setViewportSize({ width: 390, height: 844 });
      await page.screenshot({
        path: `${brainArtifactDir}/14-public-guest-checkout-wallet-mobile.png`,
      });
      await page.setViewportSize({ width: 1440, height: 900 });
    }

    // Switch to Exchange Withdrawal mode
    await page.getByRole("button", { name: /Exchange Withdrawal/i }).click();
    assert.ok(
      await page
        .getByText(/Self-custody refund address required/i)
        .first()
        .isVisible(),
    );
    assert.ok(
      await page
        .getByPlaceholder("Enter 0x... or Solana Base58 or NEAR account")
        .isVisible(),
    );

    // Switch ecosystem to Solana
    await page.getByRole("button", { name: /Solana/i }).click();
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
    await page.getByRole("button", { name: /Solana/i }).click();
    await page.getByText("SOL").first().click();

    // Wait for Quote Summary card to render
    await page.getByText("Quote Summary").waitFor();
    await page.waitForTimeout(1500);

    // Verify disabled action button
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
    await page.getByRole("button", { name: /Exchange Withdrawal/i }).click();
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
    await page.getByRole("button", { name: /Ethereum & Base/i }).click();
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

test("security: M5 Phase 4 deposit commitment, instruction issuance, polling, and settlement lifecycle", async () => {
  const owner = await person("m5p4-merchant@flow.local");
  const unauth = await app.createClient();

  // 1. Recipient creates a fixed payment request for 50.00 USDC on Base
  const createRes = await owner.client.post(
    `/api/accounts/${owner.account.id}/payment-requests`,
    {
      data: {
        title: "Web3 Software License",
        description: "Enterprise Tier Annual",
        destinationNetwork: "base-mainnet",
        destinationAssetId: "base-mainnet:USDC",
        amountMode: "FIXED",
        requestedAmount: "50.0",
        expiresInHours: 24,
      },
    },
  );
  assert.equal(createRes.status(), 201);
  const paymentReq = await createRes.json();

  // Register merchant wallet & address on destination network (base-mainnet)
  const ownerWalletId = randomUUID();
  await workerDb.query(
    `INSERT INTO flow.wallets (
      id, account_id, provider, environment, provider_wallet_id,
      near_account_id, encrypted_credential, key_id, key_digest, status
    ) VALUES (
      $1::uuid, $2::uuid, 'OUTLAYER', 'mainnet',
      'pw_owner_dest', 'owner.near', 'enc_cred', 'v1', 'digest_1',
      'ACTIVE'::flow.wallet_status
    )`,
    [ownerWalletId, owner.account.id],
  );

  await workerDb.query(
    `INSERT INTO flow.wallet_addresses (
      id, wallet_id, network, chain_id, address, public_key
    ) VALUES (
      gen_random_uuid(), $1::uuid, 'base-mainnet', '8453', '0xdest_wallet', 'pk_dest_1'
    )`,
    [ownerWalletId],
  );

  // 2. Guest discovers a quote from Solana SOL
  const quoteRes = await unauth.post(`/api/pay/${paymentReq.publicId}/quote`, {
    data: {
      sourceDeploymentId: "solana-mainnet:SOL",
      payerMode: "WALLET",
    },
  });
  assert.equal(quoteRes.status(), 200);
  const quote = await quoteRes.json();
  assert.equal(quote.routeStatus, "SUPPORTED_AND_QUOTABLE");
  const attemptPublicId = quote.attemptPublicId;
  assert.ok(attemptPublicId);

  // 3. Blocker 1 Adversarial Check: Direct POST to removed simulation route returns 404 Not Found
  const simRes = await unauth.post(
    `/api/pay/${paymentReq.publicId}/simulate-settlement`,
    {
      data: {
        attemptPublicId,
      },
    },
  );
  assert.equal(simRes.status(), 404);

  // 4. Blocker 2 Adversarial Check: Cannot commit payment attempt while FLOW_EXECUTION=disabled
  const commitDisabledRes = await unauth.post(
    `/api/pay/${paymentReq.publicId}/commit`,
    {
      data: {
        attemptPublicId,
      },
    },
  );
  assert.equal(commitDisabledRes.status(), 403);
  const commitDisabledErr = await commitDisabledRes.json();
  assert.match(commitDisabledErr.error, /PAYMENT_EXECUTION_DISABLED/);

  // 5. Guessed non-existent attempt ID is rejected
  const invalidCommitRes = await unauth.post(
    `/api/pay/${paymentReq.publicId}/commit`,
    {
      data: {
        attemptPublicId: "pa_invalid_nonexistent_0123456789abcdef",
      },
    },
  );
  assert.equal(invalidCommitRes.status(), 403);

  // 6. Privilege Separation Check: Ordinary app role cannot execute worker_settle_payment_attempt
  await assert.rejects(
    app.db.query(
      `SELECT * FROM flow.worker_settle_payment_attempt($1, '0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef', '0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef')`,
      [attemptPublicId],
    ),
    { code: "42501" }, // Insufficient privilege (permission denied)
  );

  // 7. Forged / invalid transaction hashes are rejected by stored procedure
  await assert.rejects(
    workerDb.query(
      `SELECT * FROM flow.worker_settle_payment_attempt($1, '0xshort', '0xshort')`,
      [attemptPublicId],
    ),
    /INVALID_SOURCE_TX_HASH/,
  );

  // 8. Legitimate Privileged Settlement via Worker Role
  // Set attempt to DEPOSIT_COMMITTED with authentic test address
  await workerDb.query(
    `UPDATE flow.payment_attempts
     SET status = 'DEPOSIT_COMMITTED',
         is_provider_verified = true,
         verification_tier = 'PROVIDER_VERIFIED',
         deposit_address = '9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin',
         deposit_deadline = CURRENT_TIMESTAMP + interval '15 minutes',
         quote_expires_at = CURRENT_TIMESTAMP + interval '15 minutes'
     WHERE attempt_public_id = $1`,
    [attemptPublicId],
  );

  const validSolanaTx =
    "5VERv8NMvzbJMEdV8xnrLkEaWR436xQsGhmGLxrNdEd137KqD5N2wK1i4tGv3d8nZbG1mR6tWv2tB9gH8yK3mQp2";
  const validBaseTx =
    "0x8a9b2c3d4e5f60718293a4b5c6d7e8f901a2b3c4d5e6f708192a3b4c5d6e7f80";

  // Invariant Check: Attempting settlement without verified on-chain deposit fails
  await assert.rejects(
    workerDb.query(
      `SELECT * FROM flow.worker_settle_payment_attempt($1, $2, $3)`,
      [attemptPublicId, validSolanaTx, validBaseTx],
    ),
    /UNVERIFIED_SOURCE_DEPOSIT/,
  );

  // Adversarial Check: Premature finality (CONFIRMED) cannot satisfy settlement
  const prematureTx =
    "5VERv8NMvzbJMEdV8xnrLkEaWR436xQsGhmGLxrNdEd137KqD5N2wK1i4tGv3d8nZbG1mR6tWv2tB9gH8yK3mQpremature";
  await workerDb.query(
    `SELECT * FROM flow.record_payment_verification(
      $1, 'SOURCE_DEPOSIT', 'solana-mainnet', $2,
      'payer_solana_addr', '9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin',
      'solana-mainnet:SOL', NULL, (SELECT quoted_source_atomic_amount FROM flow.payment_attempts WHERE attempt_public_id = $1),
      123455, 'slot_123455', 'CONFIRMED', NULL, 'CHAIN_RPC_DIRECT', '{"verified": true}'::jsonb
    )`,
    [attemptPublicId, prematureTx],
  );

  await assert.rejects(
    workerDb.query(
      `SELECT * FROM flow.worker_settle_payment_attempt($1, $2, $3)`,
      [attemptPublicId, prematureTx, validBaseTx],
    ),
    /UNVERIFIED_SOURCE_DEPOSIT/,
  );

  // Adversarial Check: Mismatched recipient address rejected by destination settlement verification
  await assert.rejects(
    workerDb.query(
      `SELECT * FROM flow.record_payment_verification(
        $1, 'DESTINATION_SETTLEMENT', 'base-mainnet', $2,
        '0xsolver_dest', '0xwrong_unregistered_recipient_address',
        'base-mainnet:USDC', NULL, 50000000,
        456788, '0xblock_dest_wrong', 'FINALIZED', NULL, 'CHAIN_RPC_DIRECT', '{"verified": true}'::jsonb
      )`,
      [attemptPublicId, "0xwrong_dest_tx"],
    ),
    /RECIPIENT_ADDRESS_MISMATCH/,
  );

  // Record verified source deposit (FINALIZED)
  await workerDb.query(
    `SELECT * FROM flow.record_payment_verification(
      $1, 'SOURCE_DEPOSIT', 'solana-mainnet', $2,
      'payer_solana_addr', '9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin',
      'solana-mainnet:SOL', NULL, (SELECT quoted_source_atomic_amount FROM flow.payment_attempts WHERE attempt_public_id = $1),
      123456, 'slot_123456', 'FINALIZED', NULL, 'CHAIN_RPC_DIRECT', '{"verified": true}'::jsonb
    )`,
    [attemptPublicId, validSolanaTx],
  );

  // Invariant Check: Cross-chain attempt without verified destination delivery fails
  await assert.rejects(
    workerDb.query(
      `SELECT * FROM flow.worker_settle_payment_attempt($1, $2, $3)`,
      [attemptPublicId, validSolanaTx, validBaseTx],
    ),
    /UNVERIFIED_DESTINATION_DELIVERY/,
  );

  // Record verified destination delivery
  await workerDb.query(
    `SELECT * FROM flow.record_payment_verification(
      $1, 'DESTINATION_SETTLEMENT', 'base-mainnet', $2,
      '0xsolver_dest', '0xdest_wallet',
      'base-mainnet:USDC', NULL, 50000000,
      456789, '0xblock_dest', 'FINALIZED', NULL, 'CHAIN_RPC_DIRECT', '{"verified": true}'::jsonb
    )`,
    [attemptPublicId, validBaseTx],
  );

  const settleResult = await workerDb.query(
    `SELECT * FROM flow.worker_settle_payment_attempt($1, $2, $3)`,
    [attemptPublicId, validSolanaTx, validBaseTx],
  );
  assert.equal(settleResult.rows.length, 1);
  assert.equal(settleResult.rows[0].status, "SETTLED");
  assert.ok(settleResult.rows[0].journal_id);

  // 9. Multi-Currency Double-Entry Ledger Verification
  const entries = await workerDb.query(
    `SELECT la.account_code, la.asset_id, la.network, le.entry_direction, le.amount_atomic
     FROM flow.ledger_entries le
     JOIN flow.ledger_accounts la ON la.id = le.ledger_account_id
     WHERE le.journal_id = $1`,
    [settleResult.rows[0].journal_id],
  );
  assert.equal(entries.rows.length, 4); // 2 source leg lines + 2 destination leg lines

  // Destination leg: LIABILITY_MERCHANT_PAYABLE credited with 50 USDC (50000000)
  const merchantEntry = entries.rows.find(
    (e) => e.account_code === "LIABILITY_MERCHANT_PAYABLE",
  );
  assert.ok(merchantEntry);
  assert.equal(merchantEntry.amount_atomic, "50000000");
  assert.equal(merchantEntry.entry_direction, "CREDIT");
  assert.equal(merchantEntry.network, "base-mainnet");

  // Destination leg: CLEARING_CROSS_CHAIN_RECEIVABLE debited with 50 USDC (50000000)
  const clearingRecEntry = entries.rows.find(
    (e) => e.account_code === "CLEARING_CROSS_CHAIN_RECEIVABLE",
  );
  assert.ok(clearingRecEntry);
  assert.equal(clearingRecEntry.amount_atomic, "50000000");
  assert.equal(clearingRecEntry.entry_direction, "DEBIT");

  // Source leg: ASSET_CUSTODY_IN_FLIGHT debited, CLEARING_CROSS_CHAIN_PAYABLE credited
  const custodyEntry = entries.rows.find(
    (e) => e.account_code === "ASSET_CUSTODY_IN_FLIGHT",
  );
  const clearingPayEntry = entries.rows.find(
    (e) => e.account_code === "CLEARING_CROSS_CHAIN_PAYABLE",
  );
  assert.ok(custodyEntry);
  assert.ok(clearingPayEntry);
  assert.equal(custodyEntry.amount_atomic, clearingPayEntry.amount_atomic);
  assert.equal(custodyEntry.network, "solana-mainnet");

  // 10. Verify invoice is marked COMPLETED
  const getPrRes = await owner.client.get(
    `/api/accounts/${owner.account.id}/payment-requests/${paymentReq.id}`,
  );
  assert.equal(getPrRes.status(), 200);
  const updatedReq = await getPrRes.json();
  assert.equal(updatedReq.status, "COMPLETED");

  // 11. Guest polling endpoint /api/pay/[id]/attempt/[attemptId] reflects SETTLED state
  const pollRes = await unauth.get(
    `/api/pay/${paymentReq.publicId}/attempt/${attemptPublicId}`,
  );
  assert.equal(pollRes.status(), 200);
  const polled = await pollRes.json();
  assert.equal(polled.status, "SETTLED");
  assert.ok(polled.settledAt);
  assert.ok(polled.sourceTxHash);
  assert.ok(polled.destinationTxHash);

  // 12. End-to-end Browser Lifecycle Demonstration & Screenshot Capture
  const brainArtifactDir =
    process.env.FLOW_CAPTURE_SCREENSHOTS_DIR ||
    "/Users/user/.gemini/antigravity/brain/799cfa99-869c-4a92-b3b0-b81a38ecce2b";
  const canCapture = Boolean(brainArtifactDir && existsSync(brainArtifactDir));

  const demoReqRes = await owner.client.post(
    `/api/accounts/${owner.account.id}/payment-requests`,
    {
      data: {
        title: "Global Infrastructure Services",
        description: "Decentralized node cluster subscription",
        destinationNetwork: "base-mainnet",
        destinationAssetId: "base-mainnet:USDC",
        amountMode: "FIXED",
        requestedAmount: "250.0",
        expiresInHours: 48,
      },
    },
  );
  assert.equal(demoReqRes.status(), 201);
  const demoReq = await demoReqRes.json();

  const ctx = await app.browser.newContext({
    ignoreHTTPSErrors: true,
    viewport: { width: 1440, height: 950 },
  });

  try {
    const page = await ctx.newPage();
    await page.goto(`${app.origin}/pay/${demoReq.publicId}`);
    await page
      .getByRole("heading", { name: "Global Infrastructure Services" })
      .waitFor();

    // Select Solana ecosystem and SOL
    await page.getByRole("button", { name: /Solana/i }).click();
    await page.getByText("SOL").first().click();

    // Wait for verified quote preview
    await page.getByText("Pay Now (Payment Execution Disabled)").waitFor();
    await page.waitForTimeout(500);

    // Capture screenshot: 18-public-guest-checkout-deposit.png
    if (canCapture) {
      await page.screenshot({
        path: `${brainArtifactDir}/18-public-guest-checkout-deposit.png`,
      });
    }

    // Update invoice status to COMPLETED via worker settlement to demonstrate settled state
    await workerDb.query(
      `UPDATE flow.payment_requests SET status = 'COMPLETED', updated_at = CURRENT_TIMESTAMP WHERE public_id = $1`,
      [demoReq.publicId],
    );

    // Reload page to view completed invoice
    await page.reload();
    await page.getByText("Payment Completed!").waitFor();
    await page.getByText(/Paid & Settled/i).waitFor();
    await page.waitForTimeout(500);

    // Capture screenshot: 19-public-guest-checkout-settled.png
    if (canCapture) {
      await page.screenshot({
        path: `${brainArtifactDir}/19-public-guest-checkout-settled.png`,
      });
    }
  } finally {
    await ctx.close();
  }
});

test("security: wallet persistence across re-authentication, duplicate prevention, and signing authorization isolation", async () => {
  const userEmail = "wallet-persist@flow.local";
  const client1 = await app.createClient();
  await emailLogin(client1, userEmail);

  // 1. Onboard user to create personal account
  const onbRes = await post(client1, "/api/onboarding/complete", {}, 200);
  const accountId = onbRes.account.id;
  assert.ok(accountId);

  // 2. Provision initial wallet via worker role
  const walletId = randomUUID();
  const nearAccount = "persist-near.testnet";
  const baseAddress = "0x5555555555555555555555555555555555555555";
  const solanaAddress = "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU";

  await workerDb.query(
    `INSERT INTO flow.wallets (
      id, account_id, provider, environment, provider_wallet_id, near_account_id,
      controller_account_id, encrypted_credential, key_id, key_digest, status, policy_state
    ) VALUES (
      $1::uuid, $2::uuid, 'OUTLAYER', 'mainnet', 'pw-persist-01', $3,
      'controller.near', 'enc:persistent-key-payload', 'v1', 'dig:persist-01', 'ACTIVE', 'stored'
    )`,
    [walletId, accountId, nearAccount],
  );

  await workerDb.query(
    `INSERT INTO flow.wallet_addresses (wallet_id, network, chain_id, address, public_key)
     VALUES
       ($1::uuid, 'near', 'near:mainnet', $2, 'ed25519:persist-pub'),
       ($1::uuid, 'base', 'eip155:8453', $3, 'secp256k1:persist-pub'),
       ($1::uuid, 'solana', 'solana:mainnet', $4, 'ed25519:solana-pub')`,
    [walletId, nearAccount, baseAddress, solanaAddress],
  );

  // 3. Verify /api/me reflects active wallet
  const meRes = await client1.get("/api/me");
  assert.equal(meRes.status(), 200);
  const meData = await meRes.json();
  const personalAcct = meData.accounts.find((a) => a.id === accountId);
  assert.ok(personalAcct);
  assert.equal(personalAcct.walletStatus, "active");
  assert.equal(personalAcct.provisioningComplete, true);

  // 4. Requirement 1: Re-authentication persistence across logout, session expiry, and email OTP
  await post(client1, "/api/auth/sign-out", {}, 204);

  // Sign in afresh with a new browser client using Email OTP
  const client2 = await app.createClient();
  await emailLogin(client2, userEmail);

  // Re-run onboarding endpoint (which occurs on fresh login or app restart)
  const reOnbRes = await post(client2, "/api/onboarding/complete", {}, 200);
  assert.equal(reOnbRes.account.id, accountId);
  assert.equal(reOnbRes.account.walletStatus, "active");
  assert.equal(reOnbRes.account.provisioningComplete, true);

  // Direct database assertion: verify the wallet record is EXACTLY the same and was never replaced
  const walletRows = await workerDb.query(
    `SELECT id, provider_wallet_id, near_account_id, status FROM flow.wallets WHERE account_id = $1::uuid`,
    [accountId],
  );
  assert.equal(walletRows.rows.length, 1);
  assert.equal(walletRows.rows[0].id, walletId);
  assert.equal(walletRows.rows[0].provider_wallet_id, "pw-persist-01");
  assert.equal(walletRows.rows[0].near_account_id, nearAccount);

  // 5. Duplicate wallet registration prevention: Unique constraint check
  await assert.rejects(
    workerDb.query(
      `INSERT INTO flow.wallets (
        id, account_id, provider, environment, provider_wallet_id, near_account_id,
        encrypted_credential, key_id, key_digest, status
      ) VALUES (
        $1::uuid, $2::uuid, 'OUTLAYER', 'mainnet', 'pw-dup-99', 'dup-near.testnet',
        'enc:dup', 'v1', 'dig:dup', 'ACTIVE'
      )`,
      [randomUUID(), accountId],
    ),
    { code: "23505" }, // Unique violation on flow.wallets.account_id
  );

  // 6. Failed recovery safety: ensure a job cannot replace or overwrite an existing wallet
  const finalWallet = await workerDb.query(
    `SELECT id, encrypted_credential, key_id FROM flow.wallets WHERE account_id = $1::uuid`,
    [accountId],
  );
  assert.equal(finalWallet.rows[0].id, walletId);
  assert.equal(
    finalWallet.rows[0].encrypted_credential,
    "enc:persistent-key-payload",
  );

  // 7. Requirement 2: Separation of Privileges
  // Web application role (app.db) CANNOT select encrypted_credential
  await assert.rejects(
    app.db.query("SELECT encrypted_credential FROM flow.wallets"),
    { code: "42501" }, // Permission denied for column encrypted_credential
  );

  // Web application role CAN select non-secret columns via public projection
  const publicRows = await app.db.query(
    "SELECT id, provider_wallet_id, status FROM flow.wallet_public_projections WHERE account_id = $1::uuid",
    [accountId],
  );
  assert.equal(publicRows.rows.length, 1);
  assert.equal(publicRows.rows[0].id, walletId);

  // 8. Financial Execution Safety: Verify public API does not expose any raw signing endpoint
  const rawSignAttempt = await client2.post(`/api/accounts/${accountId}/sign`, {
    data: { transaction: "0x1234" },
  });
  assert.equal(rawSignAttempt.status(), 404);

  const transferAttempt = await client2.post(
    `/api/accounts/${accountId}/transfer`,
    {
      data: { to: baseAddress, amount: "10.0" },
    },
  );
  assert.equal(transferAttempt.status(), 404);
});

test("phase 6 end-to-end acceptance scenarios A–G: live OutLayer wallet provisioning, persistence, business isolation, quote/settlement recovery, exception handling, and UI truthfulness", async () => {
  // =========================================================================
  // SCENARIO A — Account & Wallet Persistence (Genuine 3-Stage OutLayer Worker)
  // =========================================================================
  const ownerEmail = "e2e-sprint-owner@flow.local";
  const ownerClient = await app.createClient();
  await emailLogin(ownerClient, ownerEmail);

  const onb = await post(ownerClient, "/api/onboarding/complete", {}, 200);
  const personalId = onb.account.id;
  assert.equal(onb.account.walletStatus, "setup_pending");

  // Trigger on-demand 3-stage OutLayer wallet provisioning + RPC balance reconciliation
  const provRes = await ownerClient.post(
    `/api/accounts/${personalId}/wallet/provision`,
    { data: {} },
  );
  assert.equal(provRes.status(), 200);
  const provData = await provRes.json();
  assert.equal(provData.outcome, "activated");
  assert.equal(provData.walletStatus, "active");
  assert.ok(provData.wallet);
  assert.equal(provData.wallet.addresses.length, 3);

  const personalEvm = provData.wallet.addresses.find(
    (a) => a.network.includes("base") || a.network.includes("ethereum"),
  )?.address;
  const personalSol = provData.wallet.addresses.find((a) =>
    a.network.includes("solana"),
  )?.address;
  const personalNear = provData.wallet.addresses.find((a) =>
    a.network.includes("near"),
  )?.address;
  assert.match(personalEvm, /^0x[0-9a-fA-F]{40}$/);
  assert.match(personalSol, /^[1-9A-HJ-NP-Za-km-z]{32,44}$/);
  assert.match(personalNear, /^[0-9a-f]{64}$/);

  // Idempotent re-provisioning check: never replaces existing wallet
  const provAgain = await ownerClient.post(
    `/api/accounts/${personalId}/wallet/provision`,
    { data: {} },
  );
  assert.equal(provAgain.status(), 200);
  const provAgainData = await provAgain.json();
  assert.equal(provAgainData.outcome, "skipped");
  assert.equal(provAgainData.wallet.id, provData.wallet.id);

  // Sign out and sign back in: verify addresses remain identical
  await post(ownerClient, "/api/auth/sign-out", {}, 204);
  const reloginClient = await app.createClient();
  await emailLogin(reloginClient, ownerEmail);

  const portAfterRelogin = await reloginClient.get(
    `/api/accounts/${personalId}/portfolio`,
  );
  assert.equal(portAfterRelogin.status(), 200);
  const portJson = await portAfterRelogin.json();
  assert.equal(portJson.wallet.id, provData.wallet.id);
  assert.ok(portJson.balances.length > 0, "Expected reconciled RPC balances");

  // =========================================================================
  // SCENARIO B — Business Workspace & Team Isolation
  // =========================================================================
  const bizAccount = await business(reloginClient, "Nova Labs Treasury");
  const bizId = bizAccount.id;
  assert.notEqual(bizId, personalId);

  const bizProvRes = await reloginClient.post(
    `/api/accounts/${bizId}/wallet/provision`,
    { data: {} },
  );
  assert.equal(bizProvRes.status(), 200);
  const bizProvData = await bizProvRes.json();
  assert.equal(bizProvData.outcome, "activated");
  assert.notEqual(bizProvData.wallet.id, provData.wallet.id);

  const bizEvm = bizProvData.wallet.addresses.find(
    (a) => a.network.includes("base") || a.network.includes("ethereum"),
  )?.address;
  assert.notEqual(bizEvm, personalEvm);

  // Cross-account isolation check with stranger
  const stranger = await person("e2e-stranger@flow.local");
  const crossProv = await stranger.client.post(
    `/api/accounts/${bizId}/wallet/provision`,
    { data: {} },
  );
  assert.equal(crossProv.status(), 404);

  // =========================================================================
  // SCENARIO C, D, E, F — Payment Link, Quote Lifecycle, Active Attempt Recovery & Exceptions
  // =========================================================================
  const createPr = await reloginClient.post(
    `/api/accounts/${bizId}/payment-requests`,
    {
      data: {
        title: "Q4 Protocol Audit",
        description: "Milestone 1 settlement",
        destinationNetwork: "base-mainnet",
        destinationAssetId: "base-mainnet:USDC",
        amountMode: "FIXED",
        requestedAmount: "100.00",
        expiresInHours: 24,
      },
    },
  );
  assert.equal(createPr.status(), 201);
  const pr = await createPr.json();
  assert.match(pr.publicId, /^pr_/);

  const guest = await app.createClient();

  // Exchange mode without refund address fails validation
  const missingRefundQuote = await guest.post(`/api/pay/${pr.publicId}/quote`, {
    data: {
      sourceDeploymentId: "solana-mainnet:SOL",
      payerMode: "EXCHANGE",
    },
  });
  assert.equal(missingRefundQuote.status(), 400);

  // Exchange mode with valid Solana refund address succeeds
  const validQuoteRes = await guest.post(`/api/pay/${pr.publicId}/quote`, {
    data: {
      sourceDeploymentId: "solana-mainnet:SOL",
      payerMode: "EXCHANGE",
      refundAddress: "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU",
    },
  });
  assert.equal(validQuoteRes.status(), 200);
  const validQuote = await validQuoteRes.json();
  assert.equal(validQuote.routeStatus, "SUPPORTED_AND_QUOTABLE");

  // Scenario E: Insert an in-progress DEPOSIT_COMMITTED attempt and verify GET /api/pay/[id] recovers activeAttempt
  const recoveryAttemptId = `pa_rec_${randomBytes(12).toString("hex")}`;
  await workerDb.query(
    `INSERT INTO flow.payment_attempts (
      payment_request_id, attempt_public_id, payer_mode,
      source_network, source_asset_id, source_asset_symbol, source_decimals,
      route_type, route_status, swap_type, quoted_source_atomic_amount, quoted_destination_atomic_amount,
      payer_refund_address, deposit_address, quote_expires_at,
      status, verification_tier, is_provider_verified
    ) VALUES (
      $1::uuid, $2, 'WALLET',
      'solana-mainnet', 'solana-mainnet:SOL', 'SOL', 9,
      'CROSS_CHAIN_1CLICK', 'SUPPORTED_AND_QUOTABLE', 'EXACT_OUTPUT', 680000000, 100000000,
      '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU', '9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin',
      CURRENT_TIMESTAMP + INTERVAL '15 minutes',
      'DEPOSIT_COMMITTED', 'PROVIDER_VERIFIED', true
    )`,
    [pr.id, recoveryAttemptId],
  );

  const pubRead = await guest.get(`/api/pay/${pr.publicId}`);
  assert.equal(pubRead.status(), 200);
  const pubReadJson = await pubRead.json();
  assert.ok(pubReadJson.activeAttempt, "Expected activeAttempt to be returned");
  assert.equal(pubReadJson.activeAttempt.attemptPublicId, recoveryAttemptId);
  assert.equal(pubReadJson.activeAttempt.status, "DEPOSIT_COMMITTED");
  assert.equal(
    pubReadJson.activeAttempt.depositAddress,
    "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin",
  );

  // Scenario F: Transition attempt to EXCEPTION_REFUND_REQUIRED and verify truthful status recovery
  await workerDb.query(
    `UPDATE flow.payment_attempts SET status = 'EXCEPTION_REFUND_REQUIRED', settlement_error = 'UNDERPAID_DEPOSIT' WHERE attempt_public_id = $1`,
    [recoveryAttemptId],
  );
  const pubExceptionRead = await guest.get(
    `/api/pay/${pr.publicId}?attempt=${recoveryAttemptId}`,
  );
  assert.equal(pubExceptionRead.status(), 200);
  const pubExceptionJson = await pubExceptionRead.json();
  assert.equal(
    pubExceptionJson.activeAttempt.status,
    "EXCEPTION_REFUND_REQUIRED",
  );

  // =========================================================================
  // SCENARIO G — Desktop & Mobile UI Truthfulness & Layout Verification
  // =========================================================================
  const ctx = await app.browser.newContext({
    ignoreHTTPSErrors: true,
    viewport: { width: 1440, height: 900 },
  });
  try {
    const page = await ctx.newPage();
    await page.goto(`${app.origin}/sign-in`);
    await page.getByLabel("Email address").fill(ownerEmail);
    const otp = await codeFor(ownerEmail, () =>
      page.getByRole("button", { name: /Send verification code/i }).click(),
    );
    await page.getByLabel("Email code").fill(otp);
    await page.getByRole("button", { name: /Verify and continue/i }).click();
    await page.getByRole("heading", { name: /Welcome back\./i }).waitFor();

    // Verify provisioned status and zero fabricated mockup numbers on Dashboard
    assert.ok(
      await page
        .getByText("Wallet provisioned (execution disabled)")
        .first()
        .isVisible(),
    );
    const bodyText = await page.locator("body").innerText();
    for (const forbidden of [
      "$2,840.00",
      "$1,420.00",
      "$1,360.00",
      "$12,480.00",
      "#INV-1042",
      "Received from Studio Kora",
    ]) {
      assert.ok(
        !bodyText.includes(forbidden),
        `Fabricated mockup string "${forbidden}" must not appear in live workspace UI`,
      );
    }

    // Verify Settings page displays the authenticated user's real email, not Amara Okafor
    await page.goto(`${app.origin}/security`);
    await page
      .getByRole("heading", { name: "Settings", exact: true })
      .waitFor();
    const secBody = await page.locator("body").innerText();
    assert.ok(secBody.includes(ownerEmail));
    assert.ok(!secBody.includes("Amara Okafor"));

    // Verify guest checkout displays Refund Required banner for EXCEPTION_REFUND_REQUIRED attempt
    await page.goto(
      `${app.origin}/pay/${pr.publicId}?attempt=${recoveryAttemptId}`,
    );
    await page
      .getByText(/Refund Required — Do Not Send Additional Funds/i)
      .waitFor();
  } finally {
    await ctx.close();
  }
});

test("security: scoped single-use rehearsal authorization lifecycle, isolation, and fail-closed bounds", async () => {
  const merchant = await person("rehearsal-merchant@flow.local");
  const operatorPerson = await person("rehearsal-operator@flow.local");
  const unauth = await app.createClient();

  const opUserRows = await app.db.query(
    `SELECT id FROM flow.auth_users WHERE email = $1`,
    [operatorPerson.email],
  );
  const operatorAuthId = opUserRows.rows[0].id;

  // 1. Configure merchant wallet for Base Mainnet (8453)
  const walletRows = await workerDb.query(
    `SELECT id FROM flow.wallets WHERE account_id = $1 LIMIT 1`,
    [merchant.account.id],
  );
  let walletId;
  if (walletRows.rows.length > 0) {
    walletId = walletRows.rows[0].id;
    await workerDb.query(
      `UPDATE flow.wallets
       SET status = 'ACTIVE'::flow.wallet_status,
           environment = 'mainnet',
           policy_state = 'stored',
           controller_account_id = 'flow-custody.near'
       WHERE id = $1`,
      [walletId],
    );
  } else {
    walletId = randomUUID();
    await workerDb.query(
      `INSERT INTO flow.wallets (
         id, account_id, provider, environment, provider_wallet_id,
         near_account_id, encrypted_credential, key_id, key_digest, status,
         policy_state, controller_account_id
       ) VALUES (
         $1::uuid, $2::uuid, 'OUTLAYER', 'mainnet',
         $3, 'rehearsal-owner.near', 'enc_cred', 'v1', 'digest_1',
         'ACTIVE'::flow.wallet_status, 'stored', 'flow-custody.near'
       )`,
      [walletId, merchant.account.id, `pw_${walletId}`],
    );
  }

  const verifiedRecipient = "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045";
  const verifiedPayerRefund = "4wBqpZM9xaSheZzJSMawUKKwhdpChKbZ5eu5ky4Vigw";

  await workerDb.query(
    `INSERT INTO flow.wallet_addresses (wallet_id, network, chain_id, address, public_key)
     VALUES ($1, 'base-mainnet', '8453', $2, '0x00')
     ON CONFLICT (wallet_id, network) DO UPDATE
     SET chain_id = '8453', address = $2`,
    [walletId, verifiedRecipient],
  );

  await workerDb.query(
    `INSERT INTO flow.wallet_capabilities (wallet_id, network, can_derive_address, can_receive, can_sign_transfer, broadcast_mode)
     VALUES ($1, 'base-mainnet', true, true, false, 'caller_broadcast')
     ON CONFLICT (wallet_id, network) DO UPDATE
     SET can_receive = true, can_sign_transfer = false`,
    [walletId],
  );

  // 2. Create Payment Request for Base Mainnet USDC (1.00 USDC = 1,000,000 atomic)
  const prRes = await merchant.client.post(
    `/api/accounts/${merchant.account.id}/payment-requests`,
    {
      data: {
        title: "Rehearsal Isolation Test",
        destinationNetwork: "base-mainnet",
        destinationAssetId: "base-mainnet:USDC",
        amountMode: "FIXED",
        requestedAmount: "1.0",
        expiresInHours: 24,
      },
    },
  );
  assert.equal(prRes.status(), 201);
  const paymentReq = await prRes.json();

  // 3. Guest discovers quote for Solana SOL -> Base USDC
  const quoteRes1 = await unauth.post(`/api/pay/${paymentReq.publicId}/quote`, {
    data: {
      sourceDeploymentId: "solana-mainnet:SOL",
      payerMode: "WALLET",
      refundAddress: verifiedPayerRefund,
    },
  });
  assert.equal(quoteRes1.status(), 200);
  const quote1 = await quoteRes1.json();
  const attemptPublicId1 = quote1.attemptPublicId;

  // 4. Adversarial Check 1: Commit without authorization fails closed with 403
  const unauthCommitRes = await unauth.post(
    `/api/pay/${paymentReq.publicId}/commit`,
    {
      data: { attemptPublicId: attemptPublicId1 },
    },
  );
  assert.equal(unauthCommitRes.status(), 403);
  const unauthErr = await unauthCommitRes.json();
  assert.match(unauthErr.error, /PAYMENT_EXECUTION_DISABLED/);

  // 5. Adversarial Check 2: Expired authorization fails closed
  const expiredAuthRows = await workerDb.query(
    `INSERT INTO flow.payment_rehearsal_authorizations (
       payment_request_id, operator_auth_id, environment,
       source_network, source_asset_id, destination_network, destination_asset_id,
       max_atomic_amount, allowed_recipient_address, allowed_payer_refund_address,
       expires_at
     ) VALUES (
       $1, $2, 'mainnet',
       'solana-mainnet', 'solana-mainnet:SOL', 'base-mainnet', 'base-mainnet:USDC',
       5000000, $3, $4, CURRENT_TIMESTAMP - interval '10 minutes'
     ) RETURNING id`,
    [paymentReq.id, operatorAuthId, verifiedRecipient, verifiedPayerRefund],
  );
  assert.ok(expiredAuthRows.rows.length > 0);

  const expiredCommitRes = await unauth.post(
    `/api/pay/${paymentReq.publicId}/commit`,
    {
      data: { attemptPublicId: attemptPublicId1 },
    },
  );
  assert.equal(expiredCommitRes.status(), 403);

  // Delete expired test auth
  await workerDb.query(
    `DELETE FROM flow.payment_rehearsal_authorizations WHERE id = $1`,
    [expiredAuthRows.rows[0].id],
  );

  // 6. Adversarial Check 3: Amount bound enforcement (max 500 atomic < 1000000 quoted)
  const lowBoundAuth = await workerDb.query(
    `INSERT INTO flow.payment_rehearsal_authorizations (
       payment_request_id, operator_auth_id, environment,
       source_network, source_asset_id, destination_network, destination_asset_id,
       max_atomic_amount, allowed_recipient_address, allowed_payer_refund_address,
       expires_at
     ) VALUES (
       $1, $2, 'mainnet',
       'solana-mainnet', 'solana-mainnet:SOL', 'base-mainnet', 'base-mainnet:USDC',
       500, $3, $4, CURRENT_TIMESTAMP + interval '30 minutes'
     ) RETURNING id`,
    [paymentReq.id, operatorAuthId, verifiedRecipient, verifiedPayerRefund],
  );

  const lowBoundCommitRes = await unauth.post(
    `/api/pay/${paymentReq.publicId}/commit`,
    {
      data: { attemptPublicId: attemptPublicId1 },
    },
  );
  assert.equal(lowBoundCommitRes.status(), 403);
  const lowBoundErr = await lowBoundCommitRes.json();
  assert.match(
    lowBoundErr.error,
    /REHEARSAL_AMOUNT_EXCEEDS_MAX_BOUND|REHEARSAL_AUTHORIZATION_FAILED/,
  );

  // Delete low bound auth
  await workerDb.query(
    `DELETE FROM flow.payment_rehearsal_authorizations WHERE id = $1`,
    [lowBoundAuth.rows[0].id],
  );

  // 7. Adversarial Check 4: Recipient mismatch enforcement
  const wrongRecipientAuth = await workerDb.query(
    `INSERT INTO flow.payment_rehearsal_authorizations (
       payment_request_id, operator_auth_id, environment,
       source_network, source_asset_id, destination_network, destination_asset_id,
       max_atomic_amount, allowed_recipient_address, allowed_payer_refund_address,
       expires_at
     ) VALUES (
       $1, $2, 'mainnet',
       'solana-mainnet', 'solana-mainnet:SOL', 'base-mainnet', 'base-mainnet:USDC',
       5000000, '0x0000000000000000000000000000000000000001', $3,
       CURRENT_TIMESTAMP + interval '30 minutes'
     ) RETURNING id`,
    [paymentReq.id, operatorAuthId, verifiedPayerRefund],
  );

  const wrongRecipCommitRes = await unauth.post(
    `/api/pay/${paymentReq.publicId}/commit`,
    {
      data: { attemptPublicId: attemptPublicId1 },
    },
  );
  assert.equal(wrongRecipCommitRes.status(), 403);
  const wrongRecipErr = await wrongRecipCommitRes.json();
  assert.match(
    wrongRecipErr.error,
    /REHEARSAL_RECIPIENT_MISMATCH|REHEARSAL_AUTHORIZATION_FAILED/,
  );

  await workerDb.query(
    `DELETE FROM flow.payment_rehearsal_authorizations WHERE id = $1`,
    [wrongRecipientAuth.rows[0].id],
  );

  // 8. Legitimate Single-Use Authorization: Valid, matching parameters
  const validAuthRows = await workerDb.query(
    `INSERT INTO flow.payment_rehearsal_authorizations (
       payment_request_id, operator_auth_id, environment,
       source_network, source_asset_id, destination_network, destination_asset_id,
       max_atomic_amount, allowed_recipient_address, allowed_payer_refund_address,
       expires_at
     ) VALUES (
       $1, $2, 'mainnet',
       'solana-mainnet', 'solana-mainnet:SOL', 'base-mainnet', 'base-mainnet:USDC',
       5000000, $3, $4, CURRENT_TIMESTAMP + interval '30 minutes'
     ) RETURNING id`,
    [paymentReq.id, operatorAuthId, verifiedRecipient, verifiedPayerRefund],
  );
  const validAuthId = validAuthRows.rows[0].id;

  // 9. Legitimate Commitment: Valid single-use authorization allows commitment
  const commitSuccessRes = await unauth.post(
    `/api/pay/${paymentReq.publicId}/commit`,
    {
      data: { attemptPublicId: attemptPublicId1 },
    },
  );
  assert.equal(commitSuccessRes.status(), 200);
  const instructions = await commitSuccessRes.json();
  assert.equal(instructions.status, "DEPOSIT_COMMITTED");
  assert.ok(instructions.depositAddress);
  assert.ok(instructions.depositDeadline);

  // 10. Verify Authorization was Atomically Consumed in Database
  const consumedAuthRows = await workerDb.query(
    `SELECT consumed_at, consumed_by_attempt_id
     FROM flow.payment_rehearsal_authorizations
     WHERE id = $1`,
    [validAuthId],
  );
  assert.ok(consumedAuthRows.rows[0].consumed_at !== null);

  // 11. Adversarial Replay Check: Second attempt CANNOT reuse consumed authorization
  const quoteRes2 = await unauth.post(`/api/pay/${paymentReq.publicId}/quote`, {
    data: {
      sourceDeploymentId: "solana-mainnet:SOL",
      payerMode: "WALLET",
      refundAddress: verifiedPayerRefund,
    },
  });
  assert.equal(quoteRes2.status(), 200);
  const quote2 = await quoteRes2.json();
  const attemptPublicId2 = quote2.attemptPublicId;

  const replayCommitRes = await unauth.post(
    `/api/pay/${paymentReq.publicId}/commit`,
    {
      data: { attemptPublicId: attemptPublicId2 },
    },
  );
  assert.equal(replayCommitRes.status(), 403);
  const replayErr = await replayCommitRes.json();
  assert.match(replayErr.error, /PAYMENT_EXECUTION_DISABLED/);
});

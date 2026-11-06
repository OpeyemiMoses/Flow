import assert from "node:assert/strict";
import { test } from "node:test";
import { FlowError } from "../src/foundation/errors.ts";
import { log, redact } from "../src/foundation/logger.ts";

test("redacts sensitive fields recursively while keeping diagnostic fields", () => {
  assert.deepEqual(
    redact({
      requestId: "req-123",
      credential: "sensitive",
      entries: [{ api_key: "sensitive", cookie: "sensitive", amount: 123n }],
    }),
    {
      requestId: "req-123",
      credential: "[REDACTED]",
      entries: [{ api_key: "[REDACTED]", cookie: "[REDACTED]", amount: "123" }],
    },
  );
});

test("redacts database URLs, authorization strings and key-bearing URLs from text", () => {
  const sanitized = redact(
    "postgresql://flow_test_app:example%40password@127.0.0.1:5432/flow_test " +
      "Bearer sample-authorization wk_samplekey " +
      "https://example.test/wallet?key=sample-handoff eyJexample.payload.signature",
  );
  assert.equal(
    sanitized,
    "[REDACTED] [REDACTED] [REDACTED] [REDACTED] [REDACTED]",
  );
});

test("redacts unquoted, quoted and JSON credential assignments in free-form text", () => {
  const message =
    "status=ready password=plain;fixture,tail PGPASSWORD: admin-fixture " +
    "refresh_token='two words' " +
    '{"client_secret":"three \\"quoted\\" words"} API key: api-fixture x-api-key=proxy-fixture count=2';
  assert.equal(
    redact(message),
    "status=ready password=[REDACTED] PGPASSWORD: [REDACTED] " +
      "refresh_token='[REDACTED]' " +
      '{"client_secret":"[REDACTED]"} API key: [REDACTED] x-api-key=[REDACTED] count=2',
  );
});

test("redacts multiple cookie values and authorization headers without losing other lines", () => {
  const message =
    "status=ready\nCookie: session=fixture; another=fixture\n" +
    "proxy Set-Cookie: sid=proxy-fixture; Path=/\n" +
    "Authorization: Basic header-fixture\nroute=health authORIZATION=Bearer inline-fixture";
  const expected =
    "status=ready\nCookie: [REDACTED]\nproxy Set-Cookie: [REDACTED]\nAuthorization: [REDACTED]\n" +
    "route=health authORIZATION=[REDACTED]";
  assert.equal(redact(message), expected);
  assert.equal(redact(expected), expected);
});

test("drops raw error messages, stacks and causes", () => {
  assert.deepEqual(redact(new Error("hidden password")), {
    code: "INTERNAL_ERROR",
  });
  assert.deepEqual(
    redact(new FlowError("DATABASE_UNAVAILABLE", "hidden connection")),
    {
      code: "DATABASE_UNAVAILABLE",
    },
  );
});

test("writes a structured redacted log record", (context) => {
  const sink = context.mock.method(console, "info", () => {});
  log("info", "database_ready", {
    environment: "test",
    password: "fixture-only",
  });
  const output = sink.mock.calls[0]?.arguments[0];
  assert.equal(typeof output, "string");
  const record = JSON.parse(String(output));
  assert.equal(record.level, "info");
  assert.equal(record.event, "database_ready");
  assert.deepEqual(record.fields, {
    environment: "test",
    password: "[REDACTED]",
  });
});

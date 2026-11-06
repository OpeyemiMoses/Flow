import { isIP } from "node:net";
import { z } from "zod";
import { FlowError } from "./errors.ts";

type FlowEnvironment = "local" | "test" | "staging" | "production";

const fixtureGoogleId = "000000-flow-fixture.apps.googleusercontent.com";
const authVariables = z.object({
  FLOW_APP_ORIGIN: z.url(),
  FLOW_AUTH_SECRET: z.string().regex(/^[a-f0-9]{64}$/),
  FLOW_OTP_KEY: z.string().regex(/^[a-f0-9]{64}$/),
  FLOW_GOOGLE_CLIENT_ID: z
    .string()
    .regex(/^[a-z0-9-]+\.apps\.googleusercontent\.com$/),
  FLOW_GOOGLE_CLIENT_SECRET: z
    .string()
    .min(16)
    .max(256)
    .regex(/^[\w-]+$/),
  FLOW_MAIL_API_KEY: z.string().regex(/^re_[\w-]{16,256}$/),
  FLOW_MAIL_FROM: z.email().max(254),
  FLOW_CLIENT_IP_HEADER: z.enum(["x-real-ip", "cf-connecting-ip"]).optional(),
});

export function readAuthConfig(
  source: Readonly<Record<string, string | undefined>>,
  environment: FlowEnvironment,
) {
  const parsed = authVariables.safeParse(source);
  if (!parsed.success) {
    const names = parsed.error.issues.map((issue) => issue.path.join("."));
    throw new FlowError(
      "INVALID_CONFIGURATION",
      `Invalid authentication settings: ${names.join(", ")}.`,
    );
  }

  const values = parsed.data;
  const origin = new URL(values.FLOW_APP_ORIGIN);
  const secure = origin.protocol === "https:";
  const loopback = ["127.0.0.1", "localhost", "[::1]"].includes(
    origin.hostname,
  );
  const local = environment === "local" || environment === "test";
  const fixture = values.FLOW_GOOGLE_CLIENT_ID === fixtureGoogleId;
  const fixtureSecret =
    values.FLOW_GOOGLE_CLIENT_SECRET.startsWith("flow-fixture-");
  const fixtureMail = values.FLOW_MAIL_API_KEY.startsWith("re_flow_fixture_");
  const placeholder =
    values.FLOW_GOOGLE_CLIENT_ID.startsWith("replace-") ||
    values.FLOW_GOOGLE_CLIENT_SECRET.startsWith("replace-");
  if (
    origin.origin !== values.FLOW_APP_ORIGIN ||
    (local ? !loopback : loopback || isIP(origin.hostname) !== 0) ||
    (!secure && (!local || origin.protocol !== "http:")) ||
    placeholder ||
    (environment === "test"
      ? !(fixture && fixtureSecret && fixtureMail)
      : fixture || fixtureSecret || fixtureMail) ||
    values.FLOW_AUTH_SECRET === values.FLOW_OTP_KEY ||
    new Set(values.FLOW_AUTH_SECRET).size < 8 ||
    new Set(values.FLOW_OTP_KEY).size < 8
  ) {
    throw new FlowError(
      "INVALID_CONFIGURATION",
      "Authentication settings do not match this FLOW environment.",
    );
  }

  const cookie = (purpose: string) =>
    `${secure ? "__Host-" : ""}flow-${environment}-${purpose}`;
  return {
    origin: origin.origin,
    secure,
    secret: values.FLOW_AUTH_SECRET,
    otpKey: values.FLOW_OTP_KEY,
    googleId: values.FLOW_GOOGLE_CLIENT_ID,
    googleSecret: values.FLOW_GOOGLE_CLIENT_SECRET,
    mailKey: values.FLOW_MAIL_API_KEY,
    mailFrom: values.FLOW_MAIL_FROM,
    clientIpHeader: values.FLOW_CLIENT_IP_HEADER,
    cookies: {
      session: cookie("session"),
      state: cookie("state"),
      oauth: cookie("oauth"),
      email: cookie("email"),
      security: cookie("security"),
    },
  };
}

export type AuthConfig = ReturnType<typeof readAuthConfig>;

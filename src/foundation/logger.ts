import { errorCode } from "./errors.ts";

const redacted = "[REDACTED]";
const sensitiveField =
  /authorization|cookie|password|passwd|passphrase|secret|credential|token|api.?key|private.?key|database.?url|connection.?(?:string|uri)|handoff.?url|^(?:pwd|dsn|headers|stack)$/i;
const credentialAssignment =
  /(\b[\w.-]{0,64}(?:authorization|cookie|password|passwd|passphrase|pwd|secret|credential|token|(?:api|private)[-_ \t]?key|database[-_ \t]?url|connection[-_ \t]?(?:string|uri)|dsn)[\w.-]{0,32}["']?[ \t]*[:=][ \t]*)("(?:\\.|[^"\\\r\n])*"|'(?:\\.|[^'\\\r\n])*'|(?:bearer|basic)[ \t]+[^\s"']+|[^\s"']+)/gi;
const credentialHeader =
  /(^[ \t]*(?:authorization|proxy-authorization)[ \t]*:[ \t]*|\b(?:cookie|set-cookie)[ \t]*:[ \t]*)[^\r\n]+/gim;

export function redact(value: unknown, depth = 0): unknown {
  if (typeof value === "string") {
    return value
      .replace(credentialAssignment, (_match, label: string, value: string) => {
        const quote = value[0] === '"' || value[0] === "'" ? value[0] : "";
        return label + quote + redacted + quote;
      })
      .replace(credentialHeader, "$1" + redacted)
      .replace(/\bpostgres(?:ql)?:\/\/[^\s"'<>]+/gi, redacted)
      .replace(/\b(?:bearer|basic)\s+[^\s"',;]+/gi, redacted)
      .replace(/\bwk_[\w-]+/g, redacted)
      .replace(/\beyJ[\w-]+\.[\w-]+\.[\w-]+\b/g, redacted)
      .replace(/\bhttps?:\/\/[^\s"'<>]+/gi, (url) =>
        /[@?#]/.test(url) ? redacted : url,
      );
  }
  if (value instanceof Error) {
    return { code: errorCode(value) };
  }
  if (value === null || typeof value !== "object") {
    return typeof value === "bigint" ? value.toString() : value;
  }
  if (depth >= 8) {
    return "[TRUNCATED]";
  }
  if (Array.isArray(value)) {
    return value.map((item) => redact(item, depth + 1));
  }

  return Object.fromEntries(
    Object.entries(value).map(([key, field]) => [
      redact(key),
      sensitiveField.test(key) ? redacted : redact(field, depth + 1),
    ]),
  );
}

export function log(
  level: "info" | "error",
  event: string,
  fields: Readonly<Record<string, unknown>> = {},
): void {
  console[level](
    JSON.stringify({
      timestamp: new Date().toISOString(),
      level,
      event: redact(event),
      fields: redact(fields),
    }),
  );
}

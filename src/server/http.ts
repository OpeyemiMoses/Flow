import "server-only";
import { randomUUID } from "node:crypto";
import type { z } from "zod";
import type { AuthConfig } from "../foundation/auth-environment.ts";
import { log } from "../foundation/logger.ts";
import { runtime } from "../foundation/prisma.ts";

export class ApiFailure extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string) {
    super(code);
    this.status = status;
    this.code = code;
  }
}

export function privateHeaders(): Headers {
  return new Headers({
    "Cache-Control": "private, no-store",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
  });
}

export function reply(
  status: number,
  body?: object,
  headers = privateHeaders(),
): Response {
  return body
    ? Response.json(body, { status, headers })
    : new Response(null, { status, headers });
}

export async function api(action: () => Promise<Response>): Promise<Response> {
  try {
    return await action();
  } catch (error) {
    const requestId = randomUUID();
    if (
      error instanceof ApiFailure ||
      (typeof error === "object" &&
        error !== null &&
        "status" in error &&
        typeof (error as Record<string, unknown>).status === "number" &&
        "code" in error &&
        typeof (error as Record<string, unknown>).code === "string")
    ) {
      const err = error as ApiFailure;
      return reply(err.status, { error: err.code, requestId });
    }
    console.error("API 503 INTERNAL ERROR:", error);
    log("error", "request_failed", { requestId, code: "INTERNAL_ERROR" });
    return reply(503, { error: "UNAVAILABLE", requestId });
  }
}

export function canonicalHost(headers: Headers, config: AuthConfig): void {
  if (headers.get("host") !== new URL(config.origin).host) {
    throw new ApiFailure(403, "INVALID_ORIGIN");
  }
}

export async function input<S extends z.ZodType>(
  request: Request,
  schema: S,
): Promise<z.output<S>> {
  const { auth } = runtime();
  canonicalHost(request.headers, auth);
  const site = request.headers.get("sec-fetch-site");
  if (
    request.headers.get("origin") !== auth.origin ||
    (site && site !== "same-origin")
  ) {
    throw new ApiFailure(403, "INVALID_ORIGIN");
  }
  const mime = request.headers.get("content-type")?.split(";")[0]?.trim();
  if (mime !== "application/json") throw new ApiFailure(415, "JSON_REQUIRED");
  const reader = request.body?.getReader();
  if (!reader) throw new ApiFailure(422, "INVALID_INPUT");
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let json = "";
  let bytes = 0;
  let value: unknown;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > 16_384) {
        await reader.cancel();
        throw new ApiFailure(413, "REQUEST_TOO_LARGE");
      }
      json += decoder.decode(chunk.value, { stream: true });
    }
    value = JSON.parse(json + decoder.decode());
  } catch (error) {
    if (error instanceof ApiFailure) throw error;
    throw new ApiFailure(422, "INVALID_INPUT");
  }
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new ApiFailure(422, "INVALID_INPUT");
  return parsed.data;
}

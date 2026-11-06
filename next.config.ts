import type { NextConfig } from "next";
import {
  PHASE_DEVELOPMENT_SERVER,
  PHASE_PRODUCTION_SERVER,
} from "next/constants.js";
import {
  assertWebEnvironment,
  readConfig,
} from "./src/foundation/environment.ts";
import { readAuthConfig } from "./src/foundation/auth-environment.ts";

export default function nextConfig(phase: string): NextConfig {
  if (phase === PHASE_DEVELOPMENT_SERVER || phase === PHASE_PRODUCTION_SERVER) {
    const { environment } = readConfig(process.env, "runtime");
    readAuthConfig(process.env, environment);
  } else {
    assertWebEnvironment(process.env);
  }

  return {
    poweredByHeader: false,
    logging: {
      incomingRequests: { ignore: [/^\/api\/(auth|security)(?:[/?]|$)/] },
    },
    async headers() {
      const privatePage = [
        { key: "Cache-Control", value: "private, no-store" },
        { key: "X-Robots-Tag", value: "noindex" },
      ];
      return [
        {
          source: "/:path*",
          headers: [
            {
              key: "Content-Security-Policy",
              value:
                "frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
            },
            { key: "Referrer-Policy", value: "same-origin" },
          ],
        },
        ...[
          "/accounts/:path*",
          "/security",
          "/onboarding",
          "/sign-in",
          "/invites/accept",
        ].map((source) => ({ source, headers: privatePage })),
      ];
    },
  };
}

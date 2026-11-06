import type { NextConfig } from "next";
import {
  PHASE_DEVELOPMENT_SERVER,
  PHASE_PRODUCTION_SERVER,
} from "next/constants.js";
import {
  assertWebEnvironment,
  readConfig,
} from "./src/foundation/environment.ts";

export default function nextConfig(phase: string): NextConfig {
  if (phase === PHASE_DEVELOPMENT_SERVER || phase === PHASE_PRODUCTION_SERVER) {
    readConfig(process.env, "runtime");
  } else {
    assertWebEnvironment(process.env);
  }

  return { poweredByHeader: false };
}

type FlowErrorCode =
  | "INVALID_CONFIGURATION"
  | "DATABASE_UNAVAILABLE"
  | "DATABASE_NOT_READY"
  | "UNSUPPORTED_ENVELOPE"
  | "CORRUPTED_ENVELOPE"
  | "DECRYPTION_FAILED"
  | "INVALID_STATE_TRANSITION"
  | "CUSTODY_PROVIDER_ERROR"
  | "CUSTODY_PROVIDER_TIMEOUT"
  | "CUSTODY_PROVIDER_NETWORK_ERROR"
  | "CUSTODY_PROVIDER_RATE_LIMITED"
  | "CUSTODY_PROVIDER_UNAVAILABLE"
  | "UNSUPPORTED_CHAIN"
  | "JOB_LEASE_EXPIRED"
  | "STALE_FENCING_TOKEN"
  | "AMBIGUOUS_OUTCOME_QUARANTINE";

export class FlowError extends Error {
  readonly code: FlowErrorCode;

  constructor(code: FlowErrorCode, message: string) {
    super(message);
    this.name = "FlowError";
    this.code = code;
  }
}

export function errorCode(error: unknown): FlowErrorCode | "INTERNAL_ERROR" {
  return error instanceof FlowError ? error.code : "INTERNAL_ERROR";
}

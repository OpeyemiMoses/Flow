type FlowErrorCode =
  "INVALID_CONFIGURATION" | "DATABASE_UNAVAILABLE" | "DATABASE_NOT_READY";

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

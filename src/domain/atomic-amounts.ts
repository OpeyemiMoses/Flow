import { FlowError } from "../foundation/errors.ts";

/**
 * Maximum supported integer in FLOW balance and asset models (matches uint256 / numeric(78, 0)).
 * 2^256 - 1
 */
export const MAX_SUPPORTED_ATOMIC_INT: bigint = (1n << 256n) - 1n;

export const MIN_SUPPORTED_DECIMALS = 0;
export const MAX_SUPPORTED_DECIMALS = 36;

export interface ParseAtomicOptions {
  readonly allowNegative?: boolean;
}

export interface FormatAtomicOptions {
  readonly trimTrailingZeros?: boolean;
}

/**
 * Validates that decimals is an integer within the supported range [0, 36].
 */
export function assertValidDecimals(decimals: number): void {
  if (
    !Number.isInteger(decimals) ||
    decimals < MIN_SUPPORTED_DECIMALS ||
    decimals > MAX_SUPPORTED_DECIMALS
  ) {
    throw new FlowError(
      "INVALID_DECIMALS",
      `Decimals must be an integer between ${MIN_SUPPORTED_DECIMALS} and ${MAX_SUPPORTED_DECIMALS}. Received: ${decimals}.`,
    );
  }
}

/**
 * Parses a decimal string (e.g. "1.234567", "0.000001", "100", "0") into an atomic bigint.
 *
 * Guarantees:
 * - Pure string manipulation and BigInt arithmetic (NO JavaScript floating-point conversions or parseFloat).
 * - Rejects exponential / scientific notation (e.g. "1e18").
 * - Rejects non-numeric characters, multiple decimal points, or trailing garbage.
 * - Rejects precision exceeding the allowed decimals (precision overflow).
 * - Handles decimals = 0 (rejects any fractional part).
 * - Rejects values exceeding MAX_SUPPORTED_ATOMIC_INT.
 * - By default, rejects negative values unless allowNegative: true is explicitly provided.
 */
export function parseDisplayToAtomic(
  displayStr: string,
  decimals: number,
  options?: ParseAtomicOptions,
): bigint {
  assertValidDecimals(decimals);

  if (typeof displayStr !== "string") {
    throw new FlowError(
      "INVALID_AMOUNT",
      "Display amount must be a string representation of a decimal number.",
    );
  }

  const trimmed = displayStr.trim();
  if (trimmed.length === 0) {
    throw new FlowError("INVALID_AMOUNT", "Display amount cannot be empty.");
  }

  // Reject exponential / scientific notation
  if (/e/i.test(trimmed)) {
    throw new FlowError(
      "INVALID_AMOUNT",
      "Scientific notation is not supported. Use standard decimal notation.",
    );
  }

  const isNegative = trimmed.startsWith("-");
  const isPositiveExplicit = trimmed.startsWith("+");
  const signOffset = isNegative || isPositiveExplicit ? 1 : 0;
  const rawNumber = trimmed.slice(signOffset);

  if (isNegative && !options?.allowNegative) {
    throw new FlowError(
      "INVALID_AMOUNT",
      "Negative token amounts are not allowed.",
    );
  }

  if (rawNumber.length === 0) {
    throw new FlowError("INVALID_AMOUNT", "Malformed amount string.");
  }

  const parts = rawNumber.split(".");
  if (parts.length > 2) {
    throw new FlowError(
      "INVALID_AMOUNT",
      "Amount string contains multiple decimal points.",
    );
  }

  const wholePartRaw = parts[0]!;
  const fractionalPartRaw = parts[1] ?? "";

  if (wholePartRaw.length === 0 && fractionalPartRaw.length === 0) {
    throw new FlowError("INVALID_AMOUNT", "Amount string contains no digits.");
  }

  // Validate that both whole and fractional parts contain only ASCII digits
  if (wholePartRaw.length > 0 && !/^\d+$/.test(wholePartRaw)) {
    throw new FlowError(
      "INVALID_AMOUNT",
      "Amount contains invalid non-digit characters.",
    );
  }

  if (fractionalPartRaw.length > 0 && !/^\d+$/.test(fractionalPartRaw)) {
    throw new FlowError(
      "INVALID_AMOUNT",
      "Fractional part contains invalid non-digit characters.",
    );
  }

  // If decimals === 0, any fractional part is invalid
  if (decimals === 0) {
    if (fractionalPartRaw.length > 0 && BigInt(fractionalPartRaw) > 0n) {
      throw new FlowError(
        "PRECISION_OVERFLOW",
        "Tokens with 0 decimals do not allow fractional amounts.",
      );
    }
  } else if (fractionalPartRaw.length > decimals) {
    throw new FlowError(
      "PRECISION_OVERFLOW",
      `Fractional part (${fractionalPartRaw.length} digits) exceeds supported decimals (${decimals}).`,
    );
  }

  const wholeBigInt = wholePartRaw.length === 0 ? 0n : BigInt(wholePartRaw);

  const paddedFractional = fractionalPartRaw.padEnd(decimals, "0");
  const fractionalBigInt =
    paddedFractional.length === 0 ? 0n : BigInt(paddedFractional);

  let atomic =
    decimals === 0
      ? wholeBigInt
      : wholeBigInt * 10n ** BigInt(decimals) + fractionalBigInt;

  if (atomic > MAX_SUPPORTED_ATOMIC_INT) {
    throw new FlowError(
      "AMOUNT_OVERFLOW",
      "Amount exceeds the maximum supported 256-bit integer magnitude.",
    );
  }

  if (isNegative && atomic > 0n) {
    atomic = -atomic;
  }

  return atomic;
}

/**
 * Formats an atomic integer into a human-readable decimal string.
 *
 * Guarantees:
 * - Pure integer arithmetic and string slicing (NO floating-point math).
 * - Respects token decimals.
 * - Trims trailing zeros by default, unless trimTrailingZeros: false.
 * - Handles negative values with leading "-".
 * - For 0n, always outputs "0".
 */
export function formatAtomicToDisplay(
  atomic: bigint | string,
  decimals: number,
  options?: FormatAtomicOptions,
): string {
  assertValidDecimals(decimals);

  let atomicBigInt: bigint;
  if (typeof atomic === "bigint") {
    atomicBigInt = atomic;
  } else if (typeof atomic === "string") {
    const trimmed = atomic.trim();
    if (!/^-?\d+$/.test(trimmed)) {
      throw new FlowError(
        "INVALID_AMOUNT",
        "Atomic amount string must contain only digits with optional leading sign.",
      );
    }
    atomicBigInt = BigInt(trimmed);
  } else {
    throw new FlowError(
      "INVALID_AMOUNT",
      "Atomic amount must be a bigint or numeric string.",
    );
  }

  const isNegative = atomicBigInt < 0n;
  const absAtomic = isNegative ? -atomicBigInt : atomicBigInt;

  if (absAtomic === 0n) {
    return "0";
  }

  if (decimals === 0) {
    return isNegative ? `-${absAtomic.toString()}` : absAtomic.toString();
  }

  const atomicStr = absAtomic.toString();
  const minLength = decimals + 1;
  const padded = atomicStr.padStart(minLength, "0");

  const wholePart = padded.slice(0, padded.length - decimals);
  let fractionalPart = padded.slice(padded.length - decimals);

  const trim = options?.trimTrailingZeros ?? true;
  if (trim) {
    fractionalPart = fractionalPart.replace(/0+$/, "");
  }

  const sign = isNegative ? "-" : "";
  if (fractionalPart.length === 0) {
    return `${sign}${wholePart}`;
  }

  return `${sign}${wholePart}.${fractionalPart}`;
}

/**
 * Validates whether a string is a valid serialized atomic integer string (digits only).
 */
export function isValidAtomicString(
  value: string,
  options?: ParseAtomicOptions,
): boolean {
  if (typeof value !== "string") return false;
  const trimmed = value.trim();
  if (trimmed.length === 0) return false;

  const pattern = options?.allowNegative ? /^-?\d+$/ : /^\d+$/;
  if (!pattern.test(trimmed)) return false;

  try {
    const b = BigInt(trimmed);
    const abs = b < 0n ? -b : b;
    return abs <= MAX_SUPPORTED_ATOMIC_INT;
  } catch {
    return false;
  }
}

/**
 * Safe addition of two atomic BigInts enforcing max limit.
 */
export function addAtomic(a: bigint, b: bigint): bigint {
  const sum = a + b;
  if (sum < 0n) {
    throw new FlowError(
      "INVALID_AMOUNT",
      "Resulting atomic balance cannot be negative.",
    );
  }
  if (sum > MAX_SUPPORTED_ATOMIC_INT) {
    throw new FlowError(
      "AMOUNT_OVERFLOW",
      "Resulting atomic amount exceeds maximum limit.",
    );
  }
  return sum;
}

/**
 * Safe subtraction of two atomic BigInts enforcing non-negative result.
 */
export function subAtomic(a: bigint, b: bigint): bigint {
  const diff = a - b;
  if (diff < 0n) {
    throw new FlowError(
      "INSUFFICIENT_FUNDS",
      "Resulting atomic balance would be negative.",
    );
  }
  return diff;
}

/**
 * Compares two atomic amounts. Returns -1 if a < b, 0 if a === b, 1 if a > b.
 */
export function compareAtomic(a: bigint, b: bigint): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

/**
 * Asserts that an atomic integer is non-negative.
 */
export function assertNonNegativeAtomic(
  amount: bigint,
  context = "Atomic amount",
): void {
  if (amount < 0n) {
    throw new FlowError(
      "INVALID_AMOUNT",
      `${context} cannot be negative. Received: ${amount.toString()}.`,
    );
  }
}

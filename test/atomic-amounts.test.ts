import assert from "node:assert/strict";
import test from "node:test";
import {
  addAtomic,
  assertNonNegativeAtomic,
  assertValidDecimals,
  compareAtomic,
  formatAtomicToDisplay,
  isValidAtomicString,
  MAX_SUPPORTED_ATOMIC_INT,
  parseDisplayToAtomic,
  subAtomic,
} from "../src/domain/atomic-amounts.ts";

test("atomic amounts: assertValidDecimals validates 0-36 range", () => {
  assert.doesNotThrow(() => assertValidDecimals(0));
  assert.doesNotThrow(() => assertValidDecimals(6));
  assert.doesNotThrow(() => assertValidDecimals(18));
  assert.doesNotThrow(() => assertValidDecimals(24));
  assert.doesNotThrow(() => assertValidDecimals(36));

  assert.throws(() => assertValidDecimals(-1), { code: "INVALID_DECIMALS" });
  assert.throws(() => assertValidDecimals(37), { code: "INVALID_DECIMALS" });
  assert.throws(() => assertValidDecimals(1.5), { code: "INVALID_DECIMALS" });
  assert.throws(() => assertValidDecimals(Number.NaN), {
    code: "INVALID_DECIMALS",
  });
});

test("atomic amounts: parseDisplayToAtomic handles standard decimal inputs", () => {
  // 6 decimals (e.g. USDC)
  assert.equal(parseDisplayToAtomic("1", 6), 1_000_000n);
  assert.equal(parseDisplayToAtomic("1.5", 6), 1_500_000n);
  assert.equal(parseDisplayToAtomic("1.234567", 6), 1_234_567n);
  assert.equal(parseDisplayToAtomic("0.000001", 6), 1n);
  assert.equal(parseDisplayToAtomic("0", 6), 0n);
  assert.equal(parseDisplayToAtomic("0.0", 6), 0n);
  assert.equal(parseDisplayToAtomic("0.000000", 6), 0n);
  assert.equal(parseDisplayToAtomic(".5", 6), 500_000n);

  // 18 decimals (e.g. ETH)
  assert.equal(parseDisplayToAtomic("1", 18), 10n ** 18n);
  assert.equal(parseDisplayToAtomic("0.000000000000000001", 18), 1n);

  // 24 decimals (e.g. NEAR)
  assert.equal(parseDisplayToAtomic("1", 24), 10n ** 24n);
  assert.equal(parseDisplayToAtomic("0.000000000000000000000001", 24), 1n);

  // 0 decimals
  assert.equal(parseDisplayToAtomic("100", 0), 100n);
  assert.equal(parseDisplayToAtomic("0", 0), 0n);
});

test("atomic amounts: parseDisplayToAtomic precision overflow enforcement", () => {
  // 6 decimals: 7 digits of fraction must throw PRECISION_OVERFLOW
  assert.throws(() => parseDisplayToAtomic("1.2345678", 6), {
    code: "PRECISION_OVERFLOW",
  });

  // 0 decimals: any non-zero fraction must throw
  assert.throws(() => parseDisplayToAtomic("100.5", 0), {
    code: "PRECISION_OVERFLOW",
  });

  // 0 decimals with .0 is allowed since it's zero
  assert.equal(parseDisplayToAtomic("100.0", 0), 100n);
});

test("atomic amounts: parseDisplayToAtomic rejects scientific notation and invalid strings", () => {
  assert.throws(() => parseDisplayToAtomic("1e18", 18), {
    code: "INVALID_AMOUNT",
  });
  assert.throws(() => parseDisplayToAtomic("1.5e6", 6), {
    code: "INVALID_AMOUNT",
  });
  assert.throws(() => parseDisplayToAtomic("abc", 6), {
    code: "INVALID_AMOUNT",
  });
  assert.throws(() => parseDisplayToAtomic("1.2.3", 6), {
    code: "INVALID_AMOUNT",
  });
  assert.throws(() => parseDisplayToAtomic("", 6), { code: "INVALID_AMOUNT" });
  assert.throws(() => parseDisplayToAtomic("   ", 6), {
    code: "INVALID_AMOUNT",
  });
  assert.throws(() => parseDisplayToAtomic("1,000.50", 6), {
    code: "INVALID_AMOUNT",
  });
});

test("atomic amounts: parseDisplayToAtomic negative value handling", () => {
  // By default, negative values are disallowed
  assert.throws(() => parseDisplayToAtomic("-1.5", 6), {
    code: "INVALID_AMOUNT",
  });

  // Allowed when explicit option is set
  assert.equal(
    parseDisplayToAtomic("-1.5", 6, { allowNegative: true }),
    -1_500_000n,
  );
  assert.equal(
    parseDisplayToAtomic("-0.000001", 6, { allowNegative: true }),
    -1n,
  );
});

test("atomic amounts: parseDisplayToAtomic handles maximum uint256 integers", () => {
  const maxStr = MAX_SUPPORTED_ATOMIC_INT.toString();
  // With 0 decimals, max uint256 parses directly
  const parsed = parseDisplayToAtomic(maxStr, 0);
  assert.equal(parsed, MAX_SUPPORTED_ATOMIC_INT);

  // Overflows throw AMOUNT_OVERFLOW
  const overflowStr = (MAX_SUPPORTED_ATOMIC_INT + 1n).toString();
  assert.throws(() => parseDisplayToAtomic(overflowStr, 0), {
    code: "AMOUNT_OVERFLOW",
  });
});

test("atomic amounts: formatAtomicToDisplay formats integers to decimal strings", () => {
  // 6 decimals
  assert.equal(formatAtomicToDisplay(1_000_000n, 6), "1");
  assert.equal(formatAtomicToDisplay(1_500_000n, 6), "1.5");
  assert.equal(formatAtomicToDisplay(1_234_567n, 6), "1.234567");
  assert.equal(formatAtomicToDisplay(1n, 6), "0.000001");
  assert.equal(formatAtomicToDisplay(0n, 6), "0");

  // Format without trimming trailing zeros
  assert.equal(
    formatAtomicToDisplay(1_500_000n, 6, { trimTrailingZeros: false }),
    "1.500000",
  );

  // 18 decimals
  assert.equal(formatAtomicToDisplay(10n ** 18n, 18), "1");
  assert.equal(formatAtomicToDisplay(1n, 18), "0.000000000000000001");

  // 0 decimals
  assert.equal(formatAtomicToDisplay(100n, 0), "100");
  assert.equal(formatAtomicToDisplay(0n, 0), "0");

  // Negative amounts
  assert.equal(formatAtomicToDisplay(-1_500_000n, 6), "-1.5");
  assert.equal(formatAtomicToDisplay(-1n, 6), "-0.000001");
  assert.equal(formatAtomicToDisplay(-50n, 0), "-50");

  // From string representation
  assert.equal(formatAtomicToDisplay("5000000", 6), "5");
  assert.equal(formatAtomicToDisplay("-2500000", 6), "-2.5");
});

test("atomic amounts: isValidAtomicString validates digit strings", () => {
  assert.equal(isValidAtomicString("1000000"), true);
  assert.equal(isValidAtomicString("0"), true);
  assert.equal(isValidAtomicString("12345678901234567890"), true);

  assert.equal(isValidAtomicString("-100"), false);
  assert.equal(isValidAtomicString("-100", { allowNegative: true }), true);

  assert.equal(isValidAtomicString("1.5"), false);
  assert.equal(isValidAtomicString("abc"), false);
  assert.equal(isValidAtomicString(""), false);
});

test("atomic amounts: arithmetic and comparison", () => {
  assert.equal(addAtomic(100n, 200n), 300n);
  assert.equal(subAtomic(300n, 100n), 200n);

  assert.throws(() => subAtomic(100n, 200n), { code: "INSUFFICIENT_FUNDS" });

  assert.equal(compareAtomic(100n, 200n), -1);
  assert.equal(compareAtomic(200n, 200n), 0);
  assert.equal(compareAtomic(300n, 200n), 1);

  assert.doesNotThrow(() => assertNonNegativeAtomic(0n));
  assert.doesNotThrow(() => assertNonNegativeAtomic(100n));
  assert.throws(() => assertNonNegativeAtomic(-1n), { code: "INVALID_AMOUNT" });
});

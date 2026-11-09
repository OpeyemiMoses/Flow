import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  assertDoubleEntryBalance,
  assertMultiCurrencyDoubleEntryBalance,
  generateLedgerJournalPublicId,
  isValidLedgerJournalPublicId,
} from "../src/domain/ledger.ts";

describe("domain: ledger double-entry bookkeeping", () => {
  it("validates perfectly balanced debits and credits", () => {
    const lines = [
      {
        ledgerAccountId: "acct-1",
        entryDirection: "DEBIT" as const,
        amountAtomic: 10000000n, // 10 USDC
      },
      {
        ledgerAccountId: "acct-2",
        entryDirection: "CREDIT" as const,
        amountAtomic: 9900000n, // 9.90 USDC
      },
      {
        ledgerAccountId: "acct-3",
        entryDirection: "CREDIT" as const,
        amountAtomic: 100000n, // 0.10 USDC fee
      },
    ];

    const result = assertDoubleEntryBalance(lines);
    assert.equal(result.isBalanced, true);
    assert.equal(result.totalDebit, 10000000n);
    assert.equal(result.totalCredit, 10000000n);
  });

  it("validates multi-currency balanced legs per asset and network", () => {
    const multiCurrencyLines = [
      // Leg 1: Source asset SOL on Solana
      {
        ledgerAccountId: "acct-sol-custody",
        assetId: "solana-mainnet:SOL",
        network: "solana-mainnet",
        entryDirection: "DEBIT" as const,
        amountAtomic: 1000000000n, // 1 SOL
      },
      {
        ledgerAccountId: "acct-sol-clearing",
        assetId: "solana-mainnet:SOL",
        network: "solana-mainnet",
        entryDirection: "CREDIT" as const,
        amountAtomic: 1000000000n, // 1 SOL
      },
      // Leg 2: Destination asset USDC on Base
      {
        ledgerAccountId: "acct-base-clearing",
        assetId: "base-mainnet:USDC",
        network: "base-mainnet",
        entryDirection: "DEBIT" as const,
        amountAtomic: 180000000n, // 180 USDC
      },
      {
        ledgerAccountId: "acct-base-merchant",
        assetId: "base-mainnet:USDC",
        network: "base-mainnet",
        entryDirection: "CREDIT" as const,
        amountAtomic: 180000000n, // 180 USDC
      },
    ];

    const result = assertMultiCurrencyDoubleEntryBalance(multiCurrencyLines);
    assert.equal(result.isBalanced, true);
    assert.equal(result.legs.size, 2);
  });

  it("rejects cross-currency entries where a single currency leg does not balance", () => {
    // Attempting to balance 1 SOL (atomic 1000000000) against 1 SOL worth of USDC on Base without clearing legs
    const invalidLines = [
      {
        ledgerAccountId: "acct-sol-custody",
        assetId: "solana-mainnet:SOL",
        network: "solana-mainnet",
        entryDirection: "DEBIT" as const,
        amountAtomic: 1000000000n,
      },
      {
        ledgerAccountId: "acct-base-merchant",
        assetId: "base-mainnet:USDC",
        network: "base-mainnet",
        entryDirection: "CREDIT" as const,
        amountAtomic: 1000000000n, // Raw numbers match, but assets differ!
      },
    ];

    assert.throws(
      () => assertMultiCurrencyDoubleEntryBalance(invalidLines),
      /Unbalanced currency leg/,
    );
  });

  it("rejects unbalanced entries where debits > credits", () => {
    const lines = [
      {
        ledgerAccountId: "acct-1",
        entryDirection: "DEBIT" as const,
        amountAtomic: 10000000n,
      },
      {
        ledgerAccountId: "acct-2",
        entryDirection: "CREDIT" as const,
        amountAtomic: 9000000n,
      },
    ];

    assert.throws(
      () => assertDoubleEntryBalance(lines),
      /Unbalanced double-entry journal: debits \(10000000\) != credits \(9000000\)/,
    );
  });

  it("rejects zero and negative amounts", () => {
    assert.throws(
      () =>
        assertDoubleEntryBalance([
          {
            ledgerAccountId: "acct-1",
            entryDirection: "DEBIT" as const,
            amountAtomic: 0n,
          },
          {
            ledgerAccountId: "acct-2",
            entryDirection: "CREDIT" as const,
            amountAtomic: 0n,
          },
        ]),
      /Entry amount must be strictly positive/,
    );

    assert.throws(
      () =>
        assertDoubleEntryBalance([
          {
            ledgerAccountId: "acct-1",
            entryDirection: "DEBIT" as const,
            amountAtomic: -100n,
          },
          {
            ledgerAccountId: "acct-2",
            entryDirection: "CREDIT" as const,
            amountAtomic: -100n,
          },
        ]),
      /Entry amount must be strictly positive/,
    );
  });

  it("rejects entries with fewer than 2 lines", () => {
    assert.throws(
      () =>
        assertDoubleEntryBalance([
          {
            ledgerAccountId: "acct-1",
            entryDirection: "DEBIT" as const,
            amountAtomic: 100n,
          },
        ]),
      /requires at least 2 entry lines/,
    );
  });

  it("generates valid ledger journal public IDs", () => {
    const id = generateLedgerJournalPublicId();
    assert.match(id, /^lj_[a-zA-Z0-9_-]{16,64}$/);
    assert.equal(isValidLedgerJournalPublicId(id), true);
    assert.equal(isValidLedgerJournalPublicId("invalid_id"), false);
  });
});

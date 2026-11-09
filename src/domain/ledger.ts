import { randomBytes } from "node:crypto";

export type LedgerAccountType =
  "ASSET" | "LIABILITY" | "EQUITY" | "REVENUE" | "EXPENSE";

export type LedgerAccountCode =
  | "ASSET_CUSTODY_IN_FLIGHT"
  | "LIABILITY_MERCHANT_PAYABLE"
  | "REVENUE_PLATFORM_FEE"
  | "EXPENSE_PROVIDER_FEE"
  | "ASSET_SETTLED_HOLDINGS";

export type LedgerEntryDirection = "DEBIT" | "CREDIT";

export type LedgerJournalReferenceType =
  "PAYMENT_SETTLEMENT" | "PAYMENT_REFUND" | "FEE_SWEEP" | "ADJUSTMENT";

export type LedgerJournalStatus = "POSTED" | "VOID";

export interface LedgerAccountRecord {
  readonly id: string;
  readonly accountId: string | null;
  readonly accountType: LedgerAccountType;
  readonly accountCode: LedgerAccountCode;
  readonly assetId: string;
  readonly network: string;
  readonly decimals: number;
  readonly balanceAtomic: bigint;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface LedgerJournalRecord {
  readonly id: string;
  readonly journalPublicId: string;
  readonly referenceType: LedgerJournalReferenceType;
  readonly referenceId: string;
  readonly description: string;
  readonly status: LedgerJournalStatus;
  readonly postedAt: Date;
  readonly createdAt: Date;
}

export interface LedgerEntryRecord {
  readonly id: string;
  readonly journalId: string;
  readonly ledgerAccountId: string;
  readonly entryDirection: LedgerEntryDirection;
  readonly amountAtomic: bigint;
  readonly createdAt: Date;
}

export interface DoubleEntryLine {
  readonly ledgerAccountId: string;
  readonly entryDirection: LedgerEntryDirection;
  readonly amountAtomic: bigint;
}

/**
 * Validates that double-entry journal lines are strictly balanced:
 * Sum of DEBIT amounts must equal Sum of CREDIT amounts.
 * All amounts must be positive integers (bigint).
 */
export function assertDoubleEntryBalance(lines: readonly DoubleEntryLine[]): {
  readonly totalDebit: bigint;
  readonly totalCredit: bigint;
  readonly isBalanced: boolean;
} {
  if (lines.length < 2) {
    throw new Error(
      "Double-entry bookkeeping requires at least 2 entry lines.",
    );
  }

  let totalDebit = 0n;
  let totalCredit = 0n;

  for (const line of lines) {
    if (line.amountAtomic <= 0n) {
      throw new Error(
        `Entry amount must be strictly positive: received ${line.amountAtomic.toString()}`,
      );
    }

    if (line.entryDirection === "DEBIT") {
      totalDebit += line.amountAtomic;
    } else if (line.entryDirection === "CREDIT") {
      totalCredit += line.amountAtomic;
    } else {
      throw new Error(
        `Invalid entry direction: ${String(line.entryDirection)}`,
      );
    }
  }

  if (totalDebit !== totalCredit) {
    throw new Error(
      `Unbalanced double-entry journal: debits (${totalDebit.toString()}) != credits (${totalCredit.toString()})`,
    );
  }

  return {
    totalDebit,
    totalCredit,
    isBalanced: true,
  };
}

export function generateLedgerJournalPublicId(): string {
  return `lj_${randomBytes(16).toString("hex")}`;
}

export function isValidLedgerJournalPublicId(id: string): boolean {
  return /^lj_[a-zA-Z0-9_-]{16,64}$/.test(id);
}

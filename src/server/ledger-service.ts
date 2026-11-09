import "server-only";
import {
  assertDoubleEntryBalance,
  generateLedgerJournalPublicId,
  type DoubleEntryLine,
  type LedgerAccountCode,
  type LedgerAccountType,
  type LedgerJournalReferenceType,
} from "../domain/ledger.ts";
import { formatAtomicToDisplay } from "../domain/atomic-amounts.ts";
import { type FlowDb } from "../foundation/prisma.ts";
import { ApiFailure } from "./http.ts";

export interface PostBalancedJournalInput {
  readonly referenceType: LedgerJournalReferenceType;
  readonly referenceId: string;
  readonly description: string;
  readonly entries: readonly DoubleEntryLine[];
}

export interface PostBalancedJournalResult {
  readonly journalId: string;
  readonly journalPublicId: string;
  readonly entryCount: number;
  readonly totalAtomic: string;
}

export interface LedgerAccountBalanceSummary {
  readonly accountId: string;
  readonly accountCode: string;
  readonly assetId: string;
  readonly network: string;
  readonly decimals: number;
  readonly balanceAtomic: string;
  readonly displayBalance: string;
  readonly updatedAt: string;
}

/**
 * Posts a double-entry balanced journal to the financial ledger.
 * Atomically verifies that debits equal credits before executing.
 * Database trigger and function flow.post_balanced_ledger_journal enforce consistency at the SQL layer.
 */
export async function postBalancedJournal(
  tx: FlowDb,
  input: PostBalancedJournalInput,
): Promise<PostBalancedJournalResult> {
  // Application-level invariant check
  assertDoubleEntryBalance(input.entries);

  const journalPublicId = generateLedgerJournalPublicId();
  const serializedEntries = JSON.stringify(
    input.entries.map((e) => ({
      ledger_account_id: e.ledgerAccountId,
      entry_direction: e.entryDirection,
      amount_atomic: e.amountAtomic.toString(),
    })),
  );

  const rows = await tx.$queryRaw<
    Array<{
      journal_id: string;
      journal_public_id: string;
      entry_count: number;
      total_atomic: string;
    }>
  >`
    SELECT *
    FROM flow.post_balanced_ledger_journal(
      ${journalPublicId},
      ${input.referenceType},
      ${input.referenceId},
      ${input.description},
      ${serializedEntries}::jsonb
    )
  `;

  if (rows.length === 0) {
    throw new ApiFailure(500, "LEDGER_POSTING_FAILED");
  }

  const res = rows[0]!;
  return {
    journalId: res.journal_id,
    journalPublicId: res.journal_public_id,
    entryCount: res.entry_count,
    totalAtomic: res.total_atomic.toString(),
  };
}

/**
 * Finds or creates a ledger account within a database transaction.
 */
export async function getOrCreateLedgerAccount(
  tx: FlowDb,
  params: {
    accountId: string | null;
    accountType: LedgerAccountType;
    accountCode: LedgerAccountCode;
    assetId: string;
    network: string;
    decimals: number;
  },
): Promise<{ id: string; balanceAtomic: bigint }> {
  const rows = await tx.$queryRaw<
    Array<{ id: string; balance_atomic: string }>
  >`
    INSERT INTO flow.ledger_accounts (
      account_id,
      account_type,
      account_code,
      asset_id,
      network,
      decimals,
      balance_atomic
    ) VALUES (
      ${params.accountId ? params.accountId : null}::uuid,
      ${params.accountType},
      ${params.accountCode},
      ${params.assetId},
      ${params.network},
      ${params.decimals},
      0
    )
    ON CONFLICT (COALESCE(account_id, '00000000-0000-0000-0000-000000000000'::uuid), account_code, asset_id, network)
    DO UPDATE SET updated_at = CURRENT_TIMESTAMP
    RETURNING id, balance_atomic
  `;

  if (rows.length === 0) {
    throw new ApiFailure(500, "LEDGER_ACCOUNT_PROVISION_FAILED");
  }

  return {
    id: rows[0]!.id,
    balanceAtomic: BigInt(rows[0]!.balance_atomic),
  };
}

/**
 * Retrieves all ledger account balances for an authenticated tenant account.
 * Honors Row-Level Security via flow.can_access_account(account_id).
 */
export async function getTenantLedgerSummary(
  tx: FlowDb,
  accountId: string,
): Promise<readonly LedgerAccountBalanceSummary[]> {
  const rows = await tx.$queryRaw<
    Array<{
      account_id: string;
      account_code: string;
      asset_id: string;
      network: string;
      decimals: number;
      balance_atomic: string;
      updated_at: Date;
    }>
  >`
    SELECT
      la.account_id::text,
      la.account_code,
      la.asset_id,
      la.network,
      la.decimals,
      la.balance_atomic::text,
      la.updated_at
    FROM flow.ledger_accounts la
    WHERE la.account_id = ${accountId}::uuid
    ORDER BY la.account_code, la.asset_id
  `;

  return rows.map((r) => ({
    accountId: r.account_id,
    accountCode: r.account_code,
    assetId: r.asset_id,
    network: r.network,
    decimals: r.decimals,
    balanceAtomic: r.balance_atomic,
    displayBalance: formatAtomicToDisplay(BigInt(r.balance_atomic), r.decimals),
    updatedAt: new Date(r.updated_at).toISOString(),
  }));
}

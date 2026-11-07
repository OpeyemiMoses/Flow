import {
  formatAtomicToDisplay,
  assertNonNegativeAtomic,
} from "../../domain/atomic-amounts.ts";
import {
  type AccountPortfolioProjection,
  type NetworkAssetWithAsset,
  type WalletBalanceRecord,
  type AssetKind,
  type TokenStandard,
  type NetworkId,
  type SyncStatus,
  type BalanceFinality,
  assertValidFinality,
  assertValidSyncStatus,
  assertWalletChainConsistency,
} from "../../domain/assets.ts";
import { FlowError } from "../../foundation/errors.ts";
import type { FlowDb } from "../../foundation/prisma.ts";

export interface ListSupportedAssetsFilter {
  readonly network?: string;
  readonly chainId?: string;
  readonly verifiedOnly?: boolean;
}

export interface UpsertWalletBalanceInput {
  readonly walletId: string;
  readonly networkAssetId: string;
  readonly tokenAccountAddress?: string | null;
  readonly atomicBalance: bigint;
  readonly blockHeight?: bigint | null;
  readonly blockTimestamp?: Date | null;
  readonly finality?: "FINALIZED" | "CONFIRMED" | "SAFE" | "UNKNOWN";
  readonly syncStatus:
    "NOT_SYNCED" | "SYNCED" | "STALE" | "UNAVAILABLE" | "ERROR";
  readonly lastError?: string | null;
}

/**
 * Lists registered network assets, optionally filtered by network, chainId, or verification status.
 */
export async function listSupportedAssets(
  db: FlowDb,
  filter?: ListSupportedAssetsFilter,
): Promise<NetworkAssetWithAsset[]> {
  const verifiedCondition = filter?.verifiedOnly ? true : undefined;

  const rows = await db.$queryRaw<
    Array<{
      id: string;
      assetId: string;
      network: string;
      chainId: string;
      tokenStandard: string;
      contractAddress: string | null;
      decimals: number;
      symbolOverride: string | null;
      nameOverride: string | null;
      isVerified: boolean;
      isDepositEligible: boolean;
      status: string;
      assetSymbol: string;
      assetName: string;
      assetKind: string;
      assetDescription: string | null;
      assetIconUrl: string | null;
    }>
  >`
    SELECT
      na.id,
      na.asset_id AS "assetId",
      na.network,
      na.chain_id AS "chainId",
      na.token_standard AS "tokenStandard",
      na.contract_address AS "contractAddress",
      na.decimals,
      na.symbol_override AS "symbolOverride",
      na.name_override AS "nameOverride",
      na.is_verified AS "isVerified",
      na.is_deposit_eligible AS "isDepositEligible",
      na.status,
      a.symbol AS "assetSymbol",
      a.name AS "assetName",
      a.kind AS "assetKind",
      a.description AS "assetDescription",
      a.icon_url AS "assetIconUrl"
    FROM flow.network_assets na
    JOIN flow.assets a ON a.id = na.asset_id
    WHERE (${filter?.network ?? null}::text IS NULL OR na.network = ${filter?.network ?? null})
      AND (${filter?.chainId ?? null}::text IS NULL OR na.chain_id = ${filter?.chainId ?? null})
      AND (${verifiedCondition ?? null}::boolean IS NULL OR na.is_verified = ${verifiedCondition ?? null})
    ORDER BY na.network, na.chain_id, a.symbol
  `;

  return rows.map((r) => ({
    id: r.id,
    assetId: r.assetId,
    network: r.network as NetworkId,
    chainId: r.chainId,
    tokenStandard: r.tokenStandard as TokenStandard,
    contractAddress: r.contractAddress,
    decimals: r.decimals,
    symbolOverride: r.symbolOverride,
    nameOverride: r.nameOverride,
    isVerified: r.isVerified,
    isDepositEligible: r.isDepositEligible,
    status: r.status as "ACTIVE" | "DEPRECATED" | "UNSUPPORTED",
    asset: {
      id: r.assetId,
      symbol: r.assetSymbol,
      name: r.assetName,
      kind: r.assetKind as AssetKind,
      description: r.assetDescription,
      iconUrl: r.assetIconUrl,
    },
  }));
}

export interface BalanceAuthContext {
  readonly sessionToken: string;
}

/**
 * Retrieves the tenant-isolated portfolio and wallet balances for an account.
 * Enforces:
 * - Strict tenant authorization check: sessionToken must be active, unexpired, and caller must be personal owner or active business member.
 * - Non-members or unauthenticated callers receive ACCOUNT_NOT_FOUND (HTTP 404 pattern to prevent ID enumeration).
 * - Exact atomic integer amounts formatted via formatAtomicToDisplay without JavaScript Number conversions.
 * - Distinguishes confirmed zero balance from not yet synced, stale, or unavailable balances.
 */
export async function getAccountBalances(
  db: FlowDb,
  accountId: string,
  auth: BalanceAuthContext | string,
): Promise<AccountPortfolioProjection> {
  const sessionToken = typeof auth === "string" ? auth : auth?.sessionToken;
  if (!sessionToken || sessionToken.trim().length === 0) {
    throw new FlowError(
      "ACCOUNT_NOT_FOUND",
      "Account not found or access denied.",
    );
  }

  // 1. Resolve caller user from active unexpired session
  const sessions = await db.$queryRaw<
    Array<{
      userId: string;
      authUserId: string;
      active: boolean;
    }>
  >`
    SELECT u.id as "userId", u.auth_user_id as "authUserId", u.active
    FROM flow.auth_sessions s
    JOIN flow.users u ON u.auth_user_id = s.user_id
    WHERE s.token = ${sessionToken.trim()}
      AND s.expires_at > CURRENT_TIMESTAMP
      AND u.active = true
  `;

  const session = sessions[0];
  if (!session) {
    throw new FlowError(
      "ACCOUNT_NOT_FOUND",
      "Account not found or access denied.",
    );
  }

  const callerUserId = session.userId;

  // 2. Verify tenant access
  const accounts = await db.$queryRaw<
    Array<{
      id: string;
      kind: string;
      personalOwnerId: string | null;
    }>
  >`
    SELECT id, kind::text as kind, personal_owner_id as "personalOwnerId"
    FROM flow.accounts
    WHERE id = ${accountId}::uuid
  `;

  const account = accounts[0];
  if (!account) {
    throw new FlowError(
      "ACCOUNT_NOT_FOUND",
      "Account not found or access denied.",
    );
  }

  if (account.kind === "PERSONAL") {
    if (account.personalOwnerId !== callerUserId) {
      throw new FlowError(
        "ACCOUNT_NOT_FOUND",
        "Account not found or access denied.",
      );
    }
  } else {
    const memberships = await db.$queryRaw<Array<{ role: string }>>`
      SELECT role::text as role
      FROM flow.account_memberships
      WHERE account_id = ${accountId}::uuid
        AND user_id = ${callerUserId}::uuid
        AND status = 'ACTIVE'::flow.member_status
    `;
    if (!memberships[0]) {
      throw new FlowError(
        "ACCOUNT_NOT_FOUND",
        "Account not found or access denied.",
      );
    }
  }

  // 3. Fetch account wallet projection (if provisioned)
  const wallets = await db.$queryRaw<
    Array<{
      id: string;
      environment: string;
      status: string;
      policyState: string;
    }>
  >`
    SELECT id, environment, status::text as status, policy_state as "policyState"
    FROM flow.wallet_public_projections
    WHERE account_id = ${accountId}::uuid
  `;

  const wallet = wallets[0];
  let walletMeta = null;
  if (wallet) {
    const isTestnet = wallet.environment === "testnet";
    walletMeta = {
      id: wallet.id,
      environment: wallet.environment,
      isTestnet,
      status: wallet.status,
      policyState: wallet.policyState,
      eligibleForDeposits: false, // Strict M3 Phase 1 invariant: deposits disabled
      depositWarning: isTestnet
        ? "TESTNET_WALLET: Addresses are for testnet provider compatibility rehearsal only. NEVER send mainnet or real funds to testnet addresses."
        : null,
    };
  }

  if (!wallet) {
    return {
      accountId,
      wallet: null,
      balances: [],
    };
  }

  // Set database-level tenant RLS context and query wallet balances inside a transaction
  // so the RLS context applies reliably on the same connection.
  type BalanceQueryRow = {
    id: string;
    walletId: string;
    networkAssetId: string;
    tokenAccountAddress: string | null;
    atomicBalance: string;
    blockHeight: bigint | null;
    blockTimestamp: Date | null;
    observedAt: Date;
    finality: string;
    syncStatus: string;
    lastSyncedAt: Date | null;
    lastError: string | null;
    network: string;
    chainId: string;
    tokenStandard: string;
    contractAddress: string | null;
    decimals: number;
    symbolOverride: string | null;
    nameOverride: string | null;
    isVerified: boolean;
    isDepositEligible: boolean;
    status: string;
    assetId: string;
    assetSymbol: string;
    assetName: string;
    assetKind: string;
    assetDescription: string | null;
    assetIconUrl: string | null;
  };

  const queryBalancesWithContext = async (
    tx: FlowDb,
  ): Promise<BalanceQueryRow[]> => {
    await tx.$executeRaw`
      SELECT set_config('flow.current_account_id', ${accountId}, true),
             set_config('flow.current_session_token', ${sessionToken.trim()}, true)
    `;

    return tx.$queryRaw<BalanceQueryRow[]>`
      SELECT
        wb.id,
        wb.wallet_id AS "walletId",
        wb.network_asset_id AS "networkAssetId",
        wb.token_account_address AS "tokenAccountAddress",
        wb.atomic_balance::text AS "atomicBalance",
        wb.block_height AS "blockHeight",
        wb.block_timestamp AS "blockTimestamp",
        wb.observed_at AS "observedAt",
        wb.finality,
        wb.sync_status AS "syncStatus",
        wb.last_synced_at AS "lastSyncedAt",
        wb.last_error AS "lastError",
        na.network,
        na.chain_id AS "chainId",
        na.token_standard AS "tokenStandard",
        na.contract_address AS "contractAddress",
        na.decimals,
        na.symbol_override AS "symbolOverride",
        na.name_override AS "nameOverride",
        na.is_verified AS "isVerified",
        na.is_deposit_eligible AS "isDepositEligible",
        na.status,
        a.id AS "assetId",
        a.symbol AS "assetSymbol",
        a.name AS "assetName",
        a.kind AS "assetKind",
        a.description AS "assetDescription",
        a.icon_url AS "assetIconUrl"
      FROM flow.wallet_balances wb
      JOIN flow.network_assets na ON na.id = wb.network_asset_id
      JOIN flow.assets a ON a.id = na.asset_id
      WHERE wb.wallet_id = ${wallet.id}::uuid
      ORDER BY na.network, na.chain_id, a.symbol
    `;
  };

  const dbWithTx = db as {
    $transaction?: <T>(fn: (tx: FlowDb) => Promise<T>) => Promise<T>;
  };
  const balanceRows: BalanceQueryRow[] =
    typeof dbWithTx.$transaction === "function"
      ? await dbWithTx.$transaction(queryBalancesWithContext)
      : await queryBalancesWithContext(db);

  const balances: WalletBalanceRecord[] = balanceRows.map((r) => {
    const atomic = BigInt(r.atomicBalance);
    const display = formatAtomicToDisplay(atomic, r.decimals);
    const isZeroConfirmed = r.syncStatus === "SYNCED" && atomic === 0n;

    return {
      id: r.id,
      walletId: r.walletId,
      networkAssetId: r.networkAssetId,
      tokenAccountAddress: r.tokenAccountAddress,
      atomicBalance: atomic,
      displayBalance: display,
      blockHeight: r.blockHeight !== null ? BigInt(r.blockHeight) : null,
      blockTimestamp: r.blockTimestamp,
      observedAt: r.observedAt,
      finality: r.finality as BalanceFinality,
      syncStatus: r.syncStatus as SyncStatus,
      isZeroConfirmed,
      lastSyncedAt: r.lastSyncedAt,
      lastError: r.lastError,
      networkAsset: {
        id: r.networkAssetId,
        assetId: r.assetId,
        network: r.network as NetworkId,
        chainId: r.chainId,
        tokenStandard: r.tokenStandard as TokenStandard,
        contractAddress: r.contractAddress,
        decimals: r.decimals,
        symbolOverride: r.symbolOverride,
        nameOverride: r.nameOverride,
        isVerified: r.isVerified,
        isDepositEligible: r.isDepositEligible,
        status: r.status as "ACTIVE" | "DEPRECATED" | "UNSUPPORTED",
        asset: {
          id: r.assetId,
          symbol: r.assetSymbol,
          name: r.assetName,
          kind: r.assetKind as AssetKind,
          description: r.assetDescription,
          iconUrl: r.assetIconUrl,
        },
      },
    };
  });

  return {
    accountId,
    wallet: walletMeta,
    balances,
  };
}

/**
 * Upserts a wallet balance record (used by worker reconciler processes).
 * Enforces non-negative atomic balance and valid sync status/finality.
 */
export async function upsertWalletBalance(
  db: FlowDb,
  input: UpsertWalletBalanceInput,
): Promise<string> {
  assertNonNegativeAtomic(input.atomicBalance, "atomicBalance");
  assertValidSyncStatus(input.syncStatus);
  const finality = input.finality ?? "UNKNOWN";
  assertValidFinality(finality);

  if (
    input.blockHeight !== undefined &&
    input.blockHeight !== null &&
    input.blockHeight < 0n
  ) {
    throw new FlowError(
      "INVALID_CONFIGURATION",
      "Block height cannot be negative.",
    );
  }

  // 1. Verify wallet environment vs asset chain consistency
  const wallets = await db.$queryRaw<Array<{ environment: string }>>`
    SELECT environment FROM flow.wallets WHERE id = ${input.walletId}::uuid
  `;
  const wallet = wallets[0];
  if (!wallet) {
    throw new FlowError(
      "INVALID_CONFIGURATION",
      `Wallet not found: ${input.walletId}`,
    );
  }

  const assets = await db.$queryRaw<
    Array<{ network: string; chainId: string }>
  >`
    SELECT network, chain_id as "chainId" FROM flow.network_assets WHERE id = ${input.networkAssetId}::uuid
  `;
  const asset = assets[0];
  if (!asset) {
    throw new FlowError(
      "INVALID_CONFIGURATION",
      `Network asset not found: ${input.networkAssetId}`,
    );
  }

  assertWalletChainConsistency(wallet.environment, asset.chainId);

  // 2. Verify registered address exists for this network and chain
  const addresses = await db.$queryRaw<Array<{ id: string }>>`
    SELECT id FROM flow.wallet_addresses
    WHERE wallet_id = ${input.walletId}::uuid
      AND network = ${asset.network}
      AND chain_id = ${asset.chainId}
  `;
  if (!addresses[0]) {
    throw new FlowError(
      "INVALID_CONFIGURATION",
      `Wallet ${input.walletId} has no registered address for network ${asset.network} chain ${asset.chainId}.`,
    );
  }

  const tokenAccount = input.tokenAccountAddress ?? null;
  const atomicStr = input.atomicBalance.toString();
  const blockHeightStr =
    input.blockHeight !== undefined && input.blockHeight !== null
      ? input.blockHeight.toString()
      : null;

  const result =
    tokenAccount === null
      ? await db.$queryRaw<Array<{ id: string }>>`
          INSERT INTO flow.wallet_balances (
            wallet_id,
            network_asset_id,
            token_account_address,
            atomic_balance,
            block_height,
            block_timestamp,
            observed_at,
            finality,
            sync_status,
            last_synced_at,
            last_error,
            created_at,
            updated_at
          )
          VALUES (
            ${input.walletId}::uuid,
            ${input.networkAssetId}::uuid,
            NULL,
            ${atomicStr}::numeric,
            ${blockHeightStr}::bigint,
            ${input.blockTimestamp ?? null},
            CURRENT_TIMESTAMP,
            ${finality},
            ${input.syncStatus},
            CURRENT_TIMESTAMP,
            ${input.lastError ?? null},
            CURRENT_TIMESTAMP,
            CURRENT_TIMESTAMP
          )
          ON CONFLICT (wallet_id, network_asset_id) WHERE token_account_address IS NULL
          DO UPDATE SET
            atomic_balance = EXCLUDED.atomic_balance,
            block_height = EXCLUDED.block_height,
            block_timestamp = EXCLUDED.block_timestamp,
            observed_at = EXCLUDED.observed_at,
            finality = EXCLUDED.finality,
            sync_status = EXCLUDED.sync_status,
            last_synced_at = EXCLUDED.last_synced_at,
            last_error = EXCLUDED.last_error,
            updated_at = CURRENT_TIMESTAMP
          RETURNING id
        `
      : await db.$queryRaw<Array<{ id: string }>>`
          INSERT INTO flow.wallet_balances (
            wallet_id,
            network_asset_id,
            token_account_address,
            atomic_balance,
            block_height,
            block_timestamp,
            observed_at,
            finality,
            sync_status,
            last_synced_at,
            last_error,
            created_at,
            updated_at
          )
          VALUES (
            ${input.walletId}::uuid,
            ${input.networkAssetId}::uuid,
            ${tokenAccount},
            ${atomicStr}::numeric,
            ${blockHeightStr}::bigint,
            ${input.blockTimestamp ?? null},
            CURRENT_TIMESTAMP,
            ${finality},
            ${input.syncStatus},
            CURRENT_TIMESTAMP,
            ${input.lastError ?? null},
            CURRENT_TIMESTAMP,
            CURRENT_TIMESTAMP
          )
          ON CONFLICT (wallet_id, network_asset_id, token_account_address) WHERE token_account_address IS NOT NULL
          DO UPDATE SET
            atomic_balance = EXCLUDED.atomic_balance,
            block_height = EXCLUDED.block_height,
            block_timestamp = EXCLUDED.block_timestamp,
            observed_at = EXCLUDED.observed_at,
            finality = EXCLUDED.finality,
            sync_status = EXCLUDED.sync_status,
            last_synced_at = EXCLUDED.last_synced_at,
            last_error = EXCLUDED.last_error,
            updated_at = CURRENT_TIMESTAMP
          RETURNING id
        `;

  const row = result[0];
  if (!row) {
    throw new FlowError(
      "DATABASE_UNAVAILABLE",
      "Failed to upsert wallet balance record.",
    );
  }
  return row.id;
}

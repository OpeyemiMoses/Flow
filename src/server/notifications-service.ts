import { type FlowDb } from "../foundation/prisma.ts";

export type NotificationCategory = "all" | "payments" | "accounts" | "system";

export type NotificationType =
  | "PAYMENT_RECEIVED"
  | "PAYMENT_COMPLETED"
  | "PAYMENT_LINK_CREATED"
  | "DEPOSIT_DETECTED"
  | "SWAP_COMPLETED"
  | "SYNC_NOTICE"
  | "SECURITY_NOTICE";

export interface AccountNotification {
  readonly id: string;
  readonly accountId: string;
  readonly category: "payments" | "accounts" | "system";
  readonly type: NotificationType;
  readonly title: string;
  readonly description: string;
  readonly link: string | null;
  readonly isRead: boolean;
  readonly createdAt: string;
}

// In-memory set of read notification IDs per account
const readNotificationIds = new Set<string>();

export async function getAccountNotifications(
  db: FlowDb,
  accountId: string,
): Promise<AccountNotification[]> {
  const notifications: AccountNotification[] = [];

  // 1. Fetch genuine completed payment attempts for this account
  try {
    const completedAttempts = await db.$queryRaw<
      Array<{
        attempt_id: string;
        public_id: string;
        title: string;
        source_network: string;
        source_asset_symbol: string;
        destination_network: string;
        destination_asset_symbol: string;
        quoted_destination_atomic_amount: string;
        destination_decimals: number;
        settled_at: Date | null;
        created_at: Date;
      }>
    >`
      SELECT 
        pa.id as attempt_id,
        pa.attempt_public_id as public_id,
        pr.title,
        pa.source_network,
        pa.source_asset_symbol,
        pr.destination_network,
        pr.destination_asset_symbol,
        pa.quoted_destination_atomic_amount,
        pa.source_decimals as destination_decimals,
        pa.settled_at,
        pa.created_at
      FROM flow.payment_attempts pa
      JOIN flow.payment_requests pr ON pr.id = pa.payment_request_id
      WHERE pr.account_id = ${accountId}::uuid
        AND pa.status = 'SETTLED'
      ORDER BY pa.settled_at DESC NULLS LAST, pa.created_at DESC
      LIMIT 10
    `;

    for (const a of completedAttempts) {
      const notifId = `notif_settled_${a.attempt_id}`;
      const amount = (
        Number(a.quoted_destination_atomic_amount) /
        10 ** 6
      ).toFixed(2);
      notifications.push({
        id: notifId,
        accountId,
        category: "payments",
        type: "PAYMENT_RECEIVED",
        title: "Payment received",
        description: `+${amount} ${a.destination_asset_symbol} on ${a.destination_network.replace("-mainnet", "")}`,
        link: `/accounts/${accountId}?view=activity`,
        isRead: readNotificationIds.has(notifId),
        createdAt: (a.settled_at ?? a.created_at).toISOString(),
      });
    }
  } catch {
    // Graceful fallback if query fails
  }

  // 2. Fetch created payment requests
  try {
    const prs = await db.$queryRaw<
      Array<{
        id: string;
        public_id: string;
        title: string;
        created_at: Date;
      }>
    >`
      SELECT id, public_id, title, created_at
      FROM flow.payment_requests
      WHERE account_id = ${accountId}::uuid
      ORDER BY created_at DESC
      LIMIT 10
    `;

    for (const pr of prs) {
      const notifId = `notif_pr_${pr.id}`;
      notifications.push({
        id: notifId,
        accountId,
        category: "payments",
        type: "PAYMENT_LINK_CREATED",
        title: "Payment link created",
        description: `"${pr.title}" is active and ready to share.`,
        link: `/accounts/${accountId}?view=payment-links`,
        isRead: readNotificationIds.has(notifId),
        createdAt: pr.created_at.toISOString(),
      });
    }
  } catch {
    // Graceful fallback
  }

  // 3. Balance sync notices from wallet balances
  try {
    const syncErrors = await db.$queryRaw<
      Array<{
        id: string;
        network: string;
        last_error: string;
        observed_at: Date;
      }>
    >`
      SELECT wb.id, na.network, wb.last_error, wb.observed_at
      FROM flow.wallet_balances wb
      JOIN flow.network_assets na ON na.id = wb.network_asset_id
      JOIN flow.wallets w ON w.id = wb.wallet_id
      WHERE w.account_id = ${accountId}::uuid
        AND wb.last_error IS NOT NULL
      ORDER BY wb.observed_at DESC
      LIMIT 5
    `;

    for (const se of syncErrors) {
      const notifId = `notif_sync_${se.id}`;
      notifications.push({
        id: notifId,
        accountId,
        category: "system",
        type: "SYNC_NOTICE",
        title: "Balance sync notice",
        description: `${se.network}: ${se.last_error}`,
        link: `/accounts/${accountId}?view=dashboard`,
        isRead: readNotificationIds.has(notifId),
        createdAt: se.observed_at.toISOString(),
      });
    }
  } catch {
    // Graceful fallback
  }

  // Sort latest first
  notifications.sort(
    (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
  );

  return notifications;
}

export function markNotificationAsRead(notificationId: string): void {
  readNotificationIds.add(notificationId);
}

export function markAllNotificationsAsRead(notificationIds: string[]): void {
  for (const id of notificationIds) {
    readNotificationIds.add(id);
  }
}

import { NextResponse } from "next/server";
import { runtime as getPrismaRuntime } from "../../../../../foundation/prisma.ts";
import {
  getAccountNotifications,
  markAllNotificationsAsRead,
  markNotificationAsRead,
} from "../../../../../server/notifications-service.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const db = getPrismaRuntime().db;
    const notifications = await getAccountNotifications(db, id);
    const unreadCount = notifications.filter(
      (n: { isRead: boolean }) => !n.isRead,
    ).length;

    return NextResponse.json({
      ok: true,
      unreadCount,
      notifications,
    });
  } catch (error) {
    return NextResponse.json(
      {
        ok: false,
        error:
          error instanceof Error
            ? error.message
            : "Failed to fetch notifications",
      },
      { status: 500 },
    );
  }
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    await params;
    const body = await request.json();
    if (body.markAll && Array.isArray(body.ids)) {
      markAllNotificationsAsRead(body.ids);
    } else if (body.id) {
      markNotificationAsRead(body.id);
    }

    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json(
      {
        ok: false,
        error:
          error instanceof Error
            ? error.message
            : "Failed to update notifications",
      },
      { status: 500 },
    );
  }
}

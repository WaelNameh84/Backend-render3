import { db } from "@workspace/db";
import { notificationsTable } from "@workspace/db";

export type NotifType =
  | "REGISTRATION"
  | "LEAVE_REQUEST"
  | "LATE_CHECKIN"
  | "LATE_JUSTIFICATION"
  | "SYSTEM_ALERT";

export async function createNotification(params: {
  type: NotifType;
  title: string;
  message: string;
  relatedId?: number;
  relatedType?: string;
}) {
  try {
    await db.insert(notificationsTable).values({
      type: params.type,
      title: params.title,
      message: params.message,
      relatedId: params.relatedId ?? null,
      relatedType: params.relatedType ?? null,
      status: "unread",
    });
  } catch (err) {
    console.error("[notify] Failed to create notification:", err);
  }
}

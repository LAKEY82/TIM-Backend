import type { Types } from "mongoose";
import { Notification, User } from "../models";
import type { EntityType, NotificationType } from "../types/domain";
import { logger } from "../utils/logger";

export interface NotifyInput {
  recipients: (Types.ObjectId | null | undefined)[];
  actor?: Types.ObjectId | null;
  type: NotificationType;
  title: string;
  body?: string | null;
  entityType?: EntityType | null;
  entityId?: Types.ObjectId | null;
}

/**
 * Creates in-app notifications. Skips the actor themselves, duplicates, and
 * users who switched this type off (`notificationPreferences.inApp[type] === false`).
 * Like activity logging, failures never break the triggering action.
 */
export async function notify(input: NotifyInput): Promise<void> {
  try {
    const ids = new Map<string, Types.ObjectId>();
    for (const r of input.recipients) {
      if (r && (!input.actor || String(r) !== String(input.actor))) ids.set(String(r), r);
    }
    if (ids.size === 0) return;

    const users = await User.find({ _id: { $in: [...ids.values()] }, status: "ACTIVE" })
      .select("notificationPreferences")
      .lean();
    const allowed = users.filter((u) => u.notificationPreferences?.inApp?.[input.type] !== false);
    if (allowed.length === 0) return;

    await Notification.insertMany(
      allowed.map((u) => ({
        recipient: u._id,
        actor: input.actor ?? null,
        type: input.type,
        title: input.title.slice(0, 300),
        body: input.body?.slice(0, 1000) ?? null,
        entityType: input.entityType ?? null,
        entityId: input.entityId ?? null,
      })),
    );
  } catch (error) {
    logger.error("Failed to create notifications", { type: input.type, message: error instanceof Error ? error.message : String(error) });
  }
}

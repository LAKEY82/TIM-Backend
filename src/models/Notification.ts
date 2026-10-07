import { Schema, model, type Types } from "mongoose";
import { ENTITY_TYPES, NOTIFICATION_TYPES, type EntityType, type NotificationType } from "../types/domain";

export interface INotification {
  recipient: Types.ObjectId;
  actor?: Types.ObjectId | null;
  type: NotificationType;
  title: string;
  body?: string | null;
  entityType?: EntityType | null;
  entityId?: Types.ObjectId | null;
  readAt?: Date | null;
  createdAt: Date;
}

const notificationSchema = new Schema<INotification>(
  {
    recipient: { type: Schema.Types.ObjectId, ref: "User", required: true },
    actor: { type: Schema.Types.ObjectId, ref: "User", default: null },
    type: { type: String, enum: NOTIFICATION_TYPES, required: true },
    title: { type: String, required: true, maxlength: 300 },
    body: { type: String, maxlength: 1000, default: null },
    entityType: { type: String, enum: ENTITY_TYPES, default: null },
    entityId: { type: Schema.Types.ObjectId, default: null },
    readAt: { type: Date, default: null },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);

// Serves both the unread count ({recipient, readAt: null}) and the unread-only inbox.
notificationSchema.index({ recipient: 1, readAt: 1, createdAt: -1 });
notificationSchema.index({ recipient: 1, createdAt: -1 });

export const Notification = model<INotification>("Notification", notificationSchema);

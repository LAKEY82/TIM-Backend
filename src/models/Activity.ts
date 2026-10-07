import { Schema, model, type Types } from "mongoose";
import { ENTITY_TYPES, type EntityType } from "../types/domain";

export interface IActivity {
  actor?: Types.ObjectId | null;
  /** Machine key, e.g. TASK_STATUS_CHANGED. */
  type: string;
  /** Display verb, e.g. "submitted for review". The UI renders "<actor> <verb> <entity>". */
  verb: string;
  entityType: EntityType;
  entityId: Types.ObjectId;
  entityName: string;
  target?: { type: EntityType; id: Types.ObjectId; name: string } | null;
  message?: string | null;
  // Scope fields for filtering and access control.
  project?: Types.ObjectId | null;
  department?: Types.ObjectId | null;
  client?: Types.ObjectId | null;
  metadata?: Record<string, unknown> | null;
  createdAt: Date;
}

const targetSchema = new Schema(
  {
    type: { type: String, enum: ENTITY_TYPES, required: true },
    id: { type: Schema.Types.ObjectId, required: true },
    name: { type: String, default: "" },
  },
  { _id: false },
);

const activitySchema = new Schema<IActivity>(
  {
    actor: { type: Schema.Types.ObjectId, ref: "User", default: null },
    type: { type: String, required: true, maxlength: 60 },
    verb: { type: String, required: true, maxlength: 120 },
    entityType: { type: String, enum: ENTITY_TYPES, required: true },
    entityId: { type: Schema.Types.ObjectId, required: true },
    entityName: { type: String, default: "", maxlength: 300 },
    target: { type: targetSchema, default: null },
    message: { type: String, maxlength: 500, default: null },
    project: { type: Schema.Types.ObjectId, ref: "Project", default: null },
    department: { type: Schema.Types.ObjectId, ref: "Department", default: null },
    client: { type: Schema.Types.ObjectId, ref: "Client", default: null },
    metadata: { type: Schema.Types.Mixed, default: null },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);

activitySchema.index({ entityType: 1, entityId: 1, createdAt: -1 });
activitySchema.index({ project: 1, createdAt: -1 });
activitySchema.index({ actor: 1, createdAt: -1 });
activitySchema.index({ createdAt: -1 });

// The audit log is append-only: refuse in-place edits through the model.
activitySchema.pre(["updateOne", "updateMany", "findOneAndUpdate", "replaceOne"], function () {
  throw new Error("Activity entries are append-only.");
});

export const Activity = model<IActivity>("Activity", activitySchema);

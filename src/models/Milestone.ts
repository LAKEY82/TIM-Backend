import { Schema, model, type Types } from "mongoose";
import { MILESTONE_STATUSES, type MilestoneStatus } from "../types/domain";

export interface IMilestone {
  project: Types.ObjectId;
  name: string;
  description?: string | null;
  status: MilestoneStatus;
  startDate?: Date | null;
  dueDate?: Date | null;
  completedAt?: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

const milestoneSchema = new Schema<IMilestone>(
  {
    project: { type: Schema.Types.ObjectId, ref: "Project", required: true },
    name: { type: String, required: true, trim: true, maxlength: 150 },
    description: { type: String, trim: true, maxlength: 5000, default: null },
    status: { type: String, enum: MILESTONE_STATUSES, default: "PENDING" },
    startDate: { type: Date, default: null },
    dueDate: { type: Date, default: null },
    completedAt: { type: Date, default: null },
  },
  { timestamps: true },
);

milestoneSchema.index({ project: 1, dueDate: 1 });
milestoneSchema.index({ dueDate: 1 });

export const Milestone = model<IMilestone>("Milestone", milestoneSchema);

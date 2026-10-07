import { Schema, model, type Types } from "mongoose";
import { PRIORITIES, type Priority } from "../types/domain";

export interface IDailyTask {
  /** Calendar day as `yyyy-MM-dd`, so there is no timezone ambiguity. */
  date: string;
  task: Types.ObjectId;
  assignee: Types.ObjectId;
  assignedBy: Types.ObjectId;
  priority: Priority;
  estimatedHours?: number | null;
  dueTime?: string | null;
  note?: string | null;
  createdAt: Date;
}

const dailyTaskSchema = new Schema<IDailyTask>(
  {
    date: { type: String, required: true, match: /^\d{4}-\d{2}-\d{2}$/ },
    task: { type: Schema.Types.ObjectId, ref: "Task", required: true },
    assignee: { type: Schema.Types.ObjectId, ref: "User", required: true },
    assignedBy: { type: Schema.Types.ObjectId, ref: "User", required: true },
    priority: { type: String, enum: PRIORITIES, default: "MEDIUM" },
    estimatedHours: { type: Number, min: 0, max: 24, default: null },
    dueTime: { type: String, match: /^\d{2}:\d{2}$/, default: null },
    note: { type: String, trim: true, maxlength: 1000, default: null },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);

dailyTaskSchema.index({ date: 1, assignee: 1, task: 1 }, { unique: true });
dailyTaskSchema.index({ task: 1 });

export const DailyTask = model<IDailyTask>("DailyTask", dailyTaskSchema);

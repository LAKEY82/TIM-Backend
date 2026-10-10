import { Schema, model, type HydratedDocument, type Types } from "mongoose";
import { PRIORITIES, PROJECT_STATUSES, PROJECT_TYPES, type Priority, type ProjectStatus, type ProjectType } from "../types/domain";

export interface IProject {
  name: string;
  description?: string | null;
  client?: Types.ObjectId | null;
  type: ProjectType;
  status: ProjectStatus;
  priority: Priority;
  manager?: Types.ObjectId | null;
  /** QA person: tests every task after code review. */
  qa?: Types.ObjectId | null;
  /** True once the staged workflow (Design → Development → QA → Bug fixing) is set up. */
  workflow: boolean;
  /** Who gets the Bug fixing stage; it's only created once QA reports bugs on the QA stage. */
  bugFixer?: Types.ObjectId | null;
  /** Bounded (a project team), queried through a multikey index. */
  members: Types.ObjectId[];
  department?: Types.ObjectId | null;
  startDate?: Date | null;
  deadline?: Date | null;
  estimatedHours?: number | null;
  createdBy?: Types.ObjectId | null;
  // Denormalized counters, recalculated whenever tasks change (see project-stats).
  taskCount: number;
  completedTaskCount: number;
  progress: number;
  createdAt: Date;
  updatedAt: Date;
}

const projectSchema = new Schema<IProject>(
  {
    name: { type: String, required: true, trim: true, maxlength: 150 },
    description: { type: String, trim: true, maxlength: 10000, default: null },
    client: { type: Schema.Types.ObjectId, ref: "Client", default: null },
    type: { type: String, enum: PROJECT_TYPES, default: "EXTERNAL" },
    status: { type: String, enum: PROJECT_STATUSES, default: "PLANNING" },
    priority: { type: String, enum: PRIORITIES, default: "MEDIUM" },
    manager: { type: Schema.Types.ObjectId, ref: "User", default: null },
    qa: { type: Schema.Types.ObjectId, ref: "User", default: null },
    workflow: { type: Boolean, default: false },
    bugFixer: { type: Schema.Types.ObjectId, ref: "User", default: null },
    members: [{ type: Schema.Types.ObjectId, ref: "User" }],
    department: { type: Schema.Types.ObjectId, ref: "Department", default: null },
    startDate: { type: Date, default: null },
    deadline: { type: Date, default: null },
    estimatedHours: { type: Number, min: 0, default: null },
    createdBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
    taskCount: { type: Number, default: 0 },
    completedTaskCount: { type: Number, default: 0 },
    progress: { type: Number, default: 0, min: 0, max: 100 },
  },
  { timestamps: true },
);

projectSchema.index({ status: 1 });
projectSchema.index({ client: 1 });
projectSchema.index({ members: 1 });
projectSchema.index({ manager: 1 });
projectSchema.index({ qa: 1 });
projectSchema.index({ department: 1 });
projectSchema.index({ deadline: 1 });

export type ProjectDoc = HydratedDocument<IProject>;
export const Project = model<IProject>("Project", projectSchema);

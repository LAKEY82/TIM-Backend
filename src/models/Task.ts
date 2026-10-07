import { Schema, model, type HydratedDocument, type Types } from "mongoose";
import {
  PRIORITIES,
  REVIEW_DECISIONS,
  TASK_STATUSES,
  TASK_TYPES,
  QA_RESULTS,
  WORKFLOW_STAGES,
  QA_ISSUE_KINDS,
  type QaIssueKind,
  type Priority,
  type QaResult,
  type ReviewDecision,
  type TaskStatus,
  type TaskType,
  type WorkflowStage,
} from "../types/domain";

export interface IReviewEntry {
  _id: Types.ObjectId;
  decision: ReviewDecision;
  feedback?: string | null;
  actor: Types.ObjectId;
  createdAt: Date;
}

/** The QA report behind an issue subtask. */
export interface IQaIssue {
  kind: QaIssueKind;
  steps?: string | null;
  expected?: string | null;
  actual?: string | null;
  environment?: string | null;
  reportedBy: Types.ObjectId;
}

export interface ITask {
  title: string;
  description?: string | null;
  project: Types.ObjectId;
  milestone?: Types.ObjectId | null;
  /** Subtasks are ordinary tasks with a parent; the UI opens them at /tasks/:id. */
  parent?: Types.ObjectId | null;
  assignee?: Types.ObjectId | null;
  reviewer?: Types.ObjectId | null;
  /** QA tester: the project's QA, set when the task enters QA (review approved or sent by a manager). */
  qa?: Types.ObjectId | null;
  /** When QA testing should be finished; set per task by the project manager. */
  qaDueDate?: Date | null;
  /** QA's verdict on a stage subtask this testing round; cleared when it goes back to QA. */
  qaResult?: QaResult | null;
  /** When the current round of QA testing began (issues logged since then belong to it). */
  qaStartedAt?: Date | null;
  /** Set on the stage tasks of a project's workflow (see utils/workflow). */
  stage?: WorkflowStage | null;
  /** Set on subtasks QA created when reporting a bug, defect or other issue. */
  qaIssue?: IQaIssue | null;
  createdBy?: Types.ObjectId | null;
  department?: Types.ObjectId | null;
  status: TaskStatus;
  priority: Priority;
  /** Numeric mirror of `priority` so LOW < MEDIUM < HIGH < URGENT sorts correctly. */
  priorityRank: number;
  type: TaskType;
  tags: string[];
  watchers: Types.ObjectId[];
  startDate?: Date | null;
  dueDate?: Date | null;
  estimatedHours?: number | null;
  actualHours?: number | null;
  completedAt?: Date | null;
  /** Append-only and a handful per task, so embedded. Excluded from list queries. */
  reviewHistory: IReviewEntry[];
  lastDeadlineReminderAt?: Date | null;
  lastQaReminderAt?: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

const reviewSchema = new Schema<IReviewEntry>(
  {
    decision: { type: String, enum: REVIEW_DECISIONS, required: true },
    feedback: { type: String, trim: true, maxlength: 4000, default: null },
    actor: { type: Schema.Types.ObjectId, ref: "User", required: true },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);

const qaIssueSchema = new Schema<IQaIssue>(
  {
    kind: { type: String, enum: QA_ISSUE_KINDS, required: true },
    steps: { type: String, trim: true, maxlength: 5000, default: null },
    expected: { type: String, trim: true, maxlength: 2000, default: null },
    actual: { type: String, trim: true, maxlength: 2000, default: null },
    environment: { type: String, trim: true, maxlength: 300, default: null },
    reportedBy: { type: Schema.Types.ObjectId, ref: "User", required: true },
  },
  { _id: false },
);

const taskSchema = new Schema<ITask>(
  {
    title: { type: String, required: true, trim: true, maxlength: 200 },
    description: { type: String, trim: true, maxlength: 10000, default: null },
    project: { type: Schema.Types.ObjectId, ref: "Project", required: true },
    milestone: { type: Schema.Types.ObjectId, ref: "Milestone", default: null },
    parent: { type: Schema.Types.ObjectId, ref: "Task", default: null },
    assignee: { type: Schema.Types.ObjectId, ref: "User", default: null },
    reviewer: { type: Schema.Types.ObjectId, ref: "User", default: null },
    qa: { type: Schema.Types.ObjectId, ref: "User", default: null },
    createdBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
    department: { type: Schema.Types.ObjectId, ref: "Department", default: null },
    status: { type: String, enum: TASK_STATUSES, default: "TODO" },
    priority: { type: String, enum: PRIORITIES, default: "MEDIUM" },
    priorityRank: { type: Number, default: 1 },
    type: { type: String, enum: TASK_TYPES, default: "OTHER" },
    tags: { type: [{ type: String, trim: true, maxlength: 40 }], default: [] },
    watchers: [{ type: Schema.Types.ObjectId, ref: "User" }],
    startDate: { type: Date, default: null },
    dueDate: { type: Date, default: null },
    qaDueDate: { type: Date, default: null },
    qaResult: { type: String, enum: [...QA_RESULTS, null], default: null },
    qaStartedAt: { type: Date, default: null },
    stage: { type: String, enum: WORKFLOW_STAGES, default: null },
    qaIssue: { type: qaIssueSchema, default: null },
    estimatedHours: { type: Number, min: 0, max: 1000, default: null },
    actualHours: { type: Number, min: 0, max: 10000, default: null },
    completedAt: { type: Date, default: null },
    reviewHistory: { type: [reviewSchema], default: [] },
    lastDeadlineReminderAt: { type: Date, default: null },
    lastQaReminderAt: { type: Date, default: null },
  },
  { timestamps: true },
);

taskSchema.index({ project: 1, status: 1 });
taskSchema.index({ assignee: 1, status: 1 });
taskSchema.index({ reviewer: 1, status: 1 });
taskSchema.index({ qa: 1, status: 1 });
taskSchema.index({ status: 1, qaDueDate: 1 });
taskSchema.index({ dueDate: 1, status: 1 });
taskSchema.index({ priorityRank: 1 });
taskSchema.index({ project: 1, stage: 1 });
taskSchema.index({ department: 1 });
taskSchema.index({ parent: 1 });
taskSchema.index({ milestone: 1 });
taskSchema.index({ createdAt: -1 });
taskSchema.index({ completedAt: -1 });

export type TaskDoc = HydratedDocument<ITask>;
export const Task = model<ITask>("Task", taskSchema);

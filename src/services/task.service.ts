import { Types, type QueryFilter } from "mongoose";
import type { z } from "zod";
import { Comment, DailyTask, Department, FileModel, Milestone, Project, Task, User, type ITask } from "../models";
import { DONE_STATUSES, PRIORITY_RANK, QA_ISSUE_LABELS, ROLLUP_STAGES, WORKFLOW_STAGES, type Priority, type QaIssueKind, type QaResult, type ReviewDecision, type TaskStatus, type WorkflowStage } from "../types/domain";
import type { AuthUser } from "../types/express";
import { forbidden, notFound, unprocessable } from "../utils/errors";
import { isoDay, serializeTask, serializeTaskSummary } from "../utils/serialize";
import { STAGE_META } from "../utils/workflow";
import { searchRegex } from "../validators/common";
import type { createTaskSchema, listTasksQuery, updateTaskSchema } from "../validators/tasks.validators";
import { accessibleProject, accessibleTask, canManageTask, canQaTask, canReviewTask, isAssignee, taskScopeFilter } from "./access.service";
import { logActivity } from "./activity.service";
import { deleteFile, listFiles } from "./file.service";
import { notify } from "./notification.service";
import { recalcProjectStats } from "./project.service";

const USER_SUMMARY = "firstName lastName email profileImage role jobTitle";
export const TASK_POPULATE = [
  { path: "project", select: "name" },
  { path: "milestone", select: "name" },
  { path: "assignee", select: USER_SUMMARY },
  { path: "reviewer", select: USER_SUMMARY },
  { path: "qa", select: USER_SUMMARY },
];
/** Large/embedded fields not needed in lists. */
const LIST_PROJECTION = "-reviewHistory -watchers -description -lastDeadlineReminderAt -lastQaReminderAt";

const oid = (id: string) => new Types.ObjectId(id);
const isDone = (s: TaskStatus) => DONE_STATUSES.includes(s);
const startOfDay = (day: string) => new Date(`${day}T00:00:00.000Z`);
const endOfDay = (day: string) => new Date(`${day}T23:59:59.999Z`);

/** Human verb per target status, so activity reads "Pabasara started Checkout API". */
const STATUS_VERB: Record<TaskStatus, string> = {
  WAITING: "put on hold",
  TODO: "reopened",
  IN_PROGRESS: "started",
  BLOCKED: "marked as blocked",
  COMPLETED: "completed",
  IN_REVIEW: "submitted for review",
  IN_QA: "approved and sent to QA",
  TESTED: "finished testing",
  CHANGES_REQUESTED: "requested changes on",
  APPROVED: "approved",
};

/**
 * Moves an assignee may make on their own: work statuses and sending for review.
 * Completed, Testing and Tested belong to the project manager and QA (bug items
 * from QA are the exception: the developer ticks each fix off, see changeStatus).
 */
const ASSIGNEE_TRANSITIONS: Partial<Record<TaskStatus, readonly TaskStatus[]>> = {
  TODO: ["IN_PROGRESS"],
  IN_PROGRESS: ["TODO", "BLOCKED", "IN_REVIEW"],
  BLOCKED: ["IN_PROGRESS"],
  COMPLETED: ["IN_PROGRESS", "IN_REVIEW"],
  CHANGES_REQUESTED: ["IN_PROGRESS", "IN_REVIEW"],
};
const SUBMITTABLE: readonly TaskStatus[] = ["TODO", "IN_PROGRESS", "COMPLETED", "CHANGES_REQUESTED"];

// ---------------------------------------------------------------------------
// Counts used by summaries
// ---------------------------------------------------------------------------

export async function summaryCounts(taskIds: Types.ObjectId[]) {
  if (!taskIds.length) return () => ({ subtaskCount: 0, completedSubtaskCount: 0, commentCount: 0 });
  const [subtasks, comments] = await Promise.all([
    Task.aggregate<{ _id: Types.ObjectId; total: number; done: number }>([
      { $match: { parent: { $in: taskIds } } },
      { $group: { _id: "$parent", total: { $sum: 1 }, done: { $sum: { $cond: [{ $in: ["$status", [...DONE_STATUSES]] }, 1, 0] } } } },
    ]),
    Comment.aggregate<{ _id: Types.ObjectId; n: number }>([
      { $match: { entityType: "TASK", entityId: { $in: taskIds } } },
      { $group: { _id: "$entityId", n: { $sum: 1 } } },
    ]),
  ]);
  const sub = new Map(subtasks.map((s) => [String(s._id), s]));
  const com = new Map(comments.map((c) => [String(c._id), c.n]));
  return (id: Types.ObjectId) => ({
    subtaskCount: sub.get(String(id))?.total ?? 0,
    completedSubtaskCount: sub.get(String(id))?.done ?? 0,
    commentCount: com.get(String(id)) ?? 0,
  });
}

/** Serializes lean tasks (already populated) as TaskSummary DTOs with counts. */
export async function toSummaries(tasks: (ITask & { _id: Types.ObjectId })[]) {
  const counts = await summaryCounts(tasks.map((t) => t._id));
  return tasks.map((t) => serializeTaskSummary(t, counts(t._id)));
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

/**
 * Work in review that's waiting for this user: they're its reviewer, or it has
 * no reviewer and they manage its project (stage subtasks are reviewed by the PM).
 */
async function awaitingReviewFilter(user: AuthUser): Promise<QueryFilter<ITask>> {
  const managed = await Project.find({ manager: user._id }).distinct("_id");
  // A stage with subtasks is "in review" because its subtasks are: those are what get reviewed.
  const rolledUp = await Task.find({ stage: { $in: [...ROLLUP_STAGES] }, status: "IN_REVIEW" }).distinct("_id");
  const withSubtasks = rolledUp.length ? await Task.distinct("parent", { parent: { $in: rolledUp } }) : [];
  return {
    status: "IN_REVIEW",
    assignee: { $ne: user._id },
    _id: { $nin: withSubtasks },
    $or: [{ reviewer: user._id }, { reviewer: null, project: { $in: managed } }],
  };
}

export async function listTasks(user: AuthUser, q: z.output<typeof listTasksQuery>) {
  const and: QueryFilter<ITask>[] = [await taskScopeFilter(user)];
  const f: QueryFilter<ITask> = {};
  if (q.projectId) f.project = oid(q.projectId);
  if (q.milestoneId) f.milestone = oid(q.milestoneId);
  if (q.parentId) f.parent = oid(q.parentId);
  if (q.awaitingReview) and.push(await awaitingReviewFilter(user));
  if (q.assigneeId === "me" && (q.includeReviews || q.includeQa)) {
    // "My tasks": what's assigned to me, plus what's waiting on me as reviewer or QA tester.
    const mine: QueryFilter<ITask>[] = [{ assignee: user._id }];
    if (q.includeReviews) mine.push(await awaitingReviewFilter(user));
    if (q.includeQa) mine.push({ qa: user._id, status: "IN_QA" });
    and.push({ $or: mine });
  } else if (q.assigneeId) f.assignee = q.assigneeId === "me" ? user._id : oid(q.assigneeId);
  if (q.reviewerId) f.reviewer = q.reviewerId === "me" ? user._id : oid(q.reviewerId);
  if (q.qaId) f.qa = q.qaId === "me" ? user._id : oid(q.qaId);
  if (q.departmentId) f.department = oid(q.departmentId);
  if (q.priority) f.priority = q.priority;
  const re = searchRegex(q.search);
  if (re) f.title = re;
  if (q.status?.length) f.status = { $in: q.status };

  const due: Record<string, Date> = {};
  if (q.dueFrom) due.$gte = startOfDay(q.dueFrom);
  if (q.dueTo) due.$lte = endOfDay(q.dueTo);
  if (q.overdue) {
    due.$lt = new Date();
    and.push({ status: { $nin: [...DONE_STATUSES] } });
  }
  if (Object.keys(due).length) f.dueDate = due;
  and.push(f);

  const sortField = q.sortBy === "priority" ? "priorityRank" : q.sortBy;
  const filter = { $and: and };
  const [items, total] = await Promise.all([
    Task.find(filter)
      .select(LIST_PROJECTION)
      .populate(TASK_POPULATE)
      .sort({ [sortField]: q.sortOrder === "desc" ? -1 : 1, _id: 1 })
      .skip(q.skip)
      .limit(q.pageSize)
      .lean(),
    Task.countDocuments(filter),
  ]);
  return { items: await toSummaries(items), total };
}

export async function getTaskDetail(id: Types.ObjectId | string) {
  const task = await Task.findById(id)
    .select("-reviewHistory")
    .populate([...TASK_POPULATE, { path: "createdBy", select: USER_SUMMARY }, { path: "department", select: "name" }, { path: "qaIssue.reportedBy", select: USER_SUMMARY }])
    .lean();
  if (!task) throw notFound("Task");
  const [subtasks, attachments, commentCount] = await Promise.all([
    Task.find({ parent: task._id }).select("title status assignee priority qaIssue.kind").populate("assignee", USER_SUMMARY).sort({ createdAt: 1, _id: 1 }).lean(),
    listFiles("TASK", task._id),
    Comment.countDocuments({ entityType: "TASK", entityId: task._id }),
  ]);
  const dto = serializeTask(task, { subtasks, attachments: [], commentCount });
  dto.attachments = attachments;
  return dto;
}

// ---------------------------------------------------------------------------
// Create / update / delete
// ---------------------------------------------------------------------------

async function assertUsers(fields: Record<string, string | null | undefined>) {
  const errors: { path: string; message: string }[] = [];
  for (const [path, id] of Object.entries(fields)) {
    if (id && !(await User.exists({ _id: id, status: "ACTIVE" }))) errors.push({ path, message: "Select an active user." });
  }
  if (errors.length) throw unprocessable("Please correct the highlighted fields.", errors);
}

async function assertMilestone(milestoneId: string | null | undefined, projectId: Types.ObjectId) {
  if (milestoneId && !(await Milestone.exists({ _id: milestoneId, project: projectId }))) {
    throw unprocessable("That milestone doesn't belong to this project.", [{ path: "milestoneId", message: "Select a milestone from this project." }]);
  }
}

async function assertDepartment(departmentId: string | null | undefined) {
  if (departmentId && !(await Department.exists({ _id: departmentId }))) {
    throw unprocessable("Department not found.", [{ path: "departmentId", message: "Select an existing department." }]);
  }
}

function notifyAssigned(actor: AuthUser, task: { _id: Types.ObjectId; title: string; assignee?: Types.ObjectId | null }) {
  if (!task.assignee) return;
  void notify({
    recipients: [task.assignee],
    actor: actor._id,
    type: "TASK_ASSIGNED",
    title: `${actor.name} assigned ${task.title} to you`,
    entityType: "TASK",
    entityId: task._id,
  });
}

async function logAssigned(actor: AuthUser, task: { _id: Types.ObjectId; title: string; project: Types.ObjectId; department?: Types.ObjectId | null }, assigneeId: Types.ObjectId) {
  const assignee = await User.findById(assigneeId).select("firstName lastName").lean();
  void logActivity({
    actor: actor._id,
    type: "TASK_ASSIGNED",
    verb: "assigned",
    entityType: "TASK",
    entityId: task._id,
    entityName: task.title,
    target: assignee ? { type: "USER", id: assignee._id, name: `${assignee.firstName} ${assignee.lastName}`.trim() } : null,
    project: task.project,
    department: task.department ?? null,
  });
}

export async function createTask(actor: AuthUser, input: z.output<typeof createTaskSchema>) {
  // Creating requires being able to see the project.
  const project = await accessibleProject(actor, input.projectId, "read");
  await Promise.all([
    assertUsers({ assigneeId: input.assigneeId, reviewerId: input.reviewerId }),
    assertMilestone(input.milestoneId, project._id),
    assertDepartment(input.departmentId),
  ]);
  const parent = input.parentId
    ? await Task.findOne({ _id: input.parentId, project: project._id }).select("stage assignee reviewer qa").lean()
    : null;
  if (input.parentId && !parent) {
    throw unprocessable("The parent task must be in the same project.", [{ path: "parentId", message: "Invalid parent task." }]);
  }
  // A subtask of a workflow stage belongs to that stage's person (the QA for the QA stage),
  // so it shows up in their task list.
  const stageOwner = parent?.stage ? (parent.stage === "QA" ? parent.qa : parent.assignee) : null;
  const assigneeId = input.assigneeId ?? (stageOwner ? String(stageOwner) : null);
  const reviewerId = input.reviewerId ?? (parent?.stage && parent.reviewer && String(parent.reviewer) !== assigneeId ? String(parent.reviewer) : null);

  let department = input.departmentId ?? null;
  if (!department && assigneeId) {
    const assignee = await User.findById(assigneeId).select("department").lean();
    department = assignee?.department ? String(assignee.department) : null;
  }
  department ??= project.department ? String(project.department) : null;

  const task = await Task.create({
    title: input.title,
    description: input.description ?? null,
    project: project._id,
    milestone: input.milestoneId ?? null,
    parent: input.parentId ?? null,
    assignee: assigneeId,
    reviewer: reviewerId,
    createdBy: actor._id,
    department,
    priority: input.priority,
    priorityRank: PRIORITY_RANK[input.priority],
    type: input.type,
    tags: [...new Set(input.tags)],
    startDate: input.startDate ?? null,
    dueDate: input.dueDate ?? null,
    estimatedHours: input.estimatedHours ?? null,
  });

  await recalcProjectStats(project._id);
  if (task.parent) await rollUpStage(actor, task.parent);
  void logActivity({ actor: actor._id, type: "TASK_CREATED", verb: "created", entityType: "TASK", entityId: task._id, entityName: task.title, project: project._id, department: task.department ?? null, client: project.client ?? null });
  if (task.assignee) {
    await logAssigned(actor, task, task.assignee);
    notifyAssigned(actor, task);
  }
  return getTaskDetail(task._id);
}

export async function updateTask(actor: AuthUser, id: string, input: z.output<typeof updateTaskSchema>) {
  const lean = await accessibleTask(actor, id);
  const manager = await canManageTask(actor, lean);
  const keys = Object.keys(input);
  if (!manager) {
    // Assignees may log their own time and nothing else.
    if (!isAssignee(actor, lean)) throw forbidden("You can't edit this task.");
    const other = keys.filter((k) => k !== "actualHours");
    if (other.length) throw forbidden("You can only log actual hours on tasks assigned to you.");
  }

  const task = await Task.findById(id);
  if (!task) throw notFound("Task");
  await Promise.all([
    assertUsers({ assigneeId: input.assigneeId, reviewerId: input.reviewerId }),
    assertMilestone(input.milestoneId, task.project),
    assertDepartment(input.departmentId),
  ]);

  if (input.qaId && !(await User.exists({ _id: input.qaId, status: "ACTIVE" }))) {
    throw unprocessable("QA tester not found.", [{ path: "qaId", message: "Select an active user." }]);
  }
  const nextAssignee = input.assigneeId !== undefined ? input.assigneeId : task.assignee ? String(task.assignee) : null;
  const nextQa = input.qaId !== undefined ? input.qaId : task.qa ? String(task.qa) : null;
  // The workflow's QA stage is the QA's own task; anywhere else nobody tests their own work.
  if (input.qaId && nextAssignee === nextQa && task.stage !== "QA") {
    throw unprocessable("The developer can't QA their own task. Choose someone else to test it.", [{ path: "qaId", message: "Choose someone other than the assignee." }]);
  }
  const nextReviewer = input.reviewerId !== undefined ? input.reviewerId : task.reviewer ? String(task.reviewer) : null;
  if (nextAssignee && nextReviewer && nextAssignee === nextReviewer) {
    throw unprocessable("The reviewer should be someone other than the assignee.", [{ path: "reviewerId", message: "Choose a different reviewer." }]);
  }
  const start = input.startDate !== undefined ? input.startDate : task.startDate;
  const due = input.dueDate !== undefined ? input.dueDate : task.dueDate;
  if (start && due && due < start) throw unprocessable("Due date can't be before the start date.", [{ path: "dueDate", message: "Due date can't be before the start date." }]);

  const previousAssignee = task.assignee ? String(task.assignee) : null;
  const previousQaDue = task.qaDueDate?.getTime() ?? null;
  const previousQa = task.qa ? String(task.qa) : null;
  if (input.title !== undefined) task.title = input.title;
  if (input.description !== undefined) task.description = input.description;
  if (input.milestoneId !== undefined) task.milestone = input.milestoneId ? oid(input.milestoneId) : null;
  if (input.assigneeId !== undefined) task.assignee = input.assigneeId ? oid(input.assigneeId) : null;
  if (input.reviewerId !== undefined) task.reviewer = input.reviewerId ? oid(input.reviewerId) : null;
  if (input.departmentId !== undefined) task.department = input.departmentId ? oid(input.departmentId) : null;
  if (input.priority !== undefined) {
    task.priority = input.priority;
    task.priorityRank = PRIORITY_RANK[input.priority];
  }
  if (input.type !== undefined) task.type = input.type;
  if (input.startDate !== undefined) task.startDate = input.startDate;
  if (input.dueDate !== undefined) task.dueDate = input.dueDate;
  const qaChanged = input.qaId !== undefined && (input.qaId ?? null) !== previousQa;
  if (qaChanged) {
    task.qa = input.qaId ? oid(input.qaId) : null;
    if (task.stage === "QA") task.assignee = task.qa; // the QA stage belongs to its tester
    task.lastQaReminderAt = null;
  }
  const qaDueChanged = input.qaDueDate !== undefined && (input.qaDueDate?.getTime() ?? null) !== previousQaDue;
  if (qaDueChanged) {
    task.qaDueDate = input.qaDueDate ?? null;
    task.lastQaReminderAt = null; // remind again for the new date
  }
  if (input.estimatedHours !== undefined) task.estimatedHours = input.estimatedHours;
  if (input.actualHours !== undefined) task.actualHours = input.actualHours;
  if (input.tags !== undefined) task.tags = [...new Set(input.tags)];
  await task.save();

  if (qaChanged && task.qa) {
    void notify({
      recipients: [task.qa],
      actor: actor._id,
      type: "REVIEW_REQUESTED",
      title: `${actor.name} asked you to QA test ${task.title}`,
      body: task.qaDueDate ? `Finish QA by ${isoDay(task.qaDueDate)}.` : task.status === "IN_QA" ? "Pass it or report bugs." : "It comes to you after code review.",
      entityType: "TASK",
      entityId: task._id,
    });
  }
  if (qaDueChanged && task.qa && !qaChanged) {
    void notify({
      recipients: [task.qa],
      actor: actor._id,
      type: "DEADLINE_APPROACHING",
      title: task.qaDueDate ? `Finish QA on ${task.title} by ${isoDay(task.qaDueDate)}` : `The QA deadline on ${task.title} was removed`,
      entityType: "TASK",
      entityId: task._id,
    });
  }
  const assigneeChanged = String(task.assignee ?? "") !== String(previousAssignee ?? "");
  if (assigneeChanged && task.stage && task.stage !== "QA") {
    // The stage's new person takes over its subtasks that were with the previous one (or nobody).
    await Task.updateMany({ parent: task._id, assignee: { $in: [null, ...(previousAssignee ? [oid(previousAssignee)] : [])] } }, { assignee: task.assignee ?? null });
  }
  if (task.assignee && String(task.assignee) !== previousAssignee) {
    await logAssigned(actor, task, task.assignee);
    notifyAssigned(actor, task);
  } else if (keys.some((k) => k !== "actualHours")) {
    void logActivity({ actor: actor._id, type: "TASK_UPDATED", verb: "updated", entityType: "TASK", entityId: task._id, entityName: task.title, project: task.project, department: task.department ?? null });
  }
  return getTaskDetail(task._id);
}

export async function deleteTask(actor: AuthUser, id: string) {
  const lean = await accessibleTask(actor, id);
  if (!actor.permissions.has("tasks:delete") || !(await canManageTask(actor, lean))) throw forbidden("You can't delete this task.");

  const ids = [lean._id, ...(await Task.find({ parent: lean._id }).distinct("_id"))] as Types.ObjectId[];
  const files = await FileModel.find({ entityType: "TASK", entityId: { $in: ids } }).select("_id").lean();
  await Promise.all([
    Task.deleteMany({ _id: { $in: ids } }),
    Comment.deleteMany({ entityType: "TASK", entityId: { $in: ids } }),
    DailyTask.deleteMany({ task: { $in: ids } }),
    ...files.map((f) => deleteFile(String(f._id))),
  ]);
  await recalcProjectStats(lean.project);
  if (lean.parent) await rollUpStage(actor, lean.parent);
  void logActivity({ actor: actor._id, type: "TASK_DELETED", verb: "deleted", entityType: "TASK", entityId: lean._id, entityName: lean.title, project: lean.project, department: lean.department ?? null });
}

// ---------------------------------------------------------------------------
// Status & review workflow
// ---------------------------------------------------------------------------

async function applyStatus(
  actor: AuthUser,
  taskId: Types.ObjectId,
  status: TaskStatus,
  review?: { decision: ReviewDecision; feedback?: string | null },
  options: { verb?: string; qa?: Types.ObjectId | null; qaResult?: QaResult | null } = {},
) {
  const task = await Task.findById(taskId);
  if (!task) throw notFound("Task");
  const previous = task.status;
  task.status = status;
  if (options.qa !== undefined) task.qa = options.qa;
  if (status === "IN_QA" && previous !== "IN_QA") task.qaStartedAt = new Date();
  if (options.qaResult !== undefined) task.qaResult = options.qaResult;
  if (isDone(status) && !isDone(previous)) task.completedAt = new Date();
  if (!isDone(status)) task.completedAt = null;
  if (review) task.reviewHistory.push({ decision: review.decision, feedback: review.feedback ?? null, actor: actor._id } as never);
  await task.save();

  if (isDone(status) !== isDone(previous)) await recalcProjectStats(task.project);
  void logActivity({
    actor: actor._id,
    type: review ? `TASK_${review.decision}` : "TASK_STATUS_CHANGED",
    verb: options.verb ?? STATUS_VERB[status],
    entityType: "TASK",
    entityId: task._id,
    entityName: task.title,
    project: task.project,
    department: task.department ?? null,
    metadata: { from: previous, to: status },
  });
  if (task.parent) await rollUpStage(actor, task.parent);
  return task;
}

export async function submitForReview(actor: AuthUser, id: string, note?: string) {
  const task = await accessibleTask(actor, id);
  // Only the developer doing the work decides it's ready for review.
  if (!isAssignee(actor, task)) throw forbidden("Only the developer assigned to this task can send it for review.");
  if (!SUBMITTABLE.includes(task.status)) {
    throw unprocessable(
      task.status === "WAITING"
        ? "This stage starts once the previous stage is approved by the project manager."
        : `A task that is ${task.status.toLowerCase().replace(/_/g, " ")} can't be submitted for review.`,
    );
  }
  if (await hasRollupSubtasks(task)) {
    throw unprocessable("This stage moves to review on its own once every subtask is in review. Send the subtasks for review instead.");
  }
  if (task.stage === "BUG_FIXING") {
    const open = await Task.countDocuments({ parent: task._id, status: { $nin: [...DONE_STATUSES] } });
    if (open) throw unprocessable(`Fix the ${open} open bug${open === 1 ? "" : "s"} first: mark each one completed, then send Bug fixing for review.`);
  }
  const updated = await applyStatus(actor, task._id, "IN_REVIEW", { decision: "SUBMITTED", feedback: note || null });

  // Notify the reviewer, or the project manager when there's no reviewer.
  let recipient = updated.reviewer ?? null;
  if (!recipient) recipient = (await Project.findById(updated.project).select("manager").lean())?.manager ?? null;
  void notify({
    recipients: [recipient],
    actor: actor._id,
    type: "REVIEW_REQUESTED",
    title: `${actor.name} submitted ${updated.title} for review`,
    body: note || null,
    entityType: "TASK",
    entityId: updated._id,
  });
  return getTaskDetail(updated._id);
}

async function assertCanReview(actor: AuthUser, task: Awaited<ReturnType<typeof accessibleTask>>) {
  if (!(await canReviewTask(actor, task))) throw forbidden("Only the reviewer can review this task.");
  // Nobody approves their own work.
  if (isAssignee(actor, task)) throw forbidden("You can't review a task assigned to you.");
  const testedStage = task.status === "TESTED" && Boolean(task.stage);
  if (task.status !== "IN_REVIEW" && !testedStage) throw unprocessable("Only tasks in review can be approved or sent back.");
}

/** `toQa`: the PM chose "In QA" on a reviewed stage subtask, so it goes to QA now instead of waiting to be completed. */
export async function approve(actor: AuthUser, id: string, feedback?: string, options: { toQa?: boolean } = {}) {
  const task = await accessibleTask(actor, id);
  await assertCanReview(actor, task);
  if (await isRollupSubtask(task)) return approveStageSubtask(actor, task, feedback, options.toQa);
  if (await hasRollupSubtasks(task)) {
    if (task.status !== "TESTED") {
      throw unprocessable("Set this stage to Testing first. It can be approved once QA has tested every subtask.");
    }
    const notPassed = await Task.countDocuments({ parent: task._id, status: { $ne: "TESTED" } });
    if (notPassed) {
      throw unprocessable(`${notPassed} subtask${notPassed === 1 ? " still has" : "s still have"} QA findings to fix and retest before this stage can be approved.`);
    }
  }

  // Code review passed. If the project has a QA person, the task goes to them for testing.
  const project = await Project.findById(task.project).select("qa workflow manager").lean();
  // In a staged workflow QA has its own stage: approval finishes the task and opens the next stage.
  if (task.stage || project?.workflow) {
    const updated = await applyStatus(actor, task._id, "APPROVED", { decision: "APPROVED", feedback: feedback || null });
    void notify({
      recipients: [updated.assignee],
      actor: actor._id,
      type: "TASK_APPROVED",
      title: `${actor.name} approved ${updated.title}`,
      body: feedback || null,
      entityType: "TASK",
      entityId: updated._id,
    });
    if (updated.stage) await advanceWorkflow(actor, updated.project, updated.stage, updated.title);
    return getTaskDetail(updated._id);
  }
  const qa = task.qa ?? project?.qa ?? null;
  if (qa) {
    const updated = await applyStatus(actor, task._id, "IN_QA", { decision: "APPROVED", feedback: feedback || null }, { qa });
    void notify({
      recipients: [qa],
      actor: actor._id,
      type: "REVIEW_REQUESTED",
      title: `${updated.title} is ready for QA testing`,
      body: `${actor.name} approved the code review. Pass it or report bugs.`,
      entityType: "TASK",
      entityId: updated._id,
    });
    void notify({
      recipients: [updated.assignee],
      actor: actor._id,
      type: "TASK_APPROVED",
      title: `${updated.title} passed code review and is now with QA`,
      body: feedback || null,
      entityType: "TASK",
      entityId: updated._id,
    });
    // Choosing the tester and the QA due date is the project manager's job.
    void notify({
      recipients: [project?.manager],
      actor: actor._id,
      type: "REVIEW_REQUESTED",
      title: `Set up QA for ${updated.title}`,
      body: "Choose the QA tester and the QA due date.",
      entityType: "TASK",
      entityId: updated._id,
    });
    return getTaskDetail(updated._id);
  }

  const updated = await applyStatus(actor, task._id, "APPROVED", { decision: "APPROVED", feedback: feedback || null });
  void notify({
    recipients: [updated.assignee],
    actor: actor._id,
    type: "TASK_APPROVED",
    title: `${actor.name} approved ${updated.title}`,
    body: feedback || null,
    entityType: "TASK",
    entityId: updated._id,
  });
  return getTaskDetail(updated._id);
}

// ---------------------------------------------------------------------------
// QA
// ---------------------------------------------------------------------------

async function assertCanQa(actor: AuthUser, task: Awaited<ReturnType<typeof accessibleTask>>) {
  if (!(await canQaTask(actor, task))) throw forbidden("Only this project's QA can test this task.");
  if (isAssignee(actor, task) && task.stage !== "QA") throw forbidden("You can't QA a task assigned to you.");
  if (task.status !== "IN_QA") throw unprocessable("Only tasks in QA can be passed or sent back with bugs.");
  if (await hasRollupSubtasks(task)) throw unprocessable("Test each subtask of this stage: pass it or report bugs on it.");
}

/** QA approved: the task is done. */
export async function qaPass(actor: AuthUser, id: string, note?: string) {
  const task = await accessibleTask(actor, id);
  await assertCanQa(actor, task);
  const subtask = await isRollupSubtask(task);
  const updated = await applyStatus(
    actor,
    task._id,
    subtask ? "TESTED" : "APPROVED",
    { decision: "QA_PASSED", feedback: note || null },
    subtask ? { verb: "tested and passed", qaResult: "PASSED" } : { verb: "passed QA on" },
  );
  if (updated.stage === "QA") {
    await finishWorkflow(actor, updated.project);
    return getTaskDetail(updated._id);
  }
  void notify({
    recipients: [updated.assignee],
    actor: actor._id,
    type: "TASK_APPROVED",
    title: `${updated.title} passed QA`,
    body: note || null,
    entityType: "TASK",
    entityId: updated._id,
  });
  return getTaskDetail(updated._id);
}

export interface BugInput {
  kind?: QaIssueKind;
  title: string;
  description?: string | null;
  steps?: string | null;
  expected?: string | null;
  actual?: string | null;
  environment?: string | null;
  priority: Priority;
}

/** The structured QA report stored on each issue subtask. */
function issueFields(bug: BugInput, actor: AuthUser) {
  const kind = bug.kind ?? "BUG";
  return {
    type: "BUG" as const,
    tags: [...new Set(["bug", kind.toLowerCase()])],
    qaIssue: {
      kind,
      steps: bug.steps ?? null,
      expected: bug.expected ?? null,
      actual: bug.actual ?? null,
      environment: bug.environment ?? null,
      reportedBy: actor._id,
    },
  };
}

const issueLine = (b: BugInput) => `[${QA_ISSUE_LABELS[b.kind ?? "BUG"]}] ${b.title}`;

/** Where QA's issues go: the Bug fixing stage for the workflow's QA stage, otherwise the task being tested. */
async function issueStage(task: Awaited<ReturnType<typeof accessibleTask>>) {
  if (task.stage !== "QA") return null;
  return Task.findOne({ project: task.project, stage: "BUG_FIXING" }).lean();
}

/** Each reported issue becomes a BUG subtask for the developer (of the task, or of Bug fixing). */
async function insertIssues(actor: AuthUser, task: Awaited<ReturnType<typeof accessibleTask>>, bugStage: (ITask & { _id: Types.ObjectId }) | null, bugs: BugInput[]) {
  const owner = bugStage ?? task;
  return Task.insertMany(
    bugs.map((bug) => ({
      title: bug.title,
      description: bug.description ?? null,
      project: task.project,
      milestone: bugStage ? null : (task.milestone ?? null),
      parent: owner._id,
      assignee: owner.assignee ?? null,
      reviewer: owner.reviewer ?? null,
      qa: task.qa ?? actor._id,
      createdBy: actor._id,
      department: owner.department ?? null,
      status: "TODO",
      priority: bug.priority,
      priorityRank: PRIORITY_RANK[bug.priority],
      ...issueFields(bug, actor),
    })),
  );
}

/** The task goes back to its developer with the issues QA found this round. */
async function sendBackWithIssues(actor: AuthUser, task: Awaited<ReturnType<typeof accessibleTask>>, bugs: BugInput[], note?: string) {
  const summary = [note?.trim(), ...bugs.map((b, i) => `${i + 1}. ${issueLine(b)}`)].filter(Boolean).join("\n");
  const subtask = await isRollupSubtask(task);
  const count = `${bugs.length} issue${bugs.length === 1 ? "" : "s"}`;
  const updated = await applyStatus(
    actor,
    task._id,
    "CHANGES_REQUESTED",
    { decision: "QA_FAILED", feedback: summary },
    { verb: `completed QA with ${count} on`, ...(subtask ? { qaResult: "BUGS" as const } : {}) },
  );
  await recalcProjectStats(task.project);
  void notify({
    recipients: [updated.assignee],
    actor: actor._id,
    type: "CHANGES_REQUESTED",
    title: `QA found ${count} in ${updated.title}`,
    body: bugs
      .map((b) => `• ${issueLine(b)}`)
      .join("\n")
      .slice(0, 900),
    entityType: "TASK",
    entityId: updated._id,
  });
  return getTaskDetail(updated._id);
}

/** Issues logged on the workflow's QA stage: Bug fixing opens with them and QA waits for the fixes. */
async function sendStageBackWithIssues(actor: AuthUser, qaStage: Awaited<ReturnType<typeof accessibleTask>>, bugStage: ITask & { _id: Types.ObjectId }, bugs: BugInput[], note?: string) {
  const count = `${bugs.length} issue${bugs.length === 1 ? "" : "s"}`;
  const summary = [note?.trim(), ...bugs.map((b, i) => `${i + 1}. ${issueLine(b)}`)].filter(Boolean).join("\n");
  await applyStatus(actor, bugStage._id, "TODO", undefined, { verb: `opened with ${count} from QA:` });
  const updated = await applyStatus(actor, qaStage._id, "WAITING", { decision: "QA_FAILED", feedback: summary }, { verb: `completed QA with ${count} on` });
  await recalcProjectStats(qaStage.project);
  const manager = (await Project.findById(qaStage.project).select("manager").lean())?.manager ?? null;
  const list = bugs.map((b) => `• ${issueLine(b)}`).join("\n").slice(0, 900);
  void notify({ recipients: [bugStage.assignee], actor: actor._id, type: "CHANGES_REQUESTED", title: `QA found ${count}: ${bugStage.title}`, body: list, entityType: "TASK", entityId: bugStage._id });
  void notify({ recipients: [manager], actor: actor._id, type: "PROJECT_UPDATE", title: `QA found ${count} in ${updated.title}`, body: list, entityType: "TASK", entityId: bugStage._id });
  return getTaskDetail(updated._id);
}

/**
 * QA logs issues while testing. The task stays in QA, so QA can keep testing
 * and log more; nothing goes back to the developer until QA completes testing.
 */
export async function qaReport(actor: AuthUser, id: string, bugs: BugInput[]) {
  const task = await accessibleTask(actor, id);
  await assertCanQa(actor, task);
  const created = await insertIssues(actor, task, await issueStage(task), bugs);
  await recalcProjectStats(task.project);
  void logActivity({
    actor: actor._id,
    type: "TASK_QA_ISSUES_LOGGED",
    verb: `logged ${bugs.length} issue${bugs.length === 1 ? "" : "s"} on`,
    entityType: "TASK",
    entityId: task._id,
    entityName: task.title,
    project: task.project,
    department: task.department ?? null,
  });
  return { task: await getTaskDetail(task._id), bugIds: created.map((b) => String(b._id)) };
}

/** Issues logged in the current round of testing that are still open. */
async function openRoundIssues(task: Awaited<ReturnType<typeof accessibleTask>>, bugStage: (ITask & { _id: Types.ObjectId }) | null) {
  return Task.find({
    parent: (bugStage ?? task)._id,
    qaIssue: { $ne: null },
    status: { $nin: [...DONE_STATUSES] },
    // Only this round: earlier rounds' leftovers were already handled.
    ...(task.qaStartedAt ? { createdAt: { $gte: task.qaStartedAt } } : {}),
  })
    .select("title priority qaIssue.kind")
    .sort({ createdAt: 1, _id: 1 })
    .lean();
}

/**
 * QA finished testing. With open issues from this round, the task goes back to
 * the developer with all of them at once; with none, it passes QA.
 */
export async function qaComplete(actor: AuthUser, id: string, note?: string) {
  const task = await accessibleTask(actor, id);
  await assertCanQa(actor, task);
  const bugStage = await issueStage(task);
  const open = await openRoundIssues(task, bugStage);
  if (!open.length) return { task: await qaPass(actor, id, note), issues: 0 };
  const bugs: BugInput[] = open.map((o) => ({ title: o.title, kind: o.qaIssue?.kind, priority: o.priority }));
  const detail = bugStage ? await sendStageBackWithIssues(actor, task, bugStage, bugs, note) : await sendBackWithIssues(actor, task, bugs, note);
  return { task: detail, issues: open.length };
}

/** Report and complete in one step (kept for API clients that send everything at once). */
export async function qaFail(actor: AuthUser, id: string, bugs: BugInput[], note?: string) {
  const task = await accessibleTask(actor, id);
  await assertCanQa(actor, task);
  const bugStage = await issueStage(task);
  const created = await insertIssues(actor, task, bugStage, bugs);
  const detail = bugStage ? await sendStageBackWithIssues(actor, task, bugStage, bugs, note) : await sendBackWithIssues(actor, task, bugs, note);
  return { task: detail, bugIds: created.map((b) => String(b._id)) };
}

export async function requestChanges(actor: AuthUser, id: string, feedback: string) {
  const task = await accessibleTask(actor, id);
  await assertCanReview(actor, task);
  const updated = await applyStatus(actor, task._id, "CHANGES_REQUESTED", { decision: "CHANGES_REQUESTED", feedback });
  void notify({
    recipients: [updated.assignee],
    actor: actor._id,
    type: "CHANGES_REQUESTED",
    title: `${actor.name} requested changes on ${updated.title}`,
    body: feedback,
    entityType: "TASK",
    entityId: updated._id,
  });
  return getTaskDetail(updated._id);
}

/**
 * A manager sends a task straight to QA from the status menu. It goes to the
 * project's QA; if the project has no QA yet, it waits in QA and is handed to
 * the QA as soon as one is assigned to the project (see project.service).
 */
async function sendToQa(actor: AuthUser, task: Awaited<ReturnType<typeof accessibleTask>>) {
  if (!(await canManageTask(actor, task))) throw forbidden("Only the project manager can send a task to QA.");
  if (await hasRollupSubtasks(task)) return sendStageToQa(actor, task);
  const project = await Project.findById(task.project).select("qa").lean();
  const qa = project?.qa ?? null;
  const updated = await applyStatus(actor, task._id, "IN_QA", undefined, { qa, verb: "sent to QA", qaResult: null });
  void notify({
    recipients: [qa],
    actor: actor._id,
    type: "REVIEW_REQUESTED",
    title: `${actor.name} sent ${updated.title} to you for QA testing`,
    body: updated.qaDueDate ? `Finish QA by ${isoDay(updated.qaDueDate)}.` : "Pass it or report bugs.",
    entityType: "TASK",
    entityId: updated._id,
  });
  return getTaskDetail(updated._id);
}

/**
 * Generic status change (board drag/drop, status menu). Review outcomes are
 * routed through the review flow so history and notifications stay correct.
 */
export async function changeStatus(actor: AuthUser, id: string, status: TaskStatus) {
  const task = await accessibleTask(actor, id);
  if (task.status === status) return getTaskDetail(task._id);
  if (task.status === "WAITING" && !(await canManageTask(actor, task))) {
    throw unprocessable("This stage starts once the previous stage is approved by the project manager.");
  }

  if (status === "TESTED") {
    throw unprocessable("Tested is set by QA: pass the task, or report bugs on it, from the QA actions.", [{ path: "status", message: "Use the QA actions." }]);
  }
  if (status === "IN_REVIEW") return submitForReview(actor, id);
  // A task in review enters QA by being approved; otherwise a manager sends it to QA directly.
  if (status === "IN_QA") return task.status === "IN_REVIEW" ? approve(actor, id, undefined, { toQa: true }) : sendToQa(actor, task);
  if (status === "APPROVED") return task.status === "IN_QA" ? qaPass(actor, id) : approve(actor, id);
  if (status === "CHANGES_REQUESTED") {
    // Without written feedback the assignee wouldn't know what to change.
    throw unprocessable("Use “Request changes” and describe what needs to change.", [{ path: "status", message: "Feedback is required." }]);
  }

  const manager = await canManageTask(actor, task);
  if (!manager) {
    if (!isAssignee(actor, task)) throw forbidden("You can't change the status of this task.");
    // Developers tick off each bug QA reported on their work; real tasks are completed by the project manager.
    const tickOffBug = task.type === "BUG" && status === "COMPLETED" && ["TODO", "IN_PROGRESS"].includes(task.status);
    if (status === "COMPLETED" && !tickOffBug) {
      throw forbidden("Only the project manager can mark work Completed. Send it for review instead.");
    }
    if (!tickOffBug && !ASSIGNEE_TRANSITIONS[task.status]?.includes(status)) {
      throw unprocessable(`A task can't move from ${task.status.toLowerCase().replace(/_/g, " ")} to ${status.toLowerCase().replace(/_/g, " ")}.`);
    }
  }
  await applyStatus(actor, task._id, status);
  return getTaskDetail(task._id);
}

// ---------------------------------------------------------------------------
// Staged workflow (Design → Frontend + Backend → QA → Bug fixing)
// ---------------------------------------------------------------------------

/** The project's stage tasks, in workflow order. */
export async function workflowStages(projectId: string) {
  const tasks = await Task.find({ project: projectId, stage: { $ne: null } }).select(LIST_PROJECTION).populate(TASK_POPULATE).lean();
  tasks.sort((a, b) => WORKFLOW_STAGES.indexOf(a.stage!) - WORKFLOW_STAGES.indexOf(b.stage!));
  return toSummaries(tasks);
}

type StageRow = { _id: Types.ObjectId; stage?: WorkflowStage | null; status: TaskStatus; title: string; assignee?: Types.ObjectId | null };

/** Opens a waiting stage: work stages become To do, the QA stage goes to the project's QA. */
async function openStage(actor: AuthUser, stage: StageRow, qa: Types.ObjectId | null, reason: string) {
  const isQa = stage.stage === "QA";
  const updated = await applyStatus(actor, stage._id, isQa ? "IN_QA" : "TODO", undefined, isQa ? { qa, verb: "sent to QA" } : { verb: "opened" });
  void notify({
    recipients: [isQa ? qa : updated.assignee],
    actor: actor._id,
    type: isQa ? "REVIEW_REQUESTED" : "TASK_ASSIGNED",
    title: isQa ? `${updated.title} is ready for testing` : `${updated.title} is ready for you to start`,
    body: reason,
    entityType: "TASK",
    entityId: updated._id,
  });
}

/** After the PM approves a stage, open the next one(s). */
async function advanceWorkflow(actor: AuthUser, projectId: Types.ObjectId, approved: WorkflowStage, title: string) {
  const [stages, project] = await Promise.all([
    Task.find({ project: projectId, stage: { $ne: null } }).select("stage status title assignee").lean<StageRow[]>(),
    Project.findById(projectId).select("qa status").lean(),
  ]);
  const qa = project?.qa ?? null;
  const qaStage = stages.find((s) => s.stage === "QA");

  // Approved bug fixes go back to QA for a retest.
  if (approved === "BUG_FIXING") {
    if (qaStage && qaStage.status === "WAITING") await openStage(actor, qaStage, qa, "The bug fixes were approved by the project manager. Please retest.");
    return;
  }
  if (approved === "QA") return;

  // Open the next level once every stage on this level is approved (Frontend and Backend run in parallel).
  const level = STAGE_META[approved].level;
  const sameLevel = stages.filter((s) => s.stage && STAGE_META[s.stage].level === level);
  if (!sameLevel.every((s) => s.status === "APPROVED")) return;
  const later = stages.filter((s) => s.stage && s.stage !== "BUG_FIXING" && STAGE_META[s.stage].level > level);
  if (!later.length) return;
  const nextLevel = Math.min(...later.map((s) => STAGE_META[s.stage!].level));
  for (const s of later) {
    if (STAGE_META[s.stage!].level === nextLevel && s.status === "WAITING") await openStage(actor, s, qa, `${title} was approved by the project manager.`);
  }
  // Reaching QA moves the project into QA testing.
  if (nextLevel === STAGE_META.QA.level && project && ["PLANNING", "ACTIVE", "AT_RISK"].includes(project.status)) {
    await Project.updateOne({ _id: projectId }, { status: "QA_TESTING" });
    void logActivity({ actor: actor._id, type: "PROJECT_STATUS_CHANGED", verb: "moved to QA testing", entityType: "PROJECT", entityId: projectId, entityName: "", project: projectId, metadata: { from: project.status, to: "QA_TESTING" } });
  }
}

/** QA passed the QA stage: the workflow is done. A bug-fixing stage that never opened is closed. */
async function finishWorkflow(actor: AuthUser, projectId: Types.ObjectId) {
  const [bugStage, project] = await Promise.all([
    Task.findOne({ project: projectId, stage: "BUG_FIXING", status: "WAITING" }).select("_id").lean(),
    Project.findById(projectId).select("name manager").lean(),
  ]);
  if (bugStage) await applyStatus(actor, bugStage._id, "APPROVED", undefined, { verb: "closed (no bugs found)" });
  void notify({
    recipients: [project?.manager],
    actor: actor._id,
    type: "TASK_APPROVED",
    title: `${project?.name ?? "The project"} passed QA`,
    body: "Every workflow stage is complete.",
    entityType: "PROJECT",
    entityId: projectId,
  });
}

// ---------------------------------------------------------------------------
// Stage subtasks: status roll-up and per-subtask QA testing
// ---------------------------------------------------------------------------

type TaskRef = { _id: Types.ObjectId; parent?: Types.ObjectId | null; stage?: WorkflowStage | null };

/** A subtask directly under a Design / Frontend / Backend stage. */
async function isRollupSubtask(task: TaskRef): Promise<boolean> {
  if (!task.parent) return false;
  const parent = await Task.findById(task.parent).select("stage").lean();
  return Boolean(parent?.stage && ROLLUP_STAGES.includes(parent.stage));
}

/** A Design / Frontend / Backend stage that has been broken into subtasks. */
async function hasRollupSubtasks(task: TaskRef): Promise<boolean> {
  if (!task.stage || !ROLLUP_STAGES.includes(task.stage)) return false;
  return Boolean(await Task.exists({ parent: task._id }));
}

const ROLLUP_VERB: Partial<Record<TaskStatus, string>> = {
  IN_PROGRESS: "started (a subtask is in progress)",
  IN_REVIEW: "moved to review (every subtask is in review)",
  COMPLETED: "completed (every subtask is completed)",
  IN_QA: "is being tested",
  TESTED: "finished testing (QA tested every subtask)",
};

/**
 * Keeps a Design / Frontend / Backend stage in step with its subtasks:
 * all in review → In review, all completed → Completed, and once the PM sets it
 * to Testing, Tested when QA has tested every subtask (passed or with findings).
 * Locked (Waiting) and approved stages are left alone.
 */
async function rollUpStage(actor: AuthUser, parentId: Types.ObjectId) {
  const parent = await Task.findById(parentId).select("stage status title project assignee").lean();
  if (!parent?.stage || !ROLLUP_STAGES.includes(parent.stage)) return;
  if (parent.status === "WAITING" || parent.status === "APPROVED") return;
  const kids = await Task.find({ parent: parentId }).select("status qaResult").lean();
  if (!kids.length) return;

  const all = (statuses: TaskStatus[]) => kids.every((k) => statuses.includes(k.status));
  let next: TaskStatus | null = null;
  if (parent.status === "IN_QA" || parent.status === "TESTED") {
    next = kids.every((k) => k.qaResult) ? "TESTED" : "IN_QA";
  } else if (all(["TESTED"])) {
    // Subtasks were sent to QA one by one and QA has tested them all.
    next = "TESTED";
  } else if (all(["COMPLETED", "IN_QA", "TESTED"]) && kids.some((k) => k.status !== "COMPLETED")) {
    // Every subtask is done and some are already with QA: the stage is being tested.
    next = "IN_QA";
  } else if (all(["COMPLETED", "TESTED"])) {
    next = "COMPLETED";
  } else if (all(["IN_REVIEW", "COMPLETED", "TESTED"])) {
    next = "IN_REVIEW";
  } else if (["TODO", "IN_REVIEW", "COMPLETED"].includes(parent.status) && kids.some((k) => k.status !== "TODO")) {
    next = "IN_PROGRESS";
  }
  if (!next || next === parent.status) return;

  await applyStatus(actor, parent._id, next, undefined, { verb: ROLLUP_VERB[next] });
  if (next === "COMPLETED" || next === "TESTED") {
    const manager = (await Project.findById(parent.project).select("manager").lean())?.manager ?? null;
    const withFindings = next === "TESTED" ? kids.filter((k) => k.qaResult === "BUGS").length : 0;
    void notify({
      recipients: [manager],
      actor: actor._id,
      type: next === "TESTED" ? "TASK_APPROVED" : "REVIEW_REQUESTED",
      title: next === "TESTED" ? `QA finished testing ${parent.title}` : `Every subtask of ${parent.title} is completed`,
      body:
        next === "TESTED"
          ? withFindings
            ? `${withFindings} subtask${withFindings === 1 ? " has" : "s have"} findings that went back to the developer.`
            : "Every subtask passed. Approve the stage to open the next one."
          : "Set it to Testing to send its subtasks to QA.",
      entityType: "TASK",
      entityId: parent._id,
    });
  }
}

/**
 * The PM sets a stage to Testing: its completed subtasks go to the project's QA
 * (subtasks QA already passed keep their result), and the stage waits for QA.
 */
async function sendStageToQa(actor: AuthUser, stage: Awaited<ReturnType<typeof accessibleTask>>) {
  if (stage.status === "WAITING") throw unprocessable("This stage hasn't opened yet.");
  const kids = await Task.find({ parent: stage._id }).select("status").lean();
  const unfinished = kids.filter((k) => !["COMPLETED", "TESTED"].includes(k.status)).length;
  if (unfinished) {
    throw unprocessable(`${unfinished} subtask${unfinished === 1 ? " isn't" : "s aren't"} completed yet. Complete every subtask before testing.`, [
      { path: "status", message: "Complete every subtask first." },
    ]);
  }
  const qa = (await Project.findById(stage.project).select("qa").lean())?.qa ?? null;
  const toTest = kids.filter((k) => k.status === "COMPLETED");
  await Task.updateMany(
    { _id: { $in: toTest.map((k) => k._id) } },
    // Subtasks inherit the stage's QA deadline so they don't each need setting up.
    { status: "IN_QA", qa, qaResult: null, completedAt: null, qaStartedAt: new Date(), ...(stage.qaDueDate ? { qaDueDate: stage.qaDueDate } : {}) },
  );
  // The stage enters Testing; roll-up turns it Tested once QA has tested every subtask.
  // (The stage itself isn't QA's to pass: QA tests the subtasks, so it isn't put in their queue.)
  await Task.updateOne({ _id: stage._id }, { status: "IN_QA", completedAt: null });
  await recalcProjectStats(stage.project);
  void logActivity({
    actor: actor._id,
    type: "TASK_STATUS_CHANGED",
    verb: `sent ${toTest.length} subtask${toTest.length === 1 ? "" : "s"} to QA from`,
    entityType: "TASK",
    entityId: stage._id,
    entityName: stage.title,
    project: stage.project,
    department: stage.department ?? null,
    metadata: { from: stage.status, to: "IN_QA" },
  });
  void notify({
    recipients: [qa],
    actor: actor._id,
    type: "REVIEW_REQUESTED",
    title: `${toTest.length} subtask${toTest.length === 1 ? "" : "s"} of ${stage.title} ${toTest.length === 1 ? "is" : "are"} ready for testing`,
    body: stage.qaDueDate ? `Finish QA by ${isoDay(stage.qaDueDate)}. Pass each one or report bugs on it.` : "Pass each one or report bugs on it.",
    entityType: "TASK",
    entityId: stage._id,
  });
  await rollUpStage(actor, stage._id);
  return getTaskDetail(stage._id);
}

/**
 * The PM approves a reviewed stage subtask: it's Completed, or, when QA had
 * reported findings on it, its fixes are done and it goes back to QA to retest.
 */
async function approveStageSubtask(actor: AuthUser, task: Awaited<ReturnType<typeof accessibleTask>>, feedback?: string, toQa = false) {
  if (task.qaResult === "BUGS") {
    // Any bug items the developer didn't tick off are closed by the approval.
    await Task.updateMany({ parent: task._id, status: { $nin: [...DONE_STATUSES] } }, { status: "COMPLETED", completedAt: new Date() });
    const qa = task.qa ?? (await Project.findById(task.project).select("qa").lean())?.qa ?? null;
    const updated = await applyStatus(actor, task._id, "IN_QA", { decision: "APPROVED", feedback: feedback || null }, { qa, qaResult: null, verb: "approved the fixes and sent back to QA" });
    void notify({
      recipients: [qa],
      actor: actor._id,
      type: "REVIEW_REQUESTED",
      title: `${updated.title} is fixed and ready to retest`,
      body: feedback || null,
      entityType: "TASK",
      entityId: updated._id,
    });
    return getTaskDetail(updated._id);
  }
  if (toQa) {
    // Straight to the project's QA, with the stage's QA deadline if it has one.
    const [project, stage] = await Promise.all([
      Project.findById(task.project).select("qa").lean(),
      Task.findById(task.parent).select("qaDueDate").lean(),
    ]);
    const qa = project?.qa ?? null;
    if (stage?.qaDueDate && !task.qaDueDate) await Task.updateOne({ _id: task._id }, { qaDueDate: stage.qaDueDate });
    const sent = await applyStatus(actor, task._id, "IN_QA", { decision: "APPROVED", feedback: feedback || null }, { qa, qaResult: null, verb: "approved and sent to QA" });
    void notify({
      recipients: [qa],
      actor: actor._id,
      type: "REVIEW_REQUESTED",
      title: `${sent.title} is ready for QA testing`,
      body: "Pass it or report issues.",
      entityType: "TASK",
      entityId: sent._id,
    });
    void notify({
      recipients: [sent.assignee],
      actor: actor._id,
      type: "TASK_APPROVED",
      title: `${sent.title} passed review and is now with QA`,
      body: feedback || null,
      entityType: "TASK",
      entityId: sent._id,
    });
    return getTaskDetail(sent._id);
  }
  const updated = await applyStatus(actor, task._id, "COMPLETED", { decision: "APPROVED", feedback: feedback || null }, { verb: "approved and completed" });
  void notify({
    recipients: [updated.assignee],
    actor: actor._id,
    type: "TASK_APPROVED",
    title: `${actor.name} approved ${updated.title}`,
    body: feedback || null,
    entityType: "TASK",
    entityId: updated._id,
  });
  return getTaskDetail(updated._id);
}

export async function reviewHistory(actor: AuthUser, id: string) {
  const task = await accessibleTask(actor, id);
  const full = await Task.findById(task._id).select("reviewHistory").populate("reviewHistory.actor", USER_SUMMARY).lean();
  return full?.reviewHistory ?? [];
}

// ---------------------------------------------------------------------------
// My Day
// ---------------------------------------------------------------------------

/**
 * Tasks in QA that the project manager still has to set up: no QA tester, no
 * QA due date, or the developer set as their own tester.
 */
export function qaSetupFilter(projectIds: Types.ObjectId[]): QueryFilter<ITask> {
  return {
    project: { $in: projectIds },
    status: "IN_QA",
    $or: [{ qa: null }, { qaDueDate: null }, { stage: { $ne: "QA" }, $expr: { $eq: ["$qa", "$assignee"] } }],
  };
}

export async function myDay(user: AuthUser, day: string) {
  const dayStart = startOfDay(day);
  const dayEnd = endOfDay(day);
  const weekEnd = new Date(dayEnd.getTime() + 7 * 864e5);

  const planned = await DailyTask.find({ date: day, assignee: user._id }).distinct("task");

  const managed = await Project.find({ manager: user._id }).distinct("_id");

  const [mine, inReview, blocked, qaQueue, qaSetup] = await Promise.all([
    Task.find({
      assignee: user._id,
      status: { $nin: [...DONE_STATUSES, "IN_REVIEW", "BLOCKED", "WAITING"] },
      $or: [
        { dueDate: { $lte: weekEnd } },
        { startDate: { $lte: dayEnd }, dueDate: { $gte: dayStart } },
        { _id: { $in: planned } },
      ],
    })
      .select(LIST_PROJECTION)
      .populate(TASK_POPULATE)
      .sort({ priorityRank: -1, dueDate: 1 })
      .limit(300)
      .lean(),
    Task.find({ assignee: user._id, status: "IN_REVIEW" }).select(LIST_PROJECTION).populate(TASK_POPULATE).sort({ dueDate: 1 }).limit(100).lean(),
    Task.find({ assignee: user._id, status: "BLOCKED" }).select(LIST_PROJECTION).populate(TASK_POPULATE).sort({ dueDate: 1 }).limit(100).lean(),
    Task.find({ qa: user._id, status: "IN_QA" }).select(LIST_PROJECTION).populate(TASK_POPULATE).sort({ qaDueDate: 1, dueDate: 1 }).limit(100).lean(),
    managed.length ? Task.find(qaSetupFilter(managed)).select(LIST_PROJECTION).populate(TASK_POPULATE).sort({ updatedAt: 1 }).limit(100).lean() : Promise.resolve([]),
  ]);

  const plannedSet = new Set(planned.map(String));
  const today: typeof mine = [];
  const overdue: typeof mine = [];
  const upcoming: typeof mine = [];
  for (const t of mine) {
    const due = t.dueDate ?? null;
    if (due && due < dayStart) overdue.push(t);
    else if (plannedSet.has(String(t._id)) || (due && due <= dayEnd) || (t.startDate && t.startDate <= dayEnd && due && due >= dayStart)) today.push(t);
    else if (due && due > dayEnd && due <= weekEnd) upcoming.push(t);
  }

  const [todayDto, overdueDto, upcomingDto, reviewDto, blockedDto, qaDto, qaSetupDto] = await Promise.all([
    toSummaries(today),
    toSummaries(overdue),
    toSummaries(upcoming),
    toSummaries(inReview),
    toSummaries(blocked),
    toSummaries(qaQueue),
    toSummaries(qaSetup),
  ]);
  return { date: day, today: todayDto, overdue: overdueDto, upcoming: upcomingDto, inReview: reviewDto, blocked: blockedDto, qaQueue: qaDto, qaSetup: qaSetupDto };
}

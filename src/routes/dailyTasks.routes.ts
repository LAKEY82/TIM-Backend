import { Router } from "express";
import { Types } from "mongoose";
import { z } from "zod";
import { currentUser } from "../middleware/auth.middleware";
import { requirePermission } from "../middleware/permission.middleware";
import { parseBody, parseQuery, routeParam, validateObjectIds } from "../middleware/validation.middleware";
import { DailyTask, Task, User } from "../models";
import { accessibleTask, canManageTask } from "../services/access.service";
import { logActivity } from "../services/activity.service";
import { notify } from "../services/notification.service";
import { workloadFor } from "../services/workload.service";
import { forbidden, notFound, unprocessable } from "../utils/errors";
import { created, noContent, ok } from "../utils/http";
import { serializeDailyTask } from "../utils/serialize";
import { dayString, objectId, optionalText, priority } from "../validators/common";

const USER_SUMMARY = "firstName lastName email profileImage role jobTitle";
const POPULATE = [
  { path: "assignee", select: USER_SUMMARY },
  {
    path: "task",
    select: "-reviewHistory -watchers -description",
    populate: [
      { path: "project", select: "name" },
      { path: "milestone", select: "name" },
      { path: "assignee", select: USER_SUMMARY },
      { path: "reviewer", select: USER_SUMMARY },
    ],
  },
];

const listQuery = z.object({ date: dayString, assigneeId: objectId.optional() });
const createSchema = z.object({
  date: dayString,
  assigneeId: objectId,
  taskId: objectId,
  priority: priority.default("MEDIUM"),
  estimatedHours: z.number().min(0).max(24).nullable().optional(),
  dueTime: z.union([z.string().regex(/^\d{2}:\d{2}$/, "Use HH:MM."), z.literal(""), z.null()]).optional().transform((v) => v || null),
  note: optionalText(1000),
});

export const dailyTasksRouter = Router();
dailyTasksRouter.param("id", (req, res, next) => validateObjectIds("id")(req, res, next));

/** Planners see everyone's plan; anyone can read their own. */
dailyTasksRouter.get("/", async (req, res) => {
  const user = currentUser(req);
  const q = parseQuery(listQuery, req);
  const ownOnly = !user.permissions.has("daily_tasks:manage");
  if (ownOnly && q.assigneeId && q.assigneeId !== user.id) throw forbidden();
  const filter = { date: q.date, ...(ownOnly ? { assignee: user._id } : q.assigneeId ? { assignee: new Types.ObjectId(q.assigneeId) } : {}) };
  const items = await DailyTask.find(filter).populate(POPULATE).sort({ dueTime: 1, createdAt: 1 }).limit(500).lean();
  ok(res, items.filter((d) => d.task).map(serializeDailyTask));
});

dailyTasksRouter.get("/workload", requirePermission("daily_tasks:manage"), async (req, res) => {
  const { date } = parseQuery(z.object({ date: dayString }), req);
  const planned = await DailyTask.find({ date }).select("assignee task").lean();
  const userIds = [...new Map(planned.map((p) => [String(p.assignee), p.assignee])).values()];
  // Workload for the day: counts over the tasks planned for that date.
  ok(res, await workloadFor(userIds, { _id: { $in: planned.map((p) => p.task) } }));
});

dailyTasksRouter.post("/", requirePermission("daily_tasks:manage"), async (req, res) => {
  const user = currentUser(req);
  const input = parseBody(createSchema, req);
  const lean = await accessibleTask(user, input.taskId);
  if (!(await canManageTask(user, lean))) throw forbidden("You can't plan this task.");
  const assignee = await User.findOne({ _id: input.assigneeId, status: "ACTIVE" }).select("firstName lastName").lean();
  if (!assignee) throw unprocessable("Employee not found.", [{ path: "assigneeId", message: "Select an active employee." }]);

  const daily = await DailyTask.create({
    date: input.date,
    task: lean._id,
    assignee: assignee._id,
    assignedBy: user._id,
    priority: input.priority,
    estimatedHours: input.estimatedHours ?? null,
    dueTime: input.dueTime,
    note: input.note ?? null,
  });

  // An unassigned task becomes this employee's; an assigned task keeps its owner.
  if (!lean.assignee) await Task.updateOne({ _id: lean._id }, { assignee: assignee._id });
  void notify({
    recipients: [assignee._id],
    actor: user._id,
    type: "TASK_ASSIGNED",
    title: `${user.name} planned ${lean.title} for you on ${input.date}`,
    body: input.note ?? null,
    entityType: "TASK",
    entityId: lean._id,
  });
  void logActivity({
    actor: user._id,
    type: "DAILY_TASK_ASSIGNED",
    verb: "planned",
    entityType: "TASK",
    entityId: lean._id,
    entityName: lean.title,
    target: { type: "USER", id: assignee._id, name: `${assignee.firstName} ${assignee.lastName}`.trim() },
    project: lean.project,
    metadata: { date: input.date },
  });
  const full = await DailyTask.findById(daily._id).populate(POPULATE).lean();
  created(res, serializeDailyTask(full!), "Task assigned.");
});

dailyTasksRouter.delete("/:id", requirePermission("daily_tasks:manage"), async (req, res) => {
  const daily = await DailyTask.findById(routeParam(req, "id"));
  if (!daily) throw notFound("Daily task");
  await daily.deleteOne();
  noContent(res);
});

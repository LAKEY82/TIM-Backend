import { Router } from "express";
import { Types, type QueryFilter } from "mongoose";
import { z } from "zod";
import { currentUser } from "../middleware/auth.middleware";
import { parseBody, parseQuery, routeParam, validateObjectIds } from "../middleware/validation.middleware";
import { Milestone, Project, Task, type IMilestone } from "../models";
import { accessibleProject, accessibleProjectIds } from "../services/access.service";
import { logActivity } from "../services/activity.service";
import { DONE_STATUSES, MILESTONE_STATUSES } from "../types/domain";
import { notFound, unprocessable } from "../utils/errors";
import { created, noContent, ok } from "../utils/http";
import { serializeMilestone } from "../utils/serialize";
import { dateInput, dayString, objectId, optionalText } from "../validators/common";

const listQuery = z.object({ projectId: objectId.optional(), from: dayString.optional(), to: dayString.optional() });

const milestoneFields = z.object({
  name: z.string().trim().min(2, "Name must be at least 2 characters.").max(150),
  description: optionalText(5000),
  startDate: dateInput,
  dueDate: dateInput,
  status: z.enum(MILESTONE_STATUSES).optional(),
});
const createSchema = milestoneFields.extend({ projectId: objectId });
const updateSchema = milestoneFields.partial().strict();

/** Task counts per milestone for progress (completed / total). */
async function statsFor(ids: Types.ObjectId[]) {
  const rows = await Task.aggregate<{ _id: Types.ObjectId; total: number; done: number }>([
    { $match: { milestone: { $in: ids } } },
    { $group: { _id: "$milestone", total: { $sum: 1 }, done: { $sum: { $cond: [{ $in: ["$status", [...DONE_STATUSES]] }, 1, 0] } } } },
  ]);
  const map = new Map(rows.map((r) => [String(r._id), r]));
  return (id: Types.ObjectId) => ({ taskCount: map.get(String(id))?.total ?? 0, completed: map.get(String(id))?.done ?? 0 });
}

async function serializeOne(id: Types.ObjectId) {
  const m = await Milestone.findById(id).populate("project", "name").lean();
  if (!m) throw notFound("Milestone");
  return serializeMilestone(m, (await statsFor([m._id]))(m._id));
}

async function loadForManage(req: Parameters<typeof currentUser>[0]) {
  const milestone = await Milestone.findById(routeParam(req, "id"));
  if (!milestone) throw notFound("Milestone");
  await accessibleProject(currentUser(req), String(milestone.project), "manage");
  return milestone;
}

function checkDates(start: Date | null | undefined, due: Date | null | undefined) {
  if (start && due && due < start) throw unprocessable("Due date can't be before the start date.", [{ path: "dueDate", message: "Due date can't be before the start date." }]);
}

export const milestonesRouter = Router();
milestonesRouter.param("id", (req, res, next) => validateObjectIds("id")(req, res, next));

milestonesRouter.get("/", async (req, res) => {
  const user = currentUser(req);
  const q = parseQuery(listQuery, req);
  const filter: QueryFilter<IMilestone> = {};
  if (q.projectId) {
    await accessibleProject(user, q.projectId, "read");
    filter.project = new Types.ObjectId(q.projectId);
  } else {
    const ids = await accessibleProjectIds(user);
    if (ids) filter.project = { $in: ids };
  }
  if (q.from || q.to) {
    filter.dueDate = {
      ...(q.from ? { $gte: new Date(`${q.from}T00:00:00.000Z`) } : {}),
      ...(q.to ? { $lte: new Date(`${q.to}T23:59:59.999Z`) } : {}),
    };
  }
  const items = await Milestone.find(filter).populate("project", "name").sort({ dueDate: 1, name: 1 }).limit(500).lean();
  const stats = await statsFor(items.map((m) => m._id));
  ok(res, items.map((m) => serializeMilestone(m, stats(m._id))));
});

milestonesRouter.post("/", async (req, res) => {
  const user = currentUser(req);
  const input = parseBody(createSchema, req);
  const project = await accessibleProject(user, input.projectId, "manage");
  checkDates(input.startDate, input.dueDate);
  const status = input.status ?? "PENDING";
  const milestone = await Milestone.create({
    project: project._id,
    name: input.name,
    description: input.description ?? null,
    startDate: input.startDate ?? null,
    dueDate: input.dueDate ?? null,
    status,
    completedAt: status === "COMPLETED" ? new Date() : null,
  });
  void logActivity({ actor: user._id, type: "MILESTONE_CREATED", verb: "created milestone", entityType: "MILESTONE", entityId: milestone._id, entityName: milestone.name, project: project._id });
  created(res, await serializeOne(milestone._id), "Milestone created.");
});

milestonesRouter.patch("/:id", async (req, res) => {
  const user = currentUser(req);
  const input = parseBody(updateSchema, req);
  const milestone = await loadForManage(req);
  checkDates(input.startDate !== undefined ? input.startDate : milestone.startDate, input.dueDate !== undefined ? input.dueDate : milestone.dueDate);
  const wasCompleted = milestone.status === "COMPLETED";
  if (input.name !== undefined) milestone.name = input.name;
  if (input.description !== undefined) milestone.description = input.description;
  if (input.startDate !== undefined) milestone.startDate = input.startDate;
  if (input.dueDate !== undefined) milestone.dueDate = input.dueDate;
  if (input.status !== undefined) {
    milestone.status = input.status;
    milestone.completedAt = input.status === "COMPLETED" ? (milestone.completedAt ?? new Date()) : null;
  }
  await milestone.save();
  if (!wasCompleted && milestone.status === "COMPLETED") {
    const project = await Project.findById(milestone.project).select("name").lean();
    void logActivity({ actor: user._id, type: "MILESTONE_COMPLETED", verb: "completed milestone", entityType: "MILESTONE", entityId: milestone._id, entityName: milestone.name, target: project ? { type: "PROJECT", id: project._id, name: project.name } : null, project: milestone.project });
  }
  ok(res, await serializeOne(milestone._id), "Milestone updated.");
});

milestonesRouter.delete("/:id", async (req, res) => {
  const milestone = await loadForManage(req);
  // Tasks stay in the project; they just lose the milestone link.
  await Promise.all([milestone.deleteOne(), Task.updateMany({ milestone: milestone._id }, { milestone: null })]);
  noContent(res);
});

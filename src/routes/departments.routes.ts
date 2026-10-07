import { Router } from "express";
import { Types } from "mongoose";
import { z } from "zod";
import { currentUser } from "../middleware/auth.middleware";
import { requirePermission } from "../middleware/permission.middleware";
import { parseBody, validateObjectIds } from "../middleware/validation.middleware";
import { Department, Project, Task, Team, User } from "../models";
import { logActivity } from "../services/activity.service";
import { DONE_STATUSES } from "../types/domain";
import { conflict, notFound, unprocessable } from "../utils/errors";
import { created, noContent, ok } from "../utils/http";
import { serializeDepartment, serializeUser } from "../utils/serialize";
import { objectId, optionalText } from "../validators/common";

const departmentInput = z.object({
  name: z.string().trim().min(2, "Name must be at least 2 characters.").max(80),
  description: optionalText(1000),
  headId: objectId.nullable().optional(),
});

type Counts = Map<string, number>;

async function countBy(model: "users" | "tasks" | "projects", ids?: Types.ObjectId[]): Promise<Counts> {
  const match = ids ? { department: { $in: ids } } : { department: { $ne: null } };
  const group = { $group: { _id: "$department", n: { $sum: 1 } } };
  const rows =
    model === "users"
      ? await User.aggregate<{ _id: Types.ObjectId; n: number }>([{ $match: { ...match, status: "ACTIVE" } }, group])
      : model === "tasks"
        ? await Task.aggregate<{ _id: Types.ObjectId; n: number }>([{ $match: { ...match, status: { $nin: [...DONE_STATUSES] } } }, group])
        : await Project.aggregate<{ _id: Types.ObjectId; n: number }>([{ $match: { ...match, status: { $nin: ["COMPLETED", "CANCELLED"] } } }, group]);
  return new Map(rows.map((r) => [String(r._id), r.n]));
}

async function withCounts(departments: { _id: Types.ObjectId }[]) {
  const ids = departments.map((d) => d._id);
  const [members, tasks, projects] = await Promise.all([countBy("users", ids), countBy("tasks", ids), countBy("projects", ids)]);
  return (d: { _id: Types.ObjectId }) => ({
    memberCount: members.get(String(d._id)) ?? 0,
    activeTaskCount: tasks.get(String(d._id)) ?? 0,
    projectCount: projects.get(String(d._id)) ?? 0,
  });
}

async function assertHead(headId: string | null | undefined) {
  if (headId && !(await User.exists({ _id: headId, status: "ACTIVE" }))) {
    throw unprocessable("Department head not found.", [{ path: "headId", message: "Select an active user." }]);
  }
}

export const departmentsRouter = Router();
departmentsRouter.param("id", (req, res, next) => validateObjectIds("id")(req, res, next));

departmentsRouter.get("/", async (_req, res) => {
  const departments = await Department.find().populate("head", "firstName lastName email profileImage role jobTitle").sort({ name: 1 }).lean();
  const counts = await withCounts(departments);
  ok(res, departments.map((d) => serializeDepartment(d, counts(d))));
});

departmentsRouter.get("/:id", async (req, res) => {
  const dept = await Department.findById(req.params.id).populate("head", "firstName lastName email profileImage role jobTitle").lean();
  if (!dept) throw notFound("Department");
  const [members, counts] = await Promise.all([
    User.find({ department: dept._id, status: "ACTIVE" })
      .select("firstName lastName email profileImage phone jobTitle role department status createdAt")
      .sort({ firstName: 1 })
      .lean(),
    withCounts([dept]),
  ]);
  ok(res, { ...serializeDepartment(dept, counts(dept)), members: members.map((m) => serializeUser({ ...m, department: { _id: dept._id, name: dept.name } })) });
});

departmentsRouter.post("/", requirePermission("departments:manage"), async (req, res) => {
  const input = parseBody(departmentInput, req);
  await assertHead(input.headId);
  const dept = await Department.create({ name: input.name, description: input.description ?? null, head: input.headId ?? null });
  void logActivity({ actor: currentUser(req)._id, type: "DEPARTMENT_CREATED", verb: "created", entityType: "DEPARTMENT", entityId: dept._id, entityName: dept.name, department: dept._id });
  const full = await Department.findById(dept._id).populate("head", "firstName lastName email profileImage role jobTitle").lean();
  created(res, serializeDepartment(full!), "Department created.");
});

departmentsRouter.patch("/:id", requirePermission("departments:manage"), async (req, res) => {
  const input = parseBody(departmentInput.partial(), req);
  await assertHead(input.headId);
  const dept = await Department.findById(req.params.id);
  if (!dept) throw notFound("Department");
  if (input.name !== undefined) dept.name = input.name;
  if (input.description !== undefined) dept.description = input.description;
  if (input.headId !== undefined) dept.head = input.headId ? new Types.ObjectId(input.headId) : null;
  await dept.save();
  const full = await Department.findById(dept._id).populate("head", "firstName lastName email profileImage role jobTitle").lean();
  const counts = await withCounts([full!]);
  ok(res, serializeDepartment(full!, counts(full!)), "Department updated.");
});

departmentsRouter.delete("/:id", requirePermission("departments:manage"), async (req, res) => {
  const dept = await Department.findById(req.params.id);
  if (!dept) throw notFound("Department");
  const [members, teams] = await Promise.all([User.exists({ department: dept._id }), Team.exists({ department: dept._id })]);
  if (members || teams) throw conflict("Move this department's people and teams elsewhere before deleting it.");
  await Promise.all([
    dept.deleteOne(),
    // Projects and tasks keep existing; they just lose the department link.
    Project.updateMany({ department: dept._id }, { department: null }),
    Task.updateMany({ department: dept._id }, { department: null }),
  ]);
  noContent(res);
});

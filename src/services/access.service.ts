/**
 * Data-scoped authorization. Permissions say *what* a user may do; these
 * helpers decide *which records*. Every list query and every single-record
 * read or write goes through here, so the rules live in one place.
 */
import { Types, type QueryFilter } from "mongoose";
import { Project, Task, type IProject, type ITask } from "../models";
import type { AuthUser } from "../types/express";
import { forbidden, notFound } from "../utils/errors";

export type ProjectAccessLevel = "read" | "manage";

const idEq = (a: unknown, b: Types.ObjectId | string) => Boolean(a) && String(a) === String(b);

const has = (user: AuthUser, p: Parameters<AuthUser["permissions"]["has"]>[0]) => user.permissions.has(p);

/** Department heads see their department's projects and tasks. */
const deptScope = (user: AuthUser) => (user.role === "DEPARTMENT_HEAD" && user.departmentId ? user.departmentId : null);

// Cache the (moderately expensive) visibility lookups for one request.
const projectIdCache = new WeakMap<AuthUser, Promise<Types.ObjectId[]>>();

/**
 * IDs of projects the user may see, or `null` meaning "all projects".
 * Includes projects where the user manages, is a member, heads the
 * department, or is assigned / reviewing a task.
 */
export function accessibleProjectIds(user: AuthUser): Promise<Types.ObjectId[] | null> {
  if (has(user, "projects:read_all")) return Promise.resolve(null);
  let cached = projectIdCache.get(user);
  if (!cached) {
    cached = (async () => {
      const dept = deptScope(user);
      const or: QueryFilter<IProject>[] = [{ manager: user._id }, { members: user._id }, { qa: user._id }];
      if (dept) or.push({ department: dept });
      const [direct, viaTasks] = await Promise.all([
        Project.find({ $or: or }).distinct("_id"),
        Task.find({ $or: [{ assignee: user._id }, { reviewer: user._id }, { qa: user._id }] }).distinct("project"),
      ]);
      const unique = new Map<string, Types.ObjectId>();
      for (const id of [...direct, ...viaTasks] as Types.ObjectId[]) unique.set(String(id), id);
      return [...unique.values()];
    })();
    projectIdCache.set(user, cached);
  }
  return cached;
}

/** Mongo filter restricting projects to what the user can see (`{}` = everything). */
export async function projectScopeFilter(user: AuthUser): Promise<QueryFilter<IProject>> {
  const ids = await accessibleProjectIds(user);
  return ids === null ? {} : { _id: { $in: ids } };
}

/** Mongo filter restricting tasks to what the user can see. */
export async function taskScopeFilter(user: AuthUser): Promise<QueryFilter<ITask>> {
  if (has(user, "tasks:read_all")) return {};
  const ids = await accessibleProjectIds(user);
  const or: QueryFilter<ITask>[] = [{ assignee: user._id }, { reviewer: user._id }, { qa: user._id }, { createdBy: user._id }];
  if (ids && ids.length) or.push({ project: { $in: ids } });
  const dept = deptScope(user);
  if (dept) or.push({ department: dept });
  return { $or: or };
}

type ProjectLike = Pick<IProject, "manager" | "members" | "department"> & { _id: Types.ObjectId; qa?: Types.ObjectId | null };

export async function canReadProject(user: AuthUser, project: ProjectLike): Promise<boolean> {
  if (has(user, "projects:read_all")) return true;
  if (idEq(project.manager, user._id) || idEq(project.qa, user._id) || project.members?.some((m) => idEq(m, user._id))) return true;
  const dept = deptScope(user);
  if (dept && idEq(project.department, dept)) return true;
  return Boolean(await Task.exists({ project: project._id, $or: [{ assignee: user._id }, { reviewer: user._id }, { qa: user._id }] }));
}

/** Changing project settings, members, milestones: projects:update + (company-wide or the project's manager). */
export function canManageProject(user: AuthUser, project: ProjectLike): boolean {
  if (!has(user, "projects:update")) return false;
  return has(user, "projects:read_all") || idEq(project.manager, user._id);
}

/** Loads a project and enforces read/manage access. 404 hides projects the user cannot see. */
export async function accessibleProject(user: AuthUser, projectId: string, level: ProjectAccessLevel = "read") {
  if (!Types.ObjectId.isValid(projectId)) throw notFound("Project");
  const project = await Project.findById(projectId).lean();
  if (!project || !(await canReadProject(user, project))) throw notFound("Project");
  if (level === "manage" && !canManageProject(user, project)) throw forbidden("Only the project manager can change this project.");
  return project;
}

// ---------------------------------------------------------------------------
// Tasks
// ---------------------------------------------------------------------------

type TaskLike = Pick<ITask, "project" | "assignee" | "reviewer" | "createdBy" | "department"> & { _id: Types.ObjectId; qa?: Types.ObjectId | null };

export async function canReadTask(user: AuthUser, task: TaskLike): Promise<boolean> {
  if (has(user, "tasks:read_all")) return true;
  if (idEq(task.assignee, user._id) || idEq(task.reviewer, user._id) || idEq(task.qa, user._id) || idEq(task.createdBy, user._id)) return true;
  const dept = deptScope(user);
  if (dept && idEq(task.department, dept)) return true;
  const ids = await accessibleProjectIds(user);
  return ids === null || ids.some((id) => idEq(id, task.project as Types.ObjectId));
}

/**
 * Full edit rights (assign, change any field, any status): tasks:assign and
 * the task is within the user's project scope (or their department).
 */
export async function canManageTask(user: AuthUser, task: TaskLike): Promise<boolean> {
  if (!has(user, "tasks:assign")) return false;
  if (has(user, "tasks:read_all")) return true;
  const dept = deptScope(user);
  if (dept && idEq(task.department, dept)) return true;
  const project = await Project.findById(task.project).select("manager members department").lean();
  if (!project) return false;
  if (idEq(project.manager, user._id) || project.members.some((m) => idEq(m, user._id))) return true;
  return Boolean(dept && idEq(project.department, dept));
}

/** Review decisions: the designated reviewer, or tasks:review within manage scope. */
export async function canReviewTask(user: AuthUser, task: TaskLike): Promise<boolean> {
  if (idEq(task.reviewer, user._id)) return true;
  if (!has(user, "tasks:review")) return false;
  return has(user, "tasks:read_all") || (await canManageTaskScope(user, task));
}

async function canManageTaskScope(user: AuthUser, task: TaskLike) {
  // Same scope as canManageTask but keyed on tasks:review instead of tasks:assign.
  const dept = deptScope(user);
  if (dept && idEq(task.department, dept)) return true;
  const project = await Project.findById(task.project).select("manager members").lean();
  return Boolean(project && (idEq(project.manager, user._id) || project.members.some((m) => idEq(m, user._id))));
}

export const isAssignee = (user: AuthUser, task: Pick<ITask, "assignee">) => idEq(task.assignee, user._id);

/** Pass/fail QA: the task's QA tester, or tasks:review within scope (manager override). */
export async function canQaTask(user: AuthUser, task: TaskLike): Promise<boolean> {
  if (idEq(task.qa, user._id)) return true;
  if (!has(user, "tasks:review")) return false;
  return has(user, "tasks:read_all") || (await canManageTaskScope(user, task));
}

/** Loads a task (lean) and enforces read access; 404 hides tasks the user cannot see. */
export async function accessibleTask(user: AuthUser, taskId: string) {
  if (!Types.ObjectId.isValid(taskId)) throw notFound("Task");
  const task = await Task.findById(taskId).lean();
  if (!task || !(await canReadTask(user, task))) throw notFound("Task");
  return task;
}

import { Types, type QueryFilter } from "mongoose";
import type { z } from "zod";
import { Client, Comment, DailyTask, Department, FileModel, Milestone, Notification, Project, ProjectLink, Task, User, type IProject } from "../models";
import { DONE_STATUSES, PRIORITY_RANK, type WorkflowStage } from "../types/domain";
import type { AuthUser } from "../types/express";
import { conflict, notFound, unprocessable } from "../utils/errors";
import { searchRegex } from "../validators/common";
import { STAGE_META, stageTitle } from "../utils/workflow";
import type { createProjectSchema, listProjectsQuery, updateProjectSchema, WorkflowInput } from "../validators/projects.validators";
import { projectScopeFilter } from "./access.service";
import { logActivity } from "./activity.service";
import { deleteFile } from "./file.service";
import { notify } from "./notification.service";

const USER_SUMMARY = "firstName lastName email profileImage role jobTitle";
export const PROJECT_POPULATE = [
  { path: "client", select: "name" },
  { path: "manager", select: USER_SUMMARY },
  { path: "qa", select: USER_SUMMARY },
  { path: "members", select: USER_SUMMARY },
  { path: "department", select: "name" },
];

const oid = (id: string) => new Types.ObjectId(id);

/** Recomputes the denormalized task counters and progress for a project. */
export async function recalcProjectStats(projectId: Types.ObjectId | string | null | undefined): Promise<void> {
  if (!projectId) return;
  const id = typeof projectId === "string" ? oid(projectId) : projectId;
  const [row] = await Task.aggregate<{ total: number; done: number }>([
    { $match: { project: id } },
    { $group: { _id: null, total: { $sum: 1 }, done: { $sum: { $cond: [{ $in: ["$status", [...DONE_STATUSES]] }, 1, 0] } } } },
  ]);
  const total = row?.total ?? 0;
  const done = row?.done ?? 0;
  await Project.updateOne(
    { _id: id },
    { taskCount: total, completedTaskCount: done, progress: total ? Math.round((done / total) * 100) : 0 },
  );
}

export async function listProjects(user: AuthUser, q: z.output<typeof listProjectsQuery>) {
  const filter: QueryFilter<IProject> = { ...(await projectScopeFilter(user)) };
  const re = searchRegex(q.search);
  if (re) filter.name = re;
  if (q.status) filter.status = q.status;
  if (q.clientId) filter.client = oid(q.clientId);
  if (q.managerId) filter.manager = oid(q.managerId);
  if (q.memberId) filter.$and = [{ $or: [{ members: oid(q.memberId) }, { manager: oid(q.memberId) }] }];
  if (q.departmentId) filter.department = oid(q.departmentId);
  if (q.qaId) {
    const qa = q.qaId === "me" ? user._id : oid(q.qaId);
    const tested = await Task.distinct("project", { qa });
    filter.$and = [...(filter.$and ?? []), { $or: [{ qa }, { _id: { $in: tested } }] }];
  }

  const dir = q.sortOrder === "desc" ? -1 : 1;
  // Projects without a deadline sort last either way.
  const sort: Record<string, 1 | -1> = q.sortBy === "deadline" ? { deadline: dir, name: 1 } : { [q.sortBy]: dir, _id: 1 };

  const [items, total] = await Promise.all([
    Project.find(filter).populate(PROJECT_POPULATE).sort(sort).skip(q.skip).limit(q.pageSize).lean(),
    Project.countDocuments(filter),
  ]);
  return { items, total };
}

export async function getProject(id: Types.ObjectId | string) {
  const project = await Project.findById(id).populate(PROJECT_POPULATE).lean();
  if (!project) throw notFound("Project");
  return project;
}

/** Validates every reference so the database never holds dangling ids. */
async function assertRefs(input: { clientId?: string | null; managerId?: string | null; qaId?: string | null; memberIds?: string[]; departmentId?: string | null }) {
  const errors: { path: string; message: string }[] = [];
  if (input.clientId && !(await Client.exists({ _id: input.clientId }))) errors.push({ path: "clientId", message: "Select an existing client." });
  if (input.departmentId && !(await Department.exists({ _id: input.departmentId }))) errors.push({ path: "departmentId", message: "Select an existing department." });
  if (input.managerId && !(await User.exists({ _id: input.managerId, status: "ACTIVE" }))) errors.push({ path: "managerId", message: "Select an active user." });
  if (input.qaId && !(await User.exists({ _id: input.qaId, status: "ACTIVE" }))) errors.push({ path: "qaId", message: "Select an active user." });
  const members = [...new Set(input.memberIds ?? [])];
  if (members.length && (await User.countDocuments({ _id: { $in: members } })) !== members.length) {
    errors.push({ path: "memberIds", message: "One or more members were not found." });
  }
  if (errors.length) throw unprocessable("Please correct the highlighted fields.", errors);
}

export async function createProject(actor: AuthUser, input: z.output<typeof createProjectSchema>) {
  await assertRefs(input);
  // A project manager creating a project manages it unless someone else is named.
  const managerId = input.managerId ?? (actor.role === "PROJECT_MANAGER" ? actor.id : null);
  let department = input.departmentId ?? null;
  if (!department && managerId) {
    const manager = await User.findById(managerId).select("department").lean();
    department = manager?.department ? String(manager.department) : null;
  }

  const project = await Project.create({
    name: input.name,
    description: input.description ?? null,
    client: input.type === "INTERNAL" ? null : (input.clientId ?? null),
    type: input.type,
    status: input.status,
    priority: input.priority,
    startDate: input.startDate ?? null,
    deadline: input.deadline ?? null,
    designLink: input.designLink ?? null,
    githubLink: input.githubLink ?? null,
    manager: managerId,
    qa: input.qaId,
    members: [...new Set(input.memberIds)].map(oid),
    department,
    estimatedHours: input.estimatedHours ?? null,
    createdBy: actor._id,
  });

  void logActivity({ actor: actor._id, type: "PROJECT_CREATED", verb: "created", entityType: "PROJECT", entityId: project._id, entityName: project.name, project: project._id, client: project.client ?? null, department: project.department ?? null });
  void notify({
    recipients: [...project.members, project.manager],
    actor: actor._id,
    type: "PROJECT_UPDATE",
    title: `You were added to ${project.name}`,
    entityType: "PROJECT",
    entityId: project._id,
  });
  void notify({
    recipients: [project.qa],
    actor: actor._id,
    type: "PROJECT_UPDATE",
    title: `You are the QA for ${project.name}`,
    body: "Tasks will come to you for testing after code review.",
    entityType: "PROJECT",
    entityId: project._id,
  });
  if (input.workflow) await setupWorkflow(actor, project._id, input.workflow);
  return getProject(project._id);
}

/**
 * Breaks a project into its workflow stages, one task per stage, each assigned
 * to its person and reviewed by the project manager. The first stage opens
 * now; the rest wait until the stage before them is approved (task.service).
 */
export async function setupWorkflow(actor: AuthUser, projectId: Types.ObjectId | string, input: Omit<WorkflowInput, "qaId"> & { qaId?: string }) {
  const project = await Project.findById(projectId);
  if (!project) throw notFound("Project");
  if (await Task.exists({ project: project._id, stage: { $ne: null } })) throw conflict("This project already has a workflow.");
  const people = [input.designerId, input.frontendId, input.backendId, input.bugFixerId].filter((v): v is string => Boolean(v));
  await assertRefs({ qaId: input.qaId, memberIds: people });
  if (input.qaId) project.qa = oid(input.qaId);

  const bugFixer = input.bugFixerId ?? input.frontendId ?? input.backendId ?? null;
  const stages: { stage: WorkflowStage; assignee: Types.ObjectId | null }[] = [];
  if (input.designerId) stages.push({ stage: "DESIGN", assignee: oid(input.designerId) });
  if (input.frontendId) stages.push({ stage: "FRONTEND", assignee: oid(input.frontendId) });
  if (input.backendId) stages.push({ stage: "BACKEND", assignee: oid(input.backendId) });
  // Bug fixing isn't a stage yet: it's created when QA reports bugs, after development is finished.
  stages.push({ stage: "QA", assignee: project.qa ?? null });
  project.bugFixer = bugFixer ? oid(bugFixer) : null;
  const firstLevel = Math.min(...stages.map((s) => STAGE_META[s.stage].level));

  const tasks = await Task.insertMany(
    stages.map(({ stage, assignee }) => {
      const open = STAGE_META[stage].level === firstLevel;
      return {
        title: stageTitle(stage, project.name),
        description: STAGE_META[stage].description,
        project: project._id,
        stage,
        assignee,
        reviewer: project.manager ?? null,
        qa: stage === "QA" ? (project.qa ?? null) : null,
        createdBy: actor._id,
        department: project.department ?? null,
        status: !open ? "WAITING" : stage === "QA" ? "IN_QA" : "TODO",
        priority: project.priority,
        priorityRank: PRIORITY_RANK[project.priority],
        type: STAGE_META[stage].type,
        tags: ["workflow"],
      };
    }),
  );

  // Everyone on the workflow is on the project.
  const members = new Set(project.members.map(String));
  for (const person of [...tasks.map((t) => t.assignee), project.bugFixer]) if (person && !idEquals(person, project.manager)) members.add(String(person));
  project.members = [...members].map(oid);
  project.workflow = true;
  await project.save();
  await recalcProjectStats(project._id);

  void logActivity({ actor: actor._id, type: "PROJECT_UPDATED", verb: "set up the workflow for", entityType: "PROJECT", entityId: project._id, entityName: project.name, project: project._id, client: project.client ?? null, department: project.department ?? null });
  for (const t of tasks) {
    if (!t.assignee) continue;
    const meta = STAGE_META[t.stage!];
    void notify({
      recipients: [t.assignee],
      actor: actor._id,
      type: "TASK_ASSIGNED",
      title: t.status === "WAITING" ? `You're the ${meta.role} on ${project.name}` : `${t.title} is ready for you to start`,
      body: t.status === "WAITING" ? "Your stage opens when the stage before it is approved by the project manager." : meta.description,
      entityType: "TASK",
      entityId: t._id,
    });
  }
}

const idEquals = (a: unknown, b: unknown) => Boolean(a && b && String(a) === String(b));

/**
 * Moving a project to QA testing sends every approved task that hasn't passed
 * QA yet (e.g. approved before the project had a QA) to the project's QA.
 * Without a QA the tasks wait in QA and go to the QA once one is assigned.
 */
async function handOffToQa(actor: AuthUser, project: IProject & { _id: Types.ObjectId }) {
  const pending = { project: project._id, status: "APPROVED" as const, "reviewHistory.decision": { $ne: "QA_PASSED" as const } };
  // Workflow projects are tested in their QA stage, so approved work isn't pulled back into QA.
  const { modifiedCount } = project.workflow ? { modifiedCount: 0 } : await Task.updateMany(pending, { status: "IN_QA", qa: project.qa ?? null, completedAt: null, qaStartedAt: new Date() });
  if (modifiedCount) await recalcProjectStats(project._id);
  if (!project.qa) return;
  // Tasks already in QA stay with whoever is the QA now.
  await Task.updateMany({ project: project._id, status: "IN_QA" }, { qa: project.qa });
  void notify({
    recipients: [project.qa],
    actor: actor._id,
    type: "REVIEW_REQUESTED",
    title: `${project.name} is ready for QA testing`,
    body: modifiedCount ? `${modifiedCount} task${modifiedCount === 1 ? " was" : "s were"} sent to you for testing.` : "Tasks will come to you as they pass code review.",
    entityType: "PROJECT",
    entityId: project._id,
  });
}

export async function updateProject(actor: AuthUser, id: string, input: z.output<typeof updateProjectSchema>) {
  await assertRefs(input);
  const project = await Project.findById(id);
  if (!project) throw notFound("Project");

  const type = input.type ?? project.type;
  const clientId = input.clientId !== undefined ? input.clientId : project.client ? String(project.client) : null;
  if (type === "EXTERNAL" && !clientId) {
    throw unprocessable("External projects need a client.", [{ path: "clientId", message: "External projects need a client." }]);
  }
  const start = input.startDate !== undefined ? input.startDate : project.startDate;
  const end = input.deadline !== undefined ? input.deadline : project.deadline;
  if (start && end && end < start) throw unprocessable("Deadline can't be before the start date.", [{ path: "deadline", message: "Deadline can't be before the start date." }]);

  const previousStatus = project.status;
  const previousMembers = new Set(project.members.map(String));
  // Shipping: the project is Completed only when every task (stages and their subtasks) is done.
  if (input.status === "COMPLETED" && previousStatus !== "COMPLETED") {
    const open = await Task.countDocuments({ project: project._id, status: { $nin: [...DONE_STATUSES] } });
    if (open) {
      throw unprocessable(`${open} task${open === 1 ? " is" : "s are"} still open. Every stage must be tested and approved before the project is completed.`, [
        { path: "status", message: "Finish every task first." },
      ]);
    }
  }
  const previousManager = project.manager ? String(project.manager) : null;
  // QA testing may start before a QA is assigned; waiting tasks go to the QA once one is added.

  if (input.name !== undefined) project.name = input.name;
  if (input.description !== undefined) project.description = input.description;
  project.type = type;
  project.client = type === "INTERNAL" ? null : clientId ? oid(clientId) : null;
  if (input.status !== undefined) project.status = input.status;
  if (input.priority !== undefined) project.priority = input.priority;
  if (input.startDate !== undefined) project.startDate = input.startDate;
  if (input.deadline !== undefined) project.deadline = input.deadline;
  if (input.designLink !== undefined) project.designLink = input.designLink;
if (input.githubLink !== undefined) project.githubLink = input.githubLink;
  if (input.managerId !== undefined) project.manager = input.managerId ? oid(input.managerId) : null;
  const previousQa = project.qa ? String(project.qa) : null;
  if (input.qaId !== undefined) project.qa = oid(input.qaId);
  if (input.memberIds !== undefined) project.members = [...new Set(input.memberIds)].map(oid);
  if (input.departmentId !== undefined) project.department = input.departmentId ? oid(input.departmentId) : null;
  if (input.estimatedHours !== undefined) project.estimatedHours = input.estimatedHours;
  await project.save();

  void logActivity({
    actor: actor._id,
    type: previousStatus !== project.status ? "PROJECT_STATUS_CHANGED" : "PROJECT_UPDATED",
    verb: previousStatus !== project.status ? `moved to ${project.status.toLowerCase().replace(/_/g, " ")}` : "updated",
    entityType: "PROJECT",
    entityId: project._id,
    entityName: project.name,
    project: project._id,
    client: project.client ?? null,
    department: project.department ?? null,
    metadata: previousStatus !== project.status ? { from: previousStatus, to: project.status } : null,
  });
  if (previousStatus !== project.status) {
    void notify({
      // Moving into QA testing gets the QA a dedicated notification instead (handOffToQa).
      recipients: [...project.members, project.manager, ...(project.status === "QA_TESTING" ? [] : [project.qa])],
      actor: actor._id,
      type: "PROJECT_UPDATE",
      title: `${project.name} is now ${project.status === "QA_TESTING" ? "in QA testing" : project.status.toLowerCase().replace(/_/g, " ")}`,
      entityType: "PROJECT",
      entityId: project._id,
    });
  }
  const qaChanged = Boolean(project.qa) && String(project.qa) !== previousQa;
  // Keep the workflow's QA stage and stage reviewers in step with the project.
  if (qaChanged) await Task.updateMany({ project: project._id, stage: "QA" }, { assignee: project.qa, qa: project.qa });
  if ((project.manager ? String(project.manager) : null) !== previousManager) {
    await Task.updateMany({ project: project._id, stage: { $ne: null } }, { reviewer: project.manager ?? null });
  }
  // A new (or first) QA takes over whatever is waiting for QA, including tasks sent there before the project had one.
  const reassigned = qaChanged ? (await Task.updateMany({ project: project._id, status: "IN_QA" }, { qa: project.qa })).modifiedCount : 0;
  if (qaChanged) {
    void notify({
      recipients: [project.qa],
      actor: actor._id,
      type: "PROJECT_UPDATE",
      title: `You are now the QA for ${project.name}`,
      body: reassigned
        ? `${reassigned} task${reassigned === 1 ? " is" : "s are"} waiting for your QA.`
        : "Tasks will come to you for testing after code review.",
      entityType: "PROJECT",
      entityId: project._id,
    });
  }
  if (project.status === "QA_TESTING" && previousStatus !== "QA_TESTING") await handOffToQa(actor, project);
  const added = project.members.filter((m) => !previousMembers.has(String(m)));
  if (added.length) {
    void notify({ recipients: added, actor: actor._id, type: "PROJECT_UPDATE", title: `You were added to ${project.name}`, entityType: "PROJECT", entityId: project._id });
  }
  return getProject(project._id);
}

/**
 * Permanently deletes a project and everything in it: tasks and subtasks,
 * milestones, comments, attachments (including the stored files), daily plan
 * entries and notifications that point at them. The activity log keeps its
 * entries as the audit trail.
 */
export async function deleteProject(actor: AuthUser, id: string) {
  const project = await Project.findById(id);
  if (!project) throw notFound("Project");
  const [taskIds, milestoneIds] = await Promise.all([
    Task.find({ project: project._id }).distinct("_id") as Promise<Types.ObjectId[]>,
    Milestone.find({ project: project._id }).distinct("_id") as Promise<Types.ObjectId[]>,
  ]);
  const owned = [project._id, ...taskIds, ...milestoneIds];

  // Files first, so the stored objects go too (deleteFile removes them from storage).
  const files = await FileModel.find({ entityId: { $in: owned } }).select("_id").lean();
  for (const f of files) await deleteFile(String(f._id));

  await Promise.all([
    Task.deleteMany({ project: project._id }),
    Milestone.deleteMany({ project: project._id }),
    ProjectLink.deleteMany({ project: project._id }),
    Comment.deleteMany({ entityId: { $in: owned } }),
    DailyTask.deleteMany({ task: { $in: taskIds } }),
    Notification.deleteMany({ entityId: { $in: owned } }),
  ]);
  await project.deleteOne();
  void logActivity({
    actor: actor._id,
    type: "PROJECT_DELETED",
    verb: "deleted",
    entityType: "PROJECT",
    entityId: project._id,
    entityName: project.name,
    metadata: { tasks: taskIds.length, milestones: milestoneIds.length, files: files.length },
  });
}

export async function addMember(actor: AuthUser, projectId: string, userId: string) {
  const user = await User.findOne({ _id: userId, status: "ACTIVE" }).select("firstName lastName").lean();
  if (!user) throw unprocessable("User not found.", [{ path: "userId", message: "Select an active user." }]);
  const project = await Project.findByIdAndUpdate(projectId, { $addToSet: { members: user._id } }, { returnDocument: "after" }).lean();
  if (!project) throw notFound("Project");
  const name = `${user.firstName} ${user.lastName}`.trim();
  void logActivity({ actor: actor._id, type: "PROJECT_MEMBER_ADDED", verb: "added", entityType: "USER", entityId: user._id, entityName: name, target: { type: "PROJECT", id: project._id, name: project.name }, project: project._id });
  void notify({ recipients: [user._id], actor: actor._id, type: "PROJECT_UPDATE", title: `You were added to ${project.name}`, entityType: "PROJECT", entityId: project._id });
}

export async function removeMember(actor: AuthUser, projectId: string, userId: string) {
  const project = await Project.findById(projectId);
  if (!project) throw notFound("Project");
  if (String(project.manager) === userId) throw conflict("Assign a different project manager before removing this person.");
  const before = project.members.length;
  project.members = project.members.filter((m) => String(m) !== userId);
  if (project.members.length === before) throw notFound("Member");
  await project.save();
  const user = await User.findById(userId).select("firstName lastName").lean();
  void logActivity({
    actor: actor._id,
    type: "PROJECT_MEMBER_REMOVED",
    verb: "removed",
    entityType: "USER",
    entityId: oid(userId),
    entityName: user ? `${user.firstName} ${user.lastName}`.trim() : "a member",
    target: { type: "PROJECT", id: project._id, name: project.name },
    project: project._id,
  });
}

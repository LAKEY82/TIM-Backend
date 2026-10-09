/**
 * Serializers: the only place that decides the JSON shape sent to the client.
 * Shapes follow `frontend/src/types/domain.ts`; IDs are always `id` strings.
 * Inputs are lean documents whose refs may or may not be populated.
 */
import { Types } from "mongoose";
import { permissionsForRole } from "../config/permissions";
import { DONE_STATUSES, type Role, type TaskStatus } from "../types/domain";

// `any` values (not `unknown`) so lean Mongoose documents, which are
// interfaces without index signatures, are accepted as input.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyObj = Record<string, any>;

function isObj(v: unknown): v is AnyObj {
  return typeof v === "object" && v !== null && !(v instanceof Types.ObjectId) && !(v instanceof Date);
}

/** String id of an ObjectId, a populated doc, or null. */
export function idOf(value: unknown): string | null {
  if (!value) return null;
  if (value instanceof Types.ObjectId) return value.toHexString();
  if (typeof value === "string") return value;
  if (isObj(value) && value._id) return idOf(value._id);
  return null;
}

const iso = (d: unknown): string | null => (d instanceof Date ? d.toISOString() : typeof d === "string" ? d : null);
/** `yyyy-MM-dd` for date-only fields (deadlines, due dates) so the UI shows the intended day. */
export const isoDay = (d: unknown): string | null => {
  const s = iso(d);
  return s ? s.slice(0, 10) : null;
};

// ---------------------------------------------------------------------------
// Users
// ---------------------------------------------------------------------------

export interface UserSummaryDTO {
  id: string;
  name: string;
  email?: string;
  avatarUrl: string | null;
  role?: Role;
  jobTitle: string | null;
}

export function userSummary(u: unknown): UserSummaryDTO | null {
  if (!isObj(u) || !u._id) return null;
  return {
    id: idOf(u._id)!,
    name: `${String(u.firstName ?? "")} ${String(u.lastName ?? "")}`.trim(),
    email: typeof u.email === "string" ? u.email : undefined,
    avatarUrl: (u.profileImage as string | null) ?? null,
    role: u.role as Role | undefined,
    jobTitle: (u.jobTitle as string | null) ?? null,
  };
}

function named(ref: unknown): { id: string; name: string } | null {
  if (!isObj(ref) || !ref._id) return null;
  return { id: idOf(ref._id)!, name: String(ref.name ?? ref.title ?? "") };
}

export function serializeUser(u: AnyObj, opts: { withPermissions?: boolean } = {}) {
  const dept = isObj(u.department) ? named(u.department) : null;
  const base = {
    ...userSummary(u)!,
    firstName: u.firstName as string,
    lastName: (u.lastName as string) ?? "",
    phone: (u.phone as string | null) ?? null,
    status: u.status as string,
    departmentId: idOf(u.department),
    department: dept,
    teamId: idOf(u.team),
    lastLoginAt: iso(u.lastLoginAt),
    createdAt: iso(u.createdAt),
  };
  return opts.withPermissions ? { ...base, permissions: [...permissionsForRole(u.role as Role)] } : base;
}

// ---------------------------------------------------------------------------
// Departments, teams, clients
// ---------------------------------------------------------------------------

export function serializeDepartment(d: AnyObj, counts: { memberCount?: number; activeTaskCount?: number; projectCount?: number } = {}) {
  return {
    id: idOf(d._id)!,
    name: d.name as string,
    description: (d.description as string | null) ?? null,
    head: userSummary(d.head),
    memberCount: counts.memberCount ?? 0,
    activeTaskCount: counts.activeTaskCount ?? 0,
    projectCount: counts.projectCount ?? 0,
  };
}

export function serializeTeam(t: AnyObj) {
  return {
    id: idOf(t._id)!,
    name: t.name as string,
    description: (t.description as string | null) ?? null,
    department: named(t.department) ?? (idOf(t.department) ? { id: idOf(t.department)!, name: "" } : null),
    lead: userSummary(t.lead),
    members: ((t.members as unknown[]) ?? []).map(userSummary).filter(Boolean),
    createdAt: iso(t.createdAt),
  };
}

export function serializeClient(c: AnyObj, counts: { projectCount?: number; activeProjectCount?: number } = {}) {
  return {
    id: idOf(c._id)!,
    name: c.name as string,
    contactName: (c.contactName as string | null) ?? null,
    email: (c.email as string | null) ?? null,
    phone: (c.phone as string | null) ?? null,
    website: (c.website as string | null) ?? null,
    industry: (c.industry as string | null) ?? null,
    notes: (c.notes as string | null) ?? null,
    status: c.status as string,
    projectCount: counts.projectCount ?? 0,
    activeProjectCount: counts.activeProjectCount ?? 0,
    createdAt: iso(c.createdAt),
  };
}

export function serializeRetainer(r: AnyObj) {
  return {
    id: idOf(r._id)!,
    name: r.name as string,
    status: r.status as string,
    startDate: isoDay(r.startDate),
    endDate: isoDay(r.endDate),
    hoursPerMonth: (r.hoursPerMonth as number | null) ?? null,
  };
}

// ---------------------------------------------------------------------------
// Projects & milestones
// ---------------------------------------------------------------------------

export function serializeProject(p: AnyObj) {
  return {
    id: idOf(p._id)!,
    name: p.name as string,
    description: (p.description as string | null) ?? null,
    client: named(p.client),
    type: p.type as string,
    status: p.status as string,
    priority: p.priority as string,
    manager: userSummary(p.manager),
    qa: userSummary(p.qa),
    workflow: Boolean(p.workflow),
    members: ((p.members as unknown[]) ?? []).map(userSummary).filter(Boolean),
    department: named(p.department),
    startDate: isoDay(p.startDate),
    deadline: isoDay(p.deadline),
    progress: (p.progress as number) ?? 0,
    taskCount: (p.taskCount as number) ?? 0,
    completedTaskCount: (p.completedTaskCount as number) ?? 0,
    estimatedHours: (p.estimatedHours as number | null) ?? null,
    createdAt: iso(p.createdAt),
    updatedAt: iso(p.updatedAt),
  };
}

export function serializeMilestone(m: AnyObj, stats: { taskCount: number; completed: number } = { taskCount: 0, completed: 0 }) {
  const project = named(m.project);
  const progress =
    m.status === "COMPLETED" ? 100 : stats.taskCount > 0 ? Math.round((stats.completed / stats.taskCount) * 100) : 0;
  return {
    id: idOf(m._id)!,
    projectId: idOf(m.project)!,
    project,
    projectName: project?.name ?? null,
    name: m.name as string,
    description: (m.description as string | null) ?? null,
    status: m.status as string,
    startDate: isoDay(m.startDate),
    dueDate: isoDay(m.dueDate),
    completedAt: iso(m.completedAt),
    progress,
    taskCount: stats.taskCount,
  };
}

// ---------------------------------------------------------------------------
// Tasks
// ---------------------------------------------------------------------------

export interface TaskCounts {
  subtaskCount?: number;
  completedSubtaskCount?: number;
  commentCount?: number;
}

export function serializeTaskSummary(t: AnyObj, counts: TaskCounts = {}) {
  const project = named(t.project);
  return {
    id: idOf(t._id)!,
    title: t.title as string,
    status: t.status as TaskStatus,
    priority: t.priority as string,
    type: t.type as string,
    project: project ?? (idOf(t.project) ? { id: idOf(t.project)!, name: "" } : null),
    milestone: named(t.milestone),
    parentId: idOf(t.parent),
    /** Populated only where a list needs it (e.g. My bugs). */
    parent: t.parent instanceof Types.ObjectId ? null : named(t.parent),
    issueKind: ((t.qaIssue as AnyObj | null | undefined)?.kind as string) ?? null,
    assignee: userSummary(t.assignee),
    reviewer: userSummary(t.reviewer),
    qa: userSummary(t.qa),
    startDate: isoDay(t.startDate),
    dueDate: isoDay(t.dueDate),
    qaDueDate: isoDay(t.qaDueDate),
    qaResult: (t.qaResult as string | null) ?? null,
    stage: (t.stage as string | null) ?? null,
    estimatedHours: (t.estimatedHours as number | null) ?? null,
    actualHours: (t.actualHours as number | null) ?? null,
    subtaskCount: counts.subtaskCount ?? 0,
    completedSubtaskCount: counts.completedSubtaskCount ?? 0,
    commentCount: counts.commentCount ?? 0,
    tags: (t.tags as string[]) ?? [],
  };
}

export function serializeTask(
  t: AnyObj,
  extra: { subtasks: AnyObj[]; attachments: AnyObj[]; commentCount: number },
) {
  const done = extra.subtasks.filter((s) => DONE_STATUSES.includes(s.status as TaskStatus)).length;
  return {
    ...serializeTaskSummary(t, { subtaskCount: extra.subtasks.length, completedSubtaskCount: done, commentCount: extra.commentCount }),
    description: (t.description as string | null) ?? null,
    qaIssue: t.qaIssue
      ? {
          kind: (t.qaIssue as AnyObj).kind as string,
          steps: ((t.qaIssue as AnyObj).steps as string | null) ?? null,
          expected: ((t.qaIssue as AnyObj).expected as string | null) ?? null,
          actual: ((t.qaIssue as AnyObj).actual as string | null) ?? null,
          environment: ((t.qaIssue as AnyObj).environment as string | null) ?? null,
          reportedBy: userSummary((t.qaIssue as AnyObj).reportedBy),
        }
      : null,
    department: named(t.department),
    subtasks: extra.subtasks.map((s) => ({
      id: idOf(s._id)!,
      title: s.title as string,
      status: s.status as string,
      priority: (s.priority as string) ?? null,
      issueKind: ((s.qaIssue as AnyObj | null)?.kind as string) ?? null,
      dueDate: isoDay(s.dueDate),
      assignee: userSummary(s.assignee),
    })),
    attachments: extra.attachments.map(serializeFile),
    createdBy: userSummary(t.createdBy),
    createdAt: iso(t.createdAt),
    updatedAt: iso(t.updatedAt),
    completedAt: iso(t.completedAt),
  };
}

export function serializeReview(r: AnyObj) {
  return {
    id: idOf(r._id)!,
    decision: r.decision as string,
    feedback: (r.feedback as string | null) ?? null,
    actor: userSummary(r.actor) ?? { id: idOf(r.actor) ?? "", name: "Unknown user", avatarUrl: null, jobTitle: null },
    createdAt: iso(r.createdAt),
  };
}

// ---------------------------------------------------------------------------
// Comments, files, notifications, activity, daily tasks
// ---------------------------------------------------------------------------

export function serializeComment(c: AnyObj) {
  const updatedAt = iso(c.updatedAt);
  return {
    id: idOf(c._id)!,
    taskId: c.entityType === "TASK" ? idOf(c.entityId) : null,
    entityType: c.entityType as string,
    entityId: idOf(c.entityId),
    body: c.body as string,
    author: userSummary(c.author) ?? { id: idOf(c.author) ?? "", name: "Deleted user", avatarUrl: null, jobTitle: null },
    mentions: ((c.mentions as unknown[]) ?? []).map(userSummary).filter(Boolean),
    createdAt: iso(c.createdAt),
    updatedAt,
    edited: Boolean(c.editedAt),
  };
}

export function serializeFile(f: AnyObj) {
  return {
    id: idOf(f._id)!,
    fileName: f.fileName as string,
    url: f.url as string,
    size: (f.size as number) ?? null,
    mimeType: (f.mimeType as string) ?? null,
    uploadedBy: userSummary(f.uploadedBy),
    createdAt: iso(f.createdAt),
  };
}

export function serializeNotification(n: AnyObj) {
  return {
    id: idOf(n._id)!,
    type: n.type as string,
    title: n.title as string,
    body: (n.body as string | null) ?? null,
    read: Boolean(n.readAt),
    entityType: (n.entityType as string | null) ?? null,
    entityId: idOf(n.entityId),
    actor: userSummary(n.actor),
    createdAt: iso(n.createdAt),
  };
}

export function serializeActivity(a: AnyObj) {
  const target = isObj(a.target) ? a.target : null;
  return {
    id: idOf(a._id)!,
    actor: userSummary(a.actor),
    action: a.verb as string,
    type: a.type as string,
    entityType: a.entityType as string,
    entityId: idOf(a.entityId)!,
    entityName: (a.entityName as string) ?? "",
    target: target ? { type: target.type as string, id: idOf(target.id)!, name: String(target.name ?? "") } : null,
    message: (a.message as string | null) ?? null,
    createdAt: iso(a.createdAt),
  };
}

export function serializeDailyTask(d: AnyObj) {
  return {
    id: idOf(d._id)!,
    date: d.date as string,
    task: isObj(d.task) ? serializeTaskSummary(d.task) : null,
    assignee: userSummary(d.assignee),
    priority: d.priority as string,
    estimatedHours: (d.estimatedHours as number | null) ?? null,
    dueTime: (d.dueTime as string | null) ?? null,
    note: (d.note as string | null) ?? null,
  };
}

/**
 * Analytics for dashboards and the Analytics page. Everything is computed
 * with aggregation pipelines; responses are small summaries, never raw lists.
 * Shapes follow the normalizers in `frontend/src/lib/services/analytics.ts`.
 */
import { Types, type QueryFilter } from "mongoose";
import { Activity, Department, Milestone, Project, Task, User, type ITask } from "../models";
import { DONE_STATUSES } from "../types/domain";
import type { AuthUser } from "../types/express";
import { forbidden, notFound } from "../utils/errors";
import { isoDay, serializeActivity, serializeProject, userSummary } from "../utils/serialize";
import { accessibleProject, accessibleProjectIds, taskScopeFilter } from "./access.service";
import { PROJECT_POPULATE } from "./project.service";
import { teamMemberIds } from "./user.service";
import { workloadFor } from "./workload.service";

const DONE = [...DONE_STATUSES];
const DAY = 864e5;

export interface Range {
  from: Date;
  to: Date;
}

/** Default window: the last 8 weeks up to the end of today (UTC). */
export function resolveRange(from?: string, to?: string, defaultWeeks = 8): Range {
  const end = to ? new Date(`${to}T23:59:59.999Z`) : new Date(new Date().toISOString().slice(0, 10) + "T23:59:59.999Z");
  const start = from ? new Date(`${from}T00:00:00.000Z`) : new Date(end.getTime() - defaultWeeks * 7 * DAY + 1);
  return { from: start, to: end };
}

/** Monday 00:00 UTC of the week containing `d`. */
function weekStart(d: Date): Date {
  const day = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const offset = (day.getUTCDay() + 6) % 7;
  return new Date(day.getTime() - offset * DAY);
}

function weekKeys(range: Range): string[] {
  const keys: string[] = [];
  for (let w = weekStart(range.from); w <= range.to; w = new Date(w.getTime() + 7 * DAY)) keys.push(w.toISOString().slice(0, 10));
  return keys;
}

const weekTrunc = (field: string) => ({ $dateTrunc: { date: field, unit: "week", startOfWeek: "monday", timezone: "UTC" } });

/** Created vs completed per week. */
async function weeklyActivity(match: QueryFilter<ITask>, range: Range) {
  const [created, completed] = await Promise.all([
    Task.aggregate<{ _id: Date; n: number }>([
      { $match: { ...match, createdAt: { $gte: range.from, $lte: range.to } } },
      { $group: { _id: weekTrunc("$createdAt"), n: { $sum: 1 } } },
    ]),
    Task.aggregate<{ _id: Date; n: number }>([
      { $match: { ...match, completedAt: { $gte: range.from, $lte: range.to } } },
      { $group: { _id: weekTrunc("$completedAt"), n: { $sum: 1 } } },
    ]),
  ]);
  const c = new Map(created.map((r) => [r._id.toISOString().slice(0, 10), r.n]));
  const d = new Map(completed.map((r) => [r._id.toISOString().slice(0, 10), r.n]));
  return weekKeys(range).map((date) => ({ date, created: c.get(date) ?? 0, completed: d.get(date) ?? 0 }));
}

async function countByField(match: QueryFilter<ITask>, field: "status" | "priority" | "type") {
  const rows = await Task.aggregate<{ _id: string; n: number }>([{ $match: match }, { $group: { _id: `$${field}`, n: { $sum: 1 } } }]);
  return rows.map((r) => ({ key: r._id, status: r._id, count: r.n })).sort((a, b) => b.count - a.count);
}

/** Average hours from each submission to the reviewer's decision, per week of the decision. */
async function reviewCycle(match: QueryFilter<ITask>, range: Range) {
  const tasks = await Task.find({ ...match, "reviewHistory.createdAt": { $gte: range.from, $lte: range.to } })
    .select("reviewHistory.decision reviewHistory.createdAt")
    .limit(5000)
    .lean();
  const buckets = new Map<string, { total: number; n: number }>();
  for (const t of tasks) {
    let submittedAt: Date | null = null;
    for (const r of t.reviewHistory) {
      if (r.decision === "SUBMITTED") submittedAt = r.createdAt;
      else if (submittedAt && r.createdAt >= range.from && r.createdAt <= range.to) {
        const key = weekStart(r.createdAt).toISOString().slice(0, 10);
        const b = buckets.get(key) ?? { total: 0, n: 0 };
        b.total += (r.createdAt.getTime() - submittedAt.getTime()) / 36e5;
        b.n += 1;
        buckets.set(key, b);
        submittedAt = null;
      }
    }
  }
  return weekKeys(range).map((date) => {
    const b = buckets.get(date);
    return { date, averageHours: b ? Math.round((b.total / b.n) * 10) / 10 : 0, reviews: b?.n ?? 0 };
  });
}

/** Tasks that were overdue at the end of each week (reconstructed from due/completed dates). */
async function overdueTrend(match: QueryFilter<ITask>, range: Range) {
  const tasks = await Task.find({
    ...match,
    dueDate: { $ne: null, $lte: range.to },
    $or: [{ completedAt: null }, { completedAt: { $gte: range.from } }],
  })
    .select("createdAt dueDate completedAt")
    .limit(20000)
    .lean();
  return weekKeys(range).map((date) => {
    const end = new Date(new Date(`${date}T00:00:00.000Z`).getTime() + 7 * DAY - 1);
    const count = tasks.filter((t) => t.createdAt <= end && t.dueDate! < end && (!t.completedAt || t.completedAt > end)).length;
    return { date, count };
  });
}

/** Times tasks were moved to BLOCKED per week (from the audit log). */
async function blockedTrend(projectIds: Types.ObjectId[] | null, range: Range) {
  const rows = await Activity.aggregate<{ _id: Date; n: number }>([
    {
      $match: {
        type: "TASK_STATUS_CHANGED",
        "metadata.to": "BLOCKED",
        createdAt: { $gte: range.from, $lte: range.to },
        ...(projectIds ? { project: { $in: projectIds } } : {}),
      },
    },
    { $group: { _id: weekTrunc("$createdAt"), n: { $sum: 1 } } },
  ]);
  const map = new Map(rows.map((r) => [r._id.toISOString().slice(0, 10), r.n]));
  return weekKeys(range).map((date) => ({ date, count: map.get(date) ?? 0 }));
}

async function departmentWorkload() {
  const now = new Date();
  const [rows, departments] = await Promise.all([
    Task.aggregate<{ _id: Types.ObjectId; assigned: number; completed: number; overdue: number; estimatedHours: number }>([
      { $match: { department: { $ne: null } } },
      {
        $group: {
          _id: "$department",
          assigned: { $sum: { $cond: [{ $in: ["$status", DONE] }, 0, 1] } },
          completed: { $sum: { $cond: [{ $in: ["$status", DONE] }, 1, 0] } },
          overdue: { $sum: { $cond: [{ $and: [{ $not: [{ $in: ["$status", DONE] }] }, { $ne: ["$dueDate", null] }, { $lt: ["$dueDate", now] }] }, 1, 0] } },
          estimatedHours: { $sum: { $cond: [{ $in: ["$status", DONE] }, 0, { $ifNull: ["$estimatedHours", 0] }] } },
        },
      },
    ]),
    Department.find().select("name").sort({ name: 1 }).lean(),
  ]);
  const map = new Map(rows.map((r) => [String(r._id), r]));
  return departments.map((d) => {
    const r = map.get(String(d._id));
    return {
      departmentId: String(d._id),
      departmentName: d.name,
      assigned: r?.assigned ?? 0,
      completed: r?.completed ?? 0,
      overdue: r?.overdue ?? 0,
      estimatedHours: Math.round((r?.estimatedHours ?? 0) * 10) / 10,
    };
  });
}

async function upcomingDeadlines(days = 14, limit = 12) {
  const now = new Date();
  const until = new Date(now.getTime() + days * DAY);
  const USER = "firstName lastName email profileImage role jobTitle";
  const [tasks, projects, milestones] = await Promise.all([
    Task.find({ status: { $nin: DONE }, dueDate: { $gte: new Date(now.toISOString().slice(0, 10)), $lte: until } })
      .select("title dueDate status project assignee")
      .populate("project", "name")
      .populate("assignee", USER)
      .sort({ dueDate: 1 })
      .limit(limit)
      .lean(),
    Project.find({ status: { $nin: ["COMPLETED", "CANCELLED"] }, deadline: { $gte: now, $lte: until } }).select("name deadline status").limit(limit).lean(),
    Milestone.find({ status: { $ne: "COMPLETED" }, dueDate: { $gte: now, $lte: until } }).select("name dueDate status project").populate("project", "name").limit(limit).lean(),
  ]);
  const name = (v: unknown) => (v && typeof v === "object" && "name" in v ? String((v as { name: unknown }).name) : null);
  const id = (v: unknown) => (v && typeof v === "object" && "_id" in v ? String((v as { _id: unknown })._id) : null);
  return [
    ...tasks.map((t) => ({ id: String(t._id), kind: "TASK", title: t.title, dueDate: isoDay(t.dueDate)!, projectId: id(t.project), projectName: name(t.project), assignee: userSummary(t.assignee), status: t.status })),
    ...projects.map((p) => ({ id: String(p._id), kind: "PROJECT", title: p.name, dueDate: isoDay(p.deadline)!, projectId: String(p._id), projectName: p.name, assignee: null, status: p.status })),
    ...milestones.map((m) => ({ id: String(m._id), kind: "MILESTONE", title: m.name, dueDate: isoDay(m.dueDate)!, projectId: id(m.project), projectName: name(m.project), assignee: null, status: m.status })),
  ]
    .sort((a, b) => a.dueDate.localeCompare(b.dueDate))
    .slice(0, limit);
}

async function projectsRequiringAttention(limit = 6) {
  const now = new Date();
  const soon = new Date(now.getTime() + 7 * DAY);
  const open = await Project.find({ status: { $nin: ["COMPLETED", "CANCELLED"] } }).populate(PROJECT_POPULATE).lean();
  const overdue = await Task.aggregate<{ _id: Types.ObjectId; n: number }>([
    { $match: { project: { $in: open.map((p) => p._id) }, status: { $nin: DONE }, dueDate: { $lt: now } } },
    { $group: { _id: "$project", n: { $sum: 1 } } },
  ]);
  const overdueBy = new Map(overdue.map((o) => [String(o._id), o.n]));

  return open
    .map((p) => {
      const reasons: string[] = [];
      const late = overdueBy.get(String(p._id)) ?? 0;
      if (p.status === "AT_RISK") reasons.push("Marked at risk");
      if (p.deadline && p.deadline < now) reasons.push("Past its deadline");
      else if (p.deadline && p.deadline <= soon && p.progress < 70) reasons.push(`Due within 7 days at ${p.progress}% complete`);
      if (late > 0) reasons.push(`${late} overdue task${late === 1 ? "" : "s"}`);
      return { project: p, reasons, weight: reasons.length * 100 + late };
    })
    .filter((x) => x.reasons.length > 0)
    .sort((a, b) => b.weight - a.weight)
    .slice(0, limit)
    .map((x) => ({ project: serializeProject(x.project), reasons: x.reasons }));
}

// ---------------------------------------------------------------------------
// Endpoints
// ---------------------------------------------------------------------------

export async function companyAnalytics(range: Range) {
  const now = new Date();
  const [projectStatus, taskStatus, overdueTasks, workload, weekly, progress, deadlines, attention, recent, review] = await Promise.all([
    Project.aggregate<{ _id: string; n: number }>([{ $group: { _id: "$status", n: { $sum: 1 } } }]),
    Task.aggregate<{ _id: string; n: number }>([{ $group: { _id: "$status", n: { $sum: 1 } } }]),
    Task.countDocuments({ status: { $nin: DONE }, dueDate: { $lt: now } }),
    departmentWorkload(),
    weeklyActivity({}, range),
    Project.find({ status: { $nin: ["CANCELLED"] } }).select("name progress status").sort({ progress: -1 }).limit(30).lean(),
    upcomingDeadlines(),
    projectsRequiringAttention(),
    Activity.find().populate("actor", "firstName lastName email profileImage role jobTitle").sort({ createdAt: -1 }).limit(10).lean(),
    reviewCycle({}, range),
  ]);
  const p = new Map(projectStatus.map((r) => [r._id, r.n]));
  const t = new Map(taskStatus.map((r) => [r._id, r.n]));
  const totalTasks = taskStatus.reduce((s, r) => s + r.n, 0);
  const doneTasks = (t.get("COMPLETED") ?? 0) + (t.get("APPROVED") ?? 0);

  return {
    summary: {
      activeProjects: p.get("ACTIVE") ?? 0,
      completedProjects: p.get("COMPLETED") ?? 0,
      atRiskProjects: p.get("AT_RISK") ?? 0,
      overdueTasks,
      completedTasks: doneTasks,
      inReviewTasks: t.get("IN_REVIEW") ?? 0,
      blockedTasks: t.get("BLOCKED") ?? 0,
      openTasks: totalTasks - doneTasks,
    },
    projectStatus: projectStatus.map((r) => ({ status: r._id, count: r.n })),
    taskStatus: taskStatus.map((r) => ({ status: r._id, count: r.n })),
    departmentWorkload: workload,
    weeklyActivity: weekly,
    projectProgress: progress.map((x) => ({ projectId: String(x._id), name: x.name, progress: x.progress, status: x.status })),
    upcomingDeadlines: deadlines,
    projectsRequiringAttention: attention,
    recentActivity: recent.map(serializeActivity),
    reviewCycle: review,
  };
}

export async function projectAnalytics(user: AuthUser, projectId: string) {
  const project = await accessibleProject(user, projectId);
  // Real work only: tasks, subtasks and bugs. Workflow phases (Frontend development, QA testing…) just contain them.
  const match = { project: project._id, stage: null };
  // QA are counted on the subtasks they test (not on bugs, which are the developers' work).
  const tested = { ...match, qaIssue: null };
  const now = new Date();
  const range = resolveRange(undefined, undefined, 8);

  const [statusRows, hours, milestones, members, activity, overdue] = await Promise.all([
    Task.aggregate<{ _id: string; n: number }>([{ $match: match }, { $group: { _id: "$status", n: { $sum: 1 } } }]),
    Task.aggregate<{ _id: Types.ObjectId | null; est: number; act: number }>([
      { $match: match },
      { $group: { _id: "$assignee", est: { $sum: { $ifNull: ["$estimatedHours", 0] } }, act: { $sum: { $ifNull: ["$actualHours", 0] } } } },
    ]),
    Milestone.aggregate<{ total: number; completed: number }>([
      { $match: match },
      { $group: { _id: null, total: { $sum: 1 }, completed: { $sum: { $cond: [{ $eq: ["$status", "COMPLETED"] }, 1, 0] } } } },
    ]),
    Task.find(match).distinct("assignee"),
    weeklyActivity(match, range),
    Task.countDocuments({ ...match, status: { $nin: DONE }, dueDate: { $lt: now } }),
  ]);

  const s = new Map(statusRows.map((r) => [r._id, r.n]));
  const total = statusRows.reduce((sum, r) => sum + r.n, 0);
  const done = (s.get("COMPLETED") ?? 0) + (s.get("APPROVED") ?? 0);
  const assigneeIds = (members as (Types.ObjectId | null)[]).filter((m): m is Types.ObjectId => Boolean(m));
  const testers = (await Task.find({ ...tested, qa: { $ne: null } }).distinct("qa")) as Types.ObjectId[];
  const qaIds = [...new Map([...testers, ...(project.qa ? [project.qa] : [])].map((id) => [String(id), id])).values()];
  const [developers, qa] = await Promise.all([workloadFor(assigneeIds, match), workloadFor(qaIds, tested, { by: "qa" })]);
  const users = await User.find({ _id: { $in: assigneeIds } }).select("firstName lastName").lean();
  const nameOf = new Map(users.map((u) => [String(u._id), `${u.firstName} ${u.lastName ?? ""}`.trim()]));

  return {
    projectId: String(project._id),
    progress: total ? Math.round((done / total) * 100) : 0,
    totalTasks: total,
    completedTasks: done,
    overdueTasks: overdue,
    blockedTasks: s.get("BLOCKED") ?? 0,
    inReviewTasks: s.get("IN_REVIEW") ?? 0,
    milestones: { total: milestones[0]?.total ?? 0, completed: milestones[0]?.completed ?? 0 },
    taskStatus: statusRows.map((r) => ({ status: r._id, count: r.n })),
    hoursByMember: hours
      .filter((h) => h._id)
      .map((h) => ({ userId: String(h._id), name: nameOf.get(String(h._id)) ?? "Unknown", estimatedHours: h.est, actualHours: h.act })),
    estimatedHours: hours.reduce((sum, h) => sum + h.est, 0),
    actualHours: hours.reduce((sum, h) => sum + h.act, 0),
    workload: [...developers.map((w) => ({ ...w, role: "DEVELOPER" as const })), ...qa.map((w) => ({ ...w, role: "QA" as const }))],
    activity,
  };
}

/** Department "kind" inferred from its name, to pick relevant metrics. */
function departmentKind(name: string): "DEVELOPMENT" | "DESIGN" | "MARKETING" | "QA" | "GENERAL" {
  const n = name.toLowerCase();
  if (/\bqa\b|quality|test/.test(n)) return "QA";
  if (/design|ui|ux/.test(n)) return "DESIGN";
  if (/market|social|content/.test(n)) return "MARKETING";
  if (/develop|engineer|software|tech/.test(n)) return "DEVELOPMENT";
  return "GENERAL";
}

export async function departmentAnalytics(user: AuthUser, departmentId: string, range: Range) {
  if (!Types.ObjectId.isValid(departmentId)) throw notFound("Department");
  if (!user.permissions.has("analytics:company") && user.role === "DEPARTMENT_HEAD" && String(user.departmentId) !== departmentId) {
    throw forbidden("You can only view your own department's analytics.");
  }
  const dept = await Department.findById(departmentId).lean();
  if (!dept) throw notFound("Department");
  const match: QueryFilter<ITask> = { department: dept._id };
  const now = new Date();

  const [byStatus, byType, byPriorityBugs, activity, members] = await Promise.all([
    Task.aggregate<{ _id: string; n: number }>([{ $match: match }, { $group: { _id: "$status", n: { $sum: 1 } } }]),
    Task.aggregate<{ _id: { type: string; done: boolean }; n: number }>([
      { $match: match },
      { $group: { _id: { type: "$type", done: { $in: ["$status", DONE] } }, n: { $sum: 1 } } },
    ]),
    Task.aggregate<{ _id: string; n: number }>([{ $match: { ...match, type: "BUG", status: { $nin: DONE } } }, { $group: { _id: "$priority", n: { $sum: 1 } } }]),
    weeklyActivity(match, range),
    User.find({ department: dept._id, status: "ACTIVE" }).distinct("_id"),
  ]);

  const status = new Map(byStatus.map((r) => [r._id, r.n]));
  const total = byStatus.reduce((s, r) => s + r.n, 0);
  const completed = (status.get("COMPLETED") ?? 0) + (status.get("APPROVED") ?? 0);
  const typeCount = (type: string, done?: boolean) =>
    byType.filter((r) => r._id.type === type && (done === undefined || r._id.done === done)).reduce((s, r) => s + r.n, 0);
  const active = total - completed;
  const inReview = status.get("IN_REVIEW") ?? 0;
  const blocked = status.get("BLOCKED") ?? 0;
  const planned = status.get("TODO") ?? 0;

  const kind = departmentKind(dept.name);
  const metrics =
    kind === "DEVELOPMENT"
      ? [
          { key: "activeTasks", label: "Active tasks", value: active },
          { key: "completed", label: "Completed", value: completed },
          { key: "blocked", label: "Blocked", value: blocked },
          { key: "bugs", label: "Open bugs", value: typeCount("BUG", false) },
          { key: "inReview", label: "In review", value: inReview },
        ]
      : kind === "DESIGN"
        ? [
            { key: "designTasks", label: "Design tasks", value: typeCount("DESIGN") },
            { key: "completed", label: "Completed", value: completed },
            { key: "inReview", label: "In review", value: inReview },
            { key: "activeTasks", label: "Active", value: active },
          ]
        : kind === "MARKETING"
          ? [
              { key: "campaignTasks", label: "Campaign tasks", value: typeCount("CAMPAIGN") },
              { key: "contentTasks", label: "Content tasks", value: typeCount("CONTENT") },
              { key: "completed", label: "Completed", value: completed },
              { key: "planned", label: "Planned", value: planned },
            ]
          : kind === "QA"
            ? [
                { key: "openBugs", label: "Open bugs", value: typeCount("BUG", false) },
                { key: "resolvedBugs", label: "Resolved bugs", value: typeCount("BUG", true) },
                { key: "testTasks", label: "Test tasks", value: typeCount("TEST") },
                { key: "blocked", label: "Blocked", value: blocked },
              ]
            : [
                { key: "activeTasks", label: "Active tasks", value: active },
                { key: "completed", label: "Completed", value: completed },
                { key: "inReview", label: "In review", value: inReview },
                { key: "overdue", label: "Overdue", value: await Task.countDocuments({ ...match, status: { $nin: DONE }, dueDate: { $lt: now } }) },
              ];

  // Bug priority stands in for QA "severity" (tasks have no separate severity field).
  const breakdowns = kind === "QA" || kind === "DEVELOPMENT" ? [{ key: "bugPriority", label: "Open bugs by priority", items: byPriorityBugs.map((r) => ({ key: r._id, count: r.n })) }] : [];

  return {
    departmentId: String(dept._id),
    departmentName: dept.name,
    metrics,
    taskStatus: byStatus.map((r) => ({ status: r._id, count: r.n })),
    workload: await workloadFor(members as Types.ObjectId[]),
    activity,
    breakdowns,
  };
}

export async function taskAnalytics(user: AuthUser, range: Range) {
  const scope = await taskScopeFilter(user);
  const projectIds = user.permissions.has("tasks:read_all") ? null : await accessibleProjectIds(user);
  const [taskStatus, byPriority, byType, completion, overdue, blocked, review] = await Promise.all([
    countByField(scope, "status"),
    countByField(scope, "priority"),
    countByField(scope, "type"),
    weeklyActivity(scope, range),
    overdueTrend(scope, range),
    blockedTrend(projectIds, range),
    reviewCycle(scope, range),
  ]);
  return { taskStatus, byPriority, byType, completion, overdueTrend: overdue, blockedTrend: blocked, reviewCycle: review };
}

export async function workloadAnalytics(user: AuthUser, params: { departmentId?: string; projectId?: string; managerId?: string }) {
  let userIds: Types.ObjectId[];
  if (params.projectId) {
    const project = await accessibleProject(user, params.projectId);
    userIds = [...project.members, ...(project.manager ? [project.manager] : [])];
  } else if (params.managerId) {
    if (params.managerId !== user.id && !user.permissions.has("analytics:company")) {
      throw forbidden("You can only view your own team's workload.");
    }
    userIds = await teamMemberIds(new Types.ObjectId(params.managerId));
  } else if (params.departmentId) {
    userIds = (await User.find({ department: params.departmentId, status: "ACTIVE" }).distinct("_id")) as Types.ObjectId[];
  } else if (user.permissions.has("analytics:company")) {
    userIds = (await User.find({ status: "ACTIVE", role: { $ne: "ADMIN" } }).distinct("_id")) as Types.ObjectId[];
  } else {
    // Without company scope: people on the projects this user can see.
    const ids = (await accessibleProjectIds(user)) ?? [];
    const projects = await Project.find({ _id: { $in: ids } }).select("members manager").lean();
    const set = new Map<string, Types.ObjectId>();
    for (const p of projects) for (const m of [...p.members, ...(p.manager ? [p.manager] : [])]) set.set(String(m), m);
    userIds = [...set.values()];
  }
  return workloadFor(userIds.slice(0, 500));
}

import type { Types } from "mongoose";
import { Task, User } from "../models";
import { DONE_STATUSES } from "../types/domain";

export interface WorkloadEntry {
  userId: string;
  name: string;
  avatarUrl: string | null;
  departmentName: string | null;
  assigned: number;
  estimatedHours: number;
  completed: number;
  inReview: number;
  blocked: number;
  overdue: number;
}

/**
 * Factual workload per person from a single aggregation over their tasks.
 * "assigned" and "estimatedHours" count open work only. Deliberately no score.
 */
export async function workloadFor(userIds: Types.ObjectId[], taskFilter: Record<string, unknown> = {}): Promise<WorkloadEntry[]> {
  if (userIds.length === 0) return [];
  const now = new Date();
  const done = [...DONE_STATUSES];

  const [rows, users] = await Promise.all([
    Task.aggregate<{
      _id: Types.ObjectId;
      assigned: number;
      estimatedHours: number;
      completed: number;
      inReview: number;
      blocked: number;
      overdue: number;
    }>([
      { $match: { ...taskFilter, assignee: { $in: userIds } } },
      {
        $group: {
          _id: "$assignee",
          assigned: { $sum: { $cond: [{ $in: ["$status", done] }, 0, 1] } },
          estimatedHours: { $sum: { $cond: [{ $in: ["$status", done] }, 0, { $ifNull: ["$estimatedHours", 0] }] } },
          completed: { $sum: { $cond: [{ $in: ["$status", done] }, 1, 0] } },
          inReview: { $sum: { $cond: [{ $eq: ["$status", "IN_REVIEW"] }, 1, 0] } },
          blocked: { $sum: { $cond: [{ $eq: ["$status", "BLOCKED"] }, 1, 0] } },
          overdue: {
            $sum: {
              $cond: [{ $and: [{ $not: [{ $in: ["$status", done] }] }, { $ne: ["$dueDate", null] }, { $lt: ["$dueDate", now] }] }, 1, 0],
            },
          },
        },
      },
    ]),
    User.find({ _id: { $in: userIds } })
      .select("firstName lastName profileImage department")
      .populate("department", "name")
      .lean(),
  ]);

  const byUser = new Map(rows.map((r) => [String(r._id), r]));
  return users
    .map((u) => {
      const r = byUser.get(String(u._id));
      const dept = u.department as unknown as { name?: string } | null;
      return {
        userId: String(u._id),
        name: `${u.firstName} ${u.lastName ?? ""}`.trim(),
        avatarUrl: u.profileImage ?? null,
        departmentName: dept?.name ?? null,
        assigned: r?.assigned ?? 0,
        estimatedHours: Math.round((r?.estimatedHours ?? 0) * 10) / 10,
        completed: r?.completed ?? 0,
        inReview: r?.inReview ?? 0,
        blocked: r?.blocked ?? 0,
        overdue: r?.overdue ?? 0,
      };
    })
    .sort((a, b) => b.assigned - a.assigned || a.name.localeCompare(b.name));
}

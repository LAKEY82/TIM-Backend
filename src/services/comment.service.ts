import { Types } from "mongoose";
import { Comment, User } from "../models";
import type { AuthUser } from "../types/express";
import { forbidden, notFound } from "../utils/errors";
import { accessibleTask, canManageTask } from "./access.service";
import { logActivity } from "./activity.service";
import { notify } from "./notification.service";

const USER_SUMMARY = "firstName lastName email profileImage role jobTitle";
const POPULATE = [
  { path: "author", select: USER_SUMMARY },
  { path: "mentions", select: USER_SUMMARY },
];

/** Keeps only mentions of real, active users (never trust client-sent ids). */
async function validMentions(ids: string[]): Promise<Types.ObjectId[]> {
  const unique = [...new Set(ids)];
  if (!unique.length) return [];
  const found = await User.find({ _id: { $in: unique }, status: "ACTIVE" }).distinct("_id");
  return found as Types.ObjectId[];
}

export async function listTaskComments(actor: AuthUser, taskId: string) {
  const task = await accessibleTask(actor, taskId);
  return Comment.find({ entityType: "TASK", entityId: task._id }).populate(POPULATE).sort({ createdAt: 1 }).limit(500).lean();
}

export async function addTaskComment(actor: AuthUser, taskId: string, body: string, mentionIds: string[]) {
  const task = await accessibleTask(actor, taskId);
  const mentions = await validMentions(mentionIds);
  const comment = await Comment.create({ entityType: "TASK", entityId: task._id, author: actor._id, body, mentions });

  void logActivity({ actor: actor._id, type: "COMMENT_CREATED", verb: "commented on", entityType: "TASK", entityId: task._id, entityName: task.title, project: task.project, department: task.department ?? null });
  void notify({
    recipients: mentions,
    actor: actor._id,
    type: "MENTION",
    title: `${actor.name} mentioned you on ${task.title}`,
    body: body.slice(0, 200),
    entityType: "TASK",
    entityId: task._id,
  });
  return Comment.findById(comment._id).populate(POPULATE).lean();
}

async function ownComment(actor: AuthUser, taskId: string, commentId: string) {
  const task = await accessibleTask(actor, taskId);
  if (!Types.ObjectId.isValid(commentId)) throw notFound("Comment");
  const comment = await Comment.findOne({ _id: commentId, entityType: "TASK", entityId: task._id });
  if (!comment) throw notFound("Comment");
  return { task, comment };
}

export async function editTaskComment(actor: AuthUser, taskId: string, commentId: string, body: string, mentionIds: string[]) {
  const { task, comment } = await ownComment(actor, taskId, commentId);
  if (String(comment.author) !== actor.id) throw forbidden("You can only edit your own comments.");
  const before = new Set(comment.mentions.map(String));
  comment.body = body;
  comment.mentions = await validMentions(mentionIds);
  comment.editedAt = new Date();
  await comment.save();

  const newlyMentioned = comment.mentions.filter((m) => !before.has(String(m)));
  void notify({
    recipients: newlyMentioned,
    actor: actor._id,
    type: "MENTION",
    title: `${actor.name} mentioned you on ${task.title}`,
    body: body.slice(0, 200),
    entityType: "TASK",
    entityId: task._id,
  });
  return Comment.findById(comment._id).populate(POPULATE).lean();
}

export async function deleteTaskComment(actor: AuthUser, taskId: string, commentId: string) {
  const { task, comment } = await ownComment(actor, taskId, commentId);
  const isAuthor = String(comment.author) === actor.id;
  if (!isAuthor && !(await canManageTask(actor, task))) throw forbidden("You can only delete your own comments.");
  await comment.deleteOne();
}

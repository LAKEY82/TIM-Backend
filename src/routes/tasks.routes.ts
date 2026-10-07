import { Router } from "express";
import { currentUser } from "../middleware/auth.middleware";
import { requirePermission } from "../middleware/permission.middleware";
import { requireStorage, singleFile } from "../middleware/upload.middleware";
import { parseBody, parseQuery, routeParam, validateObjectIds } from "../middleware/validation.middleware";
import { FileModel } from "../models";
import { accessibleTask, canManageTask } from "../services/access.service";
import * as comments from "../services/comment.service";
import { deleteFile, saveUpload } from "../services/file.service";
import * as tasks from "../services/task.service";
import { forbidden, notFound } from "../utils/errors";
import { created, noContent, ok, paginated } from "../utils/http";
import { serializeComment, serializeReview } from "../utils/serialize";
import {
  approveSchema,
  commentSchema,
  createTaskSchema,
  listTasksQuery,
  myDayQuery,
  qaCompleteSchema,
  qaFailSchema,
  qaPassSchema,
  requestChangesSchema,
  statusSchema,
  submitSchema,
  updateTaskSchema,
} from "../validators/tasks.validators";

export const tasksRouter = Router();
for (const name of ["id", "commentId", "attachmentId"]) {
  tasksRouter.param(name, (req, res, next) => validateObjectIds(name)(req, res, next));
}

const id = (req: Parameters<typeof routeParam>[0]) => routeParam(req, "id");
const todayUtc = () => new Date().toISOString().slice(0, 10);

tasksRouter.get("/", async (req, res) => {
  const q = parseQuery(listTasksQuery, req);
  const { items, total } = await tasks.listTasks(currentUser(req), q);
  paginated(res, items, { page: q.page, pageSize: q.pageSize, total });
});

// Must be registered before "/:id".
tasksRouter.get("/my-day", async (req, res) => {
  const { date } = parseQuery(myDayQuery, req);
  ok(res, await tasks.myDay(currentUser(req), date ?? todayUtc()));
});

tasksRouter.post("/", requirePermission("tasks:create"), async (req, res) => {
  created(res, await tasks.createTask(currentUser(req), parseBody(createTaskSchema, req)), "Task created.");
});

tasksRouter.get("/:id", async (req, res) => {
  await accessibleTask(currentUser(req), id(req));
  ok(res, await tasks.getTaskDetail(id(req)));
});

tasksRouter.patch("/:id", async (req, res) => {
  ok(res, await tasks.updateTask(currentUser(req), id(req), parseBody(updateTaskSchema, req)), "Task updated.");
});

tasksRouter.delete("/:id", async (req, res) => {
  await tasks.deleteTask(currentUser(req), id(req));
  noContent(res);
});

// --- workflow ----------------------------------------------------------------

tasksRouter.patch("/:id/status", async (req, res) => {
  const { status } = parseBody(statusSchema, req);
  ok(res, await tasks.changeStatus(currentUser(req), id(req), status));
});

tasksRouter.post("/:id/submit", async (req, res) => {
  const { note } = parseBody(submitSchema, req);
  ok(res, await tasks.submitForReview(currentUser(req), id(req), note), "Task submitted for review.");
});

tasksRouter.post("/:id/approve", async (req, res) => {
  const { feedback } = parseBody(approveSchema, req);
  ok(res, await tasks.approve(currentUser(req), id(req), feedback), "Task approved.");
});

tasksRouter.post("/:id/request-changes", async (req, res) => {
  const { feedback } = parseBody(requestChangesSchema, req);
  ok(res, await tasks.requestChanges(currentUser(req), id(req), feedback), "Changes requested.");
});

// --- QA ------------------------------------------------------------------------

tasksRouter.post("/:id/qa/pass", async (req, res) => {
  const { note } = parseBody(qaPassSchema, req);
  ok(res, await tasks.qaPass(currentUser(req), id(req), note), "Task passed QA.");
});

// Log issues while testing: the task stays in QA.
tasksRouter.post("/:id/qa/issues", async (req, res) => {
  const { bugs } = parseBody(qaFailSchema, req);
  const result = await tasks.qaReport(currentUser(req), id(req), bugs);
  ok(res, { ...result.task, bugIds: result.bugIds }, `${bugs.length} issue${bugs.length === 1 ? "" : "s"} logged.`);
});

// Done testing: open issues go back to the developer together; with none, it passes.
tasksRouter.post("/:id/qa/complete", async (req, res) => {
  const { note } = parseBody(qaCompleteSchema, req);
  const result = await tasks.qaComplete(currentUser(req), id(req), note);
  ok(res, { ...result.task, openIssues: result.issues }, result.issues ? `QA complete: ${result.issues} issue${result.issues === 1 ? "" : "s"} sent to the developer.` : "QA complete: passed.");
});

tasksRouter.post("/:id/qa/fail", async (req, res) => {
  const { bugs, note } = parseBody(qaFailSchema, req);
  const result = await tasks.qaFail(currentUser(req), id(req), bugs, note);
  ok(res, { ...result.task, bugIds: result.bugIds }, `${bugs.length} issue${bugs.length === 1 ? "" : "s"} reported.`);
});

tasksRouter.get("/:id/reviews", async (req, res) => {
  const history = await tasks.reviewHistory(currentUser(req), id(req));
  ok(res, history.map(serializeReview));
});

// --- comments ------------------------------------------------------------------

tasksRouter.get("/:id/comments", async (req, res) => {
  const list = await comments.listTaskComments(currentUser(req), id(req));
  ok(res, list.map(serializeComment));
});

tasksRouter.post("/:id/comments", async (req, res) => {
  const { body, mentionIds } = parseBody(commentSchema, req);
  const comment = await comments.addTaskComment(currentUser(req), id(req), body, mentionIds);
  created(res, serializeComment(comment!), "Comment added.");
});

tasksRouter.patch("/:id/comments/:commentId", async (req, res) => {
  const { body, mentionIds } = parseBody(commentSchema, req);
  const comment = await comments.editTaskComment(currentUser(req), id(req), routeParam(req, "commentId"), body, mentionIds);
  ok(res, serializeComment(comment!), "Comment updated.");
});

tasksRouter.delete("/:id/comments/:commentId", async (req, res) => {
  await comments.deleteTaskComment(currentUser(req), id(req), routeParam(req, "commentId"));
  noContent(res);
});

// --- attachments ---------------------------------------------------------------

tasksRouter.post("/:id/attachments", requireStorage, async (req, res, next) => {
  // Check access before accepting the upload body.
  await accessibleTask(currentUser(req), id(req));
  next();
}, singleFile, async (req, res) => {
  const task = await accessibleTask(currentUser(req), id(req));
  created(res, await saveUpload(currentUser(req), "TASK", task._id, req.file), "File uploaded.");
});

tasksRouter.delete("/:id/attachments/:attachmentId", async (req, res) => {
  const user = currentUser(req);
  const task = await accessibleTask(user, id(req));
  const file = await FileModel.findOne({ _id: routeParam(req, "attachmentId"), entityType: "TASK", entityId: task._id }).lean();
  if (!file) throw notFound("Attachment");
  if (String(file.uploadedBy) !== user.id && !(await canManageTask(user, task))) throw forbidden("You can only remove files you uploaded.");
  await deleteFile(String(file._id));
  noContent(res);
});

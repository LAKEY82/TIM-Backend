import { Router } from "express";
import { z } from "zod";
import { currentUser } from "../middleware/auth.middleware";
import { parseQuery, routeParam, validateObjectIds } from "../middleware/validation.middleware";
import { Notification } from "../models";
import { notFound } from "../utils/errors";
import { noContent, ok, paginated } from "../utils/http";
import { serializeNotification } from "../utils/serialize";
import { paginationQuery, queryBool } from "../validators/common";

const listQuery = z.object({ unreadOnly: queryBool }).and(paginationQuery(100));

export const notificationsRouter = Router();
notificationsRouter.param("id", (req, res, next) => validateObjectIds("id")(req, res, next));

// Every route is scoped to the caller's own inbox.
notificationsRouter.get("/", async (req, res) => {
  const user = currentUser(req);
  const q = parseQuery(listQuery, req);
  const filter = { recipient: user._id, ...(q.unreadOnly ? { readAt: null } : {}) };
  const [items, total] = await Promise.all([
    Notification.find(filter)
      .populate("actor", "firstName lastName email profileImage role jobTitle")
      .sort({ createdAt: -1 })
      .skip(q.skip)
      .limit(q.pageSize)
      .lean(),
    Notification.countDocuments(filter),
  ]);
  paginated(res, items.map(serializeNotification), { page: q.page, pageSize: q.pageSize, total });
});

notificationsRouter.get("/unread-count", async (req, res) => {
  ok(res, { count: await Notification.countDocuments({ recipient: currentUser(req)._id, readAt: null }) });
});

notificationsRouter.patch("/read-all", async (req, res) => {
  await Notification.updateMany({ recipient: currentUser(req)._id, readAt: null }, { readAt: new Date() });
  noContent(res);
});

notificationsRouter.patch("/:id/read", async (req, res) => {
  const filter = { _id: routeParam(req, "id"), recipient: currentUser(req)._id };
  // Keep the original read time if it was already read (idempotent).
  const result = await Notification.updateOne({ ...filter, readAt: null }, { readAt: new Date() });
  if (result.matchedCount === 0 && !(await Notification.exists(filter))) throw notFound("Notification");
  noContent(res);
});

notificationsRouter.delete("/:id", async (req, res) => {
  const result = await Notification.deleteOne({ _id: routeParam(req, "id"), recipient: currentUser(req)._id });
  if (result.deletedCount === 0) throw notFound("Notification");
  noContent(res);
});

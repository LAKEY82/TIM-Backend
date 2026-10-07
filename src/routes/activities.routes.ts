import { Router } from "express";
import { Types, type QueryFilter } from "mongoose";
import { z } from "zod";
import { currentUser } from "../middleware/auth.middleware";
import { parseQuery } from "../middleware/validation.middleware";
import { Activity, type IActivity } from "../models";
import { accessibleProject, accessibleProjectIds, accessibleTask } from "../services/access.service";
import { ENTITY_TYPES } from "../types/domain";
import { ok } from "../utils/http";
import { serializeActivity } from "../utils/serialize";
import { objectId } from "../validators/common";

const listQuery = z.object({
  entityType: z.enum(ENTITY_TYPES).optional(),
  entityId: objectId.optional(),
  projectId: objectId.optional(),
  userId: objectId.optional(),
  departmentId: objectId.optional(),
  clientId: objectId.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  page: z.coerce.number().int().min(1).max(1000).default(1),
});

export const activitiesRouter = Router();

/**
 * The audit trail is read-only over HTTP. Users without company-wide access
 * only see activity in projects they can access, or their own actions.
 */
activitiesRouter.get("/", async (req, res) => {
  const user = currentUser(req);
  const q = parseQuery(listQuery, req);
  const oid = (id: string) => new Types.ObjectId(id);

  const filter: QueryFilter<IActivity> = {};
  if (q.entityId) {
    filter.entityId = oid(q.entityId);
    if (q.entityType) filter.entityType = q.entityType;
    // Entity history: authorize against the entity itself.
    if (q.entityType === "TASK") await accessibleTask(user, q.entityId);
    if (q.entityType === "PROJECT") await accessibleProject(user, q.entityId);
  }
  if (q.projectId) {
    await accessibleProject(user, q.projectId);
    filter.project = oid(q.projectId);
  }
  if (q.userId) filter.$or = [{ actor: oid(q.userId) }, { entityType: "USER", entityId: oid(q.userId) }, { "target.id": oid(q.userId) }];
  if (q.departmentId) filter.department = oid(q.departmentId);
  if (q.clientId) filter.client = oid(q.clientId);

  const and: QueryFilter<IActivity>[] = [filter];
  const entityAuthorized = Boolean(q.entityId && (q.entityType === "TASK" || q.entityType === "PROJECT"));
  if (!entityAuthorized && !q.projectId && !user.permissions.has("projects:read_all")) {
    const ids = (await accessibleProjectIds(user)) ?? [];
    and.push({ $or: [{ project: { $in: ids } }, { actor: user._id }] });
  }

  const items = await Activity.find({ $and: and })
    .populate("actor", "firstName lastName email profileImage role jobTitle")
    .sort({ createdAt: -1 })
    .skip((q.page - 1) * q.limit)
    .limit(q.limit)
    .lean();
  ok(res, items.map(serializeActivity));
});

import { Router } from "express";
import { z } from "zod";
import { currentUser } from "../middleware/auth.middleware";
import { requireAnyPermission, requirePermission } from "../middleware/permission.middleware";
import { parseQuery, routeParam, validateObjectIds } from "../middleware/validation.middleware";
import * as analytics from "../services/analytics.service";
import { ok } from "../utils/http";
import { dayString, objectId } from "../validators/common";

const rangeQuery = z
  .object({ from: dayString.optional(), to: dayString.optional() })
  .refine((r) => !r.from || !r.to || r.from <= r.to, { path: ["to"], message: "`to` must be on or after `from`." })
  .refine((r) => !r.from || !r.to || new Date(r.to).getTime() - new Date(r.from).getTime() <= 400 * 864e5, {
    path: ["from"],
    message: "The range can be at most about 13 months.",
  });

const workloadQuery = z.object({ departmentId: objectId.optional(), projectId: objectId.optional(), managerId: objectId.optional() });

export const analyticsRouter = Router();
analyticsRouter.param("id", (req, res, next) => validateObjectIds("id")(req, res, next));

analyticsRouter.get("/company", requirePermission("analytics:company"), async (req, res) => {
  const q = parseQuery(rangeQuery, req);
  ok(res, await analytics.companyAnalytics(analytics.resolveRange(q.from, q.to)));
});

// Anyone on a project can see its analytics tab; access is checked in the service.
analyticsRouter.get("/projects/:id", async (req, res) => {
  ok(res, await analytics.projectAnalytics(currentUser(req), routeParam(req, "id")));
});

analyticsRouter.get("/departments/:id", requireAnyPermission("analytics:read", "teams:read"), async (req, res) => {
  const q = parseQuery(rangeQuery, req);
  ok(res, await analytics.departmentAnalytics(currentUser(req), routeParam(req, "id"), analytics.resolveRange(q.from, q.to)));
});

analyticsRouter.get("/tasks", requirePermission("analytics:read"), async (req, res) => {
  const q = parseQuery(rangeQuery, req);
  ok(res, await analytics.taskAnalytics(currentUser(req), analytics.resolveRange(q.from, q.to)));
});

analyticsRouter.get("/workload", requireAnyPermission("analytics:read", "teams:read"), async (req, res) => {
  ok(res, await analytics.workloadAnalytics(currentUser(req), parseQuery(workloadQuery, req)));
});

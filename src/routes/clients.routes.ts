import { Router } from "express";
import { type Types, type QueryFilter } from "mongoose";
import { z } from "zod";
import { currentUser } from "../middleware/auth.middleware";
import { requirePermission } from "../middleware/permission.middleware";
import { parseBody, parseQuery, routeParam, validateObjectIds } from "../middleware/validation.middleware";
import { Client, Project, type IClient } from "../models";
import { projectScopeFilter } from "../services/access.service";
import { logActivity } from "../services/activity.service";
import { PROJECT_POPULATE } from "../services/project.service";
import { CLIENT_STATUSES } from "../types/domain";
import { conflict, notFound } from "../utils/errors";
import { created, noContent, ok, paginated } from "../utils/http";
import { serializeClient, serializeProject, serializeRetainer } from "../utils/serialize";
import { dateInput, optionalText, paginationQuery, searchRegex } from "../validators/common";

const listQuery = z.object({ search: z.string().max(100).optional(), status: z.enum(CLIENT_STATUSES).optional() }).and(paginationQuery(200));

const retainerInput = z.object({
  name: z.string().trim().min(1).max(120),
  status: z.string().trim().max(40).default("ACTIVE"),
  startDate: dateInput,
  endDate: dateInput,
  hoursPerMonth: z.number().min(0).max(10000).nullable().optional(),
});

const clientInput = z.object({
  name: z.string().trim().min(2, "Name must be at least 2 characters.").max(150),
  contactName: optionalText(150),
  email: z.union([z.email("Enter a valid email."), z.literal(""), z.null()]).optional().transform((v) => (v ? v.toLowerCase() : v === undefined ? undefined : null)),
  phone: optionalText(40),
  website: z.union([z.url("Enter a full URL, e.g. https://example.com"), z.literal(""), z.null()]).optional().transform((v) => (v === "" ? null : v)),
  industry: optionalText(100),
  notes: optionalText(5000),
  status: z.enum(CLIENT_STATUSES).optional(),
  retainers: z.array(retainerInput).max(50).optional(),
});

async function projectCounts(ids: Types.ObjectId[]) {
  const rows = await Project.aggregate<{ _id: Types.ObjectId; total: number; active: number }>([
    { $match: { client: { $in: ids } } },
    { $group: { _id: "$client", total: { $sum: 1 }, active: { $sum: { $cond: [{ $eq: ["$status", "ACTIVE"] }, 1, 0] } } } },
  ]);
  const map = new Map(rows.map((r) => [String(r._id), r]));
  return (id: Types.ObjectId) => ({ projectCount: map.get(String(id))?.total ?? 0, activeProjectCount: map.get(String(id))?.active ?? 0 });
}

export const clientsRouter = Router();
clientsRouter.param("id", (req, res, next) => validateObjectIds("id")(req, res, next));

clientsRouter.get("/", requirePermission("clients:read"), async (req, res) => {
  const q = parseQuery(listQuery, req);
  const filter: QueryFilter<IClient> = {};
  const re = searchRegex(q.search);
  if (re) filter.$or = [{ name: re }, { contactName: re }, { email: re }];
  if (q.status) filter.status = q.status;
  const [items, total] = await Promise.all([
    Client.find(filter).select("-retainers").collation({ locale: "en" }).sort({ name: 1 }).skip(q.skip).limit(q.pageSize).lean(),
    Client.countDocuments(filter),
  ]);
  const counts = await projectCounts(items.map((c) => c._id));
  paginated(res, items.map((c) => serializeClient(c, counts(c._id))), { page: q.page, pageSize: q.pageSize, total });
});

clientsRouter.get("/:id", requirePermission("clients:read"), async (req, res) => {
  const client = await Client.findById(routeParam(req, "id")).lean();
  if (!client) throw notFound("Client");
  // Only projects the caller may see are listed.
  const scope = await projectScopeFilter(currentUser(req));
  const [projects, counts] = await Promise.all([
    Project.find({ ...scope, client: client._id }).populate(PROJECT_POPULATE).sort({ createdAt: -1 }).limit(200).lean(),
    projectCounts([client._id]),
  ]);
  ok(res, {
    ...serializeClient(client, counts(client._id)),
    projects: projects.map(serializeProject),
    retainers: client.retainers.map(serializeRetainer),
  });
});

clientsRouter.post("/", requirePermission("clients:manage"), async (req, res) => {
  const input = parseBody(clientInput, req);
  const client = await Client.create(input);
  void logActivity({ actor: currentUser(req)._id, type: "CLIENT_CREATED", verb: "added client", entityType: "CLIENT", entityId: client._id, entityName: client.name, client: client._id });
  created(res, serializeClient(client.toObject()), "Client created.");
});

clientsRouter.patch("/:id", requirePermission("clients:manage"), async (req, res) => {
  const input = parseBody(clientInput.partial(), req);
  const client = await Client.findById(routeParam(req, "id"));
  if (!client) throw notFound("Client");
  client.set(Object.fromEntries(Object.entries(input).filter(([, v]) => v !== undefined)));
  await client.save();
  const counts = await projectCounts([client._id]);
  ok(res, serializeClient(client.toObject(), counts(client._id)), "Client updated.");
});

clientsRouter.delete("/:id", requirePermission("clients:manage"), async (req, res) => {
  const client = await Client.findById(routeParam(req, "id"));
  if (!client) throw notFound("Client");
  if (await Project.exists({ client: client._id })) throw conflict("This client still has projects. Mark it inactive instead.");
  await client.deleteOne();
  noContent(res);
});

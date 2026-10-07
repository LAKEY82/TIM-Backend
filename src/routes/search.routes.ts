import { Router } from "express";
import { z } from "zod";
import { currentUser } from "../middleware/auth.middleware";
import { parseQuery } from "../middleware/validation.middleware";
import { Client, Project, Task, User } from "../models";
import { projectScopeFilter, taskScopeFilter } from "../services/access.service";
import { userSearchFilter } from "../services/user.service";
import { ok } from "../utils/http";
import { searchRegex } from "../validators/common";

const LIMIT = 5;
const query = z.object({ q: z.string().trim().min(2, "Type at least 2 characters.").max(100) });

export const searchRouter = Router();

/** Global search (Ctrl/Cmd+K). Results respect the caller's project/task scope. */
searchRouter.get("/", async (req, res) => {
  const user = currentUser(req);
  const { q } = parseQuery(query, req);
  const re = searchRegex(q)!;

  const [projects, tasks, people, clients] = await Promise.all([
    projectScopeFilter(user).then((scope) =>
      Project.find({ ...scope, name: re }).select("name status client").populate("client", "name").sort({ updatedAt: -1 }).limit(LIMIT).lean(),
    ),
    taskScopeFilter(user).then((scope) =>
      Task.find({ $and: [scope, { title: re }] }).select("title status project").populate("project", "name").sort({ updatedAt: -1 }).limit(LIMIT).lean(),
    ),
    User.find({ ...userSearchFilter(q), status: "ACTIVE" })
      .select("firstName lastName role department profileImage")
      .populate("department", "name")
      .limit(LIMIT)
      .lean(),
    user.permissions.has("clients:read") ? Client.find({ name: re }).select("name").limit(LIMIT).lean() : Promise.resolve([]),
  ]);

  const name = (v: unknown) => (v && typeof v === "object" && "name" in v ? String((v as { name: unknown }).name) : null);
  ok(res, {
    projects: projects.map((p) => ({ id: String(p._id), name: p.name, status: p.status, clientName: name(p.client) })),
    tasks: tasks.map((t) => ({ id: String(t._id), title: t.title, status: t.status, projectName: name(t.project) })),
    people: people.map((u) => ({
      id: String(u._id),
      name: `${u.firstName} ${u.lastName ?? ""}`.trim(),
      role: u.role,
      departmentName: name(u.department),
      avatarUrl: u.profileImage ?? null,
    })),
    clients: clients.map((c) => ({ id: String(c._id), name: c.name })),
  });
});

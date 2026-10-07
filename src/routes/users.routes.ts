import { Router } from "express";
import { Types } from "mongoose";
import { currentUser } from "../middleware/auth.middleware";
import { requirePermission } from "../middleware/permission.middleware";
import { parseBody, parseQuery, validateObjectIds } from "../middleware/validation.middleware";
import * as users from "../services/user.service";
import { workloadFor } from "../services/workload.service";
import { forbidden, notFound } from "../utils/errors";
import { created, ok, paginated } from "../utils/http";
import { serializeUser } from "../utils/serialize";
import { createUserSchema, listUsersQuery, updateUserSchema } from "../validators/users.validators";

export const usersRouter = Router();
usersRouter.param("id", (req, _res, next) => validateObjectIds("id")(req, _res, next));

// Any signed-in user may list people: assignee pickers and @mentions need it.
usersRouter.get("/", async (req, res) => {
  const q = parseQuery(listUsersQuery, req);
  const { items, total } = await users.listUsers(q);
  paginated(res, items.map((u) => serializeUser(u)), { page: q.page, pageSize: q.pageSize, total });
});

usersRouter.post("/", requirePermission("users:manage"), async (req, res) => {
  const user = await users.createUser(currentUser(req), parseBody(createUserSchema, req));
  created(res, serializeUser(user), "User created.");
});

usersRouter.get("/:id", async (req, res) => {
  ok(res, serializeUser(await users.getUser(req.params.id)));
});

usersRouter.patch("/:id", async (req, res) => {
  const user = await users.updateUser(currentUser(req), req.params.id, parseBody(updateUserSchema, req));
  ok(res, serializeUser(user), "User updated.");
});

usersRouter.get("/:id/workload", async (req, res) => {
  const me = currentUser(req);
  const self = me.id === req.params.id;
  if (!self && !me.permissions.has("teams:read") && !me.permissions.has("analytics:read")) throw forbidden();
  const [entry] = await workloadFor([new Types.ObjectId(req.params.id)]);
  if (!entry) throw notFound("User");
  ok(res, entry);
});

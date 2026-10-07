import { Router } from "express";
import type { IProject } from "../models";
import { currentUser } from "../middleware/auth.middleware";
import { requirePermission, requireProjectAccess } from "../middleware/permission.middleware";
import { requireStorage, singleFile } from "../middleware/upload.middleware";
import { parseBody, parseQuery, routeParam, validateObjectIds } from "../middleware/validation.middleware";
import { listFiles, saveUpload } from "../services/file.service";
import * as projects from "../services/project.service";
import { workflowStages } from "../services/task.service";
import { created, noContent, ok, paginated } from "../utils/http";
import { serializeProject, userSummary } from "../utils/serialize";
import { addMemberSchema, createProjectSchema, listProjectsQuery, setupWorkflowSchema, updateProjectSchema } from "../validators/projects.validators";
import type { Types } from "mongoose";

type LeanProject = IProject & { _id: Types.ObjectId };

export const projectsRouter = Router();
projectsRouter.param("id", (req, res, next) => validateObjectIds("id")(req, res, next));
projectsRouter.param("userId", (req, res, next) => validateObjectIds("userId")(req, res, next));

projectsRouter.get("/", async (req, res) => {
  const q = parseQuery(listProjectsQuery, req);
  const { items, total } = await projects.listProjects(currentUser(req), q);
  paginated(res, items.map(serializeProject), { page: q.page, pageSize: q.pageSize, total });
});

projectsRouter.post("/", requirePermission("projects:create"), async (req, res) => {
  const project = await projects.createProject(currentUser(req), parseBody(createProjectSchema, req));
  created(res, serializeProject(project), "Project created.");
});

projectsRouter.get("/:id", requireProjectAccess("read"), async (req, res) => {
  ok(res, serializeProject(await projects.getProject(routeParam(req, "id"))));
});

projectsRouter.patch("/:id", requireProjectAccess("manage"), async (req, res) => {
  const project = await projects.updateProject(currentUser(req), routeParam(req, "id"), parseBody(updateProjectSchema, req));
  ok(res, serializeProject(project), "Project updated.");
});

projectsRouter.delete("/:id", requirePermission("projects:delete"), requireProjectAccess("read"), async (req, res) => {
  await projects.deleteProject(currentUser(req), routeParam(req, "id"));
  noContent(res);
});

// --- workflow --------------------------------------------------------------

projectsRouter.get("/:id/workflow", requireProjectAccess("read"), async (req, res) => {
  ok(res, await workflowStages(routeParam(req, "id")));
});

projectsRouter.post("/:id/workflow", requireProjectAccess("manage"), async (req, res) => {
  await projects.setupWorkflow(currentUser(req), routeParam(req, "id"), parseBody(setupWorkflowSchema, req));
  created(res, await workflowStages(routeParam(req, "id")), "Workflow created.");
});

// --- members ---------------------------------------------------------------

projectsRouter.get("/:id/members", requireProjectAccess("read"), async (req, res) => {
  const project = await projects.getProject(routeParam(req, "id"));
  const members = [...(project.manager ? [project.manager] : []), ...project.members];
  const unique = new Map(members.map((m) => [String((m as { _id: unknown })._id), m]));
  ok(res, [...unique.values()].map(userSummary).filter(Boolean));
});

projectsRouter.post("/:id/members", requireProjectAccess("manage"), async (req, res) => {
  const { userId } = parseBody(addMemberSchema, req);
  await projects.addMember(currentUser(req), routeParam(req, "id"), userId);
  created(res, null, "Member added.");
});

projectsRouter.delete("/:id/members/:userId", requireProjectAccess("manage"), async (req, res) => {
  await projects.removeMember(currentUser(req), routeParam(req, "id"), routeParam(req, "userId"));
  noContent(res);
});

// --- files -------------------------------------------------------------------

projectsRouter.get("/:id/files", requireProjectAccess("read"), async (_req, res) => {
  const project = res.locals.project as LeanProject;
  ok(res, await listFiles("PROJECT", project._id));
});

projectsRouter.post("/:id/files", requireProjectAccess("read"), requireStorage, singleFile, async (req, res) => {
  const project = res.locals.project as LeanProject;
  created(res, await saveUpload(currentUser(req), "PROJECT", project._id, req.file), "File uploaded.");
});

import { Router } from "express";
import { z } from "zod";
import { ProjectLink, type IProject } from "../models";
import { currentUser } from "../middleware/auth.middleware";
import { requirePermission, requireProjectAccess } from "../middleware/permission.middleware";
import { requireStorage, singleFile } from "../middleware/upload.middleware";
import { parseBody, parseQuery, routeParam, validateObjectIds } from "../middleware/validation.middleware";
import { canManageProject } from "../services/access.service";
import { listFiles, saveUpload } from "../services/file.service";
import * as projects from "../services/project.service";
import { workflowStages } from "../services/task.service";
import { forbidden, notFound } from "../utils/errors";
import { created, noContent, ok, paginated } from "../utils/http";
import { serializeProject, serializeProjectLink, userSummary } from "../utils/serialize";
import { addMemberSchema, createProjectSchema, listProjectsQuery, setupWorkflowSchema, updateProjectSchema } from "../validators/projects.validators";
import type { Types } from "mongoose";
import type { ProjectLinkKind } from "../types/domain";

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

// --- links ---------------------------------------------------------------------
// Designs (Figma), code (GitHub) and anything else the team needs to hand.

const linkUrl = z
  .string()
  .trim()
  .max(2000)
  .refine((v) => /^https?:\/\//i.test(v) && URL.canParse(v), "Enter the full link, e.g. https://www.figma.com/design/…");
const linkInput = z.object({ title: z.string().trim().max(200).optional(), url: linkUrl });

const hostOf = (url: string) => new URL(url).hostname.toLowerCase().replace(/^www\./, "");

/** Figma and GitHub links get their own kind (and logo); everything else is Other. */
export function linkKind(url: string): ProjectLinkKind {
  const host = hostOf(url);
  if (host === "figma.com" || host.endsWith(".figma.com")) return "FIGMA";
  if (host === "github.com" || host.endsWith(".github.com")) return "GITHUB";
  return "OTHER";
}

/** A sensible title when none is given: "owner/repo" for GitHub, the file name for Figma, else the site. */
function defaultTitle(url: string, kind: ProjectLinkKind) {
  const parts = new URL(url).pathname.split("/").filter(Boolean);
  if (kind === "GITHUB" && parts.length >= 2) return `${parts[0]}/${parts[1]}`;
  if (kind === "FIGMA" && parts.length >= 3) return decodeURIComponent(parts[2]!).replace(/-/g, " ");
  return hostOf(url);
}

const LINK_POPULATE = { path: "addedBy", select: "firstName lastName email profileImage role jobTitle" };

projectsRouter.get("/:id/links", requireProjectAccess("read"), async (_req, res) => {
  const project = res.locals.project as LeanProject;
  const links = await ProjectLink.find({ project: project._id }).populate(LINK_POPULATE).sort({ createdAt: 1, _id: 1 }).lean();
  ok(res, links.map(serializeProjectLink));
});

// Anyone on the project can add a link.
projectsRouter.post("/:id/links", requireProjectAccess("read"), async (req, res) => {
  const project = res.locals.project as LeanProject;
  const { title, url } = parseBody(linkInput, req);
  const kind = linkKind(url);
  const link = await ProjectLink.create({ project: project._id, url, kind, title: title || defaultTitle(url, kind), addedBy: currentUser(req)._id });
  created(res, serializeProjectLink((await link.populate(LINK_POPULATE)).toObject()), "Link added.");
});

/** The person who added a link, or whoever manages the project, can change or remove it. */
async function editableLink(req: Parameters<Parameters<typeof projectsRouter.patch>[1]>[0], project: LeanProject) {
  const link = await ProjectLink.findOne({ _id: routeParam(req, "linkId"), project: project._id });
  if (!link) throw notFound("Link");
  const user = currentUser(req);
  if (String(link.addedBy) !== String(user._id) && !canManageProject(user, project)) throw forbidden("Only whoever added this link or the project manager can change it.");
  return link;
}

projectsRouter.patch("/:id/links/:linkId", requireProjectAccess("read"), validateObjectIds("linkId"), async (req, res) => {
  const project = res.locals.project as LeanProject;
  const link = await editableLink(req, project);
  const input = parseBody(linkInput.partial(), req);
  if (input.url) {
    link.url = input.url;
    link.kind = linkKind(input.url);
  }
  if (input.title !== undefined) link.title = input.title || defaultTitle(link.url, link.kind);
  await link.save();
  ok(res, serializeProjectLink((await link.populate(LINK_POPULATE)).toObject()), "Link updated.");
});

projectsRouter.delete("/:id/links/:linkId", requireProjectAccess("read"), validateObjectIds("linkId"), async (req, res) => {
  const project = res.locals.project as LeanProject;
  const link = await editableLink(req, project);
  await link.deleteOne();
  noContent(res);
});

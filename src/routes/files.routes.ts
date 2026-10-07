import { Router, type Request } from "express";
import { currentUser } from "../middleware/auth.middleware";
import { routeParam, validateObjectIds } from "../middleware/validation.middleware";
import { FileModel } from "../models";
import { accessibleProject, accessibleTask, canManageProject, canManageTask } from "../services/access.service";
import { deleteFile, withUrl } from "../services/file.service";
import { forbidden, notFound } from "../utils/errors";
import { noContent, ok } from "../utils/http";

export const filesRouter = Router();
filesRouter.param("id", (req, res, next) => validateObjectIds("id")(req, res, next));

/** Loads a file and checks access through the entity it belongs to. */
async function loadFile(req: Request) {
  const user = currentUser(req);
  const file = await FileModel.findById(routeParam(req, "id")).populate("uploadedBy", "firstName lastName email profileImage role jobTitle").lean();
  if (!file) throw notFound("File");
  if (file.entityType === "TASK") {
    const task = await accessibleTask(user, String(file.entityId));
    return { file, canManage: await canManageTask(user, task) };
  }
  const project = await accessibleProject(user, String(file.entityId));
  return { file, canManage: canManageProject(user, project) };
}

filesRouter.get("/:id", async (req, res) => {
  const { file } = await loadFile(req);
  ok(res, await withUrl(file));
});

filesRouter.delete("/:id", async (req, res) => {
  const { file, canManage } = await loadFile(req);
  const uploader = (file.uploadedBy as unknown as { _id?: unknown } | null)?._id;
  if (String(uploader) !== currentUser(req).id && !canManage) throw forbidden("You can only remove files you uploaded.");
  await deleteFile(String(file._id));
  noContent(res);
});

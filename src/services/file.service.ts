import type { Types } from "mongoose";
import { FileModel, type FileEntity } from "../models";
import type { AuthUser } from "../types/express";
import { badRequest, notFound } from "../utils/errors";
import { logger } from "../utils/logger";
import { serializeFile } from "../utils/serialize";
import { getStorage, isStorageAvailable, storageKey } from "./storage.service";

const UPLOADER_FIELDS = "firstName lastName email profileImage role jobTitle";

/** Stores the bytes in object storage, then records metadata. */
export async function saveUpload(actor: AuthUser, entityType: FileEntity, entityId: Types.ObjectId, file: Express.Multer.File | undefined) {
  if (!file) throw badRequest("Attach a file in the `file` field.", [{ path: "file", message: "A file is required." }]);
  const storage = getStorage();
  const key = storageKey(entityType, String(entityId), file.originalname);
  await storage.put(key, file.buffer, file.mimetype);
  const doc = await FileModel.create({
    entityType,
    entityId,
    storageKey: key,
    url: key, // resolved to a real URL at read time (public or presigned)
    fileName: file.originalname.slice(0, 255),
    size: file.size,
    mimeType: file.mimetype,
    uploadedBy: actor._id,
  });
  const full = await FileModel.findById(doc._id).populate("uploadedBy", UPLOADER_FIELDS).lean();
  return withUrl(full!);
}

/** Serializes with a browser-usable URL. If storage is gone, the URL is empty rather than failing the page. */
export async function withUrl(file: Parameters<typeof serializeFile>[0]) {
  const dto = serializeFile(file);
  dto.url = isStorageAvailable() ? await getStorage().urlFor(String(file.storageKey), String(file.fileName)) : "";
  return dto;
}

export async function listFiles(entityType: FileEntity, entityId: Types.ObjectId) {
  const files = await FileModel.find({ entityType, entityId }).populate("uploadedBy", UPLOADER_FIELDS).sort({ createdAt: -1 }).limit(200).lean();
  return Promise.all(files.map(withUrl));
}

export async function deleteFile(fileId: string) {
  const file = await FileModel.findById(fileId);
  if (!file) throw notFound("File");
  await file.deleteOne();
  try {
    await getStorage().remove(file.storageKey);
  } catch (error) {
    // Metadata is already gone; an orphaned object is harmless and can be cleaned up later.
    logger.warn("Failed to delete stored object", { key: file.storageKey, message: error instanceof Error ? error.message : String(error) });
  }
}

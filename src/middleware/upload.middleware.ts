import type { NextFunction, Request, Response } from "express";
import multer from "multer";
import { env } from "../config/env";
import { getStorage } from "../services/storage.service";
import { AppError } from "../utils/errors";

/** Common document, image and archive types. Executables and HTML are rejected. */
const ALLOWED_MIME = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "application/pdf",
  "text/plain",
  "text/csv",
  "text/markdown",
  "application/json",
  "application/zip",
  "application/x-zip-compressed",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.ms-powerpoint",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  "application/vnd.figma",
  "video/mp4",
]);

/**
 * Memory storage: the upload is held only long enough to stream it to object
 * storage. It is never written to the server filesystem.
 */
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: env.MAX_UPLOAD_MB * 1024 * 1024, files: 1, fields: 5 },
  fileFilter: (_req, file, cb) => {
    if (ALLOWED_MIME.has(file.mimetype)) return cb(null, true);
    cb(new AppError(415, `Files of type ${file.mimetype} are not allowed.`, [{ path: "file", message: "Unsupported file type." }]));
  },
});

/** Fails fast with 503 when storage isn't configured, before reading the body. */
export function requireStorage(_req: Request, _res: Response, next: NextFunction) {
  getStorage();
  next();
}

export const singleFile = upload.single("file");

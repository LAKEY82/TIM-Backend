import type { ErrorRequestHandler, RequestHandler } from "express";
import mongoose from "mongoose";
import { MulterError } from "multer";
import { ZodError } from "zod";
import { env } from "../config/env";
import { AppError, type FieldError } from "../utils/errors";
import { logger } from "../utils/logger";
import { zodFieldErrors } from "./validation.middleware";

export const notFoundHandler: RequestHandler = (req, res) => {
  res.status(404).json({ success: false, message: `Route not found: ${req.method} ${req.path}`, errors: [] });
};

function send(res: Parameters<ErrorRequestHandler>[2], status: number, message: string, errors: FieldError[] = [], code?: string) {
  res.status(status).json({ success: false, message, errors, ...(code ? { code } : {}) });
}

/**
 * Central error handler. Known errors become clean JSON; anything unexpected
 * is logged and returned as a generic 500 (no stack traces or internals).
 */
export const errorHandler: ErrorRequestHandler = (err, req, res, _next) => {
  if (res.headersSent) return;

  if (err instanceof AppError) return send(res, err.status, err.message, err.errors, err.code);

  if (err instanceof ZodError) return send(res, 422, "Please correct the highlighted fields.", zodFieldErrors(err), "VALIDATION_FAILED");

  if (err instanceof mongoose.Error.ValidationError) {
    const errors = Object.values(err.errors).map((e) => ({ path: e.path, message: e.message }));
    return send(res, 422, "Please correct the highlighted fields.", errors, "VALIDATION_FAILED");
  }

  if (err instanceof mongoose.Error.CastError) {
    return send(res, 400, `Invalid value for ${err.path}.`, [{ path: err.path, message: "Invalid value." }], "BAD_REQUEST");
  }

  // Duplicate key (unique index).
  if (typeof err === "object" && err !== null && (err as { code?: number }).code === 11000) {
    const keyValue = (err as { keyValue?: Record<string, unknown> }).keyValue ?? {};
    const field = Object.keys(keyValue)[0] ?? "value";
    return send(res, 409, `That ${field} is already in use.`, [{ path: field, message: `This ${field} is already in use.` }], "CONFLICT");
  }

  if (err instanceof MulterError) {
    const status = err.code === "LIMIT_FILE_SIZE" ? 413 : 400;
    const message = err.code === "LIMIT_FILE_SIZE" ? `Files must be ${env.MAX_UPLOAD_MB} MB or smaller.` : err.message;
    return send(res, status, message, [{ path: err.field ?? "file", message }], "UPLOAD_REJECTED");
  }

  // Malformed JSON body from express.json().
  if (typeof err === "object" && err !== null && (err as { type?: string }).type === "entity.parse.failed") {
    return send(res, 400, "Malformed JSON body.", [], "BAD_REQUEST");
  }
  if (typeof err === "object" && err !== null && (err as { type?: string }).type === "entity.too.large") {
    return send(res, 413, "Request body too large.", [], "PAYLOAD_TOO_LARGE");
  }

  logger.error("Unhandled error", {
    method: req.method,
    path: req.path,
    message: err instanceof Error ? err.message : String(err),
    ...(env.isProduction ? {} : { stack: err instanceof Error ? err.stack : undefined }),
  });
  return send(res, 500, "Something went wrong on our side. Please try again.", [], "INTERNAL_ERROR");
};

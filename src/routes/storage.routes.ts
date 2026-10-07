import type { Request, Response } from "express";
import { MongoStorage, getStorage } from "../services/storage.service";
import { notFound } from "../utils/errors";

/** Types a browser may show in place; everything else downloads. */
const INLINE = /^(image\/(png|jpeg|gif|webp)|video\/mp4|application\/pdf|text\/plain)$/;

/**
 * Serves files kept in MongoDB (see MongoStorage). Public like a bucket URL:
 * <img> tags can't send a token, and the key is an unguessable UUID path.
 */
export async function serveStoredFile(req: Request, res: Response) {
  const storage = getStorage();
  if (!(storage instanceof MongoStorage)) throw notFound("File");
  const parts = (req.params as { key?: string | string[] }).key ?? [];
  const key = (Array.isArray(parts) ? parts : [parts]).join("/");
  const file = await storage.open(key);
  if (!file) throw notFound("File");

  // "<uuid>-<name>" → "<name>"
  const name = (key.split("/").pop() ?? "file").replace(/^[0-9a-f-]{36}-/i, "").replace(/["\\\r\n]/g, "_");
  res.setHeader("Content-Type", file.contentType);
  res.setHeader("Content-Length", String(file.length));
  res.setHeader("Content-Disposition", `${INLINE.test(file.contentType) ? "inline" : "attachment"}; filename="${name}"`);
  res.setHeader("Cache-Control", "private, max-age=31536000, immutable");
  // The frontend may live on another site in production.
  res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
  await new Promise<void>((resolve, reject) => {
    file.stream.once("error", reject).once("end", () => resolve());
    file.stream.pipe(res);
  });
}

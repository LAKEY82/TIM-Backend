import { randomUUID } from "node:crypto";
import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import mongoose from "mongoose";
import type { Readable } from "node:stream";
import { env } from "../config/env";
import { serviceUnavailable } from "../utils/errors";

/**
 * Object storage behind a small interface, so the provider can change
 * (S3, Cloudflare R2, Supabase Storage's S3 API, MinIO...) without touching
 * routes. Nothing is ever written to the API server's own disk.
 */
export interface StorageProvider {
  put(key: string, body: Buffer, contentType: string): Promise<void>;
  remove(key: string): Promise<void>;
  /** A URL the browser can open: public if configured, otherwise presigned. */
  urlFor(key: string, fileName: string): Promise<string>;
}

class S3Storage implements StorageProvider {
  private readonly client = new S3Client({
    region: env.STORAGE_REGION,
    endpoint: env.STORAGE_ENDPOINT || undefined,
    forcePathStyle: env.STORAGE_FORCE_PATH_STYLE,
    credentials: { accessKeyId: env.STORAGE_ACCESS_KEY_ID!, secretAccessKey: env.STORAGE_SECRET_ACCESS_KEY! },
  });
  private readonly bucket = env.STORAGE_BUCKET!;

  async put(key: string, body: Buffer, contentType: string) {
    await this.client.send(new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: body, ContentType: contentType }));
  }

  async remove(key: string) {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }

  async urlFor(key: string, fileName: string) {
    if (env.STORAGE_PUBLIC_URL) return `${env.STORAGE_PUBLIC_URL.replace(/\/+$/, "")}/${key}`;
    // Private bucket: short-lived signed link that downloads with the original name.
    return getSignedUrl(
      this.client,
      new GetObjectCommand({
        Bucket: this.bucket,
        Key: key,
        ResponseContentDisposition: `attachment; filename="${fileName.replace(/["\\\r\n]/g, "_")}"`,
      }),
      { expiresIn: 60 * 60 },
    );
  }
}

/**
 * Fallback when no S3-compatible bucket is configured: files live in MongoDB
 * (GridFS, "uploads" bucket) and are served by GET /api/storage/<key>. Like a
 * public bucket, the unguessable key is the access control. Fine for small
 * teams and screenshots; use a bucket for heavy use (Atlas storage is limited).
 */
export class MongoStorage implements StorageProvider {
  private bucket() {
    const db = mongoose.connection.db;
    if (!db) throw serviceUnavailable("The database is not connected.");
    return new mongoose.mongo.GridFSBucket(db, { bucketName: "uploads" });
  }

  async put(key: string, body: Buffer, contentType: string) {
    await new Promise<void>((resolve, reject) => {
      const stream = this.bucket().openUploadStream(key, { metadata: { contentType } });
      stream.once("error", reject).once("finish", () => resolve());
      stream.end(body);
    });
  }

  async remove(key: string) {
    const bucket = this.bucket();
    for (const file of await bucket.find({ filename: key }).toArray()) await bucket.delete(file._id);
  }

  async urlFor(key: string) {
    return `${env.apiUrl}/api/storage/${key.split("/").map(encodeURIComponent).join("/")}`;
  }

  /** The stored bytes for the serving route, or null if the key doesn't exist. */
  async open(key: string): Promise<{ stream: Readable; contentType: string; length: number } | null> {
    const bucket = this.bucket();
    const [file] = await bucket.find({ filename: key }).limit(1).toArray();
    if (!file) return null;
    const contentType = typeof file.metadata?.contentType === "string" ? file.metadata.contentType : "application/octet-stream";
    return { stream: bucket.openDownloadStream(file._id), contentType, length: file.length };
  }
}

let provider: StorageProvider | null | undefined;

/** Lets tests (or a future provider) swap the implementation. */
export function setStorageProvider(p: StorageProvider | null) {
  provider = p;
}

export function getStorage(): StorageProvider {
  // S3-compatible storage when configured; otherwise files are kept in MongoDB.
  if (provider === undefined) provider = env.storageConfigured ? new S3Storage() : new MongoStorage();
  if (!provider) {
    throw serviceUnavailable(
      "File storage is not configured. Set STORAGE_BUCKET, STORAGE_ACCESS_KEY_ID and STORAGE_SECRET_ACCESS_KEY (and STORAGE_ENDPOINT for R2/Supabase/MinIO).",
    );
  }
  return provider;
}

export function isStorageAvailable(): boolean {
  try {
    getStorage();
    return true;
  } catch {
    return false;
  }
}

/** `tasks/<entityId>/<uuid>-<safe-name>`: unguessable and grouped by owner. */
export function storageKey(entityType: "TASK" | "PROJECT", entityId: string, fileName: string): string {
  const safe = fileName.normalize("NFKD").replace(/[^\w.-]+/g, "_").slice(-100) || "file";
  return `${entityType === "TASK" ? "tasks" : "projects"}/${entityId}/${randomUUID()}-${safe}`;
}

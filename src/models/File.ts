import { Schema, model, type Types } from "mongoose";

export const FILE_ENTITIES = ["TASK", "PROJECT"] as const;
export type FileEntity = (typeof FILE_ENTITIES)[number];

/** Metadata only; the bytes live in object storage (see services/storage). */
export interface IFile {
  entityType: FileEntity;
  entityId: Types.ObjectId;
  storageKey: string;
  url: string;
  fileName: string;
  size: number;
  mimeType: string;
  uploadedBy: Types.ObjectId;
  createdAt: Date;
}

const fileSchema = new Schema<IFile>(
  {
    entityType: { type: String, enum: FILE_ENTITIES, required: true },
    entityId: { type: Schema.Types.ObjectId, required: true },
    storageKey: { type: String, required: true },
    url: { type: String, required: true },
    fileName: { type: String, required: true, maxlength: 255 },
    size: { type: Number, required: true, min: 0 },
    mimeType: { type: String, required: true, maxlength: 150 },
    uploadedBy: { type: Schema.Types.ObjectId, ref: "User", required: true },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);

fileSchema.index({ entityType: 1, entityId: 1, createdAt: -1 });

export const FileModel = model<IFile>("File", fileSchema);

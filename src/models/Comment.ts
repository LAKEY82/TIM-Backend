import { Schema, model, type Types } from "mongoose";

export const COMMENT_ENTITIES = ["TASK", "PROJECT"] as const;
export type CommentEntity = (typeof COMMENT_ENTITIES)[number];

export interface IComment {
  entityType: CommentEntity;
  entityId: Types.ObjectId;
  author: Types.ObjectId;
  body: string;
  mentions: Types.ObjectId[];
  editedAt?: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

const commentSchema = new Schema<IComment>(
  {
    entityType: { type: String, enum: COMMENT_ENTITIES, required: true },
    entityId: { type: Schema.Types.ObjectId, required: true },
    author: { type: Schema.Types.ObjectId, ref: "User", required: true },
    body: { type: String, required: true, trim: true, maxlength: 10000 },
    mentions: [{ type: Schema.Types.ObjectId, ref: "User" }],
    editedAt: { type: Date, default: null },
  },
  { timestamps: true },
);

commentSchema.index({ entityType: 1, entityId: 1, createdAt: 1 });

export const Comment = model<IComment>("Comment", commentSchema);

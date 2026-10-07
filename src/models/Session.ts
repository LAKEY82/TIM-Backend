import { Schema, model, type Types } from "mongoose";

/** One row per signed-in device. Stores only a hash of the current refresh-token id. */
export interface ISession {
  user: Types.ObjectId;
  jtiHash: string;
  userAgent?: string | null;
  ip?: string | null;
  expiresAt: Date;
  revokedAt?: Date | null;
  lastUsedAt?: Date | null;
  createdAt: Date;
}

const sessionSchema = new Schema<ISession>(
  {
    user: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    jtiHash: { type: String, required: true },
    userAgent: { type: String, maxlength: 300, default: null },
    ip: { type: String, maxlength: 64, default: null },
    expiresAt: { type: Date, required: true },
    revokedAt: { type: Date, default: null },
    lastUsedAt: { type: Date, default: null },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);

// MongoDB removes sessions automatically once they expire.
sessionSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const Session = model<ISession>("Session", sessionSchema);

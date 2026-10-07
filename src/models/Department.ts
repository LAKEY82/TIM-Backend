import { Schema, model, type Types } from "mongoose";

export interface IDepartment {
  name: string;
  description?: string | null;
  head?: Types.ObjectId | null;
  createdAt: Date;
  updatedAt: Date;
}

const departmentSchema = new Schema<IDepartment>(
  {
    name: { type: String, required: true, trim: true, maxlength: 80 },
    description: { type: String, trim: true, maxlength: 1000, default: null },
    head: { type: Schema.Types.ObjectId, ref: "User", default: null },
  },
  { timestamps: true },
);

// Case-insensitive uniqueness: "QA" and "qa" are the same department.
departmentSchema.index({ name: 1 }, { unique: true, collation: { locale: "en", strength: 2 } });

export const Department = model<IDepartment>("Department", departmentSchema);

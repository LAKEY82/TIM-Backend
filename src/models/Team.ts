import { Schema, model, type Types } from "mongoose";

/**
 * Sub-groups inside a department. Backend addition: the frontend "Teams" page
 * lists departments and does not call /api/teams yet.
 */
export interface ITeam {
  name: string;
  description?: string | null;
  department: Types.ObjectId;
  lead?: Types.ObjectId | null;
  members: Types.ObjectId[];
  createdAt: Date;
  updatedAt: Date;
}

const teamSchema = new Schema<ITeam>(
  {
    name: { type: String, required: true, trim: true, maxlength: 80 },
    description: { type: String, trim: true, maxlength: 1000, default: null },
    department: { type: Schema.Types.ObjectId, ref: "Department", required: true },
    lead: { type: Schema.Types.ObjectId, ref: "User", default: null },
    members: [{ type: Schema.Types.ObjectId, ref: "User" }],
  },
  { timestamps: true },
);

teamSchema.index({ department: 1, name: 1 }, { unique: true, collation: { locale: "en", strength: 2 } });
teamSchema.index({ members: 1 });

export const Team = model<ITeam>("Team", teamSchema);

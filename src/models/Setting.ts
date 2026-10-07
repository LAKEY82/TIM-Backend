import { Schema, model } from "mongoose";

/** Company-wide settings, stored as a single document with key "company". */
export interface ICompanySetting {
  key: "company";
  name: string;
  timezone: string;
  workingHoursPerDay: number;
  weekStartsOn: 0 | 1;
}

const settingSchema = new Schema<ICompanySetting>(
  {
    key: { type: String, enum: ["company"], required: true, unique: true },
    name: { type: String, required: true, trim: true, maxlength: 120 },
    timezone: { type: String, required: true, maxlength: 64 },
    workingHoursPerDay: { type: Number, min: 1, max: 24, default: 8 },
    weekStartsOn: { type: Number, enum: [0, 1], default: 1 },
  },
  { timestamps: true },
);

export const Setting = model<ICompanySetting>("Setting", settingSchema);

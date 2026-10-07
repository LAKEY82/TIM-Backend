import { Schema, model, type HydratedDocument, type Types } from "mongoose";
import { ROLES, USER_STATUSES, type Role, type UserStatus } from "../types/domain";

export interface NotificationPrefs {
  email: Record<string, boolean>;
  inApp: Record<string, boolean>;
}

export interface IUser {
  firstName: string;
  lastName: string;
  email: string;
  passwordHash: string;
  profileImage?: string | null;
  phone?: string | null;
  jobTitle?: string | null;
  role: Role;
  department?: Types.ObjectId | null;
  team?: Types.ObjectId | null;
  status: UserStatus;
  lastLoginAt?: Date | null;
  passwordChangedAt?: Date | null;
  notificationPreferences: NotificationPrefs;
  createdAt: Date;
  updatedAt: Date;
}

const userSchema = new Schema<IUser>(
  {
    firstName: { type: String, required: true, trim: true, maxlength: 60 },
    lastName: { type: String, trim: true, maxlength: 60, default: "" },
    email: { type: String, required: true, trim: true, lowercase: true, maxlength: 254 },
    // Never selected unless explicitly requested with `.select("+passwordHash")`.
    passwordHash: { type: String, required: true, select: false },
    profileImage: { type: String, default: null },
    phone: { type: String, trim: true, maxlength: 40, default: null },
    jobTitle: { type: String, trim: true, maxlength: 120, default: null },
    role: { type: String, enum: ROLES, required: true, default: "EMPLOYEE" },
    department: { type: Schema.Types.ObjectId, ref: "Department", default: null },
    team: { type: Schema.Types.ObjectId, ref: "Team", default: null },
    status: { type: String, enum: USER_STATUSES, default: "ACTIVE" },
    lastLoginAt: { type: Date, default: null },
    passwordChangedAt: { type: Date, default: null },
    notificationPreferences: {
      email: { type: Schema.Types.Mixed, default: {} },
      inApp: { type: Schema.Types.Mixed, default: {} },
    },
  },
  { timestamps: true, minimize: false },
);

userSchema.index({ email: 1 }, { unique: true });
userSchema.index({ role: 1 });
userSchema.index({ department: 1 });
userSchema.index({ status: 1 });

export type UserDoc = HydratedDocument<IUser>;
export const User = model<IUser>("User", userSchema);

export function fullName(user: Pick<IUser, "firstName" | "lastName">): string {
  return `${user.firstName} ${user.lastName ?? ""}`.trim();
}

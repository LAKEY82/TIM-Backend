import { z } from "zod";
import { ROLES, USER_STATUSES } from "../types/domain";
import { email, password } from "./auth.validators";
import { objectId, optionalText, paginationQuery } from "./common";

const name = z.string().trim().min(2, "Name must be at least 2 characters.").max(120);

export const listUsersQuery = z
  .object({
    search: z.string().max(100).optional(),
    role: z.enum(ROLES).optional(),
    departmentId: objectId.optional(),
    status: z.enum(USER_STATUSES).optional(),
  })
  .and(paginationQuery(200));

export const createUserSchema = z.object({
  name,
  email,
  role: z.enum(ROLES).default("EMPLOYEE"),
  departmentId: objectId.nullable().optional(),
  jobTitle: optionalText(120),
  phone: optionalText(40),
  /** Optional: without it the user receives an invitation link to set one. */
  password: z.union([password, z.literal("")]).optional(),
});

export const updateUserSchema = z
  .object({
    name: name.optional(),
    email: email.optional(),
    jobTitle: optionalText(120),
    phone: optionalText(40),
    profileImage: z.union([z.url("Use a full image URL."), z.literal(""), z.null()]).optional(),
    role: z.enum(ROLES).optional(),
    departmentId: objectId.nullable().optional(),
    status: z.enum(USER_STATUSES).optional(),
  })
  .strict();

/** Fields a user may change on their own profile without users:manage. */
export const SELF_EDITABLE = ["name", "jobTitle", "phone", "profileImage"] as const;

export function splitName(full: string): { firstName: string; lastName: string } {
  const parts = full.trim().split(/\s+/);
  return { firstName: parts[0] ?? full.trim(), lastName: parts.slice(1).join(" ") };
}

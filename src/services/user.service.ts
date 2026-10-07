import { Types, type QueryFilter } from "mongoose";
import type { z } from "zod";
import { Department, Project, User, type IUser } from "../models";
import type { AuthUser } from "../types/express";
import { conflict, forbidden, notFound, unprocessable } from "../utils/errors";
import { searchRegex } from "../validators/common";
import { SELF_EDITABLE, splitName, type createUserSchema, type listUsersQuery, type updateUserSchema } from "../validators/users.validators";
import { logActivity } from "./activity.service";
import { hashPassword, revokeAllSessions, sendPasswordLink } from "./auth.service";
import { randomToken } from "./token.service";

const USER_FIELDS = "firstName lastName email profileImage phone jobTitle role department team status lastLoginAt createdAt";

export function userSearchFilter(search: string | undefined): QueryFilter<IUser> {
  const re = searchRegex(search);
  if (!re) return {};
  return {
    $or: [
      { firstName: re },
      { lastName: re },
      { email: re },
      { $expr: { $regexMatch: { input: { $concat: ["$firstName", " ", "$lastName"] }, regex: re.source, options: "i" } } },
    ],
  };
}

export async function listUsers(q: z.output<typeof listUsersQuery>) {
  const filter: QueryFilter<IUser> = { ...userSearchFilter(q.search) };
  if (q.role) filter.role = q.role;
  if (q.departmentId) filter.department = new Types.ObjectId(q.departmentId);
  if (q.status) filter.status = q.status;

  const [items, total] = await Promise.all([
    User.find(filter)
      .select(USER_FIELDS)
      .populate("department", "name")
      .sort({ firstName: 1, lastName: 1 })
      .skip(q.skip)
      .limit(q.pageSize)
      .lean(),
    User.countDocuments(filter),
  ]);
  return { items, total };
}

export async function getUser(id: string) {
  const user = await User.findById(id).select(USER_FIELDS).populate("department", "name").lean();
  if (!user) throw notFound("User");
  return user;
}

async function assertDepartment(id: string | null | undefined) {
  if (id && !(await Department.exists({ _id: id }))) {
    throw unprocessable("Department not found.", [{ path: "departmentId", message: "Select an existing department." }]);
  }
}

export async function createUser(actor: AuthUser, input: z.output<typeof createUserSchema>) {
  await assertDepartment(input.departmentId);
  if (await User.exists({ email: input.email })) {
    throw conflict("A user with this email already exists.", [{ path: "email", message: "This email is already in use." }]);
  }
  const invite = !input.password;
  const user = await User.create({
    ...splitName(input.name),
    email: input.email,
    role: input.role,
    department: input.departmentId ?? null,
    jobTitle: input.jobTitle ?? null,
    phone: input.phone ?? null,
    // Invited users get an unguessable password until they set their own.
    passwordHash: await hashPassword(input.password || randomToken()),
  });
  if (invite) await sendPasswordLink(user, "invite");
  void logActivity({
    actor: actor._id,
    type: "USER_CREATED",
    verb: "added",
    entityType: "USER",
    entityId: user._id,
    entityName: `${user.firstName} ${user.lastName}`.trim(),
    department: user.department ?? null,
  });
  return getUser(user.id);
}

export async function updateUser(actor: AuthUser, id: string, input: z.output<typeof updateUserSchema>) {
  const isSelf = actor.id === id;
  const isAdmin = actor.permissions.has("users:manage");
  const keys = Object.keys(input) as (keyof typeof input)[];

  if (!isAdmin) {
    if (!isSelf) throw forbidden("You can only edit your own profile.");
    const blocked = keys.filter((k) => !(SELF_EDITABLE as readonly string[]).includes(k));
    if (blocked.length) throw forbidden(`Only an administrator can change: ${blocked.join(", ")}.`);
  }
  // Prevent administrators from locking themselves out.
  if (isSelf && (input.role !== undefined || input.status !== undefined)) {
    throw forbidden("You can't change your own role or status.");
  }

  const user = await User.findById(id);
  if (!user) throw notFound("User");
  await assertDepartment(input.departmentId);

  if (input.name !== undefined) Object.assign(user, splitName(input.name));
  if (input.email !== undefined && input.email !== user.email) {
    if (await User.exists({ email: input.email, _id: { $ne: user._id } })) {
      throw conflict("A user with this email already exists.", [{ path: "email", message: "This email is already in use." }]);
    }
    user.email = input.email;
  }
  if (input.jobTitle !== undefined) user.jobTitle = input.jobTitle;
  if (input.phone !== undefined) user.phone = input.phone;
  if (input.profileImage !== undefined) user.profileImage = input.profileImage || null;
  if (input.role !== undefined) user.role = input.role;
  if (input.departmentId !== undefined) user.department = input.departmentId ? new Types.ObjectId(input.departmentId) : null;

  const deactivated = input.status !== undefined && input.status !== "ACTIVE" && user.status === "ACTIVE";
  if (input.status !== undefined) user.status = input.status;
  await user.save();

  // A deactivated user is signed out everywhere immediately.
  if (deactivated) await revokeAllSessions(user._id);

  if (input.role !== undefined || input.status !== undefined || input.departmentId !== undefined) {
    void logActivity({
      actor: actor._id,
      type: "USER_UPDATED",
      verb: input.status && input.status !== "ACTIVE" ? "deactivated" : "updated",
      entityType: "USER",
      entityId: user._id,
      entityName: `${user.firstName} ${user.lastName}`.trim(),
      metadata: { role: input.role, status: input.status, departmentId: input.departmentId },
    });
  }
  return getUser(id);
}

/** Members a manager is responsible for: everyone on projects they manage. */
export async function teamMemberIds(managerId: Types.ObjectId): Promise<Types.ObjectId[]> {
  const projects = await Project.find({ manager: managerId }).select("members").lean();
  const ids = new Map<string, Types.ObjectId>();
  for (const p of projects) for (const m of p.members) if (String(m) !== String(managerId)) ids.set(String(m), m);
  return [...ids.values()];
}

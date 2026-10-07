import type { Types } from "mongoose";
import type { Permission } from "../config/permissions";
import type { Role } from "./domain";

/** The authenticated principal attached by `requireAuth`. */
export interface AuthUser {
  id: string;
  _id: Types.ObjectId;
  role: Role;
  name: string;
  email: string;
  departmentId: Types.ObjectId | null;
  permissions: ReadonlySet<Permission>;
  sessionId: string;
}

declare global {
  namespace Express {
    interface Request {
      user?: AuthUser;
    }
  }
}

export {};
